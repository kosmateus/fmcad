import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createControlledHostUi,
  controlledHostUiAuditPaths,
  readControlledHostUiCapture,
  type ControlledHostUiPins,
} from "../packages/node-adapters/src/execution/controlled-host-ui";
import { createControlledFusionLaunchAdapter } from "../packages/node-adapters/src/execution/controlled-fusion-launch";
import { bootstrapInstalledFilesDigest } from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import type { ControlledProcess } from "../packages/node-adapters/src/execution/controlled-fusion-launch-types";
import { controlledHostUiNative } from "../packages/node-adapters/src/execution/controlled-host-ui-native";
import { planControlledFusionAutoload } from "../packages/node-adapters/src/execution/fusion-bootstrap-autoload";

const configPath = process.env["FMCAD_CONTROLLED_WINDOWS_FIXTURE_PINS"];
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const mapped = (native: string) =>
  `/mnt/${native[0]!.toLowerCase()}/${native.slice(3).replaceAll("\\", "/")}`;
interface Config {
  nativePython: string;
  mappedNativePython: string;
  nativePythonSha256: string;
  sourceDirectory: string;
  mappedSourceDirectory: string;
  source: string;
  mappedManifest: string;
  manifestSha256: string;
}
// This window is OUR benign UI. It has no Fusion/SDK/deployment capability.
const fixture = String.raw`
$ErrorActionPreference="Stop"
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type 'using System;using System.Text;using System.Runtime.InteropServices;public static class OwnFixtureClass{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder b,int n);}'
$root=__ROOT__
$entry=__ENTRY__
$f=New-Object System.Windows.Window
$f.Title="FMCAD owned SDK-free UI fixture (not Fusion)"
$f.Width=700;$f.Height=400;$f.Left=40;$f.Top=40
$panel=New-Object System.Windows.Controls.StackPanel
$f.Content=$panel
$open=New-Object System.Windows.Controls.Button
$open.Name="OpenManager";$open.Content="Open owned manager";$open.Width=200;$open.Height=40
$list=New-Object System.Windows.Controls.ListBox
$list.Name="InstalledEntries";$list.Width=650;$list.Height=160
$item=New-Object System.Windows.Controls.ListBoxItem
$item.Content=$entry;$null=$list.Items.Add($item)
$start=New-Object System.Windows.Controls.Button
$start.Name="StartEntry";$start.Content="Count one benign input";$start.Width=220;$start.Height=40
$null=$panel.Children.Add($open);$null=$panel.Children.Add($list);$null=$panel.Children.Add($start)
$open.Add_Click({ [IO.File]::AppendAllText("$root\events.txt",("open"+[Environment]::NewLine));$list.Visibility="Visible";$start.Visibility="Visible" })
$list.Add_SelectionChanged({ [IO.File]::AppendAllText("$root\events.txt",("select"+[Environment]::NewLine)) })
$start.Add_Click({ [IO.File]::AppendAllText("$root\events.txt",("start"+[Environment]::NewLine)) })
$f.Add_ContentRendered({
 $class=New-Object System.Text.StringBuilder 1024
 $handle=(New-Object System.Windows.Interop.WindowInteropHelper($f)).Handle
 $null=[OwnFixtureClass]::GetClassName($handle,$class,1024)
 $meta=@{
   process=@{pid=$PID;birth=(Get-Process -Id $PID).StartTime.ToFileTimeUtc().ToString()};
   mainClass="Window";executable=(Get-Process -Id $PID).Path
 }
 [IO.File]::WriteAllText("$root\ready.json",($meta | ConvertTo-Json -Depth 5))
})
$timer=New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromMilliseconds(100)
$deadline=[DateTime]::UtcNow.AddSeconds(900)
$timer.Add_Tick({
 if (Test-Path "$root\hide") {$list.Visibility="Collapsed";$start.Visibility="Collapsed";Remove-Item "$root\hide";[IO.File]::WriteAllText("$root\hidden","yes")}
 if ((Test-Path "$root\stop") -or [DateTime]::UtcNow -gt $deadline) {$f.Close()}
})
$timer.Start()
$null=$f.ShowDialog()
`;
const setup = String.raw`
import getpass,json,os,shutil,subprocess,sys,tempfile,time
from pathlib import Path
r=json.load(sys.stdin)
root=Path(tempfile.mkdtemp(prefix="sol-owned-ui-"))
subprocess.run([str(Path(os.environ["SystemRoot"])/"System32"/"icacls.exe"),
 str(root),"/inheritance:r","/grant:r",getpass.getuser()+":(OI)(CI)F"],
 check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
source=root/"source";shutil.copytree(r["sourceDirectory"],source,copy_function=shutil.copyfile)
private=root/"private";private.mkdir()
(private/"receipts").mkdir()
entry=str(source/"AutodeskFusionMCP.py")
script=r["fixture"].replace("__ROOT__","'"+str(root).replace("'","''")+"'").replace("__ENTRY__","'"+entry.replace("'","''")+"'")
import base64
system_ps=Path(os.environ["SystemRoot"])/"System32"/"WindowsPowerShell"/"v1.0"/"powershell.exe"
ps=str(private/"powershell.exe")
# Windows' system executable is hard-linked by servicing. Use our own exact
# bytes copy; do not weaken the native regular-single-link safety guard.
shutil.copyfile(system_ps,ps)
shutil.copyfile(str(system_ps)+".config",ps+".config")
child=subprocess.Popen([ps,"-NoLogo","-NoProfile","-STA","-EncodedCommand",base64.b64encode(script.encode("utf-16le")).decode()],
 stdin=subprocess.DEVNULL,stdout=(root/"stdout.txt").open("wb"),stderr=(root/"stderr.txt").open("wb"))
deadline=time.monotonic()+30
while not (root/"ready.json").exists():
 if child.poll() is not None or time.monotonic()>deadline:
  raise RuntimeError("Owned fixture failed: "+(root/"stderr.txt").read_text(errors="replace"))
 time.sleep(.05)
meta=json.loads((root/"ready.json").read_text(encoding="utf-8-sig"))
if meta["process"]["pid"] != child.pid:raise RuntimeError("Own CreateProcess origin differs")
print(json.dumps({"root":str(root),"source":str(source),"private":str(private),
 "powershell":ps,"meta":meta}))
`;

test(
  "actual owned Windows UI: exact process, private originals and one benign input (NO Fusion)",
  {
    skip:
      !configPath && "NOTRUN: explicit SDK-free Windows fixture pins required",
  },
  async (t) => {
    assert.ok(configPath);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Config;
    assert.equal(
      sha(fs.readFileSync(config.mappedNativePython)),
      config.nativePythonSha256,
    );
    const manifest = fs.readFileSync(config.mappedManifest);
    assert.equal(sha(manifest), config.manifestSha256);
    const files = JSON.parse(manifest.toString()) as Record<string, string>;
    const created = spawnSync(
      config.mappedNativePython,
      ["-I", "-S", "-B", "-c", setup],
      {
        input: JSON.stringify({ ...config, fixture }),
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.equal(created.status, 0, created.stderr);
    const value = JSON.parse(created.stdout) as {
      root: string;
      source: string;
      private: string;
      powershell: string;
      meta: {
        -readonly [
          K in
            | "executable"
            | "mainClass"
            | "openManager"
            | "installedEntry"
            | "start"
        ]: ControlledHostUiPins[K];
      } & { process: ControlledProcess };
    };
    try {
      const initial = spawnSync(
        mapped(value.powershell),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(controlledHostUiNative, "utf16le").toString("base64"),
        ],
        {
          input: JSON.stringify({
            ...value.meta,
            action: "capture",
            expected: null,
            powershell: value.powershell,
            powershellSha256: sha(fs.readFileSync(mapped(value.powershell))),
            executableSha256: sha(fs.readFileSync(mapped(value.powershell))),
            powershellConfigSha256: sha(
              fs.readFileSync(mapped(`${value.powershell}.config`)),
            ),
          }),
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      assert.equal(initial.status, 0, initial.stderr);
      const initialView = JSON.parse(initial.stdout) as {
        view: {
          tree: Array<{
            id: string;
            name: string;
            class: string;
            type: string;
          }>;
        };
      };
      function selector(name: string, type?: string) {
        const item = initialView.view.tree.find(
          (item) => item.name === name && (!type || item.type === type),
        );
        assert.ok(item, JSON.stringify(initialView.view));
        return {
          id: item.id,
          name: item.name,
          class: item.class,
          type: item.type,
        };
      }
      value.meta.openManager = selector("Open owned manager");
      value.meta.installedEntry = selector(
        `${value.source}\\AutodeskFusionMCP.py`,
        "ControlType.ListItem",
      );
      value.meta.start = selector("Count one benign input");
      fs.writeFileSync(mapped(`${value.root}\\hide`), "");
      const hidden = spawnSync(
        config.mappedNativePython,
        [
          "-I",
          "-S",
          "-B",
          "-c",
          "import sys,time\nfrom pathlib import Path\np=Path(sys.argv[1]);deadline=time.monotonic()+10\nwhile not p.exists():\n if time.monotonic()>deadline:raise TimeoutError('Owned UI hide not delivered')\n time.sleep(.05)",
          `${value.root}\\hidden`,
        ],
        {
          encoding: "utf8",
        },
      );
      assert.equal(hidden.status, 0, hidden.stderr);
      t.diagnostic(
        `Owned fixture ${value.root}; source ${config.source}; Python SHA ${config.nativePythonSha256}`,
      );
      const events = () =>
        fs.existsSync(mapped(`${value.root}\\events.txt`))
          ? fs
              .readFileSync(mapped(`${value.root}\\events.txt`), "utf8")
              .trim()
              .split(/\r?\n/)
          : [];
      const paths = {
        profile: `${value.private}\\profile.json`,
        profileBackup: `${value.private}\\profile-before.json`,
        intent: `${value.private}\\intent.json`,
        receiptDirectory: `${value.private}\\receipts`,
        entry: `${value.private}\\receipts\\entry.json`,
        returned: `${value.private}\\receipts\\returned.json`,
        launchJournal: `${value.private}\\launch.json`,
        launchAttempt: `${value.private}\\launch-attempt.json`,
        sourceClosure: `${value.private}\\closure.json`,
        transcript: `${value.private}\\transcript.json`,
        provision: `${value.private}\\UNUSED-provision.json`,
      };
      let generation = 1;
      function make(
        label: string,
        changed: Partial<ControlledHostUiPins> = {},
      ) {
        const audit = `${value.private}\\${label}`;
        fs.mkdirSync(mapped(audit));
        const originals = controlledHostUiAuditPaths(audit, paths.intent);
        const native = createControlledFusionLaunchAdapter({
          ...config,
          sourceDirectory: value.source,
          mappedSourceDirectory: mapped(value.source),
          installedDirectory: value.source,
          mappedInstalledDirectory: mapped(value.source),
          installedSource: config.source,
          installedBuild: bootstrapInstalledFilesDigest(files),
          installedFiles: files,
          executable: value.powershell,
          mappedExecutable: mapped(value.powershell),
          executableSha256: sha(fs.readFileSync(mapped(value.powershell))),
          arguments: [],
          workingDirectory: value.private,
          paths,
          originalPaths: originals,
          mappedOriginalPaths: Object.fromEntries(
            [...Object.values(paths), ...originals].map((name) => [
              name,
              mapped(name),
            ]),
          ),
          receiptTimeoutMs: 100,
          normalCloseTimeoutMs: 100,
          mainWindowClass: value.meta.mainClass,
        });
        const expectedGeneration = generation;
        const fence = () =>
          assert.equal(generation, expectedGeneration, "Held lease revoked");
        return {
          native,
          audit,
          ui: createControlledHostUi(
            {
              ...value.meta,
              powershell: value.powershell,
              mappedPowershell: mapped(value.powershell),
              powershellSha256: sha(fs.readFileSync(mapped(value.powershell))),
              powershellConfigSha256: sha(
                fs.readFileSync(mapped(`${value.powershell}.config`)),
              ),
              executableSha256: sha(fs.readFileSync(mapped(value.powershell))),
              auditDirectory: audit,
              mappedAuditDirectory: mapped(audit),
              ...changed,
            },
            native,
            { fence, assertCurrent: async () => fence() },
          ),
        };
      }
      await t.test(
        "wrong birth refuses without input and cannot retry",
        async () => {
          const { native, ui } = make("wrong-birth");
          await native.preflight();
          await assert.rejects(
            ui.prepareExactHost({
              process: { ...value.meta.process, birth: "1" },
              entry: value.meta.installedEntry.name,
            }),
          );
          await assert.rejects(
            ui.prepareExactHost({
              process: value.meta.process,
              entry: value.meta.installedEntry.name,
            }),
            /retry|replay/,
          );
          assert.deepEqual(events(), []);
        },
      );
      await t.test("wrong PID refuses without input", async () => {
        const { native, ui } = make("wrong-pid");
        await native.preflight();
        await assert.rejects(
          ui.prepareExactHost({
            process: { ...value.meta.process, pid: 1 },
            entry: value.meta.installedEntry.name,
          }),
        );
        assert.deepEqual(events(), []);
      });
      await t.test("wrong visible control refuses without input", async () => {
        const { native, ui } = make("wrong-control", {
          openManager: { ...value.meta.openManager, name: "not the button" },
        });
        await native.preflight();
        await assert.rejects(
          ui.prepareExactHost({
            process: value.meta.process,
            entry: value.meta.installedEntry.name,
          }),
          /Unambiguous visible exact control/,
        );
        assert.deepEqual(events(), []);
      });
      await t.test("revoked held lease refuses without input", async () => {
        const { native, ui } = make("revoked");
        await native.preflight();
        generation++;
        await assert.rejects(
          ui.prepareExactHost({
            process: value.meta.process,
            entry: value.meta.installedEntry.name,
          }),
        );
        assert.deepEqual(events(), []);
      });
      const { native, ui } = make("positive");
      await native.preflight();
      await t.test(
        "prepare opens/selects own entry but NEVER presses start",
        async () => {
          const prepared = await ui.prepareExactHost({
            process: value.meta.process,
            entry: value.meta.installedEntry.name,
          });
          assert.equal(prepared.selectedEntry, value.meta.installedEntry.name);
          assert.equal(events().filter((event) => event === "open").length, 1);
          assert.equal(
            events().filter((event) => event === "select").length,
            1,
          );
          assert.equal(events().filter((event) => event === "start").length, 0);
          await native.assertOriginal(prepared.reference);
        },
      );
      function nativeUi(request: Record<string, unknown>) {
        return spawnSync(
          mapped(value.powershell),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(controlledHostUiNative, "utf16le").toString("base64"),
          ],
          {
            input: JSON.stringify({
              process: value.meta.process,
              executable: value.powershell,
              mainClass: value.meta.mainClass,
              powershell: value.powershell,
              powershellSha256: sha(fs.readFileSync(mapped(value.powershell))),
              powershellConfigSha256: sha(
                fs.readFileSync(mapped(`${value.powershell}.config`)),
              ),
              executableSha256: sha(fs.readFileSync(mapped(value.powershell))),
              expected: null,
              entry: value.meta.installedEntry.name,
              ...request,
            }),
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
          },
        );
      }
      await t.test(
        "actual fresh selection change refuses start without input",
        () => {
          const original = nativeUi({ action: "capture" });
          assert.equal(original.status, 0, original.stderr);
          const captured = readControlledHostUiCapture(
            original.stdout,
            value.meta.process,
            false,
          );
          captured.view.selectedEntry = "C:\\different\\AutodeskFusionMCP.py";
          const denied = nativeUi({
            action: "invoke",
            selector: value.meta.start,
            expected: captured.view,
          });
          assert.notEqual(denied.status, 0);
          assert.match(denied.stderr, /Fresh original view differs/);
          assert.equal(events().filter((event) => event === "start").length, 0);
        },
      );
      await t.test(
        "actual helper byte pin mismatch refuses before input",
        () => {
          const denied = nativeUi({
            action: "invoke",
            selector: value.meta.start,
            powershellSha256: "0".repeat(64),
          });
          assert.notEqual(denied.status, 0);
          assert.match(
            denied.stderr,
            /Pinned UI helper executable bytes|Original locked bytes differ/,
          );
          assert.equal(events().filter((event) => event === "start").length, 0);
        },
      );
      await t.test(
        "partial actual screenshot capture is rejected, never authority",
        () => {
          const original = nativeUi({ action: "capture" });
          assert.equal(original.status, 0, original.stderr);
          const captured = JSON.parse(original.stdout) as { png: string };
          captured.png = Buffer.from(captured.png, "base64")
            .subarray(0, 24)
            .toString("base64");
          assert.throws(
            () =>
              readControlledHostUiCapture(
                JSON.stringify(captured),
                value.meta.process,
                false,
              ),
            /screenshot missing\/partial/,
          );
          assert.equal(events().filter((event) => event === "start").length, 0);
        },
      );
      const profileBytes = planControlledFusionAutoload(
        Buffer.from(
          JSON.stringify({
            loadedScripts: [
              {
                name: "Owned SDK-free fixture",
                path: value.meta.installedEntry.name,
                location: 1,
                isRemoved: false,
                isFavorite: false,
                runOnStartup: false,
              },
            ],
          }),
        ),
        value.meta.installedEntry.name,
      ).registrationBytes();
      fs.writeFileSync(mapped(paths.profile), profileBytes);
      const intent = await native.publishOriginal(
        paths.intent,
        Buffer.from(
          JSON.stringify({
            kind: "fmcad-bootstrap-entry-intent",
            version: 1,
            nonce: "1".repeat(32),
            purpose: "isolated-stdout-v1",
            engineVersion: 2,
            process: value.meta.process,
            installed: {
              directory: value.source,
              source: config.source,
              files,
            },
            profile: { path: paths.profile, sha256: sha(profileBytes) },
            receipts: {
              directory: paths.receiptDirectory,
              entry: path.win32.basename(paths.entry),
              returned: path.win32.basename(paths.returned),
            },
          }),
        ),
      );
      await t.test(
        "original intent yields ONE actual benign input and original journal, not startup proof",
        async () => {
          const observed = await ui.startReviewedFork({
            process: value.meta.process,
            entry: value.meta.installedEntry.name,
            intent,
          });
          assert.equal(events().filter((event) => event === "start").length, 1);
          await native.assertOriginal(observed.reference);
          const receipt = JSON.parse(
            Buffer.from(observed.reference.bytes).toString(),
          ) as { startupProven: boolean; attempt: { nativePath: string } };
          assert.equal(receipt.startupProven, false);
          assert.equal(
            receipt.attempt.nativePath,
            `${paths.intent}.ui-start-attempt.json`,
          );
          assert.ok(fs.statSync(mapped(receipt.attempt.nativePath)).size > 0);
          await assert.rejects(
            ui.startReviewedFork({
              process: value.meta.process,
              entry: value.meta.installedEntry.name,
              intent,
            }),
            /replay/,
          );
          assert.equal(events().filter((event) => event === "start").length, 1);
        },
      );
      await t.test(
        "duplicate durable action refuses across reconstructed adapter and fresh audit directory",
        async () => {
          // Existing original O_EXCL attempt remains even after this instance is gone.
          const original = fs.readFileSync(
            mapped(`${paths.intent}.ui-start-attempt.json`),
          );
          assert.throws(
            () =>
              fs.openSync(
                mapped(`${paths.intent}.ui-start-attempt.json`),
                "wx",
              ),
            /EEXIST/,
          );
          assert.deepEqual(
            fs.readFileSync(mapped(`${paths.intent}.ui-start-attempt.json`)),
            original,
          );
          const duplicate = make("duplicate");
          await duplicate.native.preflight();
          await duplicate.ui.prepareExactHost({
            process: value.meta.process,
            entry: value.meta.installedEntry.name,
          });
          await assert.rejects(
            duplicate.ui.startReviewedFork({
              process: value.meta.process,
              entry: value.meta.installedEntry.name,
              intent,
            }),
            /EEXIST/,
          );
          assert.equal(events().filter((event) => event === "start").length, 1);
        },
      );
    } finally {
      fs.writeFileSync(mapped(`${value.root}\\stop`), "");
      const closed = spawnSync(
        config.mappedNativePython,
        [
          "-I",
          "-S",
          "-B",
          "-c",
          String.raw`
import ctypes,json,sys
from ctypes import wintypes as w
r=json.load(sys.stdin);k=ctypes.WinDLL("kernel32",use_last_error=True)
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
k.GetProcessTimes.argtypes=[w.HANDLE,ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME)]
k.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD];k.CloseHandle.argtypes=[w.HANDLE]
h=k.OpenProcess(0x1000|0x100000,False,r["pid"])
if h:
 try:
  ts=[w.FILETIME() for _ in range(4)]
  if not k.GetProcessTimes(h,*(ctypes.byref(x) for x in ts)):raise OSError("Own process birth unavailable")
  if str((ts[0].dwHighDateTime<<32)|ts[0].dwLowDateTime)!=r["birth"]:raise RuntimeError("Own process birth changed; no cleanup action")
  if k.WaitForSingleObject(h,10000)!=0:raise TimeoutError("Own fixture normal shutdown not confirmed; no force kill")
 finally:k.CloseHandle(h)
elif ctypes.get_last_error()!=87:raise OSError("Own process cleanup observation unavailable")
print("Owned exact-PID/birth fixture normal shutdown confirmed")
`,
        ],
        {
          input: JSON.stringify(value.meta.process),
          encoding: "utf8",
        },
      );
      assert.equal(closed.status, 0, closed.stderr);
      t.diagnostic(
        `Original images/JSON/journals retained in ${value.private}; own exact PID/birth normal shutdown confirmed`,
      );
    }
  },
);

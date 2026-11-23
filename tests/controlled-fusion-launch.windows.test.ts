import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createControlledFusionLaunchAdapter,
  type ControlledFusionLaunchPins,
} from "../packages/node-adapters/src/execution/controlled-fusion-launch";
import { planControlledFusionAutoload } from "../packages/node-adapters/src/execution/fusion-bootstrap-autoload";
import { bootstrapInstalledFilesDigest } from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import { controlledFusionLaunchNative } from "../packages/node-adapters/src/execution/controlled-fusion-launch-native";
import type { ControlledProcess } from "../packages/node-adapters/src/execution/controlled-fusion-launch-types";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
interface FixturePins {
  nativePython: string;
  mappedNativePython: string;
  nativePythonSha256: string;
  sourceDirectory: string;
  mappedSourceDirectory: string;
  source: string;
  mappedManifest: string;
  manifestSha256: string;
}
const fixtureConfig = process.env["FMCAD_CONTROLLED_WINDOWS_FIXTURE_PINS"];
const setup = String.raw`
import ctypes, getpass, hashlib, json, os, shutil, subprocess, sys, tempfile
from ctypes import wintypes as w
from pathlib import Path
p=json.load(sys.stdin)
root=Path(tempfile.mkdtemp(prefix="sol-controlled-launch-"))
icacls=str(Path(os.environ["SystemRoot"])/"System32"/"icacls.exe")
subprocess.run([icacls,str(root),"/inheritance:r","/grant:r",getpass.getuser()+":(OI)(CI)F"],
               check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
source=root/"source"
shutil.copytree(p["sourceDirectory"],source,copy_function=shutil.copyfile)
private=root/"private";private.mkdir()
receipts=private/"receipts";receipts.mkdir()
profile=private/"profile.json"
profile.write_text(json.dumps({"loadedScripts":[{"name":"fixture",
 "path":str(source/"AutodeskFusionMCP.py"),"location":1,"isRemoved":False,
 "isFavorite":False,"runOnStartup":True}]}),encoding="utf-8")
k=ctypes.WinDLL("kernel32",use_last_error=True)
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
k.GetProcessTimes.argtypes=[w.HANDLE,ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME)]
k.CloseHandle.argtypes=[w.HANDLE]
child=subprocess.Popen([sys.executable,"-I","-S","-B","-c","import time; time.sleep(0.3)"])
h=k.OpenProcess(0x1000,False,child.pid)
if not h:raise OSError("Fixture old process unavailable")
times=[w.FILETIME() for _ in range(4)]
if not k.GetProcessTimes(h,*(ctypes.byref(value)for value in times)):raise OSError("Fixture birth absent")
birth=str((times[0].dwHighDateTime<<32)|times[0].dwLowDateTime)
k.CloseHandle(h);child.wait()
print(json.dumps({"root":str(root),"source":str(source),"private":str(private),
 "receipts":str(receipts),"profile":str(profile),"old":{"pid":child.pid,"birth":birth},
 "pythonVersion":sys.version}))
`;
const control = String.raw`
import ctypes,json,os,subprocess,sys,time
from ctypes import wintypes as w
from pathlib import Path
r=json.load(sys.stdin)
if r["action"]=="public":
    subprocess.run([str(Path(os.environ["SystemRoot"])/"System32"/"icacls.exe"),
                    r["path"],"/grant","*S-1-1-0:R"],check=True,stdout=subprocess.PIPE)
elif r["action"]=="wait":
    k=ctypes.WinDLL("kernel32",use_last_error=True)
    k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
    k.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD];k.CloseHandle.argtypes=[w.HANDLE]
    h=k.OpenProcess(0x100000,False,r["pid"])
    if h:
        try:
            if k.WaitForSingleObject(h,15000)!=0:raise RuntimeError("Fixture child still running; not killed")
        finally:k.CloseHandle(h)
elif r["action"]=="wait-file":
    deadline=time.monotonic()+10
    while not Path(r["path"]).is_file():
        if time.monotonic()>=deadline:raise TimeoutError("Fixture child report absent")
        time.sleep(0.05)
else:raise ValueError("Unknown fixture operation")
print(json.dumps({"fixtureOperation":r["action"],"noForceTermination":True}))
`;
const ownWindow = String.raw`
import ctypes,sys
from ctypes import wintypes as w
from pathlib import Path
ready=Path(sys.argv[1])
u=ctypes.WinDLL("user32",use_last_error=True); k=ctypes.WinDLL("kernel32",use_last_error=True)
callback=ctypes.WINFUNCTYPE(ctypes.c_ssize_t,w.HWND,w.UINT,w.WPARAM,w.LPARAM)
u.DefWindowProcW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM];u.DefWindowProcW.restype=ctypes.c_ssize_t
u.DestroyWindow.argtypes=[w.HWND];u.PostQuitMessage.argtypes=[ctypes.c_int]
def procedure(hwnd,message,wp,lp):
    if message in (0x0010,0x0113):
        u.DestroyWindow(hwnd);return 0
    if message==0x0002:
        u.PostQuitMessage(0);return 0
    return u.DefWindowProcW(hwnd,message,wp,lp)
proc=callback(procedure)
class Class(ctypes.Structure):
    _fields_=[("style",w.UINT),("proc",callback),("classExtra",ctypes.c_int),
     ("windowExtra",ctypes.c_int),("instance",w.HANDLE),("icon",w.HANDLE),
     ("cursor",w.HANDLE),("background",w.HANDLE),("menu",w.LPCWSTR),("name",w.LPCWSTR)]
k.GetModuleHandleW.argtypes=[w.LPCWSTR];k.GetModuleHandleW.restype=w.HANDLE
cls=Class();cls.proc=proc;cls.instance=k.GetModuleHandleW(None);cls.name="FmcadSdkFreeControlledFixture"
u.RegisterClassW.argtypes=[ctypes.POINTER(Class)]
if not u.RegisterClassW(ctypes.byref(cls)):raise OSError("Own fixture window class unavailable")
u.CreateWindowExW.argtypes=[w.DWORD,w.LPCWSTR,w.LPCWSTR,w.DWORD,ctypes.c_int,ctypes.c_int,
 ctypes.c_int,ctypes.c_int,w.HWND,w.HMENU,w.HANDLE,ctypes.c_void_p]
u.CreateWindowExW.restype=w.HWND
hwnd=u.CreateWindowExW(0,cls.name,"SDK-free fixture (not Fusion)",0,0,0,100,100,None,None,cls.instance,None)
if not hwnd:raise OSError("Own fixture window unavailable")
u.SetTimer.argtypes=[w.HWND,w.WPARAM,w.UINT,ctypes.c_void_p]
u.SetTimer(hwnd,1,20000,None) # bounded normal self-close if the test fails; no kill
ready.write_text("own hidden window ready",encoding="utf-8")
u.GetMessageW.argtypes=[ctypes.POINTER(w.MSG),w.HWND,w.UINT,w.UINT]
u.TranslateMessage.argtypes=[ctypes.POINTER(w.MSG)];u.DispatchMessageW.argtypes=[ctypes.POINTER(w.MSG)]
message=w.MSG()
while True:
    result=u.GetMessageW(ctypes.byref(message),None,0,0)
    if result==0:break
    if result<0:raise OSError("Own fixture message loop unavailable")
    u.TranslateMessage(ctypes.byref(message));u.DispatchMessageW(ctypes.byref(message))
`;
function mapped(nativePath: string) {
  assert.match(nativePath, /^[A-Za-z]:\\/);
  return `/mnt/${nativePath[0]!.toLowerCase()}/${nativePath.slice(3).replaceAll("\\", "/")}`;
}
function nativeFixture(config: FixturePins, source: string, input: unknown) {
  assert.equal(
    sha(fs.readFileSync(config.mappedNativePython)),
    config.nativePythonSha256,
  );
  const result = spawnSync(
    config.mappedNativePython,
    ["-I", "-S", "-B", "-c", source],
    {
      cwd: config.mappedSourceDirectory,
      input: JSON.stringify(input),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test(
  "actual Windows native private-file/process fixtures (NO Fusion, SDK, UI or provision changes)",
  {
    skip:
      !fixtureConfig &&
      "NOTRUN: explicit SDK-free Windows fixture pins not supplied",
  },
  async (t) => {
    assert.ok(fixtureConfig);
    const config = JSON.parse(
      fs.readFileSync(fixtureConfig, "utf8"),
    ) as FixturePins;
    const manifestBytes = fs.readFileSync(config.mappedManifest);
    assert.equal(sha(manifestBytes), config.manifestSha256);
    const installedFiles = JSON.parse(manifestBytes.toString("utf8")) as Record<
      string,
      string
    >;
    assert.equal(Object.keys(installedFiles).length, 100);
    const created = nativeFixture(config, setup, config) as {
      root: string;
      source: string;
      private: string;
      receipts: string;
      profile: string;
      old: ControlledProcess;
      pythonVersion: string;
    };
    t.diagnostic(
      `Native runtime ${created.pythonVersion}; fixture root ${created.root}; source ${config.source}; 100-file manifest ${config.manifestSha256}`,
    );
    const paths = {
      profile: created.profile,
      profileBackup: `${created.private}\\profile-before.json`,
      intent: `${created.private}\\intent.json`,
      receiptDirectory: created.receipts,
      entry: `${created.receipts}\\entry.json`,
      returned: `${created.receipts}\\returned.json`,
      launchJournal: `${created.private}\\launch-journal.json`,
      sourceClosure: `${created.private}\\source-closure.json`,
      launchAttempt: `${created.private}\\launch-attempt.json`,
      transcript: `${created.private}\\transcript.json`,
      provision: `${created.private}\\UNUSED-provision.json`,
    };
    const childReport = `${created.private}\\child-environment.json`;
    const stop = `${created.private}\\child-stop`;
    const childProgram = [
      "import json,os,time",
      "from pathlib import Path",
      `Path(${JSON.stringify(childReport)}).write_text(json.dumps({k:os.environ.get(k)for k in ('PYTHONDONTWRITEBYTECODE','FUSION_MCP_BOOTSTRAP_INTENT','FUSION_MCP_ADMISSION_PROVISION')}),encoding='utf-8')`,
      `deadline=time.monotonic()+180`,
      `while not Path(${JSON.stringify(stop)}).exists() and time.monotonic()<deadline: time.sleep(0.05)`,
    ].join("\n");
    const pins: ControlledFusionLaunchPins = {
      nativePython: config.nativePython,
      mappedNativePython: config.mappedNativePython,
      nativePythonSha256: config.nativePythonSha256,
      sourceDirectory: created.source,
      mappedSourceDirectory: mapped(created.source),
      installedDirectory: created.source,
      mappedInstalledDirectory: mapped(created.source),
      installedSource: config.source,
      installedBuild: bootstrapInstalledFilesDigest(installedFiles),
      installedFiles,
      executable: config.nativePython,
      mappedExecutable: config.mappedNativePython,
      executableSha256: config.nativePythonSha256,
      arguments: ["-I", "-S", "-B", "-c", childProgram],
      workingDirectory: created.private,
      paths,
      originalPaths: [childReport],
      mappedOriginalPaths: Object.fromEntries(
        [...Object.values(paths), childReport].map((name) => [
          name,
          mapped(name),
        ]),
      ),
      receiptTimeoutMs: 150,
      normalCloseTimeoutMs: 100,
      mainWindowClass: "Nu::QTMainWindow",
    };
    const adapter = createControlledFusionLaunchAdapter(pins);
    assert.equal(
      pins.installedBuild,
      "a474a7d4f6194697d5e40759db18cca4f2e44f989ae9b9e3e5a6dd38cced0c58",
    );
    const launched: { process?: ControlledProcess } = {};
    t.after(() => {
      if (launched.process) {
        fs.writeFileSync(mapped(stop), "fixture requests normal self-exit");
        nativeFixture(config, control, {
          action: "wait",
          pid: launched.process.pid,
        });
      }
      // Preserve this test's original files/UNKNOWN evidence; never remove peers.
      for (const [name, digest] of Object.entries(installedFiles))
        assert.equal(
          sha(
            fs.readFileSync(
              path.join(config.mappedSourceDirectory, ...name.split("/")),
            ),
          ),
          digest,
        );
    });
    await t.test(
      "strict native stdin refuses duplicate/nonfinite/partial/unknown envelopes before operator actions",
      () => {
        assert.throws(
          () =>
            createControlledFusionLaunchAdapter({
              ...pins,
              installedBuild: config.manifestSha256,
            }),
          /build/,
        );
        for (const input of [
          '{"pins":{},"pins":{}}',
          '{"pins":NaN}',
          '{"pins":1e309}',
          '{"pins":',
          '{"pins":{},"action":"launch","request":{},"expectedSource":null,"extra":true}',
        ]) {
          const rejected = spawnSync(
            config.mappedNativePython,
            ["-I", "-S", "-B", "-c", controlledFusionLaunchNative],
            {
              cwd: config.mappedSourceDirectory,
              input,
              encoding: "utf8",
              maxBuffer: 1024 * 1024,
            },
          );
          assert.notEqual(rejected.status, 0);
          assert.equal(rejected.stdout, "");
        }
      },
    );
    await t.test(
      "native private DACL + full source preflight and OS-confirmed old death",
      async () => {
        await adapter.preflight();
        await adapter.confirmDead(created.old);
      },
    );
    const original = await adapter.readProfileAfterDeath(created.old);
    const plan = planControlledFusionAutoload(
      original.bytes,
      `${created.source}\\AutodeskFusionMCP.py`,
    );
    const applied = await adapter.applyProfileAfterDeath(
      created.old,
      original,
      plan.registrationBytes(),
    );
    await t.test(
      "actual profile exclusive backup, exact bytes and before-after identity fences",
      async () => {
        assert.equal(applied.backup.sha256, original.sha256);
        assert.equal(applied.profile.sha256, plan.plannedSha256);
        await adapter.assertOriginal(applied.backup);
        await adapter.assertOriginal(applied.profile);
        await assert.rejects(
          adapter.applyProfileAfterDeath(
            created.old,
            original,
            plan.registrationBytes(),
          ),
          /replayed/,
        );
        const stale = createControlledFusionLaunchAdapter(pins);
        await assert.rejects(
          stale.applyProfileAfterDeath(
            created.old,
            original,
            plan.registrationBytes(),
          ),
        );
        assert.equal(
          (await adapter.readOriginal(paths.profile)).sha256,
          applied.profile.sha256,
        );
        assert.equal(
          (await adapter.readOriginal(paths.profileBackup)).sha256,
          original.sha256,
        );
      },
    );
    const launch = await adapter.launch(
      created.old,
      applied.profile,
      "a".repeat(32),
    );
    launched.process = launch.process;
    await t.test(
      "real CreateProcess child origin/PID/birth and required launch environment",
      async () => {
        assert.notEqual(launch.process.pid, created.old.pid);
        assert.notEqual(launch.process.birth, created.old.birth);
        assert.deepEqual(
          (
            JSON.parse(Buffer.from(launch.journal.bytes).toString("utf8")) as {
              process: ControlledProcess;
            }
          ).process,
          launch.process,
        );
        await adapter.assertProcess(launch.process);
        nativeFixture(config, control, {
          action: "wait-file",
          path: childReport,
        });
        const report = await adapter.readOriginal(childReport);
        const environment: unknown = JSON.parse(
          Buffer.from(report.bytes).toString("utf8"),
        );
        assert.deepEqual(environment, {
          PYTHONDONTWRITEBYTECODE: "1",
          FUSION_MCP_BOOTSTRAP_INTENT: paths.intent,
          FUSION_MCP_ADMISSION_PROVISION: paths.provision,
        });
      },
    );
    await t.test(
      "old-versus-new PID/birth and no second launch/no journal overwrite",
      async () => {
        await assert.rejects(adapter.confirmDead(launch.process));
        await assert.rejects(
          adapter.assertProcess({ ...launch.process, birth: "1" }),
        );
        // This console fixture is not the pinned vendor GUI: no ambiguous
        // window signal, no force termination, and the same child stays alive.
        await assert.rejects(adapter.requestNormalCloseAndWait(launch.process));
        await adapter.assertProcess(launch.process);
        await assert.rejects(
          adapter.launch(created.old, applied.profile, "b".repeat(32)),
          /replayed/,
        );
        assert.equal(
          (await adapter.readOriginal(paths.launchJournal)).sha256,
          launch.journal.sha256,
        );
      },
    );
    await t.test(
      "ONE ordinary WM_CLOSE reaches only the exact owned hidden-window fixture and OS confirms its death",
      async () => {
        const directory = `${created.private}\\owned-gui-fixture`;
        fs.mkdirSync(mapped(directory));
        const receipts = `${directory}\\receipts`;
        fs.mkdirSync(mapped(receipts));
        const ready = `${directory}\\ready`;
        const guiPaths = {
          profile: paths.profile,
          profileBackup: `${directory}\\backup.json`,
          intent: `${directory}\\intent.json`,
          receiptDirectory: receipts,
          entry: `${receipts}\\entry.json`,
          returned: `${receipts}\\returned.json`,
          launchAttempt: `${directory}\\attempt.json`,
          launchJournal: `${directory}\\created.json`,
          sourceClosure: `${directory}\\closure.json`,
          transcript: `${directory}\\transcript.json`,
          provision: paths.provision,
        };
        const gui = createControlledFusionLaunchAdapter({
          ...pins,
          paths: guiPaths,
          originalPaths: [ready],
          normalCloseTimeoutMs: 10000,
          arguments: ["-I", "-S", "-B", "-c", ownWindow, ready],
          mainWindowClass: "FmcadSdkFreeControlledFixture",
          mappedOriginalPaths: Object.fromEntries(
            [...Object.values(guiPaths), ready].map((name) => [
              name,
              mapped(name),
            ]),
          ),
        });
        const started = await gui.launch(
          created.old,
          applied.profile,
          "c".repeat(32),
        );
        t.after(() => {
          nativeFixture(config, control, {
            action: "wait",
            pid: started.process.pid,
          });
        });
        nativeFixture(config, control, { action: "wait-file", path: ready });
        await gui.assertProcess(started.process);
        await gui.requestNormalCloseAndWait(started.process);
        await gui.confirmDead(started.process);
      },
    );
    const intent = await adapter.publishOriginal(
      paths.intent,
      Buffer.from("owned SDK-free intent fixture"),
    );
    await t.test(
      "exclusive private original writes/readbacks refuse same-instance and cross-instance replay",
      async () => {
        await adapter.assertOriginal(intent);
        await assert.rejects(
          adapter.publishOriginal(paths.intent, Buffer.from("overwrite")),
          /replayed/,
        );
        const another = createControlledFusionLaunchAdapter(pins);
        await assert.rejects(
          another.publishOriginal(paths.intent, Buffer.from("overwrite")),
        );
        assert.equal(
          (await adapter.readOriginal(paths.intent)).sha256,
          intent.sha256,
        );
      },
    );
    fs.writeFileSync(mapped(paths.entry), "original partial entry fixture");
    await t.test(
      "entry without return preserves original partial bytes and refuses settlement/replay",
      async () => {
        await assert.rejects(adapter.awaitReceipts(launch.process));
        assert.equal(
          fs.readFileSync(mapped(paths.entry), "utf8"),
          "original partial entry fixture",
        );
        assert.equal(fs.existsSync(mapped(paths.returned)), false);
      },
    );
    await t.test(
      "synchronous final fence re-reads mapped full bytes/identity and permanently revokes on change",
      () => {
        const fence = adapter.captureSynchronousFence([
          applied.profile,
          intent,
          launch.journal,
          launch.sourceClosure,
        ]);
        fence();
        fs.appendFileSync(mapped(paths.profile), "\nfixture tamper");
        assert.throws(fence);
        assert.throws(fence, /revoked/);
      },
    );
    await t.test(
      "actual Everyone-read file ACL is rejected, not treated as private",
      async () => {
        nativeFixture(config, control, {
          action: "public",
          path: paths.intent,
        });
        await assert.rejects(adapter.readOriginal(paths.intent));
      },
    );
    await t.test(
      "actual public receipt directory DACL is rejected",
      async () => {
        nativeFixture(config, control, {
          action: "public",
          path: paths.receiptDirectory,
        });
        await assert.rejects(adapter.preflight());
      },
    );
    await t.test(
      "own source-package byte tamper is rejected before fork imports",
      async () => {
        fs.appendFileSync(
          path.join(mapped(created.source), "README.md"),
          "\nfixture source tamper",
        );
        await assert.rejects(adapter.assertSource());
      },
    );
  },
);

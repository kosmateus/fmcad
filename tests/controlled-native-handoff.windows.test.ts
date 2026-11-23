import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createControlledFusionNativeHandoff,
  type ControlledNativeHandoffOptions,
} from "../packages/node-adapters/src/execution/controlled-native-handoff";
import { createControlledFusionLaunchAdapter } from "../packages/node-adapters/src/execution/controlled-fusion-launch";
import { bootstrapInstalledFilesDigest } from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import type { ControlledProcess } from "../packages/node-adapters/src/execution/controlled-fusion-launch-types";

const fixturePinsPath = process.env["FMCAD_CONTROLLED_WINDOWS_FIXTURE_PINS"];
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
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
function mapped(name: string) {
  return `/mnt/${name[0]!.toLowerCase()}/${name.slice(3).replaceAll("\\", "/")}`;
}
const setup = String.raw`
import ctypes,getpass,hashlib,json,os,shutil,sqlite3,subprocess,sys,tempfile
from ctypes import wintypes as w
from pathlib import Path
p=json.load(sys.stdin);root=Path(tempfile.mkdtemp(prefix="sol-native-handoff-"))
subprocess.run([str(Path(os.environ["SystemRoot"])/"System32"/"icacls.exe"),str(root),
 "/inheritance:r","/grant:r",getpass.getuser()+":(OI)(CI)F"],check=True,stdout=subprocess.PIPE)
helper=root/"qualified";shutil.copytree(p["sourceDirectory"],helper,copy_function=shutil.copyfile)
manifest=root/"manifest.json";manifest.write_bytes((Path(p["sourceDirectory"]).parent/"package-manifest.json").read_bytes())
discovery=root/"discovery";discovery.mkdir();other=root/"other-discovery";other.mkdir()
target=discovery/"Fork";shutil.copytree(helper,target,copy_function=shutil.copyfile)
(target/"README.md").write_bytes((target/"README.md").read_bytes()+b"\nlegacy owned fixture\n")
(target/"unknown-untracked.txt").write_bytes(b"PRESERVE ALL OWNED UNKNOWN BYTES")
private=root/"private";private.mkdir();receipts=private/"receipts";receipts.mkdir()
database=private/"admission.sqlite"
sys.path.insert(0,str(helper))
from lib.request_admission import AdmissionStore
from lib.rebaseline_fence import observe_process_birth
with AdmissionStore(database,instance="committed-next",epoch="next"):pass
old=subprocess.Popen([sys.executable,"-I","-S","-B","-c","import time;time.sleep(0.2)"],
 stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
birth=observe_process_birth(old.pid);old.wait()
provision=private/"provision.json"
value={"pid":old.pid,"birth":birth,"instance":"previous","epoch":"old",
 "source":"b"*40,"build":"c"*64,"database":str(database),
 "credentials":{"token":"owned-fixture-not-authority","marker":"żółć 日本語"},
 "preserveExtra":{"untouched":True}}
provision.write_bytes((json.dumps(value,indent=2)+"\n").encode("utf-8"))
profile=private/"profile.json";profile.write_text(json.dumps({"loadedScripts":[{
 "name":"owned","path":str(target/"AutodeskFusionMCP.py"),"location":1,
 "isRemoved":False,"isFavorite":False,"runOnStartup":False}]}),encoding="utf-8")
print(json.dumps({"root":str(root),"helper":str(helper),"manifest":str(manifest),
 "target":str(target),"discovery":str(discovery),"other":str(other),"private":str(private),
 "receipts":str(receipts),"database":str(database),"provision":str(provision),
 "profile":str(profile),"old":{"pid":old.pid,"birth":birth},
 "provisionSha256":hashlib.sha256(provision.read_bytes()).hexdigest(),"pythonVersion":sys.version}))
`;
const control = String.raw`
import ctypes,json,os,sqlite3,subprocess,sys
from ctypes import wintypes as w
from pathlib import Path
v=json.load(sys.stdin);action=v["action"]
if action in ("wrong-generation","missing-generation","admissions","db-change"):
 c=sqlite3.connect(v["database"])
 if action=="wrong-generation":c.execute("UPDATE generation SET epoch='wrong'")
 if action=="missing-generation":c.execute("DELETE FROM generation")
 if action=="admissions":c.execute("INSERT INTO admissions(request,binding,state) VALUES('foreign','{}','terminal')")
 if action=="db-change":c.execute("CREATE TABLE fixture_changed(value TEXT)");c.execute("INSERT INTO fixture_changed VALUES('changed')")
 c.commit();c.close()
elif action=="credentials":
 p=Path(v["provision"]);data=json.loads(p.read_bytes());data["credentials"]["token"]="changed";p.write_text(json.dumps(data),encoding="utf-8")
elif action in ("public","inherit-only"):
 rule="*S-1-1-0:" + ("(OI)(CI)(IO)R" if action=="inherit-only" else "R")
 subprocess.run([str(Path(os.environ["SystemRoot"])/"System32"/"icacls.exe"),
  v["path"],"/grant",rule],check=True,stdout=subprocess.PIPE)
elif action=="junction":
 target=Path(v["path"]);other=target.parent.parent/"old-alias-original"
 target.rename(other)
 subprocess.run([str(Path(os.environ["SystemRoot"])/"System32"/"cmd.exe"),
  "/d","/c","mklink","/J",str(target),str(other)],check=True,stdout=subprocess.PIPE)
elif action=="hardlink":
 root=Path(v["path"]);os.link(root/"README.md",root/"alias-hardlink")
elif action=="wait-file":
 import time
 deadline=time.monotonic()+15
 while not Path(v["path"]).exists():
  if time.monotonic()>=deadline:raise TimeoutError("Owned fixture marker absent")
  time.sleep(0.05)
elif action=="wait":
 k=ctypes.WinDLL("kernel32",use_last_error=True)
 k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
 k.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD];k.CloseHandle.argtypes=[w.HANDLE]
 h=k.OpenProcess(0x100000,False,v["pid"])
 if h:
  try:
   if k.WaitForSingleObject(h,15000)!=0:raise TimeoutError("Fixture process not exited; no force kill")
  finally:k.CloseHandle(h)
else:raise ValueError("Unknown owned fixture control")
print(json.dumps({"ownedFixtureOperation":action,"authority":"NONE"}))
`;
function native(config: FixturePins, program: string, input: unknown) {
  assert.equal(
    hash(fs.readFileSync(config.mappedNativePython)),
    config.nativePythonSha256,
  );
  const result = spawnSync(
    config.mappedNativePython,
    ["-I", "-S", "-B", "-c", program],
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
interface Owned {
  root: string;
  helper: string;
  manifest: string;
  target: string;
  discovery: string;
  other: string;
  private: string;
  receipts: string;
  database: string;
  provision: string;
  profile: string;
  old: ControlledProcess;
  provisionSha256: string;
  pythonVersion: string;
}

test(
  "actual Windows qualified-install/six-field-rebind fixtures; NO Fusion SDK/UI/deployment",
  {
    skip:
      !fixturePinsPath &&
      "NOTRUN: explicit SDK-free Windows fixture pins required",
  },
  async (t) => {
    assert.ok(fixturePinsPath);
    const config = JSON.parse(
      fs.readFileSync(fixturePinsPath, "utf8"),
    ) as FixturePins;
    const rawManifest = fs.readFileSync(config.mappedManifest);
    assert.equal(hash(rawManifest), config.manifestSha256);
    const files = JSON.parse(rawManifest.toString("utf8")) as Record<
      string,
      string
    >;
    const make = async (mode = "success") => {
      const own = native(config, setup, config) as unknown as Owned;
      t.diagnostic(
        `Owned ${mode}: ${own.root}; native ${own.pythonVersion}; source ${config.source}; rawmanifest ${config.manifestSha256}`,
      );
      const paths: ControlledNativeHandoffOptions["paths"] = {
        stage: `${own.private}\\staged-qualified`,
        backup: `${own.private}\\old-tree-backup`,
        installClosure: `${own.private}\\install-originals.json`,
        installReceipt: `${own.private}\\install-receipt.json`,
        provision: own.provision,
        provisionBackup: `${own.private}\\provision-before.json`,
        rebindReceipt: `${own.receipts}\\rebind-receipt.json`,
        database: own.database,
        launchJournal: `${own.private}\\launch-created.json`,
        launchAttempt: `${own.private}\\launch-attempt.json`,
      };
      const qualified = {
        directory: own.target,
        source: config.source,
        files,
        build: bootstrapInstalledFilesDigest(files),
      };
      let calls = 0;
      const heldLease = {
        async assertCurrent() {
          calls++;
          if (
            calls === 3 &&
            ["wrong-generation", "missing-generation"].includes(mode)
          )
            native(config, control, { action: mode, database: own.database });
          if (calls === 3 && mode === "admissions")
            native(config, control, { action: mode, database: own.database });
          if (calls === 5 && ["db-change", "credentials"].includes(mode))
            native(config, control, {
              action: mode,
              database: own.database,
              provision: own.provision,
            });
          if (calls === 5 && mode === "partial-receipt")
            native(config, control, {
              action: "inherit-only",
              path: own.receipts,
            });
          if (calls === 5 && mode === "foreign-receipt")
            fs.writeFileSync(
              mapped(paths.rebindReceipt),
              '{"kind":"foreign","affectedFields":["credentials"]}',
            );
          if (calls === 5 && mode === "source-tamper")
            fs.appendFileSync(
              path.join(mapped(own.target), "README.md"),
              "\nchanged target source",
            );
        },
        fence() {
          /* Actual tests own only this fixture; no production authority. */
        },
      };
      const mappings = Object.fromEntries(
        [...Object.values(paths), own.manifest, config.nativePython].map(
          (name) => [name, mapped(name)],
        ),
      );
      const options: ControlledNativeHandoffOptions = {
        nativePython: config.nativePython,
        mappedNativePython: config.mappedNativePython,
        nativePythonSha256: config.nativePythonSha256,
        helperDirectory: own.helper,
        mappedHelperDirectory: mapped(own.helper),
        mappedInstalledDirectory: mapped(own.target),
        manifest: {
          nativePath: own.manifest,
          mappedPath: mapped(own.manifest),
          sha256: config.manifestSha256,
        },
        qualified,
        allDiscoveryRoots: [own.discovery, own.other],
        old: mode === "wrong-old" ? { ...own.old, birth: "1" } : own.old,
        nextGeneration: { instance: "committed-next", epoch: "next" },
        expectedProvisionSha256: own.provisionSha256,
        executable: config.nativePython,
        executableSha256: config.nativePythonSha256,
        paths,
        mappedPaths: mappings,
        heldLease,
      };
      const factory = createControlledFusionNativeHandoff(options);
      const install = () =>
        factory.qualifyNativeInstallationAfterDeath({
          old: options.old,
          qualifiedPackagePins: qualified,
        });
      const stop = `${own.private}\\stop-child`,
        openDb = `${own.private}\\open-db`,
        readyDb = `${own.private}\\db-open`;
      const worker = [
        "import time,sqlite3",
        "from pathlib import Path",
        "connection=None",
        `deadline=time.monotonic()+180`,
        `while not Path(${JSON.stringify(stop)}).exists() and time.monotonic()<deadline:`,
        ` if connection is None and Path(${JSON.stringify(openDb)}).exists():`,
        `  connection=sqlite3.connect(${JSON.stringify(own.database)})`,
        `  connection.execute("INSERT INTO admissions(request,binding,state) VALUES('approved-after-rebind','{}','terminal')")`,
        "  connection.commit()",
        `  Path(${JSON.stringify(readyDb)}).write_text("RW connection held")`,
        " time.sleep(0.05)",
        "if connection is not None: connection.close()",
      ].join("\n");
      const launchPaths = {
        profile: own.profile,
        profileBackup: `${own.private}\\unused-profile-before.json`,
        intent: `${own.private}\\unused-intent.json`,
        receiptDirectory: own.receipts,
        entry: `${own.receipts}\\unused-entry.json`,
        returned: `${own.receipts}\\unused-return.json`,
        launchJournal: paths.launchJournal,
        launchAttempt: paths.launchAttempt,
        sourceClosure: `${own.private}\\launch-closure.json`,
        transcript: `${own.private}\\unused-transcript.json`,
        provision: own.provision,
      };
      const launcherOptions = {
        nativePython: config.nativePython,
        mappedNativePython: config.mappedNativePython,
        nativePythonSha256: config.nativePythonSha256,
        sourceDirectory: own.helper,
        mappedSourceDirectory: mapped(own.helper),
        installedDirectory: own.target,
        mappedInstalledDirectory: mapped(own.target),
        installedSource: config.source,
        installedBuild: qualified.build,
        installedFiles: files,
        executable: config.nativePython,
        mappedExecutable: config.mappedNativePython,
        executableSha256: config.nativePythonSha256,
        arguments: ["-I", "-S", "-B", "-c", worker],
        workingDirectory: own.private,
        paths: launchPaths,
        originalPaths: [],
        mappedOriginalPaths: Object.fromEntries(
          Object.values(launchPaths).map((name) => [name, mapped(name)]),
        ),
        receiptTimeoutMs: 100,
        normalCloseTimeoutMs: 100,
        mainWindowClass: "UnusedSdkFreeFixture",
      };
      const launcher = createControlledFusionLaunchAdapter(launcherOptions);
      const launch = async () => {
        const profile = await launcher.readProfileAfterDeath(own.old);
        const result = await launcher.launch(own.old, profile, "d".repeat(32));
        t.after(() => {
          fs.writeFileSync(mapped(stop), "normal own child exit");
          native(config, control, { action: "wait", pid: result.process.pid });
        });
        return result;
      };
      const launchBeforeInstall = async () => {
        const owner = createControlledFusionLaunchAdapter({
          ...launcherOptions,
          installedDirectory: own.helper,
          mappedInstalledDirectory: mapped(own.helper),
        });
        const profile = await owner.readProfileAfterDeath(own.old);
        const result = await owner.launch(own.old, profile, "e".repeat(32));
        t.after(() => {
          fs.writeFileSync(mapped(stop), "normal own child exit");
          native(config, control, { action: "wait", pid: result.process.pid });
        });
        return result;
      };
      return {
        own,
        paths,
        qualified,
        options,
        factory,
        install,
        launch,
        launchBeforeInstall,
        openDb,
        readyDb,
      };
    };
    await t.test(
      "an OS-live old tuple cannot authorize installation or move any target",
      async () => {
        const f = await make();
        const live = await f.launchBeforeInstall();
        const factory = createControlledFusionNativeHandoff({
          ...f.options,
          old: live.process,
        });
        await assert.rejects(
          factory.qualifyNativeInstallationAfterDeath({
            old: live.process,
            qualifiedPackagePins: f.qualified,
          }),
        );
        assert.equal(fs.existsSync(mapped(f.paths.backup)), false);
        assert.equal(fs.existsSync(mapped(f.paths.stage)), false);
      },
    );
    await t.test(
      "a dead but wrong old birth must still match the original private provision before install",
      async () => {
        const f = await make("wrong-old");
        await assert.rejects(f.install());
        assert.equal(fs.existsSync(mapped(f.paths.backup)), false);
        assert.equal(fs.existsSync(mapped(f.paths.stage)), false);
      },
    );
    await t.test(
      "full old tree including unknown files is backed up outside ALL discovery roots; new source is exact100",
      async () => {
        const f = await make();
        const receipt = await f.install();
        assert.equal(
          fs.readFileSync(
            path.join(mapped(f.paths.backup), "unknown-untracked.txt"),
            "utf8",
          ),
          "PRESERVE ALL OWNED UNKNOWN BYTES",
        );
        assert.equal(
          fs.existsSync(
            path.join(mapped(f.own.target), "unknown-untracked.txt"),
          ),
          false,
        );
        for (const [name, sha] of Object.entries(files))
          assert.equal(
            hash(
              fs.readFileSync(
                path.join(mapped(f.own.target), ...name.split("/")),
              ),
            ),
            sha,
          );
        const body = JSON.parse(
          Buffer.from(receipt.bytes).toString("utf8"),
        ) as { authority: string; backup: string };
        assert.equal(body.authority, "NONE");
        assert.equal(body.backup, f.paths.backup);
        await assert.rejects(f.install(), /replayed/);
      },
    );
    await t.test(
      "actual atomic rebind changes only six fields, preserves exact original backup/credentials/DB and allows later approved RW audit",
      async () => {
        const f = await make();
        await f.install();
        const launched = await f.launch();
        const before = fs.readFileSync(mapped(f.own.provision)),
          database = fs.readFileSync(mapped(f.own.database));
        const witness = await f.factory.rebindNative({
          old: f.own.old,
          launched,
          qualifiedPackagePins: f.qualified,
        });
        const after = JSON.parse(
          fs.readFileSync(mapped(f.own.provision), "utf8"),
        ) as Record<string, unknown>;
        const original = JSON.parse(before.toString("utf8")) as Record<
          string,
          unknown
        >;
        assert.deepEqual(after, {
          ...original,
          pid: launched.process.pid,
          birth: launched.process.birth,
          instance: "committed-next",
          epoch: "next",
          source: config.source,
          build: f.qualified.build,
        });
        assert.deepEqual(
          fs.readFileSync(mapped(f.paths.provisionBackup)),
          before,
        );
        assert.deepEqual(fs.readFileSync(mapped(f.own.database)), database);
        const receipt = JSON.parse(
          Buffer.from(witness.reference.bytes).toString("utf8"),
        ) as { affectedFields: string[] };
        assert.deepEqual(receipt.affectedFields, [
          "birth",
          "build",
          "epoch",
          "instance",
          "pid",
          "source",
        ]);
        await witness.assertCurrent();
        witness.fence();
        await assert.rejects(
          f.factory.assertOriginalRebindWitness({ ...witness }),
          /Original private/,
        );
        await assert.rejects(
          f.factory.rebindNative({
            old: f.own.old,
            launched,
            qualifiedPackagePins: f.qualified,
          }),
        );
        fs.writeFileSync(mapped(f.openDb), "open owned current RW store");
        native(config, control, { action: "wait-file", path: f.readyDb });
        assert.notDeepEqual(fs.readFileSync(mapped(f.own.database)), database);
        await witness.assertCurrent();
        witness.fence(); // live DB bytes deliberately NOT frozen
        fs.appendFileSync(
          mapped(f.paths.rebindReceipt),
          "tamper original receipt",
        );
        await assert.rejects(witness.assertCurrent());
        assert.throws(() => witness.fence(), /revoked/);
      },
    );
    for (const mode of [
      "wrong-generation",
      "missing-generation",
      "admissions",
      "db-change",
      "credentials",
      "source-tamper",
      "foreign-receipt",
    ]) {
      await t.test(
        `${mode} is denied without provision mutation, replay or fake receipt authority`,
        async () => {
          const f = await make(mode);
          await f.install();
          const launched = await f.launch();
          const before = fs.readFileSync(mapped(f.own.provision));
          await assert.rejects(
            f.factory.rebindNative({
              old: f.own.old,
              launched,
              qualifiedPackagePins: f.qualified,
            }),
          );
          if (mode !== "credentials")
            assert.deepEqual(fs.readFileSync(mapped(f.own.provision)), before);
          assert.equal(fs.existsSync(mapped(f.paths.provisionBackup)), false);
          await assert.rejects(
            f.factory.rebindNative({
              old: f.own.old,
              launched,
              qualifiedPackagePins: f.qualified,
            }),
          );
        },
      );
    }
    await t.test(
      "post-write receipt ACL failure preserves partial originals/new provision but issues no witness or retry",
      async () => {
        const f = await make("partial-receipt");
        await f.install();
        const launched = await f.launch();
        const before = fs.readFileSync(mapped(f.own.provision));
        await assert.rejects(
          f.factory.rebindNative({
            old: f.own.old,
            launched,
            qualifiedPackagePins: f.qualified,
          }),
        );
        assert.deepEqual(
          fs.readFileSync(mapped(f.paths.provisionBackup)),
          before,
        );
        const after = JSON.parse(
          fs.readFileSync(mapped(f.own.provision), "utf8"),
        ) as { pid: number };
        assert.equal(after.pid, launched.process.pid);
        assert.equal(fs.existsSync(mapped(f.paths.rebindReceipt)), true);
        await assert.rejects(
          f.factory.rebindNative({
            old: f.own.old,
            launched,
            qualifiedPackagePins: f.qualified,
          }),
        );
      },
    );
    for (const mode of ["public", "hardlink", "junction"]) {
      await t.test(
        `old-tree ${mode} is rejected before moving the target or staging replacement`,
        async () => {
          const f = await make();
          native(config, control, {
            action: mode,
            path:
              mode === "public" ? `${f.own.target}\\README.md` : f.own.target,
          });
          await assert.rejects(f.install());
          assert.equal(fs.existsSync(mapped(f.paths.backup)), false);
          assert.equal(fs.existsSync(mapped(f.paths.stage)), false);
        },
      );
    }
    await t.test(
      "wrong old/new tuple cannot redirect the original controlled process rebind",
      async () => {
        const f = await make();
        await f.install();
        const launched = await f.launch();
        await assert.rejects(
          f.factory.rebindNative({
            old: f.own.old,
            launched: { ...launched, process: f.own.old },
            qualifiedPackagePins: f.qualified,
          }),
        );
        assert.equal(
          hash(fs.readFileSync(mapped(f.own.provision))),
          f.own.provisionSha256,
        );
        assert.equal(fs.existsSync(mapped(f.paths.provisionBackup)), false);
      },
    );
    for (const [name, sha] of Object.entries(files))
      assert.equal(
        hash(
          fs.readFileSync(
            path.join(config.mappedSourceDirectory, ...name.split("/")),
          ),
        ),
        sha,
      );
  },
);

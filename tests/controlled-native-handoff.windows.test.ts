import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createControlledFusionNativeHandoff,
  type ControlledNativeHandoffOptions,
  createOwnedNativeReboundObserver,
  type OwnedNativeReboundOptions,
} from "../packages/node-adapters/src/execution/controlled-native-handoff";
import { createControlledFusionLaunchAdapter } from "../packages/node-adapters/src/execution/controlled-fusion-launch";
import { bootstrapInstalledFilesDigest } from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import {
  controlledNativeHandoffProgram,
  ownedNativeReboundProgram,
} from "../packages/node-adapters/src/execution/controlled-native-handoff-program";
import { normalObserverNativeBootstrap } from "../packages/node-adapters/src/execution/controlled-fusion-launch-native";
import type {
  ControlledProcess,
  ControlledFile,
  OwnedAutoloadLaunch,
} from "../packages/node-adapters/src/execution/controlled-fusion-launch-types";

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
  sourceManifest: string;
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
manifest=root/"manifest.json";manifest.write_bytes(Path(p["sourceManifest"]).read_bytes())
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
const ownedLifecycleFixture = String.raw`
import json,sys
from pathlib import Path
r=json.load(sys.stdin);sys.path.insert(0,r["helper"])
from lib.request_admission import AdmissionStore
provision=Path(r["provision"]);value=json.loads(provision.read_bytes());value.pop("preserveExtra")
provision.write_bytes((json.dumps(value)+"\n").encode())
old={"instance":"previous","epoch":"old"};next={"instance":"committed-next","epoch":"next"}
with AdmissionStore(Path(r["database"]),**old) as store:
 store._turn_schema()
 store._db.execute("CREATE TABLE IF NOT EXISTS physical_owners(generation TEXT PRIMARY KEY,binding TEXT NOT NULL)")
 store.register_physical_runtime({"generation":old,"physicalRuntime":{**r["old"],"version":"owned-fixture",
   "source":value["source"],"build":value["build"]},"endpointURL":"http://127.0.0.1:8765/mcp"})
 result=store.advance_generation(**next,handoff_id="owned-original-handoff")
request={"handoffId":"owned-original-handoff","generation":old,"nextGeneration":next}
base=Path(r["private"]);(base/"handoff.json").write_text(json.dumps(request),encoding="utf-8")
(base/"completed.json").write_text(json.dumps({**result,"state":"completed"}),encoding="utf-8")
print(json.dumps({"done":True}))
`;
const ownedChildFixture = String.raw`
import hashlib,json,os,sys,time
from pathlib import Path
intent_path=Path(os.environ["FUSION_MCP_BOOTSTRAP_INTENT"])
intent=json.loads(intent_path.read_bytes())
provision=json.loads(Path(os.environ["FUSION_MCP_ADMISSION_PROVISION"]).read_bytes())
assert intent["process"]["pid"]==os.getpid()==provision["pid"]
sys.path.insert(0,sys.argv[3])
from lib.request_admission import AdmissionStore
with AdmissionStore(Path(provision["database"]),instance=provision["instance"],epoch=provision["epoch"]) as store:
 store.register_physical_runtime({"generation":intent["generation"],"physicalRuntime":{
  "pid":os.getpid(),"birth":provision["birth"],"version":"owned-fixture","source":provision["source"],"build":provision["build"]},
  "endpointURL":"http://127.0.0.1:8765/mcp"})
base={key:intent[key]for key in ("version","mode","nonce","process","purpose","engineVersion","executable","profile","provision","generation")}
base.update({"kind":"fmcad-bootstrap-entry-receipt","intent":{"path":str(intent_path),"sha256":hashlib.sha256(intent_path.read_bytes()).hexdigest()},
 "installed":{"directory":intent["installed"]["directory"],"source":intent["installed"]["source"],"filesDigest":sys.argv[4]}})
entry=Path(intent["receipts"]["directory"])/intent["receipts"]["entry"]
returned=Path(intent["receipts"]["directory"])/intent["receipts"]["returned"]
# Fixture receipt bytes test native identity/binding, NOT a real SDK audit.
entry.write_text(json.dumps({**base,"phase":"entry-audited-before-addon-import","startupAudit":{"fixture":"NO_SDK_DATA_ONLY"}}),encoding="utf-8")
returned.write_text(json.dumps({**base,"phase":"run-returned","entry":{"path":str(entry),"sha256":hashlib.sha256(entry.read_bytes()).hexdigest()}}),encoding="utf-8")
Path(sys.argv[1]).write_text(json.dumps({"pid":os.getpid(),"sdkModules":[m for m in sys.modules if m=="adsk"or m.startswith("adsk.")]}))
deadline=time.monotonic()+90
while not Path(sys.argv[2]).exists() and time.monotonic()<deadline:time.sleep(.025)
`;
const ownedStartFixture =
  controlledNativeHandoffProgram.split(
    '\ntry:\n    exe,unused=read(p["nativePython"]',
  )[0] +
  String.raw`
sys.path.insert(0,p["helperDirectory"])
from lib.physical_authority import _check_windows_acl as check_acl
from lib.request_admission import _encode
helper=tree(p["helperDirectory"]);source={"helper":helper,"installed":tree(q["directory"])}
paths=v["paths"];nonce="a"*32
old_raw=read(p["paths"]["provision"])[0];old_provision=decode(old_raw)
db=open_handle(p["paths"]["database"],read=False,share=7);database={"nativePath":p["paths"]["database"],"identity":ident(db)};k.CloseHandle(db)
profile=decode(read(paths["profile"])[0]);profile_backup=publish(paths["profileBackup"],read(paths["profile"])[0])
for row in profile["loadedScripts"]:row["runOnStartup"]=True
with open(paths["profile"],"wb")as f:f.write(_encode(profile).encode());f.flush();os.fsync(f.fileno())
profile=snap(paths["profile"])
closure=publish_json(paths["sourceClosure"],source)
attempt=publish_json(p["paths"]["launchAttempt"],{"kind":"owned-autoload-launch-attempt-v1","isolation":"NOT_PROVEN",
 "nonce":nonce,"old":p["old"],"executable":p["executable"],"executableSha256":p["executableSha256"],
 "profile":profile,"sourceClosure":ref(closure)})
class Startup(ctypes.Structure):
 _fields_=[("cb",w.DWORD),("reserved",w.LPWSTR),("desktop",w.LPWSTR),("title",w.LPWSTR),
 ("x",w.DWORD),("y",w.DWORD),("xSize",w.DWORD),("ySize",w.DWORD),("xChars",w.DWORD),("yChars",w.DWORD),
 ("fill",w.DWORD),("flags",w.DWORD),("show",w.WORD),("reservedSize",w.WORD),("reserved2",ctypes.c_void_p),
 ("stdin",w.HANDLE),("stdout",w.HANDLE),("stderr",w.HANDLE)]
class Created(ctypes.Structure):
 _fields_=[("process",w.HANDLE),("thread",w.HANDLE),("pid",w.DWORD),("tid",w.DWORD)]
import subprocess
command=ctypes.create_unicode_buffer(subprocess.list2cmdline([p["executable"],"-I","-S","-B","-c",v["child"],paths["ready"],paths["stop"],p["helperDirectory"],q["build"]]))
env=dict(os.environ,PYTHONDONTWRITEBYTECODE="1",FUSION_MCP_BOOTSTRAP_INTENT=paths["intent"],FUSION_MCP_ADMISSION_PROVISION=p["paths"]["provision"])
block=ctypes.create_unicode_buffer("\0".join(key+"="+value for key,value in sorted(env.items(),key=lambda x:x[0].upper()))+"\0\0")
k.CreateProcessW.argtypes=[w.LPCWSTR,w.LPWSTR,ctypes.c_void_p,ctypes.c_void_p,w.BOOL,w.DWORD,ctypes.c_void_p,w.LPCWSTR,ctypes.POINTER(Startup),ctypes.POINTER(Created)]
k.ResumeThread.argtypes=[w.HANDLE];k.ResumeThread.restype=w.DWORD
startup=Startup();startup.cb=ctypes.sizeof(startup);startup.flags=0x100;created=Created()
assert k.CreateProcessW(p["executable"],command,None,None,False,0x4|0x400,block,str(Path(paths["ready"]).parent),ctypes.byref(startup),ctypes.byref(created))
try:
 times=[w.FILETIME()for _ in range(4)];assert k.GetProcessTimes(created.process,*(ctypes.byref(t)for t in times))
 process={"pid":created.pid,"birth":str((times[0].dwHighDateTime<<32)|times[0].dwLowDateTime)}
 journal=publish_json(p["paths"]["launchJournal"],{"kind":"owned-autoload-created-process-v1","nonce":nonce,"process":process,
  "executable":p["executable"],"executableSha256":p["executableSha256"],"attempt":ref(attempt),
  "threadId":created.tid,"phase":"created-suspended","isolation":"NOT_PROVEN"})
 cold=publish_json(paths["coldProcess"],{**process,"exe":p["executable"],"executableSha256":p["executableSha256"],
  "nonce":nonce,"phase":"created-suspended","isolation":"NOT_PROVEN"})
 backup=publish(p["paths"]["provisionBackup"],old_raw)
 updated={**old_provision,**process,**p["nextGeneration"]}
 with open(p["paths"]["provision"],"wb")as f:f.write(_encode(updated).encode());f.flush();os.fsync(f.fileno())
 provision=snap(p["paths"]["provision"])
 request=snap(paths["handoffRequest"]);completion=snap(paths["handoffReceipt"])
 receipt=publish_json(paths["provisionReceipt"],{"kind":"owned-autoload-provision-bound-v1","isolation":"NOT_PROVEN",
  "nonce":nonce,"old":p["old"],"process":process,"handoffId":"owned-original-handoff","generation":p["nextGeneration"],
  "database":database,"beforeSha256":p["expectedProvisionSha256"],"backup":ref(backup),"after":ref(provision),
  "handoffRequest":{"nativePath":request["nativePath"],"sha256":request["sha256"]},
  "handoffReceipt":{"nativePath":completion["nativePath"],"sha256":completion["sha256"]}})
 intent=publish_json(paths["intent"],{"kind":"fmcad-bootstrap-entry-intent","version":3,"mode":"owned-autoload-v1",
  "nonce":nonce,"process":process,"purpose":"isolated-stdout-v1","engineVersion":2,
  "executable":{"path":p["executable"],"sha256":p["executableSha256"]},
  "installed":{"directory":q["directory"],"source":q["source"],"files":q["files"]},
  "profile":{"path":profile["nativePath"],"sha256":profile["sha256"]},
  "provision":{"path":provision["nativePath"],"sha256":provision["sha256"]},"generation":p["nextGeneration"],
  "receipts":{"directory":paths["receiptDirectory"],"entry":"owned-entry.json","returned":"owned-returned.json"}})
 assert k.ResumeThread(created.thread)==1
 import time
 deadline=time.monotonic()+20
 while not Path(paths["ready"]).exists():
  if time.monotonic()>deadline:raise TimeoutError("Benign owned child did not publish receipts")
  time.sleep(.025)
 result={"process":process,"startupProven":False,"journal":journal,"attempt":attempt,"coldProcess":cold,
  "sourceClosure":closure,"profile":profile,"profileBackup":profile_backup,"provision":provision,"provisionBackup":backup,
  "provisionReceipt":receipt,"intent":intent}
 print(_encode({"launch":result,"entry":snap(str(Path(paths["receiptDirectory"])/"owned-entry.json")),
  "returned":snap(str(Path(paths["receiptDirectory"])/"owned-returned.json")),"database":database,
  "handoffRequest":ref(request),"handoffReceipt":ref(completion)}))
finally:k.CloseHandle(created.thread);k.CloseHandle(created.process)
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

function framedNative(config: FixturePins, program: string, input: unknown) {
  const body = Buffer.from(program, "utf8");
  const result = spawnSync(
    config.mappedNativePython,
    ["-I", "-S", "-B", "-c", normalObserverNativeBootstrap],
    {
      input: Buffer.concat([
        Buffer.from(`${body.length}\n`),
        body,
        Buffer.from(JSON.stringify(input)),
      ]),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test(
  "owned readonly original rebound Windows fixtures (NO Fusion/SDK, no observer DB/provision writes)",
  {
    skip:
      !fixturePinsPath &&
      "NOTRUN: explicit qualified SDK-free Windows fixture pins required",
  },
  async (t) => {
    assert.ok(fixturePinsPath);
    const config = JSON.parse(
      fs.readFileSync(fixturePinsPath, "utf8"),
    ) as FixturePins;
    const manifest = fs.readFileSync(config.mappedManifest);
    assert.equal(hash(manifest), config.manifestSha256);
    const files = JSON.parse(manifest.toString("utf8")) as Record<
      string,
      string
    >;
    const build = bootstrapInstalledFilesDigest(files);
    const asFile = (value: unknown): ControlledFile => {
      const f = value as {
        nativePath: string;
        sha256: string;
        identity: string;
        base64: string;
      };
      const bytes = Buffer.from(f.base64, "base64");
      assert.equal(hash(bytes), f.sha256);
      return {
        nativePath: f.nativePath,
        sha256: f.sha256,
        identity: f.identity,
        bytes,
      };
    };
    async function make() {
      const ownedSetup = setup.replace(
        'with AdmissionStore(database,instance="committed-next",epoch="next"):pass',
        'with AdmissionStore(database,instance="previous",epoch="old"):pass',
      );
      assert.notEqual(ownedSetup, setup);
      const f = native(config, ownedSetup, config) as unknown as Owned;
      native(config, ownedLifecycleFixture, f);
      f.provisionSha256 = hash(fs.readFileSync(mapped(f.provision)));
      const paths: ControlledNativeHandoffOptions["paths"] = {
        stage: `${f.private}\\staged-qualified`,
        backup: `${f.private}\\backup`,
        installReceipt: `${f.private}\\installation.json`,
        installClosure: `${f.private}\\installation-originals.json`,
        provision: f.provision,
        provisionBackup: `${f.private}\\provision-before.json`,
        rebindReceipt: `${f.private}\\UNUSED-rebind.json`,
        database: f.database,
        launchJournal: `${f.private}\\created.json`,
        launchAttempt: `${f.private}\\attempt.json`,
      };
      const extra = {
        profile: f.profile,
        profileBackup: `${f.private}\\profile-before.json`,
        intent: `${f.private}\\intent.json`,
        coldProcess: `${f.private}\\cold.json`,
        sourceClosure: `${f.private}\\source.json`,
        provisionReceipt: `${f.private}\\provision-bound.json`,
        handoffRequest: `${f.private}\\handoff.json`,
        handoffReceipt: `${f.private}\\completed.json`,
        ready: `${f.private}\\ready.json`,
        stop: `${f.private}\\stop`,
        receiptDirectory: f.receipts,
        entry: `${f.receipts}\\owned-entry.json`,
        returned: `${f.receipts}\\owned-returned.json`,
        audit: `${f.private}\\owned-observation.json`,
      };
      const base: ControlledNativeHandoffOptions = {
        nativePython: config.nativePython,
        mappedNativePython: config.mappedNativePython,
        nativePythonSha256: config.nativePythonSha256,
        helperDirectory: f.helper,
        mappedHelperDirectory: mapped(f.helper),
        mappedInstalledDirectory: mapped(f.target),
        manifest: {
          nativePath: f.manifest,
          mappedPath: mapped(f.manifest),
          sha256: config.manifestSha256,
        },
        qualified: { directory: f.target, source: config.source, build, files },
        allDiscoveryRoots: [f.discovery, f.other],
        old: f.old,
        nextGeneration: { instance: "committed-next", epoch: "next" },
        expectedProvisionSha256: f.provisionSha256,
        executable: config.nativePython,
        executableSha256: config.nativePythonSha256,
        paths,
        mappedPaths: Object.fromEntries(
          [
            ...Object.values(paths),
            ...Object.values(extra),
            f.manifest,
            config.nativePython,
          ].map((name) => [name, mapped(name)]),
        ),
        heldLease: { async assertCurrent() {}, fence() {} },
      };
      const installed = await createControlledFusionNativeHandoff(
        base,
      ).qualifyNativeInstallationAfterDeath({
        old: f.old,
        qualifiedPackagePins: base.qualified,
      });
      const result = framedNative(config, ownedStartFixture, {
        pins: base,
        action: "fixture-start",
        input: { paths: extra, child: ownedChildFixture },
      });
      const raw = result["launch"] as Record<string, unknown>;
      const launch = {
        process: raw["process"] as ControlledProcess,
        startupProven: false,
        ...Object.fromEntries(
          [
            "journal",
            "attempt",
            "coldProcess",
            "sourceClosure",
            "profile",
            "profileBackup",
            "provision",
            "provisionBackup",
            "provisionReceipt",
            "intent",
          ].map((name) => [name, asFile(raw[name])]),
        ),
      } as OwnedAutoloadLaunch;
      t.after(() => {
        fs.writeFileSync(mapped(extra.stop), "normal own fixture self-exit");
        native(config, control, { action: "wait", pid: launch.process.pid });
      });
      const originalFile = (name: string) =>
        asFile(
          framedNative(
            config,
            controlledNativeHandoffProgram.split(
              '\ntry:\n    exe,unused=read(p["nativePython"]',
            )[0] +
              String.raw`
sys.path.insert(0,p["helperDirectory"])
from lib.physical_authority import _check_windows_acl as check_acl
from lib.request_admission import _encode
print(_encode(snap(v["path"])))
`,
            { pins: base, action: "fixture-read", input: { path: name } },
          ),
        );
      const request = originalFile(extra.handoffRequest),
        completion = originalFile(extra.handoffReceipt);
      const { allDiscoveryRoots, ...observedBase } = base;
      const options: OwnedNativeReboundOptions = {
        ...observedBase,
        scopeKind: "controlled-native-runtime-v1",
        observedDiscoveryRoots: allDiscoveryRoots,
        owned: {
          database: result["database"] as {
            nativePath: string;
            identity: string;
          },
          handoffRequest: request,
          handoffReceipt: completion,
          installReceipt: installed,
          installClosure: originalFile(paths.installClosure),
          entry: asFile(result["entry"]),
          returned: asFile(result["returned"]),
          auditPath: extra.audit,
        },
      };
      const input = {
        old: f.old,
        launch,
        qualifiedPackagePins: base.qualified,
      };
      t.diagnostic(
        `Owned rebound fixture ${f.root}; native${config.source}/${build}; logical sourceb40/buildc64`,
      );
      return { f, options, input, extra, launch };
    }
    const fileState = (names: string[]) =>
      Object.fromEntries(
        names.map((name) => {
          const p = mapped(name),
            s = fs.statSync(p, { bigint: true });
          return [
            name,
            {
              sha256: hash(fs.readFileSync(p)),
              stamp: [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":"),
            },
          ];
        }),
      );
    await t.test(
      "separate readonly program denies mutating roles before helper import",
      () => {
        for (const action of [
          "install",
          "prepare-rebind",
          "commit-rebind",
          "assert-current",
        ]) {
          const body = Buffer.from(ownedNativeReboundProgram(), "utf8");
          const result = spawnSync(
            config.mappedNativePython,
            ["-I", "-S", "-B", "-c", normalObserverNativeBootstrap],
            {
              input: Buffer.concat([
                Buffer.from(`${body.length}\n`),
                body,
                Buffer.from(
                  JSON.stringify({
                    pins: {
                      qualified: {
                        directory: "C:\\fixture",
                        source: config.source,
                        build,
                        files,
                      },
                    },
                    action,
                    input: {},
                  }) + "\n",
                ),
              ]),
              encoding: "utf8",
            },
          );
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /Readonly owned role refuses/);
        }
      },
    );
    await t.test(
      "different logical/native source succeeds; original reads are no-write and witness rechecks without TTL",
      async () => {
        const { f, options, input, extra } = await make();
        const observedFiles = [
          f.database,
          f.provision,
          options.owned.entry.nativePath,
          options.owned.returned.nativePath,
          input.launch.intent.nativePath,
          input.launch.journal.nativePath,
        ];
        const before = fileState(observedFiles),
          listing = fs.readdirSync(mapped(f.private)).sort();
        let live = true;
        Object.assign(options.heldLease, {
          fence() {
            if (!live) throw new Error("ORIGINAL_HELD_WINDOW_LOST");
          },
        });
        const port = createOwnedNativeReboundObserver(options);
        const witness = await port.observeNativeRebound(input);
        await witness.assertCurrent();
        witness.fence();
        assert.deepEqual(fileState(observedFiles), before);
        assert.deepEqual(
          fs
            .readdirSync(mapped(f.private))
            .filter((name) => name !== "owned-observation.json")
            .sort(),
          listing,
        );
        const data = JSON.parse(
          Buffer.from(witness.reference.bytes).toString("utf8"),
        );
        assert.equal(
          data.database.binding.physicalRuntime.source,
          "b".repeat(40),
        );
        assert.equal(
          data.database.binding.physicalRuntime.build,
          "c".repeat(64),
        );
        assert.notEqual(
          data.database.binding.physicalRuntime.source,
          options.qualified.source,
        );
        assert.notEqual(
          data.database.binding.physicalRuntime.build,
          options.qualified.build,
        );
        assert.equal(data.authority, "NONE");
        assert.deepEqual(witness.process, input.launch.process);
        await assert.rejects(
          port.assertOriginalOwnedReboundWitness({ ...witness }),
          /Original private owned/,
        );
        native(
          config,
          String.raw`
import json,sqlite3,sys
r=json.load(sys.stdin)
with sqlite3.connect(r["database"])as c:c.execute("CREATE TABLE legitimate_fixture_write(value TEXT)")
print(json.dumps({"done":True}))
`,
          { database: f.database },
        );
        await witness.assertCurrent();
        witness.fence();
        const written = fileState([f.database, f.provision]);
        await witness.assertCurrent();
        assert.deepEqual(fileState([f.database, f.provision]), written);
        assert.equal(fs.existsSync(mapped(options.paths.rebindReceipt)), false);
        assert.equal(fs.existsSync(mapped(extra.ready)), true);
        assert.deepEqual(
          JSON.parse(fs.readFileSync(mapped(extra.ready), "utf8")).sdkModules,
          [],
        );
        await assert.rejects(port.observeNativeRebound(input), /no retry/);
        live = false;
        Object.assign(options.heldLease, { fence() {} });
        assert.throws(() => witness.fence(), /ORIGINAL_HELD_WINDOW_LOST/);
        await assert.rejects(witness.assertCurrent(), /Original private owned/);
      },
    );
    await t.test(
      "wrong current tuple/generation/logical source/provision/sourcefile/receipt identity refuse before audit",
      async () => {
        for (const failure of [
          "tuple",
          "generation",
          "logical-source",
          "logical-build",
          "database-identity",
          "provision",
          "source",
          "receipt-identity",
        ]) {
          const { f, options, input } = await make();
          if (failure === "tuple")
            Object.assign(input.launch.process, { birth: "1" });
          if (failure === "generation")
            native(config, control, {
              action: "wrong-generation",
              database: f.database,
            });
          if (failure === "logical-source" || failure === "logical-build")
            native(
              config,
              String.raw`
import json,sqlite3,sys
r=json.load(sys.stdin)
with sqlite3.connect(r["database"])as c:
 b=json.loads(c.execute("SELECT binding FROM physical_runtime_binding WHERE singleton=1").fetchone()[0])
 b["physicalRuntime"][r["field"]]="WRONG-LOGICAL-VALUE"
 c.execute("UPDATE physical_runtime_binding SET binding=? WHERE singleton=1",(json.dumps(b),))
print(json.dumps({"done":True}))
`,
              {
                database: f.database,
                field: failure === "logical-source" ? "source" : "build",
              },
            );
          if (failure === "database-identity") {
            const name = mapped(f.database);
            fs.writeFileSync(name + ".replacement", fs.readFileSync(name));
            fs.renameSync(name + ".replacement", name);
          }
          if (failure === "provision")
            fs.appendFileSync(mapped(f.provision), " ");
          if (failure === "source")
            fs.appendFileSync(
              path.join(mapped(f.target), "README.md"),
              "changed source",
            );
          if (failure === "receipt-identity") {
            const name = mapped(options.owned.entry.nativePath);
            fs.writeFileSync(name + ".replacement", fs.readFileSync(name));
            fs.renameSync(name + ".replacement", name);
          }
          const before = fileState([f.database, f.provision]);
          const port = createOwnedNativeReboundObserver(options);
          await assert.rejects(port.observeNativeRebound(input));
          assert.deepEqual(fileState([f.database, f.provision]), before);
          assert.equal(fs.existsSync(mapped(options.owned.auditPath)), false);
          await assert.rejects(port.observeNativeRebound(input), /no retry/);
        }
      },
    );
    await t.test(
      "held original loss at native continuation produces no audit and never retries",
      async () => {
        const { f, options, input } = await make();
        let fences = 0;
        Object.assign(options.heldLease, {
          fence() {
            if (++fences >= 3) throw new Error("REAL_FIXTURE_LEASE_REVOKED");
          },
        });
        const port = createOwnedNativeReboundObserver(options),
          before = fileState([f.database, f.provision]);
        await assert.rejects(port.observeNativeRebound(input));
        assert.deepEqual(fileState([f.database, f.provision]), before);
        assert.equal(fs.existsSync(mapped(options.owned.auditPath)), false);
        await assert.rejects(port.observeNativeRebound(input), /no retry/);
      },
    );
    await t.test(
      "current witness is permanently revoked by native generation drift even if bytes are later restored",
      async () => {
        const { f, options, input } = await make();
        const witness =
          await createOwnedNativeReboundObserver(options).observeNativeRebound(
            input,
          );
        native(config, control, {
          action: "wrong-generation",
          database: f.database,
        });
        await assert.rejects(witness.assertCurrent());
        assert.throws(() => witness.fence(), /revoked/);
        native(
          config,
          String.raw`
import json,sqlite3,sys
r=json.load(sys.stdin)
with sqlite3.connect(r["database"])as c:c.execute("UPDATE generation SET epoch='next'")
print(json.dumps({"done":True}))
`,
          { database: f.database },
        );
        await assert.rejects(witness.assertCurrent(), /Original private owned/);
        assert.throws(() => witness.fence(), /revoked/);
      },
    );
  },
);

test(
  "Windows superscript devices refuse before helper import or filesystem effects",
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
    const raw = fs.readFileSync(config.mappedManifest);
    assert.equal(hash(raw), config.manifestSha256);
    const original = JSON.parse(raw.toString("utf8")) as Record<string, string>;
    assert.equal(
      hash(fs.readFileSync(config.mappedNativePython)),
      config.nativePythonSha256,
    );
    for (const device of ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"]) {
      await t.test(device, () => {
        for (const name of [
          `lib/${device}`,
          `lib/${device}.py`,
          `lib/${device}/entry.py`,
        ]) {
          const files = { ...original, [name]: "a".repeat(64) };
          const qualified = {
            directory: "C:\\unused-owned-fixture",
            source: config.source,
            files,
            build: bootstrapInstalledFilesDigest(files),
          };
          const result = spawnSync(
            config.mappedNativePython,
            ["-I", "-S", "-B", "-c", controlledNativeHandoffProgram],
            {
              cwd: config.mappedSourceDirectory,
              input: JSON.stringify({
                pins: { qualified },
                action: "install",
                input: {},
              }),
              encoding: "utf8",
            },
          );
          assert.notEqual(result.status, 0, name);
          assert.match(
            result.stderr,
            /Unsafe qualified Windows name\/hash/,
            name,
          );
          assert.doesNotMatch(result.stderr, /KeyError|WinDLL|adsk/, name);
          assert.equal(result.stdout, "");
        }
      });
    }
  },
);

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
    assert.equal(config.source, "8818d2c8dcbcc9988992da561f276ea9b6a0e241");
    assert.equal(Object.keys(files).length, 104);
    assert.equal(
      bootstrapInstalledFilesDigest(files),
      "38d188040c6ffc0b55fe9aeb5cc10521512ce85a13823b8ab96420976c8bae88",
    );
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
    for (const mode of [
      "missing",
      "extra",
      "renamed",
      "changed",
      "case-changed",
    ]) {
      await t.test(
        `qualified helper ${mode} refuses before staging or moving owned installation`,
        async () => {
          const f = await make();
          const root = mapped(f.own.helper);
          const original = path.join(root, "README.md");
          if (mode === "missing") fs.unlinkSync(original);
          if (mode === "extra")
            fs.writeFileSync(
              path.join(root, "unqualified-extra.txt"),
              "not pinned",
            );
          if (mode === "renamed")
            fs.renameSync(original, path.join(root, "renamed-readme.md"));
          if (mode === "changed")
            fs.appendFileSync(original, "\nchanged qualified input");
          if (mode === "case-changed") {
            fs.renameSync(original, path.join(root, "case-intermediate.txt"));
            fs.renameSync(
              path.join(root, "case-intermediate.txt"),
              path.join(root, "readme.md"),
            );
          }
          await assert.rejects(f.install());
          assert.equal(fs.existsSync(mapped(f.paths.backup)), false);
          assert.equal(fs.existsSync(mapped(f.paths.stage)), false);
        },
      );
    }
    await t.test(
      "full old tree including unknown files is backed up outside ALL discovery roots; new source matches every qualified file",
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

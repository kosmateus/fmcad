import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createNormalObserverLaunchAdapter,
  ControlledFusionNativeError,
  type NormalObserverLaunchPins,
} from "../packages/node-adapters/src/execution/controlled-fusion-launch";

const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const configPath = process.env["FMCAD_NORMAL_OBSERVER_WINDOWS_FIXTURE_PINS"];
const protocolBuild =
  "ed336029c8960f4809b5bef7651db354db6cfdcc759dc6acba8e45e2bd967e35";
interface Config {
  nativePython: string;
  mappedNativePython: string;
  nativePythonSha256: string;
  sourceDirectory: string;
  mappedSourceDirectory: string;
  source: string;
  installedFiles: Record<string, string>;
}
function mapped(name: string) {
  assert.match(name, /^[A-Za-z]:\\/);
  return `/mnt/${name[0]!.toLowerCase()}/${name.slice(3).replaceAll("\\", "/")}`;
}
function native(config: Config, code: string, input: unknown) {
  assert.equal(
    sha(fs.readFileSync(config.mappedNativePython)),
    config.nativePythonSha256,
  );
  const result = spawnSync(
    config.mappedNativePython,
    ["-I", "-S", "-B", "-c", code],
    {
      cwd: config.mappedSourceDirectory,
      input: JSON.stringify(input),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
const setup = String.raw`
import ctypes,hashlib,json,os,shutil,subprocess,sys,tempfile,time
from ctypes import wintypes as w
from pathlib import Path
p=json.load(sys.stdin)
root=Path(tempfile.mkdtemp(prefix="sol-normal-observer-fixture-"))
helper=root/"helper";shutil.copytree(p["sourceDirectory"],helper,copy_function=shutil.copyfile)
installed=root/"installed";shutil.copytree(helper,installed,copy_function=shutil.copyfile)
cache=installed/"__pycache__";cache.mkdir()
(cache/"fixture.pyc").write_bytes(b"pinned existing fixture bytecode, never imported")
private=root/"private";private.mkdir(mode=0o700)
receipts=private/"receipts";receipts.mkdir(mode=0o700)
sys.path.insert(0,str(helper))
from lib.physical_authority import _check_windows_acl
from lib.rebaseline_fence import observe_process_birth
from lib.request_admission import AdmissionStore
ready=private/"old-window-ready"
child=subprocess.Popen([sys.executable,"-I","-S","-B","-c",
                       p.get("windowProgram","import time;time.sleep(0.25)"),str(ready)],
                       stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
birth=observe_process_birth(child.pid)
if p.get("windowProgram"):
    deadline=time.monotonic()+10
    while not ready.exists():
        if time.monotonic()>deadline:raise TimeoutError("Owned benign window did not start")
        time.sleep(0.025)
else:
    child.wait()
old={"pid":child.pid,"birth":birth}
old_generation={"instance":"fixture-old-instance","epoch":"fixture-old-epoch"}
next_generation={"instance":"fixture-new-instance","epoch":"fixture-new-epoch"}
request={"handoffId":"fixture-original-handoff","generation":old_generation,"nextGeneration":next_generation}
database=private/"admission.sqlite3"
with AdmissionStore(database,instance=old_generation["instance"],epoch=old_generation["epoch"]) as store:
    store._turn_schema()
    store._db.execute("CREATE TABLE physical_owners(generation TEXT PRIMARY KEY,binding TEXT NOT NULL)")
    store.register_physical_runtime({"generation":old_generation,
        "physicalRuntime":{**old,"version":"benign-fixture-version","source":p["source"],"build":p["build"]},
        "endpointURL":"http://127.0.0.1:8765/mcp"})
    committed=store.advance_generation(**next_generation,handoff_id=request["handoffId"])
request_path=private/"handoff.json";request_path.write_text(json.dumps(request),encoding="utf-8")
completed_path=private/"completed.json";completed_path.write_text(json.dumps({**committed,"state":"completed"}),encoding="utf-8")
provision=private/"provision.json"
provision.write_text(json.dumps({"database":str(database),**old,**old_generation,
    "source":p["source"],"build":p["build"],"credentials":{"fixture":"not-a-live-key"}}),encoding="utf-8")
profile=private/"profile.json"
profile.write_text(json.dumps({"loadedScripts":[
    {"name":"vendor","path":"$VENDOR/path","location":1,"isRemoved":False,"isFavorite":False,"runOnStartup":True},
    {"name":"owned","path":str(installed/"AutodeskFusionMCP.py"),"location":3,"isRemoved":False,"isFavorite":False,"runOnStartup":False}
]}),encoding="utf-8")
class Info(ctypes.Structure):
 _fields_=[("attributes",w.DWORD),("creation",w.FILETIME),("access",w.FILETIME),("write",w.FILETIME),
           ("volume",w.DWORD),("sizeHigh",w.DWORD),("sizeLow",w.DWORD),("links",w.DWORD),
           ("indexHigh",w.DWORD),("indexLow",w.DWORD)]
k=ctypes.WinDLL("kernel32",use_last_error=True)
k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,w.DWORD,w.DWORD,w.HANDLE];k.CreateFileW.restype=w.HANDLE
k.GetFileInformationByHandle.argtypes=[w.HANDLE,ctypes.c_void_p];k.CloseHandle.argtypes=[w.HANDLE]
h=k.CreateFileW(str(database),0x80020000,1,None,3,0x00200000,None);info=Info()
assert h not in(None,ctypes.c_void_p(-1).value) and k.GetFileInformationByHandle(h,ctypes.byref(info))
identity=json.dumps([info.volume,info.indexHigh,info.indexLow,info.creation.dwHighDateTime,info.creation.dwLowDateTime,
 info.write.dwHighDateTime,info.write.dwLowDateTime,info.sizeHigh,info.sizeLow,info.links,info.attributes],separators=(",",":"))
k.CloseHandle(h)
for item in [root,*root.rglob("*")]:_check_windows_acl(item)
digest=lambda name:hashlib.sha256(Path(name).read_bytes()).hexdigest()
print(json.dumps({"root":str(root),"helper":str(helper),"installed":str(installed),"private":str(private),
 "receipts":str(receipts),"profile":str(profile),"provision":str(provision),"database":str(database),
 "databaseIdentity":identity,"old":old,"request":str(request_path),"completed":str(completed_path),
 "requestSha256":digest(request_path),"completedSha256":digest(completed_path),"provisionSha256":digest(provision),
 "installedFiles":{f.relative_to(installed).as_posix():digest(f)for f in installed.rglob("*")if f.is_file()}}))
`;
const ownWindow = String.raw`
import ctypes,json,sys
from ctypes import wintypes as w
from pathlib import Path
u=ctypes.WinDLL("user32",use_last_error=True);k=ctypes.WinDLL("kernel32",use_last_error=True)
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
    _fields_=[("style",w.UINT),("proc",callback),("classExtra",ctypes.c_int),("windowExtra",ctypes.c_int),
              ("instance",w.HANDLE),("icon",w.HANDLE),("cursor",w.HANDLE),("background",w.HANDLE),
              ("menu",w.LPCWSTR),("name",w.LPWSTR)]
k.GetModuleHandleW.argtypes=[w.LPCWSTR];k.GetModuleHandleW.restype=w.HANDLE
cls=Class();cls.proc=proc;cls.instance=k.GetModuleHandleW(None);cls.name="FmcadNormalObserverFixture"
u.RegisterClassW.argtypes=[ctypes.POINTER(Class)];assert u.RegisterClassW(ctypes.byref(cls))
u.CreateWindowExW.argtypes=[w.DWORD,w.LPCWSTR,w.LPCWSTR,w.DWORD,ctypes.c_int,ctypes.c_int,
                          ctypes.c_int,ctypes.c_int,w.HWND,w.HMENU,w.HANDLE,ctypes.c_void_p]
u.CreateWindowExW.restype=w.HWND
hwnd=u.CreateWindowExW(0,cls.name,"Owned SDK-free normal close fixture",0,0,0,100,100,None,None,cls.instance,None)
assert hwnd
hidden=u.CreateWindowExW(0,cls.name,"Same-class hidden fixture (must NOT select)",0,0,0,100,100,None,None,cls.instance,None)
assert hidden
u.ShowWindow.argtypes=[w.HWND,ctypes.c_int]
u.ShowWindow(hwnd,4) # SW_SHOWNOACTIVATE: visible owned fixture, never activate Fusion
u.SetTimer.argtypes=[w.HWND,w.WPARAM,w.UINT,ctypes.c_void_p]
u.SetTimer(hwnd,1,20000,None) # bounded ordinary self-close even if the test fails
Path(sys.argv[1]).write_text(json.dumps({"visible":hwnd,"hidden":hidden}))
u.GetMessageW.argtypes=[ctypes.POINTER(w.MSG),w.HWND,w.UINT,w.UINT]
u.TranslateMessage.argtypes=[ctypes.POINTER(w.MSG)];u.DispatchMessageW.argtypes=[ctypes.POINTER(w.MSG)]
message=w.MSG()
while True:
    result=u.GetMessageW(ctypes.byref(message),None,0,0)
    if result==0:break
    if result<0:raise OSError("Fixture message loop failed")
    u.TranslateMessage(ctypes.byref(message));u.DispatchMessageW(ctypes.byref(message))
`;
const childProgram = String.raw`
import ctypes,json,os,sqlite3,sys,time
from ctypes import wintypes as w
from pathlib import Path
# The first user action after stdlib import is the original provision read.
raw=Path(os.environ["FUSION_MCP_ADMISSION_PROVISION"]).read_bytes()
provision=json.loads(raw)
k=ctypes.WinDLL("kernel32",use_last_error=True)
k.GetCurrentProcess.restype=w.HANDLE
k.GetProcessTimes.argtypes=[w.HANDLE,ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME)]
times=[w.FILETIME()for _ in range(4)]
assert k.GetProcessTimes(k.GetCurrentProcess(),*(ctypes.byref(t)for t in times))
birth=str((times[0].dwHighDateTime<<32)|times[0].dwLowDateTime)
correct=(provision["pid"]==os.getpid() and provision["birth"]==birth and
 provision["instance"]=="fixture-new-instance" and provision["epoch"]=="fixture-new-epoch")
Path(sys.argv[1]).write_text(json.dumps({"correctFirstRead":correct,"pid":os.getpid(),"birth":birth,
 "instance":provision["instance"],"epoch":provision["epoch"],"bootstrapIntent":os.environ.get("FUSION_MCP_BOOTSTRAP_INTENT"),
 "source":provision["source"],"build":provision["build"],
 "sdkModules":[m for m in sys.modules if m=="adsk"or m.startswith("adsk.")]}),encoding="utf-8")
assert correct,"First instruction saw stale provision"
with sqlite3.connect(provision["database"],timeout=2) as db:
 db.execute("CREATE TABLE normal_observer_fixture_started(pid INTEGER NOT NULL)")
 db.execute("INSERT INTO normal_observer_fixture_started VALUES (?)",(os.getpid(),))
 db.commit()
Path(sys.argv[1]+".database-write").write_text(json.dumps({"databaseWrite":True}),encoding="utf-8")
time.sleep(0.1)
`;
const waitReport = String.raw`
import json,sys,time
from pathlib import Path
p=json.load(sys.stdin);deadline=time.monotonic()+15
while not Path(p["report"]).is_file():
 if time.monotonic()>deadline:raise TimeoutError("No first-instruction report")
 time.sleep(0.025)
print(Path(p["report"]).read_text())
`;
const cleanupSuspendedFixture = String.raw`
# Explicit fixture-only cleanup, AFTER negative evidence; not a production path.
import ctypes,hashlib,json,sys
from ctypes import wintypes as w
from pathlib import Path
r=json.load(sys.stdin)
root=Path(r["root"]).resolve(strict=True)
journal=Path(r["journal"]).resolve(strict=True)
assert root.name.startswith("sol-normal-observer-fixture-") and journal.parent==root/"private"
raw=journal.read_bytes();assert hashlib.sha256(raw).hexdigest()==r["journalSha256"]
original=json.loads(raw);process=original["process"]
assert original["phase"]=="created-suspended" and original["executable"]==r["executable"]
assert original["nonce"]==r["nonce"] and original["isolation"]=="NOT_PROVEN"
assert hashlib.sha256(Path(r["executable"]).read_bytes()).hexdigest()==original["executableSha256"]==r["executableSha256"]
assert not Path(r["report"]).exists()
k=ctypes.WinDLL("kernel32",use_last_error=True);a=ctypes.WinDLL("advapi32",use_last_error=True)
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
k.OpenThread.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenThread.restype=w.HANDLE
k.GetProcessTimes.argtypes=[w.HANDLE,ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME)]
k.QueryFullProcessImageNameW.argtypes=[w.HANDLE,w.DWORD,w.LPWSTR,ctypes.POINTER(w.DWORD)]
k.GetProcessIdOfThread.argtypes=[w.HANDLE];k.GetProcessIdOfThread.restype=w.DWORD
k.GetCurrentProcess.restype=w.HANDLE;k.CloseHandle.argtypes=[w.HANDLE]
k.ResumeThread.argtypes=[w.HANDLE];k.ResumeThread.restype=w.DWORD
k.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD]
a.OpenProcessToken.argtypes=[w.HANDLE,w.DWORD,ctypes.POINTER(w.HANDLE)]
a.GetTokenInformation.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD,ctypes.POINTER(w.DWORD)]
a.EqualSid.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
def token_user(handle):
 token=w.HANDLE();assert a.OpenProcessToken(handle,8,ctypes.byref(token))
 try:
  size=w.DWORD();a.GetTokenInformation(token,1,None,0,ctypes.byref(size))
  buf=ctypes.create_string_buffer(size.value);assert a.GetTokenInformation(token,1,buf,size,ctypes.byref(size))
  return buf
 finally:k.CloseHandle(token)
h=k.OpenProcess(0x1000|0x100000,False,process["pid"]);assert h
thread=None
try:
 times=[w.FILETIME()for _ in range(4)]
 assert k.GetProcessTimes(h,*(ctypes.byref(t)for t in times))
 assert str((times[0].dwHighDateTime<<32)|times[0].dwLowDateTime)==process["birth"]
 assert k.WaitForSingleObject(h,0)==258
 length=w.DWORD(32768);image=ctypes.create_unicode_buffer(length.value)
 assert k.QueryFullProcessImageNameW(h,0,image,ctypes.byref(length))
 assert image.value.casefold()==r["executable"].casefold()
 actual,current=token_user(h),token_user(k.GetCurrentProcess())
 assert a.EqualSid(ctypes.cast(actual,ctypes.POINTER(ctypes.c_void_p))[0],
                   ctypes.cast(current,ctypes.POINTER(ctypes.c_void_p))[0])
 thread=k.OpenThread(0x0002|0x0800,False,original["threadId"]);assert thread
 assert k.GetProcessIdOfThread(thread)==process["pid"]
 # Exactly one explicit cleanup resume; preserve unknown outcome, never retry.
 previous=k.ResumeThread(thread)
 assert previous==1,"Fixture cleanup resume UNKNOWN; do not retry"
 assert k.WaitForSingleObject(h,15000)==0,"Fixture cleanup exit UNKNOWN; do not retry"
 print(json.dumps({"fixtureCleanup":"explicit-original-benign-child-resume-for-self-exit",
                   "process":process,"threadId":original["threadId"],"priorSuspendCount":previous,
                   "forceKill":False,"productionOutcome":"UNKNOWN-preserved"}))
finally:
 if thread:k.CloseHandle(thread)
 k.CloseHandle(h)
`;

test(
  "normal observer real Windows suspended child (NO Fusion, SDK or live provision writes)",
  {
    skip:
      !configPath &&
      "NOTRUN: explicit benign Windows fixture pins not supplied",
  },
  async (t) => {
    assert.ok(configPath);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Config;
    for (const [name, hash] of Object.entries(config.installedFiles))
      assert.equal(
        sha(
          fs.readFileSync(
            path.join(config.mappedSourceDirectory, ...name.split("/")),
          ),
        ),
        hash,
      );
    function fixture(withWindow = false) {
      const f = native(config, setup, {
        ...config,
        build: protocolBuild,
        ...(withWindow ? { windowProgram: ownWindow } : {}),
      }) as {
        root: string;
        helper: string;
        installed: string;
        private: string;
        receipts: string;
        profile: string;
        provision: string;
        database: string;
        databaseIdentity: string;
        old: { pid: number; birth: string };
        request: string;
        completed: string;
        requestSha256: string;
        completedSha256: string;
        provisionSha256: string;
        installedFiles: Record<string, string>;
      };
      const paths = {
        profile: f.profile,
        profileBackup: `${f.private}\\profile-before.json`,
        intent: `${f.private}\\UNUSED-intent.json`,
        entry: `${f.receipts}\\UNUSED-entry.json`,
        returned: `${f.receipts}\\UNUSED-return.json`,
        receiptDirectory: f.receipts,
        launchAttempt: `${f.private}\\attempt.json`,
        launchJournal: `${f.private}\\journal.json`,
        sourceClosure: `${f.private}\\source.json`,
        transcript: `${f.private}\\transcript.json`,
        provision: f.provision,
      };
      const report = `${f.private}\\first-instruction.json`;
      const originals = [
        f.database,
        f.request,
        f.completed,
        `${f.private}\\provision-before.json`,
        `${f.private}\\provision-bound.json`,
        `${f.private}\\retired-process.json`,
        `${f.private}\\cold-process.json`,
      ];
      const pins: NormalObserverLaunchPins = {
        nativePython: config.nativePython,
        mappedNativePython: config.mappedNativePython,
        nativePythonSha256: config.nativePythonSha256,
        executable: config.nativePython,
        mappedExecutable: config.mappedNativePython,
        executableSha256: config.nativePythonSha256,
        sourceDirectory: f.helper,
        mappedSourceDirectory: mapped(f.helper),
        installedDirectory: f.installed,
        mappedInstalledDirectory: mapped(f.installed),
        installedFiles: config.installedFiles,
        installedBuild: protocolBuild,
        installedSource: config.source,
        arguments: ["-I", "-S", "-B", "-c", childProgram, report],
        workingDirectory: f.private,
        paths,
        originalPaths: originals,
        mappedOriginalPaths: Object.fromEntries(
          [...Object.values(paths), ...originals].map((name) => [
            name,
            mapped(name),
          ]),
        ),
        receiptTimeoutMs: 1000,
        normalCloseTimeoutMs: 1000,
        mainWindowClass: "FmcadNormalObserverFixture",
        normal: {
          database: { nativePath: f.database, identity: f.databaseIdentity },
          provisionSha256: f.provisionSha256,
          handoffRequest: { nativePath: f.request, sha256: f.requestSha256 },
          handoffReceipt: {
            nativePath: f.completed,
            sha256: f.completedSha256,
          },
          provisionBackupPath: originals[3]!,
          provisionReceiptPath: originals[4]!,
          retiredProcessPath: originals[5]!,
          coldProcessPath: originals[6]!,
          installedFiles: f.installedFiles,
        },
        assertHeld() {},
      };
      t.diagnostic(`Owned SDK-free fixture: ${f.root}`);
      return { f, pins, report };
    }

    await t.test(
      "one normal close selects the sole visible same-class owned window and publishes OS death facts",
      async () => {
        const { f, pins } = fixture(true);
        const adapter = createNormalObserverLaunchAdapter(pins);
        const original = await adapter.requestNormalCloseAndWait(f.old);
        const facts = JSON.parse(
          Buffer.from(original.bytes).toString("utf8"),
        ) as Record<string, unknown>;
        assert.equal(facts["exited"], true);
        assert.equal(facts["oldPidPresent"], false);
        assert.equal(facts["forceUsed"], false);
        assert.equal(facts["oldPid"], f.old.pid);
        assert.equal(facts["oldBirth"], f.old.birth);
        const windows = JSON.parse(
          fs.readFileSync(mapped(`${f.private}\\old-window-ready`), "utf8"),
        ) as { visible: number; hidden: number };
        assert.equal(facts["windowHandle"], windows.visible);
        assert.notEqual(facts["windowHandle"], windows.hidden);
        assert.equal(facts["windowVisibleAtInput"], true);
        assert.equal(original.nativePath, pins.normal.retiredProcessPath);
        assert.equal(sha(original.bytes), original.sha256);
        await assert.rejects(
          adapter.requestNormalCloseAndWait(f.old),
          /replayed/,
        );
      },
    );

    await t.test(
      "first user instruction reads its own PID/birth and committed generation after ONE resume",
      async () => {
        const { f, pins, report } = fixture();
        const oldProvision = fs.readFileSync(mapped(f.provision));
        const oldProfile = fs.readFileSync(mapped(f.profile));
        const adapter = createNormalObserverLaunchAdapter(pins);
        const result = await adapter.launchAfterDeath(f.old, "a".repeat(32));
        const first = native(config, waitReport, { report });
        assert.equal(first["correctFirstRead"], true);
        assert.equal(first["pid"], result.process.pid);
        assert.equal(first["birth"], result.process.birth);
        assert.equal(first["source"], config.source);
        assert.equal(first["build"], protocolBuild);
        assert.equal(first["bootstrapIntent"], null);
        assert.deepEqual(first["sdkModules"], []);
        assert.equal(
          native(config, waitReport, { report: report + ".database-write" })[
            "databaseWrite"
          ],
          true,
        );
        assert.equal(result.isolation, "NOT_PROVEN");
        const cold = JSON.parse(
          Buffer.from(result.coldProcess.bytes).toString("utf8"),
        ) as Record<string, unknown>;
        assert.equal(cold["pid"], result.process.pid);
        assert.equal(cold["birth"], result.process.birth);
        assert.equal(cold["exe"], config.nativePython);
        assert.equal(cold["phase"], "created-suspended");
        assert.deepEqual(result.provisionBackup.bytes, oldProvision);
        assert.deepEqual(result.profileBackup.bytes, oldProfile);
        const profile = JSON.parse(
          Buffer.from(result.profile.bytes).toString("utf8"),
        ) as { loadedScripts: Array<{ runOnStartup: boolean }> };
        assert.deepEqual(
          profile.loadedScripts.map((row) => row.runOnStartup),
          [true, true],
        );
        const journal = JSON.parse(
          Buffer.from(result.journal.bytes).toString("utf8"),
        ) as { threadId: number; phase: string };
        assert.ok(journal.threadId > 0);
        assert.equal(journal.phase, "created-suspended");
        await assert.rejects(
          adapter.launchAfterDeath(f.old, "b".repeat(32)),
          /replayed/,
        );
      },
    );

    await t.test(
      "wrong source/build/generation/request/provision CAS refuse before any process creation",
      async () => {
        for (const failure of [
          "source",
          "build",
          "registered-build",
          "registered-source",
          "generation",
          "request",
          "committed-row",
          "cas",
          "provision-drift",
          "owner-lease",
        ]) {
          const { f, pins, report } = fixture();
          if (failure === "source")
            Object.assign(pins, { installedSource: "f".repeat(40) });
          if (failure === "build")
            Object.assign(pins, { installedBuild: "f".repeat(64) });
          if (
            failure === "registered-build" ||
            failure === "registered-source"
          ) {
            const before = JSON.parse(
              fs.readFileSync(mapped(f.provision), "utf8"),
            ) as Record<string, unknown>;
            if (failure === "registered-build") {
              before["build"] = "f".repeat(64);
              Object.assign(pins, { installedBuild: before["build"] });
            } else {
              before["source"] = "f".repeat(40);
              Object.assign(pins, { installedSource: before["source"] });
            }
            fs.writeFileSync(mapped(f.provision), JSON.stringify(before));
            Object.assign(pins.normal, {
              provisionSha256: sha(fs.readFileSync(mapped(f.provision))),
            });
          }
          if (failure === "cas")
            Object.assign(pins.normal, { provisionSha256: "0".repeat(64) });
          if (failure === "request")
            Object.assign(pins.normal.handoffRequest, {
              sha256: "0".repeat(64),
            });
          if (failure === "committed-row") {
            for (const original of [
              pins.normal.handoffRequest,
              pins.normal.handoffReceipt,
            ]) {
              const value = JSON.parse(
                fs.readFileSync(mapped(original.nativePath), "utf8"),
              ) as Record<string, unknown>;
              value["handoffId"] = "fixture-not-committed-in-this-database";
              fs.writeFileSync(
                mapped(original.nativePath),
                JSON.stringify(value),
              );
              Object.assign(original, {
                sha256: sha(fs.readFileSync(mapped(original.nativePath))),
              });
            }
          }
          if (failure === "generation") {
            const provision = JSON.parse(
              fs.readFileSync(mapped(f.provision), "utf8"),
            ) as Record<string, unknown>;
            provision["epoch"] = "wrong-generation";
            fs.writeFileSync(mapped(f.provision), JSON.stringify(provision));
            Object.assign(pins.normal, {
              provisionSha256: sha(fs.readFileSync(mapped(f.provision))),
            });
          }
          if (failure === "provision-drift") {
            const provision = JSON.parse(
              fs.readFileSync(mapped(f.provision), "utf8"),
            ) as Record<string, unknown>;
            provision["credentials"] = { changed: "fixture-only-drift" };
            fs.writeFileSync(mapped(f.provision), JSON.stringify(provision));
          }
          if (failure === "owner-lease")
            Object.assign(pins, {
              assertHeld() {
                throw new Error("LEASE_LOST");
              },
            });
          const adapter = createNormalObserverLaunchAdapter(pins);
          await assert.rejects(
            adapter.launchAfterDeath(f.old, "a".repeat(32)),
            (error: unknown) =>
              failure === "owner-lease"
                ? error instanceof Error && error.message === "LEASE_LOST"
                : error instanceof ControlledFusionNativeError &&
                  error.action === "normal-launch" &&
                  error.stderr.includes("ValueError") &&
                  (!failure.startsWith("registered-") ||
                    error.stderr.includes(
                      "Original registered physical runtime/source/build/database differs",
                    )) &&
                  !error.stderr.includes("createdProcess") &&
                  !error.stdout.includes("ready-before-create"),
          );
          assert.equal(fs.existsSync(mapped(pins.paths.launchJournal)), false);
          assert.equal(fs.existsSync(mapped(report)), false);
          await assert.rejects(
            adapter.launchAfterDeath(f.old, "a".repeat(32)),
            /replayed/,
          );
        }
      },
    );

    await t.test(
      "lost post-create boundary retains the original suspended tuple and never resumes/relaunches",
      async () => {
        const { f, pins, report } = fixture();
        const before = fs.readFileSync(mapped(f.provision));
        Object.assign(pins, {
          assertHeld() {
            if (fs.existsSync(mapped(pins.normal.provisionReceiptPath)))
              throw new Error("FIXTURE_POST_CREATE_LEASE_REVOKED");
          },
        });
        const adapter = createNormalObserverLaunchAdapter(pins);
        await assert.rejects(
          adapter.launchAfterDeath(f.old, "c".repeat(32)),
          (error: unknown) =>
            error instanceof ControlledFusionNativeError &&
            error.outcome === "UNKNOWN" &&
            error.stdout.includes("bound-before-resume") &&
            error.stderr.includes("createdProcess"),
        );
        const journalBytes = fs.readFileSync(mapped(pins.paths.launchJournal));
        assert.deepEqual(
          fs.readFileSync(mapped(pins.normal.provisionBackupPath)),
          before,
        );
        const bound = JSON.parse(
          fs.readFileSync(mapped(f.provision), "utf8"),
        ) as Record<string, unknown>;
        const originalJournal = JSON.parse(journalBytes.toString("utf8")) as {
          process: { pid: number; birth: string };
        };
        assert.equal(bound["pid"], originalJournal.process.pid);
        assert.equal(bound["birth"], originalJournal.process.birth);
        assert.equal(fs.existsSync(mapped(report)), false);
        assert.equal(
          fs.existsSync(mapped(pins.normal.provisionReceiptPath)),
          true,
        );
        await assert.rejects(
          adapter.launchAfterDeath(f.old, "d".repeat(32)),
          /replayed/,
        );
        // Separate, explicitly authorized fixture cleanup, AFTER durable negative
        // evidence. No cleanup functionality exists on the production adapter.
        fs.writeFileSync(
          mapped(`${f.private}\\negative-evidence.json`),
          JSON.stringify({
            journalSha256: sha(journalBytes),
            reportAbsentBeforeCleanup: true,
            productionOutcome: "UNKNOWN",
            productionResume: false,
            originalProvisionSha256: sha(before),
            boundProvisionSha256: sha(fs.readFileSync(mapped(f.provision))),
          }),
        );
        const cleanup = native(config, cleanupSuspendedFixture, {
          root: f.root,
          journal: pins.paths.launchJournal,
          journalSha256: sha(journalBytes),
          executable: config.nativePython,
          executableSha256: config.nativePythonSha256,
          nonce: "c".repeat(32),
          report,
        });
        fs.writeFileSync(
          mapped(`${f.private}\\explicit-fixture-cleanup.json`),
          JSON.stringify(cleanup),
        );
        assert.equal(cleanup["productionOutcome"], "UNKNOWN-preserved");
      },
    );
  },
);

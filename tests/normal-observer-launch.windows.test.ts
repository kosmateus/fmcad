import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createNormalObserverLaunchAdapter,
  createOwnedAutoloadLaunchAdapter,
  type OwnedAutoloadLaunchPins,
  ControlledFusionNativeError,
  type NormalObserverLaunchPins,
} from "../packages/node-adapters/src/execution/controlled-fusion-launch";
import { ownedAutoloadLaunchNative } from "../packages/node-adapters/src/execution/owned-autoload-launch-native";
import { bootstrapInstalledFilesDigest } from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import { normalObserverNativeBootstrap } from "../packages/node-adapters/src/execution/controlled-fusion-launch-native";
import type { ControlledFile } from "../packages/node-adapters/src/execution/controlled-fusion-launch-types";
import { compileControlledIdentityFixture } from "./fixtures/controlled-identity-fixture";

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
const ownedPopupWindow = ownWindow
  .replace(
    "u.ShowWindow.argtypes=",
    'popup=u.CreateWindowExW(0,cls.name,"Same-class owned popup",0x80000000,0,0,100,100,hwnd,None,cls.instance,None)\nassert popup\nu.ShowWindow.argtypes=',
  )
  .replace(
    "u.ShowWindow(hwnd,4)",
    "u.ShowWindow(popup,4)\nu.ShowWindow(hwnd,4)",
  )
  .replace(
    '{"visible":hwnd,"hidden":hidden}',
    '{"visible":hwnd,"hidden":hidden,"ownedPopup":popup}',
  );
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
const ownedChildProgram = childProgram
  .replace(
    "import ctypes,json,os,sqlite3,sys,time",
    "import ctypes,hashlib,json,os,sqlite3,sys,time",
  )
  .replace(
    'correct=(provision["pid"]',
    String.raw`
intent_path=os.environ["FUSION_MCP_BOOTSTRAP_INTENT"]
intent=json.loads(Path(intent_path).read_bytes())
profile_path=Path(intent["profile"]["path"])
profile=json.loads(profile_path.read_bytes())
assert set(intent)=={"kind","version","mode","nonce","process","purpose","engineVersion","executable","installed","profile","receipts","provision","generation"}
assert intent["version"]==3 and intent["mode"]=="owned-autoload-v1" and intent["purpose"]=="isolated-stdout-v1"
assert intent["engineVersion"]==2 and intent["executable"]["path"].casefold()==sys.executable.casefold()
assert intent["executable"]["sha256"]==hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest()
assert intent["profile"]["sha256"]==hashlib.sha256(profile_path.read_bytes()).hexdigest()
assert intent["provision"]["sha256"]==hashlib.sha256(raw).hexdigest()
assert intent["provision"]["path"]==os.environ["FUSION_MCP_ADMISSION_PROVISION"]
assert intent["generation"]=={"instance":provision["instance"],"epoch":provision["epoch"]}
assert [r["runOnStartup"] for r in profile["loadedScripts"]]==[False,True]
correct=(intent["process"]=={"pid":os.getpid(),"birth":birth} and provision["pid"]`,
  )
  .replace(
    '"source":provision["source"],"build":provision["build"],',
    '"source":provision["source"],"build":provision["build"],"installedSource":intent["installed"]["source"],"installedDigest":hashlib.sha256(json.dumps(intent["installed"]["files"],sort_keys=True,separators=(",",":")).encode()).hexdigest(),',
  );
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
const stopIdentityFixture = String.raw`
import ctypes,json,sys
from ctypes import wintypes as w
from pathlib import Path
r=json.load(sys.stdin);image=str(Path(r["executable"]).resolve(strict=True))
Path(r["stop"]).write_text("fixture requests normal self-exit",encoding="utf-8")
class Entry(ctypes.Structure):
 _fields_=[("size",w.DWORD),("usage",w.DWORD),("pid",w.DWORD),("heap",ctypes.c_size_t),
           ("module",w.DWORD),("threads",w.DWORD),("parent",w.DWORD),("priority",w.LONG),
           ("flags",w.DWORD),("name",w.WCHAR*260)]
k=ctypes.WinDLL("kernel32",use_last_error=True)
k.CreateToolhelp32Snapshot.argtypes=[w.DWORD,w.DWORD];k.CreateToolhelp32Snapshot.restype=w.HANDLE
k.Process32FirstW.argtypes=[w.HANDLE,ctypes.POINTER(Entry)];k.Process32NextW.argtypes=[w.HANDLE,ctypes.POINTER(Entry)]
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
k.QueryFullProcessImageNameW.argtypes=[w.HANDLE,w.DWORD,w.LPWSTR,ctypes.POINTER(w.DWORD)]
k.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD];k.CloseHandle.argtypes=[w.HANDLE]
snap=k.CreateToolhelp32Snapshot(2,0)
if snap in(None,ctypes.c_void_p(-1).value):raise OSError("Fixture process inventory unavailable")
found=[]
try:
 entry=Entry();entry.size=ctypes.sizeof(entry);ok=k.Process32FirstW(snap,ctypes.byref(entry))
 while ok:
  if entry.name.casefold()==Path(image).name.casefold():
   h=k.OpenProcess(0x1000|0x00100000,False,entry.pid)
   if h:
    try:
     n=w.DWORD(32768);text=ctypes.create_unicode_buffer(n.value)
     if k.QueryFullProcessImageNameW(h,0,text,ctypes.byref(n)) and text.value.casefold()==image.casefold():
      found.append((entry.pid,h));h=None
    finally:
     if h:k.CloseHandle(h)
  ok=k.Process32NextW(snap,ctypes.byref(entry))
finally:k.CloseHandle(snap)
try:
 for pid,h in found:
  if k.WaitForSingleObject(h,15000)!=0:raise TimeoutError("Owned Identity fixture did not exit normally")
 print(json.dumps({"fixture":"Identity","pids":[pid for pid,_ in found],"forceTermination":False}))
finally:
 for _,h in found:k.CloseHandle(h)
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
    const identityFixtures: ReturnType<
      typeof compileControlledIdentityFixture
    >[] = [];
    let identityFixtureIndex = 0;
    t.after(() => {
      for (const identityFixture of identityFixtures)
        native(config, stopIdentityFixture, {
          executable: identityFixture.executable,
          stop: identityFixture.stopFile,
        });
    });
    function fixture(
      withWindow = false,
      admissionSource = config.source,
      admissionBuild = protocolBuild,
      windowProgram = ownWindow,
    ) {
      const f = native(config, setup, {
        ...config,
        source: admissionSource,
        build: admissionBuild,
        ...(withWindow ? { windowProgram } : {}),
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
    function ownedFixture() {
      const { f, pins, report } = fixture(
        false,
        "7".repeat(40),
        "8".repeat(64),
      );
      const identityFixture = compileControlledIdentityFixture(
        f.private,
        `FmcadControlledIdentityFixture-${++identityFixtureIndex}.exe`,
      );
      identityFixtures.push(identityFixture);
      const values = native(
        config,
        String.raw`
import ctypes,hashlib,json,sys
from ctypes import wintypes as w
from pathlib import Path
r=json.load(sys.stdin);root=Path(r["private"])
class Info(ctypes.Structure):
 _fields_=[("attributes",w.DWORD),("creation",w.FILETIME),("access",w.FILETIME),("write",w.FILETIME),
           ("volume",w.DWORD),("sizeHigh",w.DWORD),("sizeLow",w.DWORD),("links",w.DWORD),
           ("indexHigh",w.DWORD),("indexLow",w.DWORD)]
k=ctypes.WinDLL("kernel32",use_last_error=True)
k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,w.DWORD,w.DWORD,w.HANDLE];k.CreateFileW.restype=w.HANDLE
k.GetFileInformationByHandle.argtypes=[w.HANDLE,ctypes.c_void_p];k.CloseHandle.argtypes=[w.HANDLE]
out=[]
for name in ("autorun-one.xml","autorun-two.xml","discovery-original.json"):
 p=root/name;p.write_text("original benign fixture "+name,encoding="utf-8")
 h=k.CreateFileW(str(p),0x80020000,1,None,3,0x00200000,None);info=Info()
 assert h not in(None,ctypes.c_void_p(-1).value) and k.GetFileInformationByHandle(h,ctypes.byref(info))
 ident=json.dumps([info.volume,info.indexHigh,info.indexLow,info.creation.dwHighDateTime,info.creation.dwLowDateTime,
  info.write.dwHighDateTime,info.write.dwLowDateTime,info.sizeHigh,info.sizeLow,info.links,info.attributes],separators=(",",":"))
 k.CloseHandle(h)
 out.append({"nativePath":str(p),"sha256":hashlib.sha256(p.read_bytes()).hexdigest(),"identity":ident})
print(json.dumps({"refs":out}))
`,
        { private: f.private },
      )["refs"] as Array<{
        nativePath: string;
        sha256: string;
        identity: string;
      }>;
      const refs = values.map((v) => ({
        ...v,
        bytes: fs.readFileSync(mapped(v.nativePath)),
      }));
      const { normal, ...base } = pins;
      const paths = {
        ...base.paths,
        identityAttempt: `${f.private}\\identity-attempt.json`,
        identityJournal: `${f.private}\\identity-journal.json`,
        identityPreparation: `${f.private}\\identity-preparation.json`,
      };
      const ownedPins: OwnedAutoloadLaunchPins = {
        ...base,
        paths,
        identity: {
          executable: identityFixture.executable,
          mappedExecutable: identityFixture.mappedExecutable,
          sha256: identityFixture.sha256,
          version: identityFixture.version,
          arguments: identityFixture.arguments,
          logFile: identityFixture.logFile,
          mappedLogFile: identityFixture.mappedLogFile,
          preparationTimeoutMs: 5000,
        },
        installedBuild: bootstrapInstalledFilesDigest(config.installedFiles),
        arguments: ["-I", "-S", "-B", "-c", ownedChildProgram, report],
        originalPaths: [
          ...base.originalPaths,
          ...refs.map((v) => v.nativePath),
        ],
        mappedOriginalPaths: {
          ...base.mappedOriginalPaths,
          ...Object.fromEntries(
            Object.values(paths).map((name) => [name, mapped(name)]),
          ),
          ...Object.fromEntries(
            refs.map((v) => [v.nativePath, mapped(v.nativePath)]),
          ),
        },
        owned: {
          ...normal,
          admissionPins: { source: "7".repeat(40), build: "8".repeat(64) },
          autorunOriginals: [refs[0]!, refs[1]!],
          discoveryOriginals: [refs[2]!],
        },
        assertBeforeResumeOriginals() {},
      };
      return { f, pins: ownedPins, report, identityFixture };
    }
    function originalFiles(paths: string[]): ControlledFile[] {
      const rows = native(
        config,
        String.raw`
import ctypes,hashlib,json,sys
from ctypes import wintypes as w
from pathlib import Path
class Info(ctypes.Structure):
 _fields_=[("attributes",w.DWORD),("creation",w.FILETIME),("access",w.FILETIME),("write",w.FILETIME),
           ("volume",w.DWORD),("sizeHigh",w.DWORD),("sizeLow",w.DWORD),("links",w.DWORD),
           ("indexHigh",w.DWORD),("indexLow",w.DWORD)]
k=ctypes.WinDLL("kernel32",use_last_error=True)
k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,w.DWORD,w.DWORD,w.HANDLE]
k.CreateFileW.restype=w.HANDLE
k.GetFileInformationByHandle.argtypes=[w.HANDLE,ctypes.c_void_p]
k.CloseHandle.argtypes=[w.HANDLE]
out=[]
for name in json.load(sys.stdin)["paths"]:
 h=k.CreateFileW(name,0x80020000,1,None,3,0x00200000,None);a=Info();b=Info()
 assert h not in(None,ctypes.c_void_p(-1).value)
 try:
  assert k.GetFileInformationByHandle(h,ctypes.byref(a))
  raw=Path(name).read_bytes()
  assert k.GetFileInformationByHandle(h,ctypes.byref(b))
  vector=lambda info:[info.volume,info.indexHigh,info.indexLow,
      info.creation.dwHighDateTime,info.creation.dwLowDateTime,
      info.write.dwHighDateTime,info.write.dwLowDateTime,info.sizeHigh,info.sizeLow,
      info.links,info.attributes]
  assert vector(a)==vector(b) and a.links==1 and not a.attributes&0x410
  out.append({"nativePath":name,"identity":json.dumps(vector(a),separators=(",",":")),
              "sha256":hashlib.sha256(raw).hexdigest()})
 finally:k.CloseHandle(h)
print(json.dumps({"refs":out}))
`,
        { paths },
      )["refs"] as Omit<ControlledFile, "bytes">[];
      return rows.map((row) => ({
        ...row,
        bytes: fs.readFileSync(mapped(row.nativePath)),
      }));
    }

    await t.test(
      "owned native program refuses manual/NORMAL actions before any filesystem or process mutation",
      () => {
        const program = Buffer.from(ownedAutoloadLaunchNative(), "utf8");
        for (const action of [
          "launch",
          "normal-launch",
          "normal-close",
          "replace-profile",
          "publish",
        ]) {
          const envelope = Buffer.from(
            JSON.stringify({
              pins: {},
              action,
              request: {},
              expectedSource: null,
            }) + "\n",
          );
          const result = spawnSync(
            config.mappedNativePython,
            ["-I", "-S", "-B", "-c", normalObserverNativeBootstrap],
            {
              input: Buffer.concat([
                Buffer.from(`${program.length}\n`),
                program,
                envelope,
              ]),
              encoding: "utf8",
            },
          );
          assert.notEqual(result.status, 0);
          assert.match(
            result.stderr,
            /Separate owned native role refuses manual\/NORMAL actions/,
          );
          assert.doesNotMatch(result.stderr, /createdProcess/);
        }
      },
    );
    await t.test(
      "one normal close selects the unowned main window despite a visible same-class owned popup",
      async () => {
        const { f, pins } = fixture(
          true,
          config.source,
          protocolBuild,
          ownedPopupWindow,
        );
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
        ) as { visible: number; hidden: number; ownedPopup: number };
        assert.equal(facts["windowHandle"], windows.visible);
        assert.notEqual(facts["windowHandle"], windows.hidden);
        assert.notEqual(facts["windowHandle"], windows.ownedPopup);
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
      "two independent visible same-class windows remain ambiguous before any close input",
      async () => {
        const ambiguous = ownedPopupWindow.replace(
          "100,100,hwnd,None,cls.instance,None)",
          "100,100,None,None,cls.instance,None)",
        );
        assert.notEqual(ambiguous, ownedPopupWindow);
        const { f, pins } = fixture(
          true,
          config.source,
          protocolBuild,
          ambiguous,
        );
        const adapter = createNormalObserverLaunchAdapter(pins);
        await assert.rejects(
          adapter.requestNormalCloseAndWait(f.old),
          (error: unknown) => {
            assert.ok(error instanceof ControlledFusionNativeError);
            assert.equal(error.action, "normal-close");
            assert.match(
              error.stderr,
              /Unique exact vendor main window required/,
            );
            return true;
          },
        );
        assert.equal(
          fs.existsSync(mapped(pins.normal.retiredProcessPath)),
          false,
        );
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
    await t.test(
      "owned first user instructions see original v3 intent, bound provision and exact-one-ON profile before one resume",
      async () => {
        const { f, pins, report } = ownedFixture();
        let locked = false;
        Object.assign(pins, {
          assertBeforeResumeOriginals() {
            if (fs.existsSync(mapped(pins.paths.intent)) && !locked) {
              const result = native(
                config,
                String.raw`
import json,sys
from pathlib import Path
r=json.load(sys.stdin)
try:Path(r["path"]).write_bytes(b"FORBIDDEN MUTATION");blocked=False
except OSError:blocked=True
print(json.dumps({"retainedOriginalWriteBlocked":blocked}))
`,
                { path: pins.owned.autorunOriginals[0].nativePath },
              );
              assert.equal(result["retainedOriginalWriteBlocked"], true);
              locked = true;
            }
          },
        });
        const adapter = createOwnedAutoloadLaunchAdapter(pins);
        const result = await adapter.launchAfterDeath(f.old, "e".repeat(32));
        const first = native(config, waitReport, { report });
        assert.deepEqual(
          Object.keys(
            JSON.parse(Buffer.from(result.journal.bytes).toString("utf8")),
          ).sort(),
          [
            "attempt",
            "executable",
            "executableSha256",
            "isolation",
            "kind",
            "nonce",
            "phase",
            "process",
            "threadId",
          ].sort(),
          "owned launch journal keeps the existing closed consumer contract",
        );
        assert.equal(
          result.identityPreparation.state,
          "PREPARATION_ONLY_NOT_SERVICE_READY",
        );
        assert.equal(result.identityPreparation.origin, "spawned");
        assert.equal(
          result.identityPreparation.process.pid,
          JSON.parse(Buffer.from(result.identityJournal.bytes).toString("utf8"))
            .process.pid,
        );
        const identityRecord = JSON.parse(
          Buffer.from(result.identityPreparationFile.bytes).toString("utf8"),
        );
        assert.equal(identityRecord.authority, "NONE");
        assert.equal(
          identityRecord.state,
          "PREPARATION_ONLY_NOT_SERVICE_READY",
        );
        const identityAttempt = JSON.parse(
          Buffer.from(result.identityAttempt.bytes).toString("utf8"),
        );
        assert.equal(
          identityAttempt.fusionLaunchAttempt.nativePath,
          pins.paths.launchAttempt,
        );
        const eventFileTime =
          BigInt(Date.parse(result.identityPreparation.logEvent.timestamp)) *
            10000n +
          116444736000000000n;
        assert.ok(
          eventFileTime < BigInt(result.process.birth),
          "Identity preparation event must precede Fusion CreateProcess/ResumeThread",
        );
        assert.equal(first["correctFirstRead"], true);
        assert.equal(first["pid"], result.process.pid);
        assert.equal(first["birth"], result.process.birth);
        assert.equal(first["bootstrapIntent"], pins.paths.intent);
        assert.equal(first["source"], pins.owned.admissionPins.source);
        assert.equal(first["build"], pins.owned.admissionPins.build);
        assert.equal(first["installedSource"], pins.installedSource);
        assert.equal(first["installedDigest"], pins.installedBuild);
        assert.notEqual(first["source"], first["installedSource"]);
        assert.notEqual(first["build"], first["installedDigest"]);
        assert.deepEqual(first["sdkModules"], []);
        assert.equal(locked, true);
        assert.equal(result.startupProven, false);
        const intent = JSON.parse(
          Buffer.from(result.intent.bytes).toString("utf8"),
        );
        assert.equal(intent.version, 3);
        assert.equal(intent.mode, "owned-autoload-v1");
        assert.equal(intent.installed.source, pins.installedSource);
        assert.deepEqual(intent.process, result.process);
        assert.equal(intent.provision.sha256, result.provision.sha256);
        assert.deepEqual(
          JSON.parse(
            Buffer.from(result.profile.bytes).toString(),
          ).loadedScripts.map(
            (row: { runOnStartup: boolean }) => row.runOnStartup,
          ),
          [false, true],
        );
        assert.equal(
          native(config, waitReport, { report: report + ".database-write" })[
            "databaseWrite"
          ],
          true,
        );
        await assert.rejects(
          adapter.launchAfterDeath(f.old, "f".repeat(32)),
          /replayed/,
        );
      },
    );
    await t.test(
      "two owned launches wait for one delayed pinned Identity process instead of cold-spawning twice",
      async () => {
        const firstFixture = ownedFixture();
        const secondFixture = ownedFixture();
        fs.writeFileSync(
          firstFixture.identityFixture.mappedModeFile,
          "delayed-ready-800",
          "utf8",
        );
        const secondPins: OwnedAutoloadLaunchPins = {
          ...secondFixture.pins,
          identity: firstFixture.pins.identity,
        };
        const [first, second] = await Promise.all([
          createOwnedAutoloadLaunchAdapter(firstFixture.pins).launchAfterDeath(
            firstFixture.f.old,
            "1".repeat(32),
          ),
          createOwnedAutoloadLaunchAdapter(secondPins).launchAfterDeath(
            secondFixture.f.old,
            "2".repeat(32),
          ),
        ]);
        assert.deepEqual(
          first.identityPreparation.process,
          second.identityPreparation.process,
        );
        assert.deepEqual(
          [
            first.identityPreparation.origin,
            second.identityPreparation.origin,
          ].sort(),
          ["adopted", "spawned"],
        );
        assert.equal(
          first.identityPreparation.state,
          "PREPARATION_ONLY_NOT_SERVICE_READY",
        );
        const lines = fs
          .readFileSync(firstFixture.identityFixture.mappedLogFile, "utf8")
          .trim()
          .split(/\r?\n/);
        assert.equal(
          lines.filter((line) =>
            line.includes("Starting Autodesk IDSDK Server process"),
          ).length,
          1,
        );
        const started = Date.parse(lines[0]!.slice(0, 24));
        const ready = Date.parse(
          lines
            .find((line) => line.includes("SSO Server is ready"))!
            .slice(0, 24),
        );
        assert.ok(ready - started >= 500, "fixture readiness was delayed");
      },
    );
    await t.test(
      "owned launch refuses Identity PID and pre-birth log-event drift without creating Fusion",
      async () => {
        for (const [index, mode] of ["wrong-pid", "pre-birth"].entries()) {
          const { f, pins, report, identityFixture } = ownedFixture();
          Object.assign(pins.identity, { preparationTimeoutMs: 3000 });
          fs.writeFileSync(identityFixture.mappedModeFile, mode, "utf8");
          await assert.rejects(
            createOwnedAutoloadLaunchAdapter(pins).launchAfterDeath(
              f.old,
              String(index + 3)
                .repeat(32)
                .slice(0, 32),
            ),
            (error: unknown) =>
              error instanceof ControlledFusionNativeError &&
              error.action === "owned-autoload-launch" &&
              error.outcome === "UNKNOWN",
          );
          const unknown = JSON.parse(
            fs.readFileSync(mapped(pins.paths.identityPreparation), "utf8"),
          );
          assert.equal(unknown.authority, "NONE");
          assert.equal(unknown.state, "UNKNOWN");
          assert.equal(fs.existsSync(mapped(pins.paths.identityAttempt)), true);
          assert.equal(fs.existsSync(mapped(pins.paths.identityJournal)), true);
          assert.equal(fs.existsSync(mapped(pins.paths.launchJournal)), false);
          assert.equal(fs.existsSync(mapped(report)), false);
        }
      },
    );
    await t.test(
      "owned launch rechecks Identity log evidence at the pre-create fence",
      async () => {
        const { f, pins, report, identityFixture } = ownedFixture();
        let changed = false;
        const adapter = createOwnedAutoloadLaunchAdapter({
          ...pins,
          assertBeforeResumeOriginals() {
            if (changed || !fs.existsSync(identityFixture.mappedLogFile))
              return;
            const current = fs.readFileSync(
              identityFixture.mappedLogFile,
              "utf8",
            );
            if (!current.includes("SSO Server is ready")) return;
            fs.writeFileSync(
              identityFixture.mappedLogFile,
              current.replace(
                "SSO Server is ready",
                "SSO Server readiness evidence drifted",
              ),
              "utf8",
            );
            changed = true;
          },
        });
        await assert.rejects(
          adapter.launchAfterDeath(f.old, "4".repeat(32)),
          (error: unknown) =>
            error instanceof ControlledFusionNativeError &&
            error.action === "owned-autoload-launch" &&
            error.outcome === "UNKNOWN",
        );
        assert.equal(changed, true);
        const preparation = JSON.parse(
          fs.readFileSync(mapped(pins.paths.identityPreparation), "utf8"),
        );
        assert.equal(preparation.state, "PREPARATION_ONLY_NOT_SERVICE_READY");
        assert.equal(fs.existsSync(mapped(pins.paths.launchJournal)), false);
        assert.equal(fs.existsSync(mapped(report)), false);
      },
    );
    await t.test(
      "mapped Identity hash drift refuses before owned native dispatch or process creation",
      async () => {
        const { f, pins, report, identityFixture } = ownedFixture();
        const adapter = createOwnedAutoloadLaunchAdapter(pins);
        fs.appendFileSync(identityFixture.mappedExecutable, "drift");
        await assert.rejects(
          adapter.launchAfterDeath(f.old, "5".repeat(32)),
          (error: unknown) =>
            error instanceof ControlledFusionNativeError &&
            /Identity bytes differ before spawn/.test(error.stderr),
        );
        assert.equal(fs.existsSync(mapped(pins.paths.identityAttempt)), false);
        assert.equal(fs.existsSync(mapped(pins.paths.launchJournal)), false);
        assert.equal(fs.existsSync(mapped(report)), false);
      },
    );
    await t.test(
      "partial Identity UNKNOWN keeps receipts and a fresh owned request adopts instead of respawning",
      async () => {
        const firstFixture = ownedFixture();
        const secondFixture = ownedFixture();
        Object.assign(firstFixture.pins.identity, {
          preparationTimeoutMs: 1000,
        });
        fs.writeFileSync(
          firstFixture.identityFixture.mappedModeFile,
          "missing-event",
          "utf8",
        );
        await assert.rejects(
          createOwnedAutoloadLaunchAdapter(firstFixture.pins).launchAfterDeath(
            firstFixture.f.old,
            "6".repeat(32),
          ),
          (error: unknown) =>
            error instanceof ControlledFusionNativeError &&
            error.action === "owned-autoload-launch" &&
            error.outcome === "UNKNOWN",
        );
        const firstUnknown = JSON.parse(
          fs.readFileSync(
            mapped(firstFixture.pins.paths.identityPreparation),
            "utf8",
          ),
        );
        assert.equal(firstUnknown.state, "UNKNOWN");
        assert.equal(
          fs.existsSync(mapped(firstFixture.pins.paths.identityAttempt)),
          true,
        );
        assert.equal(
          fs.existsSync(mapped(firstFixture.pins.paths.identityJournal)),
          true,
        );
        const retryPins: OwnedAutoloadLaunchPins = {
          ...secondFixture.pins,
          identity: firstFixture.pins.identity,
        };
        await assert.rejects(
          createOwnedAutoloadLaunchAdapter(retryPins).launchAfterDeath(
            secondFixture.f.old,
            "7".repeat(32),
          ),
          (error: unknown) =>
            error instanceof ControlledFusionNativeError &&
            error.action === "owned-autoload-launch" &&
            error.outcome === "UNKNOWN",
        );
        const retryUnknown = JSON.parse(
          fs.readFileSync(mapped(retryPins.paths.identityPreparation), "utf8"),
        );
        const retryJournal = JSON.parse(
          fs.readFileSync(mapped(retryPins.paths.identityJournal), "utf8"),
        );
        assert.equal(retryUnknown.state, "UNKNOWN");
        assert.equal(retryJournal.origin, "adopted");
        assert.deepEqual(retryUnknown.process, firstUnknown.process);
        assert.equal(
          fs
            .readFileSync(firstFixture.identityFixture.mappedLogFile, "utf8")
            .split("Starting Autodesk IDSDK Server process").length - 1,
          1,
        );
        for (const pins of [firstFixture.pins, retryPins]) {
          assert.equal(fs.existsSync(mapped(pins.paths.launchJournal)), false);
          assert.equal(fs.existsSync(mapped(pins.paths.identityAttempt)), true);
          assert.equal(fs.existsSync(mapped(pins.paths.identityJournal)), true);
          assert.equal(
            fs.existsSync(mapped(pins.paths.identityPreparation)),
            true,
          );
        }
      },
    );
    await t.test(
      "owned replacements verify the complete original lineage before each real bind and one resume",
      async () => {
        const { f, pins, report } = ownedFixture();
        const windowProgram = ownWindow.replace(
          'Path(sys.argv[1]).write_text(json.dumps({"visible":hwnd,"hidden":hidden}))',
          'Path(sys.argv[1]+".window").write_text(json.dumps({"visible":hwnd,"hidden":hidden}))',
        );
        assert.notEqual(windowProgram, ownWindow);
        Object.assign(pins, {
          arguments: [
            "-I",
            "-S",
            "-B",
            "-c",
            ownedChildProgram + windowProgram,
            report,
          ],
        });
        const first = await createOwnedAutoloadLaunchAdapter(
          pins,
        ).launchAfterDeath(f.old, "1".repeat(32));
        native(config, waitReport, { report: report + ".window" });
        native(config, waitReport, { report: report + ".database-write" });
        const before = fs.readFileSync(mapped(f.provision));
        const { owned, assertBeforeResumeOriginals, ...normalBase } = pins;
        const {
          admissionPins,
          autorunOriginals,
          discoveryOriginals,
          replacement,
          ...normal
        } = owned;
        void assertBeforeResumeOriginals;
        void autorunOriginals;
        void discoveryOriginals;
        void replacement;
        const retired = await createNormalObserverLaunchAdapter({
          ...normalBase,
          installedSource: admissionPins.source,
          installedBuild: admissionPins.build,
          normal: { ...normal, provisionSha256: first.provision.sha256 },
        }).requestNormalCloseAndWait(first.process);
        assert.equal(
          JSON.parse(Buffer.from(retired.bytes).toString()).forceUsed,
          false,
        );
        const database = originalFiles([f.database])[0]!;
        const nextName = (name: string) =>
          path.win32.join(
            path.win32.dirname(name),
            "replacement-" + path.win32.basename(name),
          );
        const paths = Object.fromEntries(
          Object.entries(pins.paths).map(([key, value]) => [
            key,
            ["profile", "provision", "receiptDirectory"].includes(key)
              ? value
              : nextName(value),
          ]),
        ) as typeof pins.paths;
        const outputs = {
          provisionBackupPath: nextName(owned.provisionBackupPath),
          provisionReceiptPath: nextName(owned.provisionReceiptPath),
          coldProcessPath: nextName(owned.coldProcessPath),
        };
        const originals = [
          ...new Set([
            ...pins.originalPaths,
            ...Object.values(outputs),
            first.provisionBackup.nativePath,
            first.provisionReceipt.nativePath,
            retired.nativePath,
          ]),
        ];
        const secondReport = nextName(report);
        const secondPins: OwnedAutoloadLaunchPins = {
          ...pins,
          paths,
          originalPaths: originals,
          mappedOriginalPaths: Object.fromEntries(
            [...Object.values(paths), ...originals].map((name) => [
              name,
              mapped(name),
            ]),
          ),
          arguments: [
            "-I",
            "-S",
            "-B",
            "-c",
            ownedChildProgram.replace(
              "CREATE TABLE normal_observer_fixture_started",
              "CREATE TABLE IF NOT EXISTS normal_observer_fixture_started",
            ) + windowProgram,
            secondReport,
          ],
          owned: {
            ...owned,
            ...outputs,
            database: {
              nativePath: database.nativePath,
              identity: database.identity,
            },
            provisionSha256: first.provision.sha256,
            replacement: {
              kind: "unregistered-created-process-v1",
              priorProvision: first.provisionBackup,
              provisionReceipt: first.provisionReceipt,
              retiredProcess: retired,
            },
          },
        };
        const adapter = createOwnedAutoloadLaunchAdapter(secondPins);
        const second = await adapter.launchAfterDeath(
          first.process,
          "2".repeat(32),
        );
        const observed = native(config, waitReport, { report: secondReport });
        assert.equal(observed["correctFirstRead"], true);
        assert.equal(observed["pid"], second.process.pid);
        assert.equal(observed["bootstrapIntent"], paths.intent);
        assert.deepEqual(observed["sdkModules"], []);
        assert.notEqual(second.process.pid, first.process.pid);
        const prior = JSON.parse(before.toString()),
          after = JSON.parse(Buffer.from(second.provision.bytes).toString());
        assert.deepEqual(
          Object.keys(after)
            .filter((key) => after[key] !== prior[key] && key !== "credentials")
            .sort(),
          ["birth", "pid"],
        );
        assert.deepEqual(after.credentials, prior.credentials);
        assert.deepEqual(
          fs.readFileSync(mapped(outputs.provisionBackupPath)),
          before,
        );
        for (const original of [
          first.provisionBackup,
          first.provisionReceipt,
          retired,
        ])
          assert.deepEqual(
            fs.readFileSync(mapped(original.nativePath)),
            Buffer.from(original.bytes),
          );
        assert.equal(
          native(config, waitReport, {
            report: secondReport + ".database-write",
          })["databaseWrite"],
          true,
        );
        await assert.rejects(
          adapter.launchAfterDeath(first.process, "3".repeat(32)),
          /replayed/,
        );
        native(config, waitReport, { report: secondReport + ".window" });
        const retiredSecondPath = nextName(retired.nativePath);
        const normalOriginalPaths = [
          ...new Set([...secondPins.originalPaths, retiredSecondPath]),
        ];
        const retiredSecond = await createNormalObserverLaunchAdapter({
          ...normalBase,
          paths: secondPins.paths,
          installedSource: admissionPins.source,
          installedBuild: admissionPins.build,
          originalPaths: normalOriginalPaths,
          mappedOriginalPaths: Object.fromEntries(
            [...Object.values(secondPins.paths), ...normalOriginalPaths].map(
              (name) => [name, mapped(name)],
            ),
          ),
          normal: {
            ...normal,
            database: secondPins.owned.database,
            provisionSha256: second.provision.sha256,
            retiredProcessPath: retiredSecondPath,
          },
        }).requestNormalCloseAndWait(second.process);
        const thirdPaths = Object.fromEntries(
          Object.entries(secondPins.paths).map(([key, value]) => [
            key,
            ["profile", "provision", "receiptDirectory"].includes(key)
              ? value
              : nextName(value),
          ]),
        ) as typeof pins.paths;
        const thirdOutputs = Object.fromEntries(
          Object.entries(outputs).map(([key, value]) => [key, nextName(value)]),
        ) as typeof outputs;
        const chain = [
          {
            priorProvision: first.provisionBackup,
            provisionReceipt: first.provisionReceipt,
            retiredProcess: retired,
          },
          {
            priorProvision: second.provisionBackup,
            provisionReceipt: second.provisionReceipt,
            retiredProcess: retiredSecond,
          },
        ];
        const chainFiles = chain.flatMap((step) => [
          step.priorProvision,
          step.provisionReceipt,
          step.retiredProcess,
        ]);
        const thirdOriginalPaths = [
          ...new Set([
            ...secondPins.originalPaths,
            ...Object.values(thirdOutputs),
            ...chainFiles.map((file) => file.nativePath),
          ]),
        ];
        const thirdDatabase = originalFiles([f.database])[0]!;
        const thirdReport = nextName(secondReport);
        const thirdPins: OwnedAutoloadLaunchPins = {
          ...secondPins,
          paths: thirdPaths,
          originalPaths: thirdOriginalPaths,
          mappedOriginalPaths: Object.fromEntries(
            [...Object.values(thirdPaths), ...thirdOriginalPaths].map(
              (name) => [name, mapped(name)],
            ),
          ),
          arguments: [
            "-I",
            "-S",
            "-B",
            "-c",
            ownedChildProgram.replace(
              "CREATE TABLE normal_observer_fixture_started",
              "CREATE TABLE IF NOT EXISTS normal_observer_fixture_started",
            ),
            thirdReport,
          ],
          owned: {
            ...secondPins.owned,
            ...thirdOutputs,
            database: {
              nativePath: thirdDatabase.nativePath,
              identity: thirdDatabase.identity,
            },
            provisionSha256: second.provision.sha256,
            retiredProcessPath: retiredSecond.nativePath,
            replacement: {
              kind: "unregistered-created-process-chain-v1",
              steps: chain,
            },
          },
        };
        const third = await createOwnedAutoloadLaunchAdapter(
          thirdPins,
        ).launchAfterDeath(second.process, "4".repeat(32));
        const thirdObserved = native(config, waitReport, {
          report: thirdReport,
        });
        assert.equal(thirdObserved["correctFirstRead"], true);
        assert.equal(thirdObserved["pid"], third.process.pid);
        assert.deepEqual(thirdObserved["sdkModules"], []);
        assert.equal(
          JSON.parse(Buffer.from(third.provision.bytes).toString()).instance,
          after.instance,
        );
        assert.deepEqual(
          Buffer.from(third.provisionBackup.bytes),
          Buffer.from(second.provision.bytes),
        );
        for (const original of chainFiles)
          assert.deepEqual(
            fs.readFileSync(mapped(original.nativePath)),
            Buffer.from(original.bytes),
          );
        assert.equal(
          native(config, waitReport, {
            report: thirdReport + ".database-write",
          })["databaseWrite"],
          true,
        );
      },
    );
    await t.test(
      "owned admission mismatch refuses before CreateProcess without changing original provision",
      async () => {
        const { f, pins, report } = ownedFixture();
        const before = fs.readFileSync(mapped(pins.paths.provision));
        Object.assign(pins.owned.admissionPins, { source: "9".repeat(40) });
        const adapter = createOwnedAutoloadLaunchAdapter(pins);
        await assert.rejects(
          adapter.launchAfterDeath(f.old, "b".repeat(32)),
          ControlledFusionNativeError,
        );
        assert.deepEqual(fs.readFileSync(mapped(pins.paths.provision)), before);
        assert.equal(fs.existsSync(mapped(pins.paths.launchJournal)), false);
        assert.equal(fs.existsSync(mapped(report)), false);
      },
    );
    await t.test(
      "owned changed autorun or discovery originals refuse before creation without fallback",
      async () => {
        for (const which of [0, 1, 2, "native-identity"] as const) {
          const { f, pins, report } = ownedFixture();
          const refs = [
            ...pins.owned.autorunOriginals,
            ...pins.owned.discoveryOriginals,
          ];
          if (which === "native-identity")
            Object.assign(refs[0]!, { identity: "[1,2,3,4,5,6,7,8,9,1,0]" });
          else
            fs.writeFileSync(
              mapped(refs[which]!.nativePath),
              "changed fixture original",
            );
          const adapter = createOwnedAutoloadLaunchAdapter(pins);
          await assert.rejects(
            adapter.launchAfterDeath(f.old, "a".repeat(32)),
            (error: unknown) =>
              which === "native-identity"
                ? error instanceof ControlledFusionNativeError &&
                  error.action === "owned-autoload-launch" &&
                  !error.stderr.includes("createdProcess")
                : error instanceof Error && /Mapped/.test(error.message),
          );
          assert.equal(fs.existsSync(mapped(pins.paths.launchJournal)), false);
          assert.equal(fs.existsSync(mapped(report)), false);
          await assert.rejects(
            adapter.launchAfterDeath(f.old, "b".repeat(32)),
            /replayed/,
          );
        }
      },
    );
    await t.test(
      "owned final original-witness revocation retains v3 and suspended tuple but never resumes",
      async () => {
        const { f, pins, report } = ownedFixture();
        Object.assign(pins, {
          assertBeforeResumeOriginals() {
            if (fs.existsSync(mapped(pins.paths.intent)))
              throw new Error("ORIGINAL_STARTUP_WITNESS_REVOKED");
          },
        });
        const adapter = createOwnedAutoloadLaunchAdapter(pins);
        await assert.rejects(
          adapter.launchAfterDeath(f.old, "d".repeat(32)),
          (error: unknown) =>
            error instanceof ControlledFusionNativeError &&
            error.outcome === "UNKNOWN" &&
            error.stdout.includes("bound-before-resume") &&
            error.stderr.includes("createdProcess"),
        );
        assert.equal(fs.existsSync(mapped(report)), false);
        assert.equal(fs.existsSync(mapped(pins.paths.intent)), true);
        const journal = fs.readFileSync(mapped(pins.paths.launchJournal));
        fs.writeFileSync(
          mapped(`${f.private}\\owned-negative-evidence.json`),
          JSON.stringify({
            reportAbsentBeforeCleanup: true,
            productionResume: false,
            outcome: "UNKNOWN",
            journalSha256: sha(journal),
            intentSha256: sha(fs.readFileSync(mapped(pins.paths.intent))),
          }),
        );
        await assert.rejects(
          adapter.launchAfterDeath(f.old, "e".repeat(32)),
          /replayed/,
        );
        const cleanup = native(config, cleanupSuspendedFixture, {
          root: f.root,
          journal: pins.paths.launchJournal,
          journalSha256: sha(journal),
          executable: config.nativePython,
          executableSha256: config.nativePythonSha256,
          nonce: "d".repeat(32),
          report,
        });
        fs.writeFileSync(
          mapped(`${f.private}\\owned-explicit-fixture-cleanup.json`),
          JSON.stringify(cleanup),
        );
        assert.equal(cleanup["productionOutcome"], "UNKNOWN-preserved");
      },
    );
  },
);

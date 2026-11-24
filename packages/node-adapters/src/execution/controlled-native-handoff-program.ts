/** SDK-free operator over qualified input and OWNED native filesystem/processes.
 * Supported private provision writer/reader and process-birth observer are loaded
 * only from the closed qualified package. No add-in entrypoint is executed.
 */
export const controlledNativeHandoffProgram = String.raw`
import base64,ctypes,hashlib,json,math,os,re,sqlite3,sys
from ctypes import wintypes as w
from pathlib import Path

def decode(raw):
    def pairs(items):
        result={}
        for key,value in items:
            if key in result:raise ValueError("Duplicate JSON key")
            result[key]=value
        return result
    def bad(_):raise ValueError("Nonfinite JSON")
    def number(value):
        result=float(value)
        if not math.isfinite(result):raise ValueError("Nonfinite JSON number")
        return result
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=bad,parse_float=number)
raw=sys.stdin.buffer.read(4194305)
if len(raw)>4194304:raise ValueError("Envelope budget")
e=decode(raw)
if set(e)!={"pins","action","input"}:raise ValueError("Closed handoff envelope required")
p,action,v=e["pins"],e["action"],e["input"]
q=p["qualified"]
required={"AutodeskFusionMCP.py","addon_runtime.py","lib/bootstrap_entry.py",
 "lib/startup_audit.py","lib/physical_authority.py","lib/rebaseline_fence.py",
 "lib/request_admission.py","fusion_bridge/dispatch.py","fusion_bridge/runtime.py",
 "fusion_bridge/admission_runtime.py"}
if (type(q) is not dict or set(q)!={"directory","source","build","files"}
    or type(q["source"]) is not str or re.fullmatch("[a-f0-9]{40}",q["source"]) is None
    or type(q["build"]) is not str or re.fullmatch("[a-f0-9]{64}",q["build"]) is None
    or type(q["files"]) is not dict or not 0<len(q["files"])<=4096
    or not required.issubset(q["files"])):
    raise ValueError("Complete qualified audited package required")
aliases={}
for name,digest in q["files"].items():
    if (type(name) is not str or type(digest) is not str
        or re.fullmatch("[a-f0-9]{64}",digest) is None
        or re.search(r'[\x00-\x1f<>:"\\|?*]',name)
        or any(not part or part in (".","..") or part.endswith(("."," "))
          or re.match(r"^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])([.]|$)",part,re.I)
          for part in name.split("/"))):
        raise ValueError("Unsafe qualified Windows name/hash")
    parts=name.split("/")
    for i in range(1,len(parts)+1):
        prefix="/".join(parts[:i]);key=prefix.casefold()
        if key in aliases and aliases[key]!=prefix:raise ValueError("Qualified Windows case alias")
        aliases[key]=prefix
file_keys={name.casefold()for name in q["files"]}
for name in q["files"]:
    parts=name.split("/")
    if any("/".join(parts[:i]).casefold()in file_keys for i in range(1,len(parts))):
        raise ValueError("Qualified file/directory alias")
if sys.platform!="win32":raise RuntimeError("Native Windows required")
sys.dont_write_bytecode=True
k=ctypes.WinDLL("kernel32",use_last_error=True)
k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,ctypes.c_void_p,w.DWORD,w.DWORD,w.HANDLE]
k.CreateFileW.restype=w.HANDLE
k.GetFileType.argtypes=[w.HANDLE]
k.GetFileInformationByHandle.argtypes=[w.HANDLE,ctypes.c_void_p]
k.CloseHandle.argtypes=[w.HANDLE]
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
k.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD]
k.GetProcessTimes.argtypes=[w.HANDLE,ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME),ctypes.POINTER(w.FILETIME)]
INVALID=ctypes.c_void_p(-1).value
held=[]
class Info(ctypes.Structure):
    _fields_=[("attributes",w.DWORD),("created",w.FILETIME),("access",w.FILETIME),
      ("write",w.FILETIME),("volume",w.DWORD),("sizeHigh",w.DWORD),("sizeLow",w.DWORD),
      ("links",w.DWORD),("indexHigh",w.DWORD),("indexLow",w.DWORD)]
def sha(raw):return hashlib.sha256(raw).hexdigest()
def canonical(name,missing=False):
    path=Path(name)
    existing=path.parent if missing else path
    if not path.is_absolute() or str(existing.resolve(strict=True)).casefold()!=str(existing).casefold():
        raise ValueError("Canonical local native path required")
    for part in (existing,*existing.parents):
        if getattr(part.lstat(),"st_file_attributes",0)&0x400:raise ValueError("Reparse ancestor")
    return path
def open_handle(name,directory=False,share=1,read=True):
    path=canonical(name)
    h=k.CreateFileW(str(path),0x20080|(0x80000000 if read else 0),share,None,3,
                    0x00200000|(0x02000000 if directory else 0),None)
    if h in (None,INVALID):raise OSError(ctypes.get_last_error(),"Stable native file unavailable")
    try:
        info=Info()
        if (k.GetFileType(h)!=1 or not k.GetFileInformationByHandle(h,ctypes.byref(info))
            or info.attributes&0x400 or bool(info.attributes&0x10)!=directory
            or not directory and info.links!=1):raise ValueError("Non-aliased regular native file required")
        return h
    except:k.CloseHandle(h);raise
def ident(h,directory=False):
    i=Info()
    if not k.GetFileInformationByHandle(h,ctypes.byref(i)):raise OSError("File identity unavailable")
    # Directory rename changes its name, not its stable volume/file identity.
    values=[i.volume,i.indexHigh,i.indexLow,i.created.dwHighDateTime,i.created.dwLowDateTime,i.attributes,i.links]
    if not directory:values=[i.volume,i.indexHigh,i.indexLow,i.created.dwHighDateTime,i.created.dwLowDateTime,
      i.write.dwHighDateTime,i.write.dwLowDateTime,i.sizeHigh,i.sizeLow,i.links,i.attributes]
    return json.dumps(values,separators=(",",":"))
def read(name,private=True,locks=None,share=1):
    import msvcrt
    h=open_handle(name,share=share)
    fd=None
    try:
        original=ident(h)
        if private:check_acl(None,handle=h)
        fd=msvcrt.open_osfhandle(h,os.O_RDONLY|os.O_BINARY);h=None
        raw=bytearray()
        while True:
            chunk=os.read(fd,65536)
            if not chunk:break
            raw.extend(chunk)
            if len(raw)>67108864:raise ValueError("Native file budget exceeded")
        handle=msvcrt.get_osfhandle(fd)
        if ident(handle)!=original:raise ValueError("Native file changed while reading")
        if private:check_acl(None,handle=handle)
        result=bytes(raw),original
        if locks is not None:locks.append(("fd",fd));fd=None
        return result
    finally:
        if fd is not None:os.close(fd)
        if h is not None:k.CloseHandle(h)
def close(locks):
    for kind,h in reversed(locks):
        if kind=="fd":os.close(h)
        else:k.CloseHandle(h)
    locks.clear()
def private_dir(name,locks=None):
    h=open_handle(name,directory=True,read=False)
    try:
        check_acl(None,handle=h)
        value=ident(h,True)
        if locks is not None:locks.append(("handle",h));h=None
        return value
    finally:
        if h is not None:k.CloseHandle(h)
def tree(name,private=True,locks=None):
    root=canonical(name);files={};directories={}
    for current,dirs,names in os.walk(root,followlinks=False):
        current=Path(current)
        h=open_handle(current,directory=True,read=False)
        try:
            if private:check_acl(None,handle=h)
            directories[current.relative_to(root).as_posix()]=ident(h,True)
            if locks is not None:locks.append(("handle",h));h=None
        finally:
            if h is not None:k.CloseHandle(h)
        for child in dirs:
            if getattr((current/child).lstat(),"st_file_attributes",0)&0x400:raise ValueError("Tree alias")
        for child in names:
            raw,identity=read(current/child,private,locks)
            files[(current/child).relative_to(root).as_posix()]={"sha256":sha(raw),"identity":identity}
            if len(files)>4096:raise ValueError("Tree inventory budget exceeded")
    return {"files":files,"directories":directories}
def qualified(value):
    if {name:item["sha256"]for name,item in value["files"].items()}!=p["qualified"]["files"]:
        raise ValueError("Full qualified package manifest differs")
def snap(name,share=1):
    raw,identity=read(name,share=share)
    return {"nativePath":str(Path(name)),"sha256":sha(raw),"identity":identity,
            "base64":base64.b64encode(raw).decode("ascii")}
def ref(value):return {key:value[key]for key in ("nativePath","sha256","identity")}
def match(reference):
    actual=snap(reference["nativePath"])
    if ref(actual)!=ref(reference):raise ValueError("Original private reference changed")
    return actual
def publish(name,raw):
    canonical(name,True);private_dir(str(Path(name).parent))
    fd=os.open(name,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_BINARY,0o600)
    try:
        import msvcrt
        check_acl(None,handle=msvcrt.get_osfhandle(fd))
        view=memoryview(raw)
        while view:
            n=os.write(fd,view)
            if n<=0:raise OSError("Partial private output")
            view=view[n:]
        os.fsync(fd)
    finally:os.close(fd)
    actual=snap(name)
    if actual["sha256"]!=sha(raw):raise ValueError("Private output differs")
    return actual
def publish_json(name,value):return publish(name,_encode(value).encode("utf-8"))
def absent(name):
    canonical(name,True)
    if os.path.lexists(name):raise ValueError("Exclusive original path already exists; no replay")
def old_dead(value):
    h=k.OpenProcess(0x1000|0x100000,False,value["pid"])
    if not h:
        if ctypes.get_last_error()==87:return
        raise OSError("Old process state unavailable")
    try:
        times=[w.FILETIME()for _ in range(4)]
        if not k.GetProcessTimes(h,*(ctypes.byref(t)for t in times)):raise OSError("Old process birth absent")
        birth=str((times[0].dwHighDateTime<<32)|times[0].dwLowDateTime)
        if birth!=value["birth"] or k.WaitForSingleObject(h,0)!=0:raise ValueError("Exact old process not dead")
    finally:k.CloseHandle(h)
def new_alive(value):
    if value["pid"]==p["old"]["pid"] or value["birth"]==p["old"]["birth"]:
        raise ValueError("Old versus new tuple mismatch")
    if observe_process_birth(value["pid"])!=value["birth"]:raise ValueError("New process birth differs")
    h=k.OpenProcess(0x1000,False,value["pid"])
    if not h:raise OSError("New process image unavailable")
    try:
        k.QueryFullProcessImageNameW.argtypes=[w.HANDLE,w.DWORD,w.LPWSTR,ctypes.POINTER(w.DWORD)]
        size=w.DWORD(32768);image=ctypes.create_unicode_buffer(size.value)
        if not k.QueryFullProcessImageNameW(h,0,image,ctypes.byref(size)) or image.value.casefold()!=p["executable"].casefold():
            raise ValueError("Current controlled process executable differs")
    finally:k.CloseHandle(h)
def provision():
    result=snap(p["paths"]["provision"]);value=decode(base64.b64decode(result["base64"]))
    if not isinstance(value,dict) or not all(key in value for key in ("pid","birth","instance","epoch","source","build","database","credentials")):
        raise ValueError("Incomplete provision schema")
    if str(canonical(value["database"])).casefold()!=p["paths"]["database"].casefold():
        raise ValueError("Provision database path differs")
    return result,value
def generation(zero):
    name=canonical(p["paths"]["database"])
    # READ_CONTROL with SHARE_ALL validates the live DB's actual handle/ACL
    # without freezing approved writers after startup. SQL is query-only.
    h=open_handle(name,share=7,read=False)
    try:
        check_acl(None,handle=h);before=ident(h)
        c=sqlite3.connect(name.as_uri()+"?mode=ro",uri=True,timeout=5)
        try:
            c.execute("PRAGMA query_only=ON")
            c.execute("BEGIN")
            if c.execute("SELECT instance,epoch FROM generation WHERE singleton=1").fetchone()!=(p["nextGeneration"]["instance"],p["nextGeneration"]["epoch"]):
                raise ValueError("Target generation is not already committed")
            if zero and c.execute("SELECT count(*) FROM admissions").fetchone()!=(0,):
                raise ValueError("Admissions are not empty")
        finally:c.close()
        # Content may legitimately change in later assert-current calls. Only
        # stable volume/file identity and ACL (not live bytes) are required then.
        current=open_handle(name,share=7,read=False)
        try:
            check_acl(None,handle=current)
            if json.loads(ident(current))[:5]!=json.loads(before)[:5]:raise ValueError("Database identity changed")
        finally:k.CloseHandle(current)
        check_acl(None,handle=h)
    finally:k.CloseHandle(h)
def database_snapshot():
    for suffix in ("-wal","-shm","-journal"):
        if os.path.lexists(p["paths"]["database"]+suffix):raise ValueError("Nonquiescent database sidecar")
    return snap(p["paths"]["database"],share=7)
def launch_origin(launch):
    journal=match(launch["journal"]);data=decode(base64.b64decode(journal["base64"]))
    if data.get("kind")!="controlled-created-process-v1" or data.get("process")!=launch["process"]:
        raise ValueError("Original controlled-launch tuple differs")
    if data.get("executable")!=p["executable"] or data.get("executableSha256")!=p["executableSha256"]:
        raise ValueError("Controlled-launch executable differs")
    attempt=match(data["attempt"]);attempt_value=decode(base64.b64decode(attempt["base64"]))
    if attempt_value.get("kind")!="controlled-launch-attempt-v1" or attempt_value.get("old")!=p["old"] or attempt_value.get("nonce")!=data.get("nonce"):
        raise ValueError("Original controlled-launch attempt differs")
    new_alive(launch["process"])
def installed():
    value=tree(p["qualified"]["directory"],locks=held);qualified(value);return value
def install():
    old_dead(p["old"])
    original_provision,old_value=provision()
    if original_provision["sha256"]!=p["expectedProvisionSha256"] or (old_value["pid"],old_value["birth"])!=(p["old"]["pid"],p["old"]["birth"]):
        raise ValueError("Install old tuple is not the original provision process")
    for key in ("stage","backup","installClosure","installReceipt"):absent(p["paths"][key])
    target=Path(p["qualified"]["directory"]);canonical(str(target.parent))
    before=None;old_locks=[]
    if target.exists():before=tree(target,locks=old_locks)
    closure=publish_json(p["paths"]["installClosure"],{"kind":"controlled-native-install-originals-v1","authority":"NONE",
      "oldProcess":p["old"],"qualified":p["qualified"],"originalManifest":ref(manifest),
      "helper":helper,"target":str(target),"oldTree":before,"provisionBefore":ref(original_provision)})
    stage=Path(p["paths"]["stage"])
    private_dir(str(stage.parent));os.mkdir(stage,0o700);private_dir(stage)
    for name in sorted(p["qualified"]["files"]):
        destination=stage/name
        parent=destination.parent
        if not parent.exists():
            parent.mkdir(parents=True);private_dir(parent)
        raw=_read_private_bytes(Path(p["helperDirectory"])/name)
        if sha(raw)!=p["qualified"]["files"][name]:raise ValueError("Qualified source changed")
        publish(str(destination),raw)
    staged=tree(stage);qualified(staged)
    if before is not None and tree(target)!=before:raise ValueError("Old installation changed before backup")
    old_dead(p["old"]);close(old_locks)
    # A failed rename leaves original/staged/backup artifacts intact. Never
    # copy-delete, remove unknown files, restore automatically or retry.
    if before is not None:
        os.rename(target,p["paths"]["backup"])
        if tree(p["paths"]["backup"])!=before:raise ValueError("Full backup differs from original tree")
    os.rename(stage,target)
    after=installed()
    if after!=staged:raise ValueError("Installed copy/identity differs")
    old_dead(p["old"])
    current_provision,unused=provision()
    if ref(current_provision)!=ref(original_provision):raise ValueError("Provision changed during qualified install")
    receipt=publish_json(p["paths"]["installReceipt"],{"kind":"controlled-native-install-receipt-v1","authority":"NONE",
      "oldProcess":p["old"],"qualified":p["qualified"],"originals":ref(closure),
      "backup":p["paths"]["backup"] if before is not None else None,"installed":after})
    return {"receipt":receipt,"closure":closure}
def prepare_rebind():
    old_dead(p["old"]);installed();match(v["installReceipt"]);match(v["installClosure"])
    launch_origin(v["launch"])
    current,value=provision()
    if current["sha256"]!=p["expectedProvisionSha256"] or (value["pid"],value["birth"])!=(p["old"]["pid"],p["old"]["birth"]):
        raise ValueError("Original provision/old tuple changed")
    absent(p["paths"]["provisionBackup"]);absent(p["paths"]["rebindReceipt"])
    generation(True);db=database_snapshot()
    return {"provision":current,"database":ref(db)}
def commit_rebind():
    old_dead(p["old"]);installed();match(v["installReceipt"]);match(v["installClosure"]);launch_origin(v["launch"])
    prepared=v["prepared"];before,value=provision()
    if ref(before)!=ref(prepared["provision"]):raise ValueError("Provision/credentials changed after prepare")
    db=database_snapshot()
    if ref(db)!=ref(prepared["database"]):raise ValueError("Database changed after prepare")
    generation(True)
    absent(p["paths"]["provisionBackup"]);absent(p["paths"]["rebindReceipt"])
    backup=publish(p["paths"]["provisionBackup"],base64.b64decode(before["base64"]))
    fields={"pid":v["launch"]["process"]["pid"],"birth":v["launch"]["process"]["birth"],
      "instance":p["nextGeneration"]["instance"],"epoch":p["nextGeneration"]["epoch"],
      "source":p["qualified"]["source"],"build":p["qualified"]["build"]}
    updated=dict(value,**fields)
    if set(updated)!=set(value) or any(updated[key]!=value[key]for key in value if key not in fields):
        raise ValueError("Unexpected provision field change")
    credentials=_encode(value["credentials"])
    write_private(Path(p["paths"]["provision"]),updated)
    after,observed=provision()
    # Preserve factual post-write metadata before receipt publication can fail.
    print(_encode({"provisionWritten":ref(after),"process":v["launch"]["process"]}),file=sys.stderr,flush=True)
    if observed!=updated or _encode(observed["credentials"])!=credentials:raise ValueError("Credentials or provision changed")
    if ref(database_snapshot())!=ref(db):raise ValueError("Database bytes changed across atomic rebind")
    generation(True);new_alive(v["launch"]["process"]);installed()
    receipt=publish_json(p["paths"]["rebindReceipt"],{"kind":"controlled-native-rebind-receipt-v1","authority":"NONE",
      "oldProcess":p["old"],"process":v["launch"]["process"],"nextGeneration":p["nextGeneration"],
      "qualified":p["qualified"],"affectedFields":sorted(fields),"before":ref(before),"backup":ref(backup),
      "after":ref(after),"databaseBefore":ref(db),"databaseAfter":ref(database_snapshot()),
      "credentialsSha256":sha(credentials.encode()),"installReceipt":ref(v["installReceipt"]),
      "launchJournal":ref(v["launch"]["journal"])})
    return {"receipt":receipt,"backup":backup,"provision":after}
def assert_current():
    installed();launch_origin(v["launch"])
    for key in ("receipt","backup","installReceipt","installClosure"):match(v[key])
    current,value=provision()
    if ref(current)!=ref(v["provision"]):raise ValueError("Current provision identity/bytes differs")
    if (value["pid"],value["birth"])!=(v["launch"]["process"]["pid"],v["launch"]["process"]["birth"]):
        raise ValueError("Current process tuple differs")
    if (value["source"],value["build"])!=(p["qualified"]["source"],p["qualified"]["build"]):
        raise ValueError("Current source/build differs")
    if (value["instance"],value["epoch"])!=(p["nextGeneration"]["instance"],p["nextGeneration"]["epoch"]):
        raise ValueError("Current provision generation differs")
    generation(False);new_alive(v["launch"]["process"])
    return None
try:
    exe,unused=read(p["nativePython"],private=False,locks=held)
    if str(Path(sys.executable).resolve()).casefold()!=p["nativePython"].casefold() or sha(exe)!=p["nativePythonSha256"]:
        raise ValueError("Pinned native interpreter differs")
    executable,unused=read(p["executable"],private=False,locks=held)
    if sha(executable)!=p["executableSha256"]:raise ValueError("Pinned controlled executable bytes differ")
    helper=tree(p["helperDirectory"],private=False,locks=held);qualified(helper)
    sys.path.insert(0,p["helperDirectory"])
    from lib.physical_authority import _check_windows_acl as check_acl,_read_private_bytes,write_private
    from lib.rebaseline_fence import observe_process_birth
    from lib.request_admission import _encode
    if tree(p["helperDirectory"],locks=held)!=helper:raise ValueError("Qualified helper source changed")
    manifest_raw,manifest_identity=read(p["manifest"]["nativePath"],locks=held)
    manifest={"nativePath":p["manifest"]["nativePath"],"sha256":sha(manifest_raw),
      "identity":manifest_identity,"base64":base64.b64encode(manifest_raw).decode("ascii")}
    if manifest["sha256"]!=p["manifest"]["sha256"] or decode(base64.b64decode(manifest["base64"]))!=p["qualified"]["files"]:
        raise ValueError("Original complete manifest bytes differ")
    if sha(_encode(p["qualified"]["files"]).encode())!=p["qualified"]["build"]:raise ValueError("Native build digest differs")
    if action=="install":result=install()
    elif action=="prepare-rebind":result=prepare_rebind()
    elif action=="commit-rebind":result=commit_rebind()
    elif action=="assert-current":result=assert_current()
    else:raise ValueError("Unknown native handoff operation")
    if tree(p["helperDirectory"])!=helper:raise ValueError("Qualified helper after-fence changed")
    match(manifest)
    print(_encode({"kind":"controlled-native-handoff-v1","action":action,"result":result}))
finally:close(held)
`;

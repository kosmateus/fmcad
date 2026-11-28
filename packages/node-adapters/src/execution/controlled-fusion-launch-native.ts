import { createRequire } from "node:module";

/**
 * Pinned Windows-Python stdlib operator. Only private local composition invokes
 * this program. It never imports Fusion/SDK, discovers a Fusion process, kills a
 * process or starts an add-in through SDK/UI. NORMAL and the separate owned
 * program bind provision while suspended; no result is host authority.
 */
export const controlledFusionLaunchNative = String.raw`
import base64, ctypes, hashlib, json, math, os, stat, subprocess, sys, time
from ctypes import wintypes as w
from pathlib import Path

def strict(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError("Duplicate JSON key")
            value[key] = item
        return value
    def constant(_):
        raise ValueError("Nonfinite JSON")
    def number(value):
        result = float(value)
        if not math.isfinite(result):
            raise ValueError("Nonfinite JSON number")
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant, parse_float=number)

raw = sys.stdin.buffer.readline(4194305)
if len(raw) > 4194304:
    raise ValueError("Envelope too large")
e = strict(raw)
if set(e) != {"pins", "action", "request", "expectedSource"}:
    raise ValueError("Closed native envelope required")
p, action, request = e["pins"], e["action"], e["request"]
if action != "normal-launch" and sys.stdin.buffer.read(1):
    raise ValueError("Trailing native input")
if sys.platform != "win32":
    raise RuntimeError("Native Windows required")
sys.dont_write_bytecode = True
k = ctypes.WinDLL("kernel32", use_last_error=True)
k.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
k.CreateFileW.restype = w.HANDLE
k.GetFileInformationByHandle.argtypes = [w.HANDLE, ctypes.c_void_p]
k.GetFileType.argtypes = [w.HANDLE]
k.CloseHandle.argtypes = [w.HANDLE]
k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k.OpenProcess.restype = w.HANDLE
k.GetProcessTimes.argtypes = [w.HANDLE, ctypes.POINTER(w.FILETIME), ctypes.POINTER(w.FILETIME), ctypes.POINTER(w.FILETIME), ctypes.POINTER(w.FILETIME)]
k.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]
k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
INVALID = ctypes.c_void_p(-1).value
held = []
mutated = False

class NativeFileSharingViolation(OSError):
    # Tagged only at CreateFileW, never a generic read/ACL/identity failure.
    pass

class FileInfo(ctypes.Structure):
    _fields_ = [("attributes", w.DWORD), ("creation", w.FILETIME),
                ("access", w.FILETIME), ("write", w.FILETIME), ("volume", w.DWORD),
                ("sizeHigh", w.DWORD), ("sizeLow", w.DWORD), ("links", w.DWORD),
                ("indexHigh", w.DWORD), ("indexLow", w.DWORD)]

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def canonical(name):
    path = Path(name)
    if not path.is_absolute() or str(path.resolve(strict=True)).casefold() != str(path).casefold():
        raise ValueError("Canonical existing native path required")
    for parent in (path, *path.parents):
        if getattr(parent.lstat(), "st_file_attributes", 0) & 0x400:
            raise ValueError("Reparse ancestor refused")
    return path

def open_file(name, write=False, directory=False):
    path = canonical(name)
    access = 0x80020000 | (0x40000000 if write else 0)
    handle = k.CreateFileW(str(path), access, 1, None, 3,
                          0x00200000 | (0x02000000 if directory else 0), None)
    if handle in (None, INVALID):
        error = ctypes.get_last_error()
        if error == 32:
            raise NativeFileSharingViolation(error, "Stable native file unavailable")
        raise OSError(error, "Stable native file unavailable")
    try:
        info = FileInfo()
        if (k.GetFileType(handle) != 1 or
                not k.GetFileInformationByHandle(handle, ctypes.byref(info)) or
                info.attributes & 0x400 or bool(info.attributes & 0x10) != directory or
                (not directory and info.links != 1)):
            raise ValueError("Regular non-aliased native file required")
        return handle
    except:
        k.CloseHandle(handle)
        raise

def identity(handle):
    info = FileInfo()
    if not k.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise OSError("Native file identity unavailable")
    return json.dumps([info.volume, info.indexHigh, info.indexLow,
                       info.creation.dwHighDateTime, info.creation.dwLowDateTime,
                       info.write.dwHighDateTime, info.write.dwLowDateTime,
                       info.sizeHigh, info.sizeLow, info.links, info.attributes],
                      separators=(",", ":"))

def file_bytes(name, private=False, retain=True):
    import msvcrt
    handle = open_file(name)
    fd = None
    try:
        before = identity(handle)
        if private:
            check_acl(None, handle=handle)
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None
        result = bytearray()
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            result.extend(chunk)
            if len(result) > 8388608:
                raise ValueError("Native file budget exceeded")
        native_handle = msvcrt.get_osfhandle(fd)
        if identity(native_handle) != before:
            raise ValueError("Native file changed")
        if private:
            check_acl(None, handle=native_handle)
        if retain:
            held.append(("fd", fd))
            fd = None
        return bytes(result), before
    finally:
        if fd is not None:
            os.close(fd)
        if handle is not None:
            k.CloseHandle(handle)

def inventory(directory, private=False, expected_files=None):
    root = canonical(directory)
    files, directories = {}, {}
    for current, dirs, names in os.walk(root, followlinks=False):
        current = Path(current)
        handle = open_file(current, directory=True)
        held.append(("handle", handle))
        if private:
            check_acl(None, handle=handle)
        directories[current.relative_to(root).as_posix()] = identity(handle)
        for name in dirs:
            if getattr((current/name).lstat(), "st_file_attributes", 0) & 0x400:
                raise ValueError("Source directory alias refused")
        for name in names:
            relative = (current/name).relative_to(root).as_posix()
            raw, ident = file_bytes(current/name, private)
            files[relative] = {"sha256": digest(raw), "identity": ident}
    if {name: value["sha256"] for name, value in files.items()} != (
            p["installedFiles"] if expected_files is None else expected_files):
        raise ValueError("Full installed manifest differs")
    return {"files": files, "directories": directories}

def private_directory(name):
    handle = open_file(name, directory=True)
    held.append(("handle", handle))
    check_acl(None, handle=handle)
    return Path(name)

def snapshot(name):
    raw, ident = file_bytes(name, True)
    return {"nativePath": str(Path(name)), "sha256": digest(raw),
            "identity": ident, "base64": base64.b64encode(raw).decode("ascii")}

def publish(name, raw):
    global mutated
    parent = private_directory(str(Path(name).parent))
    if Path(name).exists() or Path(name).is_symlink():
        raise ValueError("Exclusive output already exists; no replay")
    mutated = True
    fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_BINARY, 0o600)
    try:
        import msvcrt
        check_acl(None, handle=msvcrt.get_osfhandle(fd))
        view = memoryview(raw)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("Partial exclusive write")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    result = snapshot(name)
    if result["sha256"] != digest(raw):
        raise ValueError("Exclusive write postcondition differs")
    private_directory(str(parent))
    return result

def process_handle(value, absent=False):
    if set(value) != {"pid", "birth"} or type(value["pid"]) is not int or value["pid"] <= 0 or not value["birth"]:
        raise ValueError("Exact process tuple required")
    h = k.OpenProcess(0x1000 | 0x00100000, False, value["pid"])
    if not h:
        if absent and ctypes.get_last_error() == 87:
            return None
        raise OSError(ctypes.get_last_error(), "Process identity unavailable")
    try:
        if process_birth(h) != value["birth"]:
            raise ValueError("Old versus new/reused PID mismatch")
        return h
    except:
        k.CloseHandle(h)
        raise

def process_birth(handle):
    times = [w.FILETIME() for _ in range(4)]
    if not k.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
        raise OSError("Process birth unavailable")
    return str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)

def image(handle):
    length = w.DWORD(32768)
    text = ctypes.create_unicode_buffer(length.value)
    if not k.QueryFullProcessImageNameW(handle, 0, text, ctypes.byref(length)):
        raise OSError("Process executable unavailable")
    return text.value

def dead(value):
    h = process_handle(value, True)
    if h is not None:
        try:
            if k.WaitForSingleObject(h, 0) != 0:
                raise ValueError("Original process is still alive")
        finally:
            k.CloseHandle(h)

def alive(value):
    h = process_handle(value)
    try:
        if k.WaitForSingleObject(h, 0) != 258:
            raise ValueError("Launch process exited")
        if image(h).casefold() != p["executable"].casefold():
            raise ValueError("Process image differs from controlled executable")
    finally:
        k.CloseHandle(h)

def normal_original(value):
    if p.get("normal") is not None:
        if os.path.lexists(p["normal"]["retiredProcessPath"]):
            raise ValueError("Original normal retirement output already exists")
        provision, _ = file_bytes(p["paths"]["provision"], True)
        body = strict(provision)
        if (digest(provision) != p["normal"]["provisionSha256"] or
                {"pid": body["pid"], "birth": body["birth"]} != value or
                body["source"] != p["normal"]["source"] or body["build"] != p["normal"]["build"]):
            raise ValueError("Normal close original process/provision/source differs")

def observe_dead(value):
    if p.get("normal") is None:
        raise ValueError("Private normal retirement observation role required")
    normal_original(value)
    dead(value)
    # The source/OS/provision-bound observation is new. It does not assert a
    # successful earlier WM_CLOSE, a termination cause, or historical settlement.
    facts = {"exited": True, "oldPidPresent": False,
             "oldPid": value["pid"], "oldBirth": value["birth"],
             "observation": "exact-original-provision-process-verified-dead",
             "processControl": 0, "originalTerminationOutcome": "UNKNOWN_UNCHANGED",
             "oldExe": p["executable"], "oldExeSha256": p["executableSha256"]}
    dead(value)
    result = publish(p["normal"]["retiredProcessPath"],
                     json.dumps(facts, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    dead(value)
    return result

def normal_close(value):
    normal_original(value)
    h = process_handle(value)
    try:
        if k.WaitForSingleObject(h, 0) != 258 or image(h).casefold() != p["executable"].casefold():
            raise ValueError("Exact original vendor process required")
        u = ctypes.WinDLL("user32", use_last_error=True)
        callback_type = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
        u.EnumThreadWindows.argtypes = [w.DWORD, callback_type, w.LPARAM]
        u.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
        u.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
        u.IsWindowVisible.argtypes = [w.HWND]
        u.IsWindowVisible.restype = w.BOOL
        u.GetWindow.argtypes = [w.HWND, w.UINT]
        u.GetWindow.restype = w.HWND
        u.GetAncestor.argtypes = [w.HWND, w.UINT]
        u.GetAncestor.restype = w.HWND
        u.PostMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
        windows = []
        def inspect(hwnd, _):
            pid = w.DWORD()
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value == value["pid"]:
                name = ctypes.create_unicode_buffer(512)
                # Qt owned popups can share the visible main window's class.
                # NORMAL targets the unique unowned root, never its popup.
                if (u.GetClassNameW(hwnd, name, len(name)) and name.value == p["mainWindowClass"]
                        and (p.get("normal") is None or (
                            u.IsWindowVisible(hwnd) and not u.GetWindow(hwnd, 4)
                            and u.GetAncestor(hwnd, 3) == hwnd))):
                    windows.append(hwnd)
            return True
        # Enumerate GUI windows ONLY on the exact process's native threads,
        # never inspect another application's windows just to filter its PID.
        class ThreadEntry(ctypes.Structure):
            _fields_ = [("size", w.DWORD), ("usage", w.DWORD), ("tid", w.DWORD),
                        ("owner", w.DWORD), ("base", w.LONG), ("delta", w.LONG),
                        ("flags", w.DWORD)]
        k.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
        k.CreateToolhelp32Snapshot.restype = w.HANDLE
        k.Thread32First.argtypes = [w.HANDLE, ctypes.POINTER(ThreadEntry)]
        k.Thread32Next.argtypes = [w.HANDLE, ctypes.POINTER(ThreadEntry)]
        snapshot = k.CreateToolhelp32Snapshot(0x4, 0)
        if snapshot in (None, INVALID):
            raise OSError("Native thread inventory unavailable")
        callback = callback_type(inspect)
        try:
            thread = ThreadEntry()
            thread.size = ctypes.sizeof(thread)
            available = k.Thread32First(snapshot, ctypes.byref(thread))
            while available:
                if thread.owner == value["pid"]:
                    u.EnumThreadWindows(thread.tid, callback, 0)
                available = k.Thread32Next(snapshot, ctypes.byref(thread))
            if ctypes.get_last_error() != 18:
                raise OSError("Native thread inventory incomplete")
        finally:
            k.CloseHandle(snapshot)
        if len(windows) != 1:
            raise ValueError("Unique exact vendor main window required")
        pid = w.DWORD()
        u.GetWindowThreadProcessId(windows[0], ctypes.byref(pid))
        current_class = ctypes.create_unicode_buffer(512)
        if (pid.value != value["pid"] or process_birth(h) != value["birth"]
                or k.WaitForSingleObject(h, 0) != 258
                or (p.get("normal") is not None and (
                    not u.IsWindowVisible(windows[0]) or
                    u.GetWindow(windows[0], 4) or
                    u.GetAncestor(windows[0], 3) != windows[0] or
                    not u.GetClassNameW(windows[0], current_class, len(current_class)) or
                    current_class.value != p["mainWindowClass"]))):
            raise ValueError("Exact original window/process changed")
        # ONE ordinary window-close request, never TerminateProcess/taskkill.
        if not u.PostMessageW(windows[0], 0x0010, 0, 0):
            raise OSError("Normal close input unproven")
        if k.WaitForSingleObject(h, p["normalCloseTimeoutMs"]) != 0:
            raise TimeoutError("Normal close not terminal; no force/replay")
        if process_birth(h) != value["birth"]:
            raise ValueError("Original process birth changed")
        if p.get("normal") is not None:
            facts = {"exited": True, "oldPidPresent": False, "forceUsed": False,
                     "oldPid": value["pid"], "oldBirth": process_birth(h),
                     "observation": "exact-original-process-signaled-after-one-WM_CLOSE",
                     "windowHandle": windows[0], "windowVisibleAtInput": True,
                     "windowClass": p["mainWindowClass"],
                     "oldExe": p["executable"], "oldExeSha256": p["executableSha256"]}
            print(json.dumps({"normalDeathObserved": facts}), file=sys.stderr, flush=True)
            return publish(p["normal"]["retiredProcessPath"],
                           json.dumps(facts, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    finally:
        k.CloseHandle(h)

def replace_profile():
    global mutated
    import msvcrt
    dead(request["old"])
    name = p["paths"]["profile"]
    h = open_file(name, write=True)
    fd = None
    try:
        check_acl(None, handle=h)
        if identity(h) != request["original"]["identity"]:
            raise ValueError("Profile identity changed before apply")
        fd = msvcrt.open_osfhandle(h, os.O_RDWR | os.O_BINARY)
        h = None
        before = bytearray()
        while True:
            value = os.read(fd, 65536)
            if not value:
                break
            before.extend(value)
            if len(before) > 8388608:
                raise ValueError("Profile budget exceeded")
        if digest(before) != request["original"]["sha256"]:
            raise ValueError("Profile bytes changed before apply")
        backup = publish(p["paths"]["profileBackup"], bytes(before))
        planned = base64.b64decode(request["base64"], validate=True)
        mutated = True
        os.lseek(fd, 0, os.SEEK_SET)
        view = memoryview(planned)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("Partial profile write")
            view = view[written:]
        os.ftruncate(fd, len(planned))
        os.fsync(fd)
        check_acl(None, handle=msvcrt.get_osfhandle(fd))
    finally:
        if fd is not None:
            os.close(fd)
        if h is not None:
            k.CloseHandle(h)
    profile = snapshot(name)
    if profile["sha256"] != digest(planned):
        raise ValueError("Profile post-write bytes differ")
    dead(request["old"])
    return {"profile": profile, "backup": backup}

def require_profile(ref):
    actual = snapshot(p["paths"]["profile"])
    if (ref["nativePath"] != actual["nativePath"] or
            ref["identity"] != actual["identity"] or ref["sha256"] != actual["sha256"]):
        raise ValueError("Current actual profile differs")

def launch(source):
    global mutated
    dead(request["old"])
    normal = action == "normal-launch"
    profile_result = normal_prepare(source) if normal else None
    profile = profile_result["profile"] if normal else request["profile"]
    require_profile(profile)
    paths = p["paths"]
    fresh = (("launchAttempt", "launchJournal", "sourceClosure", "transcript") if normal else
             ("intent", "entry", "returned", "launchAttempt", "launchJournal", "sourceClosure", "transcript"))
    for name in fresh:
        private_directory(str(Path(paths[name]).parent))
        if Path(paths[name]).exists() or Path(paths[name]).is_symlink() or (normal and os.path.lexists(paths[name])):
            raise ValueError("Fresh launch paths required")
    closure = publish(paths["sourceClosure"], json.dumps(source, sort_keys=True, separators=(",", ":")).encode())
    attempt = publish(paths["launchAttempt"], json.dumps({
        "kind": "normal-observer-launch-attempt-v1" if normal else "controlled-launch-attempt-v1",
        **({"isolation": "NOT_PROVEN"} if normal else {}),
        "nonce": request["nonce"],
        "old": request["old"], "executable": p["executable"],
        "executableSha256": p["executableSha256"], "profile": profile,
        "sourceClosure": {key: closure[key] for key in ("nativePath", "sha256", "identity")},
    }, sort_keys=True, separators=(",", ":")).encode())
    class Startup(ctypes.Structure):
        _fields_ = [("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR),
                    ("title", w.LPWSTR), ("x", w.DWORD), ("y", w.DWORD),
                    ("xSize", w.DWORD), ("ySize", w.DWORD), ("xChars", w.DWORD),
                    ("yChars", w.DWORD), ("fill", w.DWORD), ("flags", w.DWORD),
                    ("show", w.WORD), ("reservedSize", w.WORD), ("reserved2", ctypes.c_void_p),
                    ("stdin", w.HANDLE), ("stdout", w.HANDLE), ("stderr", w.HANDLE)]
    class ProcessInfo(ctypes.Structure):
        _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]
    k.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                                w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR,
                                ctypes.POINTER(Startup), ctypes.POINTER(ProcessInfo)]
    k.ResumeThread.argtypes = [w.HANDLE]
    k.ResumeThread.restype = w.DWORD
    environment = dict(os.environ)
    environment.update({"PYTHONDONTWRITEBYTECODE": "1",
                        "FUSION_MCP_ADMISSION_PROVISION": paths["provision"]})
    if normal:
        environment.pop("FUSION_MCP_BOOTSTRAP_INTENT", None)
    else:
        environment["FUSION_MCP_BOOTSTRAP_INTENT"] = paths["intent"]
    block = ctypes.create_unicode_buffer("\0".join(key + "=" + value for key, value in sorted(environment.items(), key=lambda item: item[0].upper())) + "\0\0")
    command = ctypes.create_unicode_buffer(subprocess.list2cmdline([p["executable"], *p["arguments"]]))
    startup, created = Startup(), ProcessInfo()
    startup.cb = ctypes.sizeof(startup)
    # A GUI/vendor child must not retain the operator's stdin/result pipes.
    # Windows otherwise supplies parent standard handles even though no general
    # handle inheritance was requested. No bootstrap JSON is child stdin.
    startup.flags = 0x00000100
    startup.stdin = None
    startup.stdout = None
    startup.stderr = None
    mutated = True
    canonical(p["workingDirectory"])
    if normal:
        normal_checkpoint("ready-before-create")
        normal_fence(source)
        require_profile(profile)
    if not k.CreateProcessW(p["executable"], command, None, None, False,
                            0x00000004 | 0x00000400, block, p["workingDirectory"],
                            ctypes.byref(startup), ctypes.byref(created)):
        raise OSError(ctypes.get_last_error(), "Controlled CreateProcess failed")
    try:
        value = {"pid": created.pid, "birth": process_birth(created.process)}
        # Preserve the actual created tuple even if the exclusive post-create
        # journal or resume fails. Never lose it and rediscover another process.
        print(json.dumps({"createdProcess": value, "attempt": paths["launchAttempt"]}),
              file=sys.stderr, flush=True)
        if (value["pid"] == request["old"]["pid"] or value["birth"] == request["old"]["birth"]
                or image(created.process).casefold() != p["executable"].casefold()):
            raise ValueError("CreateProcess origin differs")
        journal = publish(paths["launchJournal"], json.dumps({
            "kind": "normal-observer-created-process-v1" if normal else "controlled-created-process-v1",
            "nonce": request["nonce"],
            "process": value, "executable": p["executable"],
            **({"threadId": created.tid, "phase": "created-suspended", "isolation": "NOT_PROVEN"} if normal else {}),
            "executableSha256": p["executableSha256"],
            "attempt": {key: attempt[key] for key in ("nativePath", "sha256", "identity")},
        }, sort_keys=True, separators=(",", ":")).encode())
        cold = publish(p["normal"]["coldProcessPath"], json.dumps({
            "pid": created.pid, "birth": process_birth(created.process), "exe": image(created.process),
            "executableSha256": p["executableSha256"], "nonce": request["nonce"],
            "phase": "created-suspended", "isolation": "NOT_PROVEN",
        }, sort_keys=True, separators=(",", ":")).encode()) if normal else None
        bound = normal_bind(created, source, profile) if normal else None
        if normal:
            normal_release_database()
        resumed = k.ResumeThread(created.thread)
        if resumed == 0xffffffff or (normal and resumed != 1):
            raise OSError("Controlled process resume unknown")
        # Never rediscover another PID, retry, force-resume or terminate on error.
        alive(value)
        result = {"process": value, "journal": journal, "attempt": attempt, "sourceClosure": closure}
        if normal:
            result.update({"profile": profile_result["profile"], "profileBackup": profile_result["backup"],
                           "provisionBackup": bound["backup"], "provision": bound["provision"],
                           "provisionReceipt": bound["receipt"], "coldProcess": cold})
        return result
    finally:
        k.CloseHandle(created.thread)
        k.CloseHandle(created.process)

# NORMAL_OBSERVER_PRIVATE_EXTENSION

try:
    if str(Path(sys.executable).resolve()).casefold() != p["nativePython"].casefold():
        raise ValueError("Pinned native interpreter path differs")
    interpreter, _ = file_bytes(p["nativePython"])
    if digest(interpreter) != p["nativePythonSha256"]:
        raise ValueError("Pinned native interpreter bytes differ")
    helper_before = inventory(p["sourceDirectory"])
    sys.path.insert(0, p["sourceDirectory"])
    from lib.physical_authority import _check_windows_acl as check_acl
    helper = inventory(p["sourceDirectory"], True)
    if helper_before != helper:
        raise ValueError("Qualified helper source changed before import")
    expected = e["expectedSource"]
    if expected is not None and expected["helper"] != helper:
        raise ValueError("Qualified helper identities changed")
    installed = None
    if (p.get("normal") is not None or action not in ("dead", "normal-close")
            or expected is not None and expected["installed"] is not None):
        installed = inventory(p["installedDirectory"], True,
                              p["normal"]["installedFiles"] if p.get("normal") is not None else None)
        if expected is not None and expected["installed"] is not None and expected["installed"] != installed:
            raise ValueError("Installed source identities changed")
    source = {"helper": helper, "installed": installed}
    executable, _ = file_bytes(p["executable"])
    if digest(executable) != p["executableSha256"]:
        raise ValueError("Controlled executable bytes differ")
    if action == "preflight":
        private_directory(p["paths"]["receiptDirectory"])
        result = None
    elif action == "dead":
        dead(request["process"])
        result = None
    elif action == "normal-close":
        result = normal_close(request["process"])
    elif action == "observe-dead":
        result = observe_dead(request["process"])
    elif action == "assert-process":
        alive(request["process"])
        result = None
    elif action == "read-profile":
        dead(request["process"])
        result = snapshot(p["paths"]["profile"])
        dead(request["process"])
    elif action == "replace-profile":
        result = replace_profile()
    elif action == "read":
        if request["path"] not in [*p["paths"].values(), *p["originalPaths"]]:
            raise ValueError("Unpinned original path")
        result = snapshot(request["path"])
    elif action == "publish":
        name = request["path"]
        if name not in [p["paths"][key] for key in ("intent", "transcript")]:
            raise ValueError("Unpinned exclusive output path")
        if name == p["paths"]["intent"]:
            for key in ("entry", "returned"):
                if Path(p["paths"][key]).exists():
                    raise ValueError("Unexpected entry before private intent")
        result = publish(name, base64.b64decode(request["base64"], validate=True))
    elif action in ("launch", "normal-launch"):
        result = launch(source)
    elif action == "receipts":
        deadline = time.monotonic() + p["receiptTimeoutMs"] / 1000
        # Keep one pinned entry handle while its separate returned file is pending.
        entry = None
        while True:
            alive(request["process"])
            try:
                if entry is None:
                    entry = snapshot(p["paths"]["entry"])
                result = {"entry": entry,
                          "returned": snapshot(p["paths"]["returned"])}
                break
            except (FileNotFoundError, NativeFileSharingViolation):
                if time.monotonic() >= deadline:
                    raise TimeoutError("Original receipt pair incomplete; no replay")
                time.sleep(0.05)
    else:
        raise ValueError("Unknown native action")
    after = {"helper": inventory(p["sourceDirectory"], True),
             "installed": inventory(p["installedDirectory"], True,
                                    p["normal"]["installedFiles"] if p.get("normal") is not None else None)
                          if installed is not None else None}
    if source != after:
        raise ValueError("Full source after-fence differs")
    print(json.dumps({"kind": "controlled-fusion-native-v1", "action": action,
                      "source": source, "result": result}, separators=(",", ":")))
finally:
    for kind, handle in reversed(held):
        if kind == "fd":
            os.close(handle)
        else:
            k.CloseHandle(handle)
`;

export function normalObserverFusionLaunchNative() {
  const {
    normalObserverLaunchNative,
  }: typeof import("./normal-observer-launch-native") = createRequire(
    __filename,
  )("./normal-observer-launch-native");
  return controlledFusionLaunchNative.replace(
    "# NORMAL_OBSERVER_PRIVATE_EXTENSION",
    normalObserverLaunchNative,
  );
}

/** Keep the closed, build-pinned program off Windows' 32K command-line limit.
 * Only private composition sends this length-framed source; the invocation
 * envelope and continuation decisions remain separate stdin records.
 */
export const normalObserverNativeBootstrap = String.raw`
import sys
length=sys.stdin.buffer.readline(16)
if not length.endswith(b"\n") or not length[:-1].isdigit():
    raise ValueError("Private native program frame required")
size=int(length)
if not 1 <= size <= 262144:
    raise ValueError("Private native program budget exceeded")
program=sys.stdin.buffer.read(size)
if len(program)!=size:
    raise ValueError("Incomplete private native program")
exec(compile(program,"<fmcad-private-normal-launch>","exec"))
`;

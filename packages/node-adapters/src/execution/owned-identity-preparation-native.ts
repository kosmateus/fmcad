/** Private, bounded Identity process preparation for the separate OWNED launch. */
export const ownedIdentityPreparationNative = String.raw`
import datetime, re

owned_identity_state = None

def owned_identity_file_versions(name):
    version = ctypes.WinDLL("version", use_last_error=True)
    version.GetFileVersionInfoSizeW.argtypes = [w.LPCWSTR, ctypes.POINTER(w.DWORD)]
    version.GetFileVersionInfoSizeW.restype = w.DWORD
    version.GetFileVersionInfoW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p]
    version.VerQueryValueW.argtypes = [
        ctypes.c_void_p, w.LPCWSTR, ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(w.UINT),
    ]
    ignored = w.DWORD()
    size = version.GetFileVersionInfoSizeW(name, ctypes.byref(ignored))
    if not size or size > 1048576:
        raise ValueError("Pinned Identity version resource unavailable")
    data = ctypes.create_string_buffer(size)
    if not version.GetFileVersionInfoW(name, 0, size, data):
        raise OSError(ctypes.get_last_error(), "Identity version resource unreadable")
    value, length = ctypes.c_void_p(), w.UINT()
    if not version.VerQueryValueW(
            data, "\\VarFileInfo\\Translation", ctypes.byref(value), ctypes.byref(length)):
        raise ValueError("Identity version translation unavailable")
    units = length.value // ctypes.sizeof(w.WORD)
    translations = ctypes.cast(value, ctypes.POINTER(w.WORD * units)).contents
    result = set()
    for index in range(0, len(translations), 2):
        locale, codepage = translations[index:index + 2]
        for key in ("FileVersion", "ProductVersion"):
            query = f"\\StringFileInfo\\{locale:04x}{codepage:04x}\\{key}"
            text, count = ctypes.c_void_p(), w.UINT()
            if version.VerQueryValueW(data, query, ctypes.byref(text), ctypes.byref(count)) and count.value:
                result.add(ctypes.wstring_at(text.value, count.value).rstrip("\0").strip())
    return result

def owned_identity_check_image():
    config = p["identity"]
    path = canonical(config["executable"])
    raw, _ = file_bytes(path, retain=False)
    if (digest(raw) != config["sha256"]
            or config["version"] not in owned_identity_file_versions(str(path))):
        raise ValueError("Pinned Identity executable hash/version differs")

def owned_identity_log_snapshot(name, offset=0, expected_identity=None):
    import msvcrt
    path = Path(name)
    canonical(str(path.parent))
    if not os.path.lexists(path):
        if expected_identity is not None:
            raise ValueError("Pinned Identity log disappeared")
        return b"", 0, None
    canonical(str(path))
    handle = k.CreateFileW(str(path), 0x80020000, 0x7, None, 3, 0x00200000, None)
    if handle in (None, INVALID):
        raise OSError(ctypes.get_last_error(), "Identity log unavailable")
    fd = None
    try:
        info = FileInfo()
        if (k.GetFileType(handle) != 1
                or not k.GetFileInformationByHandle(handle, ctypes.byref(info))
                or info.attributes & 0x400 or info.attributes & 0x10 or info.links != 1):
            raise ValueError("Regular non-aliased Identity log required")
        before = identity(handle)
        stable = owned_identity_stable_file_identity(before)
        if expected_identity is not None and stable != expected_identity:
            raise ValueError("Identity log file identity changed")
        size = (info.sizeHigh << 32) | info.sizeLow
        if offset < 0 or offset > size:
            raise ValueError("Identity log was truncated or replaced")
        start = max(offset, size - 4194304)
        if start > offset and offset != 0:
            raise ValueError("Identity log exceeded the bounded post-start window")
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None
        os.lseek(fd, start, os.SEEK_SET)
        raw = bytearray()
        remaining = size - start
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                raise ValueError("Identity log changed during bounded read")
            raw.extend(chunk)
            remaining -= len(chunk)
        after = identity(msvcrt.get_osfhandle(fd))
        if stable != owned_identity_stable_file_identity(after):
            raise ValueError("Identity log file identity changed during read")
        return bytes(raw), start, stable
    finally:
        if fd is not None:
            os.close(fd)
        if handle is not None:
            k.CloseHandle(handle)

def owned_identity_stable_file_identity(value):
    numbers = strict(value)
    return tuple(numbers[:5] + numbers[9:10])

def owned_identity_timestamp(line):
    match = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) ", line)
    if not match:
        return None
    value = datetime.datetime.fromisoformat(match.group(1).replace("Z", "+00:00"))
    return int((value - datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)).total_seconds() * 10000000)

def owned_identity_log_event(raw, base_offset, process):
    events = []
    position = base_offset
    for data in raw.splitlines(keepends=True):
        offset = position
        position += len(data)
        if not data.endswith(b"\n"):
            continue
        text = data.decode("utf-8", errors="strict").rstrip("\r\n")
        match = re.match(
            r"^\d{4}-\d{2}-\d{2}T[^ ]+ \[AdskIdentityManager:(\d+), \d+\] "
            r"\[AdskIdentityManager INFO\] (.*)$", text,
        )
        if not match or int(match.group(1)) != process["pid"]:
            continue
        timestamp = owned_identity_timestamp(text)
        if timestamp is not None and timestamp > int(process["birth"]):
            events.append((offset, timestamp, text, match.group(2)))
    config = p["identity"]
    expected_image = config["executable"].replace("/", "\\").casefold()
    expected_args = " ".join(config["arguments"])
    start = arguments = ready = None
    for event in events:
        offset, timestamp, text, message = event
        if message.startswith("Starting Autodesk IDSDK Server process "):
            version_match = re.search(r"\(Version: ([^ ]+) ", message)
            image_match = re.search(r"File: (.+)\)$", message)
            if (version_match and version_match.group(1) == config["version"]
                    and image_match
                    and image_match.group(1).replace("/", "\\").casefold() == expected_image):
                start = event
        elif message == "Command line arguments: " + expected_args:
            arguments = event
        elif message == "SSO Server is ready":
            ready = event
    # Log timestamps have millisecond precision; serialized byte offsets prove
    # strict event order even when two or all three timestamps share one tick.
    if (start is None or arguments is None or ready is None
            or not start[0] < arguments[0] < ready[0]
            or not start[1] <= arguments[1] <= ready[1]):
        return None
    return {
        "pid": process["pid"], "timestamp": ready[2][:24],
        "offset": ready[0], "line": ready[2],
    }

def owned_identity_process_candidates():
    class Entry(ctypes.Structure):
        _fields_ = [
            ("size", w.DWORD), ("usage", w.DWORD), ("pid", w.DWORD),
            ("heap", ctypes.c_size_t), ("module", w.DWORD), ("threads", w.DWORD),
            ("parent", w.DWORD), ("priority", w.LONG), ("flags", w.DWORD),
            ("name", w.WCHAR * 260),
        ]
    k.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    k.CreateToolhelp32Snapshot.restype = w.HANDLE
    k.Process32FirstW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
    k.Process32FirstW.restype = w.BOOL
    k.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(Entry)]
    k.Process32NextW.restype = w.BOOL
    snapshot = k.CreateToolhelp32Snapshot(0x2, 0)
    if snapshot in (None, INVALID):
        raise OSError(ctypes.get_last_error(), "Identity process inventory unavailable")
    found = []
    try:
        entry = Entry()
        entry.size = ctypes.sizeof(entry)
        ctypes.set_last_error(0)
        available = k.Process32FirstW(snapshot, ctypes.byref(entry))
        while available:
            if entry.name.casefold() == Path(p["identity"]["executable"]).name.casefold():
                handle = k.OpenProcess(0x1000 | 0x00100000, False, entry.pid)
                if not handle:
                    if ctypes.get_last_error() == 87:
                        ctypes.set_last_error(0)
                        available = k.Process32NextW(snapshot, ctypes.byref(entry))
                        continue
                    raise OSError(ctypes.get_last_error(), "Identity candidate process unavailable")
                try:
                    if k.WaitForSingleObject(handle, 0) == 258:
                        value = {"pid": int(entry.pid), "birth": process_birth(handle)}
                        observed_image = image(handle)
                        found.append((value, handle, observed_image))
                        handle = None
                finally:
                    if handle not in (None, INVALID):
                        k.CloseHandle(handle)
            ctypes.set_last_error(0)
            available = k.Process32NextW(snapshot, ctypes.byref(entry))
        if ctypes.get_last_error() not in (0, 18):
            raise OSError(ctypes.get_last_error(), "Identity process inventory incomplete")
        return found
    except:
        for _, handle, _ in found:
            k.CloseHandle(handle)
        raise
    finally:
        k.CloseHandle(snapshot)

def owned_identity_mutex(timeout_ms):
    k.CreateMutexW.argtypes = [ctypes.c_void_p, w.BOOL, w.LPCWSTR]
    k.CreateMutexW.restype = w.HANDLE
    k.ReleaseMutex.argtypes = [w.HANDLE]
    config = p["identity"]
    name = "Local\\Fmcad-Identity-" + digest(
        (config["executable"].casefold() + "\0" + " ".join(config["arguments"])).encode(
            "utf-8"
        )
    )
    handle = k.CreateMutexW(None, False, name)
    if not handle:
        raise OSError(ctypes.get_last_error(), "Identity startup mutex unavailable")
    result = k.WaitForSingleObject(handle, max(0, timeout_ms))
    if result not in (0, 0x80):
        k.CloseHandle(handle)
        raise TimeoutError("Identity startup mutex wait exceeded its bound")
    return handle

def owned_identity_ref(value):
    return {key: value[key] for key in ("nativePath", "sha256", "identity")}

def owned_identity_attempt(source, old, profile, nonce, paths, launch_attempt, closure):
    global mutated, owned_identity_state
    config = p["identity"]
    if (set(config) != {"executable", "sha256", "version", "arguments",
                        "logFile", "preparationTimeoutMs"}
            or config["arguments"] != [
                "--process_name", "Autodesk.IDSDK.DefaultProcess-v2",
                "--server_name", "Autodesk.IDSDK.DefaultServer-v2",
            ]
            or not re.fullmatch(r"[a-f0-9]{64}", config["sha256"])
            or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", config["version"])
            or type(config["preparationTimeoutMs"]) is not int
            or not 100 <= config["preparationTimeoutMs"] <= 30000):
        raise ValueError("Exact bounded Identity preparation pins required")
    deadline = time.monotonic() + config["preparationTimeoutMs"] / 1000
    mutex = owned_identity_mutex(int((deadline - time.monotonic()) * 1000))
    candidates = []
    process = None
    process_handle_value = None
    thread_handle = None
    created = None
    attempt = journal = terminal = None
    origin = "adopted"
    try:
        owned_identity_check_image()
        candidates = owned_identity_process_candidates()
        if len(candidates) > 1:
            raise ValueError("Multiple Identity image candidates; refusing another start")
        if candidates:
            process, process_handle_value, observed_image = candidates[0]
            if observed_image.casefold() != config["executable"].casefold():
                raise ValueError("Existing Identity candidate image differs; no second start")
        else:
            origin = "spawned"
            process, observed_image = None, config["executable"]
        if origin == "spawned":
            previous, base_offset, log_identity = owned_identity_log_snapshot(config["logFile"])
            baseline_raw, baseline, log_identity = owned_identity_log_snapshot(
                config["logFile"], base_offset, log_identity,
            )
            if baseline != base_offset:
                raise ValueError("Identity log baseline changed")
            log_offset = baseline + len(baseline_raw)
        else:
            # Existing ready processes must be proved from their birth, not only
            # from log bytes written after this request began.
            log_offset = 0
            _, _, log_identity = owned_identity_log_snapshot(config["logFile"])
        for key in ("identityAttempt", "identityJournal", "identityPreparation"):
            private_directory(str(Path(paths[key]).parent))
            if os.path.lexists(paths[key]):
                raise ValueError("Fresh owned Identity receipt paths required; no replay")
        attempt = publish(paths["identityAttempt"], json.dumps({
            "kind": "owned-identity-preparation-attempt-v1", "authority": "NONE",
            "nonce": nonce, "fusionOld": old, "profile": profile,
            "fusionLaunchAttempt": owned_identity_ref(launch_attempt),
            "sourceClosure": owned_identity_ref(closure),
            "identity": {
                "executable": config["executable"], "sha256": config["sha256"],
                "version": config["version"], "arguments": config["arguments"],
                "commandLine": subprocess.list2cmdline(
                    [config["executable"], *config["arguments"]]
                ),
            },
            "log": {"path": config["logFile"], "offset": log_offset,
                    "fileIdentity": log_identity},
        }, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        command_line = subprocess.list2cmdline(
            [config["executable"], *config["arguments"]]
        )
        if process is None:
            class IdentityStartup(ctypes.Structure):
                _fields_ = [
                    ("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR),
                    ("title", w.LPWSTR), ("x", w.DWORD), ("y", w.DWORD),
                    ("xSize", w.DWORD), ("ySize", w.DWORD), ("xChars", w.DWORD),
                    ("yChars", w.DWORD), ("fill", w.DWORD), ("flags", w.DWORD),
                    ("show", w.WORD), ("reservedSize", w.WORD),
                    ("reserved2", ctypes.c_void_p), ("stdin", w.HANDLE),
                    ("stdout", w.HANDLE), ("stderr", w.HANDLE),
                ]
            class ProcessInfo(ctypes.Structure):
                _fields_ = [
                    ("process", w.HANDLE), ("thread", w.HANDLE),
                    ("pid", w.DWORD), ("tid", w.DWORD),
                ]
            k.CreateProcessW.argtypes = [
                w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL,
                w.DWORD, ctypes.c_void_p, w.LPCWSTR, ctypes.POINTER(IdentityStartup),
                ctypes.POINTER(ProcessInfo),
            ]
            k.CreateProcessW.restype = w.BOOL
            k.ResumeThread.argtypes = [w.HANDLE]
            k.ResumeThread.restype = w.DWORD
            startup, created = IdentityStartup(), ProcessInfo()
            startup.cb = ctypes.sizeof(startup)
            startup.flags = 0x00000100
            command = ctypes.create_unicode_buffer(command_line)
            mutated = True
            if not k.CreateProcessW(
                    config["executable"], command, None, None, False, 0x00000004,
                    None, str(Path(config["executable"]).parent),
                    ctypes.byref(startup), ctypes.byref(created)):
                raise OSError(ctypes.get_last_error(), "Pinned Identity process start failed")
            process_handle_value, thread_handle = created.process, created.thread
            process = {"pid": int(created.pid), "birth": process_birth(created.process)}
            print(json.dumps({
                "createdIdentityProcess": process,
                "commandLine": command_line,
                "attempt": paths["identityAttempt"],
            }), file=sys.stderr, flush=True)
            if (process["pid"] <= 0
                    or image(created.process).casefold() != config["executable"].casefold()
                    or process_birth(created.process) != process["birth"]):
                raise ValueError("Created Identity process origin differs")
            observed_image = image(created.process)
            owned_identity_check_image()
            journal = publish(paths["identityJournal"], json.dumps({
                "kind": "owned-identity-process-v1", "authority": "NONE",
                "nonce": nonce, "origin": origin, "process": process,
                "executable": config["executable"], "image": observed_image,
                "sha256": config["sha256"], "version": config["version"],
                "arguments": config["arguments"], "commandLine": command_line,
                "attempt": owned_identity_ref(attempt),
                "fusionLaunchAttempt": owned_identity_ref(launch_attempt),
                "state": "CREATED_SUSPENDED",
            }, sort_keys=True, separators=(",", ":")).encode("utf-8"))
            if k.ResumeThread(thread_handle) != 1:
                raise OSError("Identity resume outcome unknown; preserve receipts")
            k.CloseHandle(thread_handle)
            thread_handle = None
        else:
            journal = publish(paths["identityJournal"], json.dumps({
                "kind": "owned-identity-process-v1", "authority": "NONE",
                "nonce": nonce, "origin": origin, "process": process,
                "executable": config["executable"], "image": observed_image,
                "sha256": config["sha256"], "version": config["version"],
                "arguments": config["arguments"], "commandLine": command_line,
                "attempt": owned_identity_ref(attempt),
                "fusionLaunchAttempt": owned_identity_ref(launch_attempt),
                "state": "ADOPTED",
            }, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        if (process_birth(process_handle_value) != process["birth"]
                or k.WaitForSingleObject(process_handle_value, 0) != 258
                or image(process_handle_value).casefold() != config["executable"].casefold()):
            raise ValueError("Identity process tuple/image/liveness differs")
        owned_identity_check_image()
        u = ctypes.WinDLL("user32", use_last_error=True)
        u.WaitForInputIdle.argtypes = [w.HANDLE, w.DWORD]
        u.WaitForInputIdle.restype = w.DWORD
        remaining = max(0, int((deadline - time.monotonic()) * 1000))
        idle = u.WaitForInputIdle(process_handle_value, remaining)
        if idle != 0:
            raise TimeoutError("Bounded Identity input-idle preparation not observed")
        log_event = None
        expected_log_identity = log_identity
        while time.monotonic() < deadline:
            raw, base_offset, actual_identity = owned_identity_log_snapshot(
                config["logFile"], log_offset, expected_log_identity,
            )
            if expected_log_identity is None and actual_identity is not None:
                expected_log_identity = actual_identity
            if actual_identity is not None:
                log_event = owned_identity_log_event(raw, base_offset, process)
            if log_event is not None:
                break
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        if log_event is None:
            raise TimeoutError("PID/birth-bound Identity preparation event not observed")
        if (process_birth(process_handle_value) != process["birth"]
                or k.WaitForSingleObject(process_handle_value, 0) != 258
                or image(process_handle_value).casefold() != config["executable"].casefold()):
            raise ValueError("Identity process tuple changed during preparation")
        owned_identity_check_image()
        preparation = {
            "kind": "owned-identity-preparation-v1", "authority": "NONE",
            "state": "PREPARATION_ONLY_NOT_SERVICE_READY", "origin": origin,
            "process": process, "executable": config["executable"],
            "sha256": config["sha256"], "version": config["version"],
            "arguments": config["arguments"], "commandLine": command_line,
            "inputIdleCode": idle, "logEvent": log_event,
            "attempt": owned_identity_ref(attempt),
            "identityJournal": owned_identity_ref(journal),
            "fusionLaunchAttempt": owned_identity_ref(launch_attempt),
        }
        terminal = publish(
            paths["identityPreparation"],
            json.dumps(preparation, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        )
        owned_identity_state = {
            "process": process, "logOffset": log_offset,
            "logIdentity": expected_log_identity, "logEvent": log_event,
            "attempt": attempt, "journal": journal, "terminal": terminal,
            "preparation": preparation,
        }
        return {
            "attempt": attempt, "journal": journal, "terminal": terminal,
            "preparation": preparation,
        }
    except Exception as error:
        if created is not None and process is None:
            process = {"pid": int(created.pid), "birth": None}
            try:
                process["birth"] = process_birth(created.process)
            except Exception:
                pass
        if attempt is not None and terminal is None:
            try:
                terminal = publish(paths["identityPreparation"], json.dumps({
                    "kind": "owned-identity-preparation-v1", "authority": "NONE",
                    "state": "UNKNOWN", "nonce": nonce, "origin": origin,
                    "process": process, "error": type(error).__name__,
                    "attempt": owned_identity_ref(attempt),
                    "identityJournal": owned_identity_ref(journal) if journal is not None else None,
                    "fusionLaunchAttempt": owned_identity_ref(launch_attempt),
                }, sort_keys=True, separators=(",", ":")).encode("utf-8"))
            except:
                pass
        raise
    finally:
        if thread_handle not in (None, INVALID):
            k.CloseHandle(thread_handle)
        if process_handle_value not in (None, INVALID):
            k.CloseHandle(process_handle_value)
        for _, handle, _ in candidates:
            if handle not in (None, INVALID) and handle != process_handle_value:
                k.CloseHandle(handle)
        k.ReleaseMutex(mutex)
        k.CloseHandle(mutex)

def owned_identity_assert_current():
    state = owned_identity_state
    if state is None:
        raise ValueError("Owned Identity preparation receipt absent before resume")
    config = p["identity"]
    handle = process_handle(state["process"])
    try:
        if (k.WaitForSingleObject(handle, 0) != 258
                or image(handle).casefold() != config["executable"].casefold()
                or process_birth(handle) != state["process"]["birth"]):
            raise ValueError("Pinned Identity process changed before Fusion resume")
        owned_identity_check_image()
        raw, offset, log_identity = owned_identity_log_snapshot(
            config["logFile"], state["logOffset"], state["logIdentity"],
        )
        event = owned_identity_log_event(raw, offset, state["process"])
        if log_identity != state["logIdentity"] or event != state["logEvent"]:
            raise ValueError("Pinned Identity log event changed before Fusion resume")
        for key, ref in (
            ("identityAttempt", state["attempt"]),
            ("identityJournal", state["journal"]),
            ("identityPreparation", state["terminal"]),
        ):
            if snapshot(p["paths"][key]) != ref:
                raise ValueError("Owned Identity receipt changed before Fusion resume")
    finally:
        k.CloseHandle(handle)
`;

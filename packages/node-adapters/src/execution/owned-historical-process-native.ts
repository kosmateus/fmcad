/** Read-only historical tuple absence; never a current-process control grant. */
export const ownedHistoricalProcessNative = String.raw`
def owned_process_creation_snapshot(target_pid):
    # SYSTEM_PROCESS_INFORMATION's native ABI prefix on 64-bit
    # Windows. Validate layout and our own exact kernel creation time before
    # trusting any target entry. No image pointers or protected handles used.
    if ctypes.sizeof(ctypes.c_void_p) != 8:
        raise ValueError("Historical inventory requires native 64-bit ABI")
    class UnicodeString(ctypes.Structure):
        _fields_ = [("length", ctypes.c_uint16), ("maximum", ctypes.c_uint16),
                    ("buffer", ctypes.c_void_p)]
    class ProcessPrefix(ctypes.Structure):
        _fields_ = [
            ("next", ctypes.c_uint32), ("threads", ctypes.c_uint32),
            ("privateWorkingSet", ctypes.c_int64),
            ("hardFaults", ctypes.c_uint32), ("threadHighWatermark", ctypes.c_uint32),
            ("cycleTime", ctypes.c_uint64), ("created", ctypes.c_int64),
            ("userTime", ctypes.c_int64), ("kernelTime", ctypes.c_int64),
            ("name", UnicodeString), ("priority", ctypes.c_int32),
            ("pid", ctypes.c_void_p),
        ]
    if (ProcessPrefix.created.offset != 32 or ProcessPrefix.pid.offset != 80
            or ctypes.sizeof(ProcessPrefix) != 88):
        raise ValueError("Historical inventory ABI layout differs")
    nt = ctypes.WinDLL("ntdll.dll", use_last_error=True)
    query = nt.NtQuerySystemInformation
    query.argtypes = [ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32,
                      ctypes.POINTER(ctypes.c_uint32)]
    query.restype = ctypes.c_int32
    size = 65536
    for _ in range(12):
        if size > 64 * 1024 * 1024:
            raise ValueError("Historical inventory size budget exceeded")
        buffer = ctypes.create_string_buffer(size)
        returned = ctypes.c_uint32()
        status = query(5, buffer, size, ctypes.byref(returned)) & 0xffffffff
        if status == 0xc0000004:
            size = max(size * 2, int(returned.value))
            continue
        if status != 0:
            raise OSError(status, "Historical kernel inventory unavailable")
        if not ctypes.sizeof(ProcessPrefix) <= returned.value <= size:
            raise ValueError("Historical inventory returned length differs")
        break
    else:
        raise ValueError("Historical inventory growth budget exceeded")
    k.GetCurrentProcessId.restype = w.DWORD
    k.GetCurrentProcess.restype = w.HANDLE
    self_pid = int(k.GetCurrentProcessId())
    self_birth = process_birth(k.GetCurrentProcess())
    found = {}
    offset = 0
    while True:
        if offset + ctypes.sizeof(ProcessPrefix) > returned.value:
            raise ValueError("Historical inventory record truncated")
        entry = ProcessPrefix.from_buffer(buffer, offset)
        pid = int(entry.pid or 0)
        if pid in (target_pid, self_pid):
            if pid in found or entry.created <= 0:
                raise ValueError("Historical inventory ambiguous creation time")
            found[pid] = str(entry.created)
        advance = int(entry.next)
        if advance == 0:
            break
        if (advance < ctypes.sizeof(ProcessPrefix)
                or offset + advance > returned.value):
            raise ValueError("Historical inventory record offset differs")
        offset += advance
    if found.get(self_pid) != self_birth:
        raise ValueError("Historical inventory exact self-birth check failed")
    return found.get(target_pid)

def owned_historical_dead(value):
    # This is ONLY used for old lineage evidence. process_handle/alive and all
    # current lifecycle/control paths retain their strict original contract.
    if (type(value) is not dict or set(value) != {"pid", "birth"}
            or type(value["pid"]) is not int or not 0 < value["pid"] <= 0xffffffff
            or type(value["birth"]) is not str or not value["birth"].isdigit()
            or not value["birth"].isascii() or value["birth"].startswith("0")
            or len(value["birth"]) > 19 or not 0 < int(value["birth"]) <= 0x7fffffffffffffff):
        raise ValueError("Exact historical process tuple required")
    handle = k.OpenProcess(0x1000 | 0x00100000, False, value["pid"])
    if handle:
        try:
            actual_birth = process_birth(handle)
            if actual_birth != value["birth"]:
                return "ORIGINAL_TUPLE_NOT_CURRENT"
            if k.WaitForSingleObject(handle, 0) != 0:
                raise ValueError("Original historical process is still alive")
            return "ORIGINAL_PROCESS_SIGNALED"
        finally:
            k.CloseHandle(handle)
    error = ctypes.get_last_error()
    if error == 87:
        return "ORIGINAL_PID_ABSENT"
    if error != 5:
        raise OSError(error, "Historical process identity unavailable")
    first = owned_process_creation_snapshot(value["pid"])
    second = owned_process_creation_snapshot(value["pid"])
    if (type(first) is not str or second != first or first == value["birth"]
            or not first.isascii() or not first.isdigit() or first.startswith("0")
            or len(first) > 19 or not 0 < int(first) <= 0x7fffffffffffffff):
        raise ValueError("Historical PID reuse not proved by stable exact birth")
    return "ORIGINAL_TUPLE_NOT_CURRENT"
`;

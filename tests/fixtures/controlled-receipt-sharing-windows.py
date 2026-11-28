"""Run the actual native receipts protocol against an owned Windows writer FD.

No Fusion/SDK imports, application control, admission state or original receipts.
The trace hook only observes the real CreateFileW sharing failure and releases
the fixture writer; it never changes the native program or fabricates an error.
"""
import base64
import contextlib
import ctypes
import getpass
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from ctypes import wintypes as w

config = json.load(sys.stdin)
mode = config["case"]
if mode not in (
    "entry", "returned", "entry-timeout", "returned-timeout",
    "missing-returned", "hardlink", "public-acl", "directory-entry",
):
    raise ValueError("Closed sharing fixture case required")
root = Path(tempfile.mkdtemp(prefix="fmcad-receipt-sharing-"))
release = threading.Event()
writer_ready = threading.Event()
thread_errors = []
writer = None
original_stdin = sys.stdin
observed = {"sharingErrors": 0, "entrySnapshots": 0, "returnedSnapshots": 0}
entry_bytes = b'{"kind":"sdk-free-entry-fixture","complete":true}'
returned_bytes = b'{"kind":"sdk-free-returned-fixture","complete":true}'

try:
    subprocess.run([
        str(Path(os.environ["SystemRoot"]) / "System32" / "icacls.exe"),
        str(root), "/inheritance:r", "/grant:r", getpass.getuser() + ":(OI)(CI)F",
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    source = root / "helper"
    installed = root / "installed"
    shutil.copytree(config["sourceDirectory"], source, copy_function=shutil.copyfile)
    shutil.copytree(config["sourceDirectory"], installed, copy_function=shutil.copyfile)
    private = root / "private"
    private.mkdir()
    entry = private / "entry.json"
    returned = private / "returned.json"
    target = returned if mode.startswith("returned") else entry

    def write_fixture():
        fd = None
        try:
            fd = os.open(str(target), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_BINARY, 0o600)
            os.write(fd, returned_bytes if target == returned else entry_bytes)
            os.fsync(fd)
            other = entry if target == returned else returned
            other.write_bytes(entry_bytes if other == entry else returned_bytes)
            writer_ready.set()
            if not release.wait(15):
                raise TimeoutError("Fixture writer release was not signalled")
        except BaseException as error:
            thread_errors.append(repr(error))
            writer_ready.set()
        finally:
            if fd is not None:
                os.close(fd)

    if mode == "missing-returned":
        entry.write_bytes(entry_bytes)
    elif mode == "hardlink":
        entry.write_bytes(entry_bytes)
        returned.write_bytes(returned_bytes)
        os.link(entry, private / "entry-alias.json")
    elif mode == "public-acl":
        entry.write_bytes(entry_bytes)
        returned.write_bytes(returned_bytes)
        subprocess.run([
            str(Path(os.environ["SystemRoot"]) / "System32" / "icacls.exe"),
            str(entry), "/grant", "*S-1-1-0:R",
        ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    elif mode == "directory-entry":
        entry.mkdir()
        returned.write_bytes(returned_bytes)
    else:
        writer = threading.Thread(target=write_fixture)
        writer.start()
        if not writer_ready.wait(5) or thread_errors:
            raise RuntimeError("Fixture writer did not acquire its file")

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.OpenProcess.restype = w.HANDLE
    kernel.GetProcessTimes.argtypes = [w.HANDLE] + [ctypes.POINTER(w.FILETIME)] * 4
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.GetCurrentProcess.restype = w.HANDLE
    kernel.GetProcessHandleCount.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]

    def handle_count():
        value = w.DWORD()
        if not kernel.GetProcessHandleCount(kernel.GetCurrentProcess(), ctypes.byref(value)):
            raise OSError("Own fixture handle count unavailable")
        return value.value

    handle = kernel.OpenProcess(0x1000, False, os.getpid())
    if not handle:
        raise OSError("Own fixture process handle unavailable")
    try:
        times = [w.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
            raise OSError("Own fixture process birth unavailable")
        birth = str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)
    finally:
        kernel.CloseHandle(handle)
    envelope = {
        "pins": {
            "nativePython": config["nativePython"],
            "nativePythonSha256": config["nativePythonSha256"],
            "sourceDirectory": str(source),
            "installedDirectory": str(installed),
            "installedFiles": config["installedFiles"],
            "executable": config["nativePython"],
            "executableSha256": config["nativePythonSha256"],
            "receiptTimeoutMs": config.get("receiptTimeoutMs", 300),
            "paths": {"receiptDirectory": str(private), "entry": str(entry), "returned": str(returned)},
        },
        "action": "receipts",
        "request": {"process": {"pid": os.getpid(), "birth": birth}},
        "expectedSource": None,
    }

    def trace(frame, event, arg):
        if frame.f_code.co_filename != "actual-native-receipts.py":
            return trace
        if event == "call" and frame.f_code.co_name == "snapshot":
            if "baselineReceiptHandles" not in observed:
                observed["baselineReceiptHandles"] = handle_count()
            if str(frame.f_locals.get("name")) == str(entry):
                observed["entrySnapshots"] += 1
            if str(frame.f_locals.get("name")) == str(returned):
                observed["returnedSnapshots"] += 1
        if event == "exception" and frame.f_code.co_name == "open_file":
            error = arg[1]
            if isinstance(error, OSError) and error.errno == 32 and str(frame.f_locals.get("name")) == str(target):
                observed["sharingErrors"] += 1
                if not mode.endswith("-timeout"):
                    release.set()
        if event == "exception" and isinstance(arg[1], TimeoutError) and "baselineReceiptHandles" in observed:
            observed["receiptOpenHandleGrowthAtTimeout"] = handle_count() - observed["baselineReceiptHandles"]
        return trace

    output = io.StringIO()
    error_result = None
    sys.stdin = io.TextIOWrapper(io.BytesIO((json.dumps(envelope) + "\n").encode("utf-8")))
    sys.settrace(trace)
    started = time.monotonic()
    try:
        with contextlib.redirect_stdout(output):
            exec(compile(config["program"], "actual-native-receipts.py", "exec"), {"__name__": "__main__"})
    except BaseException as error:
        error_result = {"type": type(error).__name__, "errno": getattr(error, "errno", None), "message": str(error)}
    finally:
        sys.settrace(None)
        sys.stdin = original_stdin
        release.set()
        if writer is not None:
            writer.join(5)
            if writer.is_alive() or thread_errors:
                raise RuntimeError("Fixture writer cleanup failed")
    result = None
    if error_result is None:
        native = json.loads(output.getvalue())
        if native["action"] != "receipts":
            raise ValueError("Unexpected native action")
        result = native["result"]
        for key, expected in (("entry", entry_bytes), ("returned", returned_bytes)):
            ref = result[key]
            raw = base64.b64decode(ref["base64"], validate=True)
            if raw != expected or hashlib.sha256(raw).hexdigest() != ref["sha256"]:
                raise ValueError("Actual fixture receipt bytes/hash differ")
            if len(json.loads(ref["identity"])) != 11:
                raise ValueError("Actual fixture native identity absent")
    print(json.dumps({
        "case": mode, "status": "RECEIPT_PAIR_READ" if error_result is None else "ERROR",
        "error": error_result, "observed": observed,
        "elapsedMs": round((time.monotonic() - started) * 1000, 3),
        "SDK": 0, "processControl": 0, "admissionWrites": 0,
        "originalReceiptWrites": 0, "nativeProgramUnmodified": True,
    }, separators=(",", ":")))
finally:
    sys.settrace(None)
    sys.stdin = original_stdin
    release.set()
    if writer is not None:
        writer.join(5)
    shutil.rmtree(root)

"""Real generated kernel-inventory decoder against its native buffer port."""
import ast
import ctypes
from ctypes import wintypes as w
import json
import struct
import sys
from types import SimpleNamespace

tree = ast.parse(sys.stdin.read())
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
             and node.name == "owned_process_creation_snapshot"]
assert len(functions) == 1

def run(mode):
    calls = [0]
    def row(pid, birth, advance):
        value = bytearray(88)
        struct.pack_into("<I", value, 0, advance)
        struct.pack_into("<q", value, 32, birth)
        struct.pack_into("<Q", value, 80, pid)
        return bytes(value)
    class Function:
        def __init__(self, function): self.function = function
        def __call__(self, *args): return self.function(*args)
    def query(kind, buffer, size, returned):
        calls[0] += 1
        assert kind == 5
        if mode == "status":
            return -1073741790
        if mode == "overflow":
            returned._obj.value = 128 * 1024 * 1024
            return -1073741820
        if mode == "growth" and calls[0] == 1:
            returned._obj.value = 131072
            return -1073741820
        own_birth = 100001 if mode == "self-birth" else 100000
        payload = row(123, own_birth, 88) + row(456, 200000, 0)
        if mode == "duplicate-target":
            payload = row(123, own_birth, 88) + row(456, 200000, 88) + row(456, 200000, 0)
        if mode == "duplicate-self":
            payload = row(123, own_birth, 88) + row(123, own_birth, 88) + row(456, 200000, 0)
        if mode == "no-target":
            payload = row(123, own_birth, 0)
        if mode == "no-self":
            payload = row(456, 200000, 0)
        if mode == "offset":
            payload = row(123, own_birth, 1) + row(456, 200000, 0)
        assert len(payload) <= size
        ctypes.memmove(buffer, payload, len(payload))
        returned._obj.value = len(payload)
        if mode == "truncated":
            returned._obj.value = 96
        if mode == "length":
            returned._obj.value = 0
        return 0
    actual = ctypes
    proxy = SimpleNamespace(**{name: getattr(actual, name) for name in (
        "c_void_p", "c_uint16", "c_uint32", "c_int32", "c_int64", "c_uint64",
        "Structure", "POINTER", "byref", "create_string_buffer",
    )})
    proxy.sizeof = lambda value: 4 if mode == "abi" and value is actual.c_void_p else actual.sizeof(value)
    proxy.WinDLL = lambda *args, **kwargs: SimpleNamespace(NtQuerySystemInformation=Function(query))
    scope = {
        "ctypes": proxy, "w": w,
        "k": SimpleNamespace(GetCurrentProcessId=Function(lambda: 123),
                             GetCurrentProcess=Function(lambda: 999)),
        "process_birth": lambda handle: "100000",
    }
    exec(compile(ast.Module(body=functions, type_ignores=[]), "<actual-kernel-inventory>", "exec"), scope)
    error = None
    result = None
    try: result = scope["owned_process_creation_snapshot"](456)
    except Exception as exc: error = f"{type(exc).__name__}: {exc}"
    return {"mode": mode, "value": result, "error": error, "queries": calls[0]}

results = [run(mode) for mode in (
    "success", "growth", "no-target", "self-birth", "no-self", "duplicate-target",
    "duplicate-self", "offset", "truncated", "length", "status", "overflow", "abi",
)]
for result in results:
    if result["mode"] in ("success", "growth"):
        assert result["value"] == "200000" and result["error"] is None, result
    elif result["mode"] == "no-target":
        assert result["value"] is None and result["error"] is None, result
    else:
        assert result["error"] is not None, result
assert results[1]["queries"] == 2
assert results[-1]["queries"] == 0
print(json.dumps({"SDK": 0, "cases": results}))

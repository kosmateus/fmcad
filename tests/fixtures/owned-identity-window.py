"""Real generated launch/final-resume; external native ports and virtual time.

No native processes, SDK, files, or uncertain requests are executed.
"""
import ast
import base64
import ctypes
from ctypes import wintypes as w
import json
import subprocess
import sys
from types import SimpleNamespace

tree = ast.parse(sys.stdin.read())
names = {"launch", "owned_final_resume", "owned_identity_assert_current"}
functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
assert len(functions) == 3

def run(binding_seconds, fault=None):
    clock, trace, refs = [0], [], {}
    calls = {"resume": 0, "prepare": 0}
    p = {
        "executable": "Fusion.exe", "executableSha256": "hash",
        "arguments": [], "workingDirectory": "fixture",
        "identity": {"executable": "Identity.exe", "logFile": "identity.log"},
        "paths": {n: n for n in (
            "launchAttempt", "launchJournal", "sourceClosure", "transcript",
            "provision", "intent", "identityAttempt", "identityJournal", "identityPreparation")},
        "owned": {"coldProcessPath": "cold"},
    }
    def fence(*args):
        trace.append("source-fence")
        if fault == "source":
            raise ValueError("source changed")
    def publish(name, raw):
        value = {"nativePath": name, "sha256": "hash", "identity": "identity",
                 "base64": base64.b64encode(raw).decode()}
        refs[name] = value
        return value
    def prepare(*args):
        calls["prepare"] += 1
        trace.append("identity-prepared")
        fields = ("state", "origin", "process", "executable", "sha256",
                  "version", "arguments", "commandLine", "inputIdleCode", "logEvent")
        state = {"process": {"pid": 3, "birth": "3"}, "logOffset": 0,
                 "logIdentity": "log", "logEvent": "ready", "readyAt": clock[0]}
        for role, name in [("attempt", "identityAttempt"), ("journal", "identityJournal"),
                           ("terminal", "identityPreparation")]:
            state[role] = publish(name, b"{}")
        scope["owned_identity_state"] = state
        if fault == "binding":
            publish("provision", b'{"changed":true}')
        return {**state, "preparation": dict.fromkeys(fields, "fixture")}
    def process_handle(process):
        trace.append("identity-current")
        if fault == "identity" or clock[0] - scope["owned_identity_state"]["readyAt"] >= 31:
            raise OSError(87, "Process identity unavailable")
        return 3
    def bind(created, source, profile):
        trace.append("parent-bind-boundary")
        clock[0] += binding_seconds
        scope["owned_intent"] = publish("intent", json.dumps({
            "process": {"pid": created.pid, "birth": "2"},
        }).encode())
        return {"provision": publish("provision", b"{}"), "backup": {}, "receipt": {}}
    class Function:
        def __init__(self, fn): self.fn = fn
        def __call__(self, *args): return self.fn(*args)
    def create(*args):
        trace.append("create-suspended")
        created = args[-1]._obj
        created.pid, created.tid, created.process, created.thread = 2, 4, 2, 4
        return True
    def resume(thread):
        calls["resume"] += 1
        trace.append("resume")
        return 1
    def birth(handle):
        if fault == "process" and calls["prepare"] and handle == 2:
            return "changed"
        return str(handle)
    kernel = SimpleNamespace(
        CreateProcessW=Function(create), ResumeThread=Function(resume),
        WaitForSingleObject=lambda *args: 258, CloseHandle=lambda handle: True)
    class FreshPath:
        def __init__(self, value): self.parent = "fixture"
        def exists(self): return False
        def is_symlink(self): return False
    scope = {
        "ctypes": ctypes, "w": w, "k": kernel, "json": json, "sys": sys,
        "subprocess": subprocess, "base64": base64, "Path": FreshPath,
        "os": SimpleNamespace(environ={}, path=SimpleNamespace(lexists=lambda name: False)),
        "p": p, "action": "owned-autoload-launch",
        "request": {"old": {"pid": 1, "birth": "1"}, "nonce": "nonce"},
        "dead": lambda *args: None, "alive": lambda *args: None,
        "owned_prepare": lambda source: {"profile": {}, "backup": {}},
        "require_profile": lambda value: trace.append("profile-fence"),
        "private_directory": lambda name: None, "publish": publish,
        "owned_identity_attempt": prepare, "process_handle": process_handle,
        "owned_identity_state": None, "owned_identity_check_image": lambda: None,
        "owned_identity_log_snapshot": lambda *args: (b"ready", 0, "log"),
        "owned_identity_log_event": lambda *args: "changed" if fault == "log" else "ready",
        "snapshot": lambda name: refs[name], "canonical": lambda *args: None,
        "process_birth": birth,
        "image": lambda handle: "Identity.exe" if handle == 3 else "Fusion.exe",
        "owned_checkpoint": lambda *args: trace.append("parent-checkpoint"),
        "owned_fence": fence, "owned_inputs_fence": fence, "owned_bind": bind,
        "owned_release_database": lambda: trace.append("database-release"),
        "owned_intent": None, "strict": json.loads,
    }
    exec(compile(ast.Module(body=functions, type_ignores=[]), "<actual-generated-launch>", "exec"), scope)
    error = None
    try: scope["launch"]({})
    except Exception as exc: error = f"{type(exc).__name__}: {exc}"
    return {"bindingSeconds": binding_seconds, "fault": fault, **calls,
            "error": error, "trace": trace}

results = [run(delay) for delay in (0, 35, 90)]
results += [run(35, fault) for fault in ("identity", "binding", "process", "source", "log")]
for result in results:
    if result["fault"] is None:
        assert result["error"] is None and result["resume"] == 1, result
        assert result["prepare"] == 1, result
    else:
        assert result["error"] is not None and result["resume"] == 0, result
        assert result["prepare"] <= 1, result
print(json.dumps({"SDK": 0, "cases": results}))

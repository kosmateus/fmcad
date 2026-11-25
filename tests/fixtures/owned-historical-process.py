"""Exercise real generated replacement-chain policy at its native I/O ports."""
import ast
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace

tree = ast.parse(sys.stdin.read())
names = {"owned_replacement_chain", "owned_retirement_matches", "owned_provision_identity",
         "process_handle", "process_birth", "dead", "owned_historical_dead"}
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]

def run(mode):
    old = {"pid": 3468, "birth": "134399754342709495"}
    if mode == "leading-zero":
        old["birth"] = "0" + old["birth"]
    if mode == "unicode-birth":
        old["birth"] = "١٣٤٣٩٩٧٥٤٣٤٢٧٠٩٤٩٥"
    if mode == "oversized-birth":
        old["birth"] = "9" * 20
    process = {"pid": 9804, "birth": "134399800000000000"}
    generation = {"instance": "before", "epoch": "before"}
    next_generation = {"instance": "after", "epoch": "after"}
    ident = json.dumps([1] * 11, separators=(",", ":"))
    root = {"database": "C:/fixture.db", **old, **generation,
            "source": "source", "build": "build", "credentials": {}}
    current = {**root, **process, **next_generation}
    digest = lambda raw: hashlib.sha256(raw).hexdigest()
    current_raw = json.dumps(current).encode()
    current_ref = {"nativePath": "C:/provision", "sha256": digest(current_raw), "identity": ident}
    prior_ref = {"nativePath": "prior", "sha256": digest(json.dumps(root).encode()), "identity": ident}
    n = {"handoffRequest": "handoff", "handoffReceipt": "handoff-receipt",
         "database": {"nativePath": "C:/fixture.db", "identity": ident},
         "source": "source", "build": "build", "retiredProcessPath": "retired",
         "provisionSha256": current_ref["sha256"]}
    handoff = {"generation": generation, "nextGeneration": next_generation, "handoffId": "handoff-id"}
    receipt = {"kind": "owned-autoload-provision-bound-v1", "isolation": "NOT_PROVEN",
               "nonce": "a" * 32, "old": old, "process": process, "generation": next_generation,
               "handoffId": "handoff-id", "handoffRequest": "handoff",
               "handoffReceipt": "handoff-receipt", "database": n["database"],
               "beforeSha256": prior_ref["sha256"], "backup": prior_ref, "after": current_ref}
    retired = {"oldPid": process["pid"], "oldBirth": process["birth"],
               "oldExe": "Fusion.exe", "oldExeSha256": "executable-hash",
               "exited": True, "oldPidPresent": False, "processControl": 0,
               "originalTerminationOutcome": "UNKNOWN_UNCHANGED",
               "observation": "exact-original-provision-process-verified-dead"}
    records = {"prior": root, "receipt": receipt, "retired": retired}
    steps = [{"priorProvision": prior_ref,
              "provisionReceipt": {"nativePath": "receipt"},
              "retiredProcess": {"nativePath": "retired"}}]
    state = {"lastError": 0, "queries": 0, "closed": 0}
    def open_process(rights, inherit, pid):
        assert not inherit
        if pid == 3468:
            state["lastError"] = 87 if mode == "absent" else 5
            if mode == "accessible-reused":
                return 123
        else:
            state["lastError"] = 87
        return 0
    def snapshot(pid):
        assert pid == 3468
        state["queries"] += 1
        if mode == "query-error":
            raise OSError("Inventory unavailable")
        if mode == "same-birth":
            return old["birth"]
        if mode == "missing":
            return None
        if mode == "snapshot-leading-zero":
            return "0134401206121628220"
        if mode == "snapshot-type":
            return 134401206121628220
        if mode == "drift" and state["queries"] == 2:
            return "134401206121628221"
        return "134401206121628220"
    def close(handle):
        state["closed"] += 1
    scope = {
        "json": json, "Path": Path, "digest": digest, "strict": json.loads,
        "p": {"paths": {"provision": "C:/provision"}, "executable": "Fusion.exe",
              "executableSha256": "executable-hash"},
        "request": {"old": process},
        "owned_reference": lambda ref: (None, handoff),
        "file_bytes": lambda *args: (current_raw, ident),
        "owned_replacement_file": lambda ref: records[ref["nativePath"]],
        "ctypes": SimpleNamespace(get_last_error=lambda: state["lastError"]),
        "k": SimpleNamespace(OpenProcess=open_process, CloseHandle=close,
                             WaitForSingleObject=lambda *args: 258),
    }
    exec(compile(ast.Module(body=functions, type_ignores=[]), "<actual-owned-lineage>", "exec"), scope)
    scope["owned_process_creation_snapshot"] = snapshot
    scope["process_birth"] = lambda handle: "134401206121628220"
    # Neither current-process liveness/control nor its identity check may use
    # the historical absence port, even if it would show a different birth.
    try:
        scope["process_handle"](old)
        raise AssertionError("Current process guard unexpectedly accepted reuse")
    except (OSError, ValueError):
        pass
    assert state["queries"] == 0
    error = None
    try:
        result = scope["owned_replacement_chain"](n, steps)
        assert result["registeredBefore"] == root
        assert result["provisionIdentity"] == ident
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    return {"mode": mode, "error": error, **state}

results = [run(mode) for mode in (
    "absent", "reused", "accessible-reused", "same-birth", "drift", "missing", "query-error",
    "leading-zero", "unicode-birth", "oversized-birth", "snapshot-leading-zero", "snapshot-type")]
for result in results:
    expected_success = result["mode"] in ("absent", "reused", "accessible-reused")
    assert (result["error"] is None) == expected_success, result
print(json.dumps({"scope": "actual generated owned lineage through external native I/O",
                  "SDK": 0, "cases": results}))

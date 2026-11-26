"""Whole actual owned_view with in-memory OS/files/DB ports, SDK-free."""
import ast
import base64
import copy
import hashlib
import json
from pathlib import PureWindowsPath
import re
import sys

tree = ast.parse(sys.stdin.read())
names = {"owned_match", "owned_pair", "owned_profile_match", "owned_view"}
functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
assert {"owned_match", "owned_pair", "owned_view"} <= {n.name for n in functions}
code = compile(ast.Module(body=functions, type_ignores=[]), "<actual-owned-rebound>", "exec")
encode = lambda v: json.dumps(v, sort_keys=True, separators=(",", ":"), allow_nan=False)
sha = lambda raw: hashlib.sha256(raw).hexdigest()


def decode(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))


def run(semantic=True, pretty=True, fault=None):
    store = {}
    def file(name, value):
        raw = encode(value).encode()
        store[name] = (raw, "original:" + name)
        return {"nativePath": name, "sha256": sha(raw), "identity": store[name][1],
                "base64": base64.b64encode(raw).decode()}
    ref = lambda f: {k: f[k] for k in ("nativePath", "sha256", "identity")}
    process, old = {"pid": 13, "birth": "13"}, {"pid": 12, "birth": "12"}
    generation, prior = {"instance": "new", "epoch": "new"}, {"instance": "old", "epoch": "old"}
    q = {"directory": r"C:\addin", "source": "a"*40, "files": {"AutodeskFusionMCP.py": "b"*64}, "build": "c"*64}
    helper = {"files": {"helper.py": {"sha256": "d"*64, "identity": "helper"}}}
    installed = {"files": {"AutodeskFusionMCP.py": {"sha256": "b"*64, "identity": "installed"}}}
    profile_value = {"loadedScripts": [{"name": "Zażółć", "path": r"C:\addin\AutodeskFusionMCP.py",
      "location": 3, "isRemoved": False, "isFavorite": False, "runOnStartup": True}]}
    profile = file(r"C:\user\profile.json", profile_value)
    paths = {key: r"C:\original" + "\\" + key + ".json" for key in
             ["launchJournal", "launchAttempt", "provision", "database"]}
    p = {"old": old, "executable": r"C:\Fusion.exe", "executableSha256": "e"*64,
         "paths": paths, "nextGeneration": generation}
    handoff = {"handoffId": "handoff", "generation": prior, "nextGeneration": generation}
    request = file(r"C:\original\handoff.json", handoff)
    completion = file(r"C:\original\completed.json", {**handoff, "state": "completed"})
    source = file(r"C:\original\source.json", {"installed": installed, "helper": helper})
    manifest = file(r"C:\original\manifest.json", {"code": True})
    closure = file(r"C:\original\closure.json", {"kind": "controlled-native-install-originals-v1",
      "qualified": q, "oldProcess": old, "authority": "NONE", "target": q["directory"],
      "originalManifest": ref(manifest), "helper": helper})
    install = file(r"C:\original\install.json", {"kind": "controlled-native-install-receipt-v1",
      "qualified": q, "oldProcess": old, "authority": "NONE", "originals": ref(closure), "installed": installed})
    attempt = file(paths["launchAttempt"], {"kind": "owned-autoload-launch-attempt-v1",
      "isolation": "NOT_PROVEN", "nonce": "f"*32, "old": old, "executable": p["executable"],
      "executableSha256": p["executableSha256"], "profile": profile, "sourceClosure": ref(source)})
    journal = file(paths["launchJournal"], {"kind": "owned-autoload-created-process-v1",
      "nonce": "f"*32, "process": process, "executable": p["executable"], "executableSha256": p["executableSha256"],
      "attempt": ref(attempt), "threadId": 99, "phase": "created-suspended", "isolation": "NOT_PROVEN"})
    cold = file(r"C:\original\cold.json", {**process, "exe": p["executable"],
      "executableSha256": p["executableSha256"], "nonce": "f"*32, "phase": "created-suspended", "isolation": "NOT_PROVEN"})
    before = {"database": paths["database"], **old, **prior, "source": "1"*40, "build": "2"*64, "credentials": {}}
    backup = file(r"C:\original\before.json", before)
    provision = file(paths["provision"], {**before, **process, **generation})
    database = {"nativePath": paths["database"], "identity": "database"}
    bound = file(r"C:\original\bound.json", {"kind": "owned-autoload-provision-bound-v1",
      "isolation": "NOT_PROVEN", "nonce": "f"*32, "old": old, "process": process,
      "handoffId": "handoff", "generation": generation, "database": database,
      "beforeSha256": backup["sha256"], "backup": ref(backup), "after": ref(provision),
      "handoffRequest": {k: request[k] for k in ("nativePath", "sha256")},
      "handoffReceipt": {k: completion[k] for k in ("nativePath", "sha256")}})
    descriptor = {"path": profile["nativePath"], "sha256": profile["sha256"]}
    if semantic:
        descriptor["semanticSha256"] = sha(encode(profile_value).encode())
    if fault == "bad-digest": descriptor["semanticSha256"] = "0"*64
    if fault == "unknown-field": descriptor["skip"] = True
    intent_value = {"kind": "fmcad-bootstrap-entry-intent", "version": 3, "mode": "owned-autoload-v1",
      "nonce": "f"*32, "process": process, "executable": {"path": p["executable"], "sha256": p["executableSha256"]},
      "purpose": "isolated-stdout-v1", "engineVersion": 2,
      "installed": {k: q[k] for k in ("directory", "source", "files")},
      "profile": descriptor, "receipts": {"directory": r"C:\receipts", "entry": "entry.json", "returned": "returned.json"},
      "provision": {"path": provision["nativePath"], "sha256": provision["sha256"]}, "generation": generation}
    intent = file(r"C:\original\intent.json", intent_value)
    base = {"kind": "fmcad-bootstrap-entry-receipt", "version": 3, "mode": intent_value["mode"],
      "nonce": "f"*32, "process": process, "purpose": intent_value["purpose"], "engineVersion": 2,
      "executable": intent_value["executable"], "provision": intent_value["provision"], "generation": generation,
      "intent": {"path": intent["nativePath"], "sha256": intent["sha256"]}, "profile": descriptor,
      "installed": {"directory": q["directory"], "source": q["source"], "filesDigest": q["build"]}}
    entry = file(r"C:\receipts\entry.json", {**base, "phase": "entry-audited-before-addon-import", "startupAudit": {}})
    returned = file(r"C:\receipts\returned.json", {**base, "phase": "run-returned",
      "entry": {"path": entry["nativePath"], "sha256": entry["sha256"]}})
    launch = {"process": process, "startupProven": False, **{key: ref(value) for key, value in {
      "journal": journal, "attempt": attempt, "coldProcess": cold, "sourceClosure": source, "profile": profile,
      "profileBackup": file(r"C:\original\profile-backup.json", profile_value), "provision": provision,
      "provisionBackup": backup, "provisionReceipt": bound, "intent": intent}.items()}}
    o = {"database": database, "handoffRequest": ref(request), "handoffReceipt": ref(completion),
         "installReceipt": ref(install), "installClosure": ref(closure), "entry": ref(entry), "returned": ref(returned)}
    # Simulate vendor formatting only AFTER the original launch/intent records.
    if fault == "content": profile_value["loadedScripts"][0]["isFavorite"] = True
    if pretty:
        store[profile["nativePath"]] = (json.dumps(profile_value, indent="\t", ensure_ascii=False).replace("\n", "\r\n").encode(), "vendor-current-identity")
    reads = []
    def read(name, **_):
        reads.append(name);return store[name]
    scope = {"p": {**p, "expectedProvisionSha256": backup["sha256"]}, "v": {"launch": launch, "nonce": "f"*32},
      "o": o, "q": q, "helper": helper, "manifest": manifest, "held": [], "read": read,
      "old_dead": lambda _: None, "owned_process": lambda _: None, "installed": lambda: installed,
      "owned_database": lambda *_: database, "sha": sha, "ref": ref, "decode": decode, "_encode": encode,
      "base64": base64, "re": re, "Path": PureWindowsPath}
    exec(code, scope)
    first = scope["owned_view"]()
    assert first["originals"]["profile"] == ref(profile)
    count = reads.count(profile["nativePath"])
    assert scope["owned_view"]() == first
    assert reads.count(profile["nativePath"]) == count + 1, "Current semantics must be freshly reread"
    return True


assert run(semantic=False, pretty=False)
assert run()
for options in [{"semantic": False}, {"fault": "content"}, {"fault": "bad-digest", "pretty": False},
                {"fault": "unknown-field", "pretty": False}]:
    try:
        run(**options)
    except ValueError:
        pass
    else:
        raise AssertionError(f"Expected profile refusal: {options}")
print(json.dumps({"SDK": 0, "nativeProcessControl": 0, "cases": 6}))

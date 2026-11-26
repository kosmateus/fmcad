"""Exercise published owned intent from the generated native program, SDK-free."""
import ast
import base64
import hashlib
import json
from pathlib import Path, PureWindowsPath
import re
import sys
import types

program = sys.stdin.read()
tree = ast.parse(program)
checkpoint = [node for node in tree.body
               if isinstance(node, ast.FunctionDef) and node.name == "owned_checkpoint"][-1]
strict_decoder = next(node for node in tree.body
                      if isinstance(node, ast.FunctionDef) and node.name == "strict")
directory = r"C:\fixture\private\receipts"
paths = {
    "provision": r"C:\fixture\private\provision.json",
    "profile": r"C:\fixture\private\profile.json",
    "intent": r"C:\fixture\private\intent.json",
    "receiptDirectory": directory,
    "entry": directory + r"\entry.json",
    "returned": directory + r"\returned.json",
}
process = {"pid": 1234, "birth": "134400000000000000"}
profile_value = {"loadedScripts": [{"name": "Zażółć 😀", "location": 3,
                                   "path": r"C:\fixture\addin\AutodeskFusionMCP.py",
                                   "runOnStartup": True, "isRemoved": False, "isFavorite": False}],
                 "nested": {"😀": {"b": 2, "a": 1}, "\ue000": "ą"}}
profile_bytes = json.dumps(profile_value, ensure_ascii=False, indent="\t").replace("\n", "\r\n").encode()
if len(sys.argv) > 1:
    profile_bytes = Path(sys.argv[1]).read_bytes()
    profile_value = json.loads(profile_bytes)
profile = {"sha256": hashlib.sha256(profile_bytes).hexdigest()}
provision = {"nativePath": paths["provision"], "sha256": "a" * 64,
             "identity": "synthetic-original-provision"}
published = {}


def publish(name, raw):
    assert name == paths["intent"]
    assert not published, "Intent publication must remain exclusive"
    published["value"] = json.loads(raw)
    published["reference"] = {
        "nativePath": name, "sha256": "c" * 64,
        "identity": "synthetic-published-intent",
        "base64": base64.b64encode(raw).decode(),
    }
    return published["reference"]


def snapshot(name):
    if name == paths["provision"]:
        return provision
    assert name == paths["intent"]
    return published["reference"]


def acknowledge(_limit):
    return json.dumps({
        "kind": "owned-autoload-continue-v1", "phase": "bound-before-resume",
        "nonce": "d" * 32, "process": process,
        "provision": provision,
        "intent": {key: published["reference"][key]
                   for key in ("nativePath", "sha256", "identity")},
    }).encode()


def require_profile(actual):
    assert actual == profile


scope = {
    "owned_intent": None,
    "owned_inputs_fence": lambda: None,
    "p": {"paths": paths, "executable": r"C:\fixture\Fusion360.exe",
          "executableSha256": "e" * 64,
          "installedDirectory": r"C:\fixture\addin",
          "installedSource": "f" * 40,
          "installedFiles": {"AutodeskFusionMCP.py": "a" * 64}},
    "owned_binding_profile": profile,
    "owned_binding_source": object(),
    "owned_state": {"next": {"instance": "fixture-instance", "epoch": "fixture-epoch"}},
    "request": {"nonce": "d" * 32},
    "snapshot": snapshot, "publish": publish,
    "require_profile": require_profile,
    "owned_fence": lambda _source: None,
    "json": json, "Path": PureWindowsPath,
    "print": lambda *_args, **_kwargs: None,
    "strict": json.loads,
    "file_bytes": lambda *_args: (profile_bytes, "synthetic-profile-identity"),
    "digest": lambda raw: hashlib.sha256(raw).hexdigest(),
    "sys": types.SimpleNamespace(
        stdin=types.SimpleNamespace(buffer=types.SimpleNamespace(readline=acknowledge))),
}
exec(compile(ast.Module(body=[strict_decoder, checkpoint], type_ignores=[]),
             "<generated-owned-native>", "exec"), scope)
scope["owned_checkpoint"]("bound-before-resume", process, provision["sha256"])
intent = published["value"]
assert intent["process"] == process
assert intent["version"] == 3 and intent["mode"] == "owned-autoload-v1"
assert intent["generation"] == scope["owned_state"]["next"]
assert intent["profile"]["sha256"] == profile["sha256"]
assert intent["profile"]["semanticSha256"] == hashlib.sha256(
    json.dumps(profile_value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
).hexdigest()
for invalid in (b'{"loadedScripts":[],"loadedScripts":[]}', b'{"loadedScripts":NaN}'):
    profile_bytes = invalid
    profile["sha256"] = hashlib.sha256(invalid).hexdigest()
    published.clear()
    try:
        scope["owned_checkpoint"]("bound-before-resume", process, provision["sha256"])
    except ValueError:
        pass
    else:
        raise AssertionError("Ambiguous profile must not publish an intent")
    assert not published
receipts = intent["receipts"]
assert set(receipts) == {"directory", "entry", "returned"}
assert receipts["directory"] == directory
assert receipts["entry"] != receipts["returned"]
for role in ("entry", "returned"):
    name = receipts[role]
    # BootstrapEntry's public intent format: names within its pinned directory,
    # never full paths or an additional caller-selected output directory.
    assert re.fullmatch(r"[a-z0-9_-]+[.]json", name), (
        f"BootstrapEntry requires a receipt basename, got {name!r}")
    assert not re.fullmatch(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])[.]json", name)
    assert str(PureWindowsPath(receipts["directory"]) / name) == paths[role]
print(json.dumps({"SDK": 0, "nativeProcessControl": 0,
                  "semanticSha256": intent["profile"]["semanticSha256"],
                  "receiptNames": [receipts["entry"], receipts["returned"]]}))

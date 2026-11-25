"""Generated native guard integration with real owned files/SQLite, fake OS/ACL.

Stops after the complete pre-mutation fence. No process, profile or provision
mutation is permitted. This does not qualify Windows or Fusion.
"""
import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import types

program = sys.stdin.read()
tree = ast.parse(program)
encode = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"))
sha = lambda raw: hashlib.sha256(raw).hexdigest()
sys.modules["msvcrt"] = types.SimpleNamespace(open_osfhandle=lambda h, _: h, get_osfhandle=lambda fd: fd)
sys.modules["lib"] = types.ModuleType("lib")
sys.modules["lib.request_admission"] = types.SimpleNamespace(_encode=encode)
if not hasattr(os, "O_BINARY"):
    os.O_BINARY = 0


class VerifiedFence(Exception):
    pass


def scenario(case):
    with tempfile.TemporaryDirectory(prefix="owned-replacement-") as name:
        root = Path(name)
        database = root / "fixture.sqlite3"
        old = {"instance": "old-instance", "epoch": "old-epoch"}
        new = {"instance": "next-instance", "epoch": "next-epoch"}
        handoff = {"handoffId": "original-handoff", "generation": old, "nextGeneration": new}
        db = sqlite3.connect(database)
        db.executescript("""
            CREATE TABLE generation(singleton INTEGER,instance TEXT,epoch TEXT);
            CREATE TABLE physical_handoffs(id TEXT,result TEXT);
            CREATE TABLE physical_runtime_binding(singleton INTEGER,binding TEXT);
            CREATE TABLE physical_owners(generation TEXT);
            CREATE TABLE admissions(state TEXT,binding TEXT);
            CREATE TABLE physical_turns(state TEXT,binding TEXT);
        """)
        registered = {"protocol": "fmcad-provision-fence-v1",
                      "database": {"path": str(database.resolve()), "device": database.stat().st_dev,
                                   "inode": database.stat().st_ino},
                      "generation": old, "endpointURL": "http://fixture.invalid/mcp",
                      "physicalRuntime": {"pid": 34, "birth": "34", "source": "source",
                                          "build": "build", "version": "fixture"}}
        db.execute("INSERT INTO generation VALUES (1,?,?)", (new["instance"], new["epoch"]))
        db.execute("INSERT INTO physical_handoffs VALUES (?,?)",
                   (handoff["handoffId"], encode(dict(state="committed", **handoff))))
        if case == "wrong-registered-process":
            registered["physicalRuntime"]["birth"] = "another-birth"
        db.execute("INSERT INTO physical_runtime_binding VALUES (1,?)", (encode(registered),))
        if case == "existing-current-owner":
            db.execute("INSERT INTO physical_owners VALUES (?)", (encode(new),))
        db.commit()
        db.close()
        prior = {"database": str(database), "pid": 34, "birth": "34", **old,
                 "source": "source", "build": "build", "credentials": {"fixture": "not-real"}}
        current = {**prior, "pid": 38, "birth": "38", **new}
        handles = []

        def write(file, value):
            file.write_text(encode(value))
            return str(file)

        def snapshot(file):
            raw = Path(file).read_bytes()
            return {"nativePath": str(file), "identity": "fixture-native-identity",
                    "sha256": sha(raw), "base64": base64.b64encode(raw).decode("ascii")}

        def reference(file, identity=True):
            value = snapshot(file)
            return {key: value[key] for key in (
                ("nativePath", "sha256", "identity") if identity else ("nativePath", "sha256"))}

        def open_file(file, write=False):
            fd = os.open(file, os.O_RDWR if write else os.O_RDONLY)
            handles.append(fd)
            return fd

        provision = write(root / "provision.json", current)
        prior_file = write(root / "prior.json", prior)
        request_file = write(root / "request.json", handoff)
        receipt_file = write(root / "handoff-receipt.json", dict(state="completed", **handoff))
        retired = {"exited": True, "oldPidPresent": False, "forceUsed": False, "oldPid": 38,
                   "oldBirth": "38", "observation": "exact-original-process-signaled-after-one-WM_CLOSE",
                   "windowHandle": 1, "windowVisibleAtInput": True, "windowClass": "fixture",
                   "oldExe": "fixture-executable", "oldExeSha256": sha(b"exe")}
        if case == "forced-retirement":
            retired["forceUsed"] = True
        retired_file = write(root / "retired.json", retired)
        bound = {"kind": "owned-autoload-provision-bound-v1", "isolation": "NOT_PROVEN",
                 "nonce": "a" * 32, "old": {"pid": 34, "birth": "34"},
                 "process": {"pid": 38, "birth": "38"}, "generation": new,
                 "handoffId": handoff["handoffId"], "handoffRequest": reference(request_file, False),
                 "handoffReceipt": reference(receipt_file, False),
                 "database": {"nativePath": str(database), "identity": "fixture-native-identity"},
                 "beforeSha256": sha(Path(prior_file).read_bytes()), "backup": reference(prior_file),
                 "after": reference(provision)}
        if case == "wrong-original-process":
            bound["process"]["birth"] = "another-birth"
        bound_file = write(root / "bound.json", bound)
        inputs = [write(root / ("input-" + str(i)), {"fixture": i}) for i in range(3)]
        proof = {"kind": "unregistered-created-process-v1", "priorProvision": reference(prior_file),
                 "provisionReceipt": reference(bound_file), "retiredProcess": reference(retired_file)}
        if case == "changed-original-bytes":
            Path(prior_file).write_text("changed")
        normal = {"database": {"nativePath": str(database), "identity": "fixture-native-identity"},
                  "provisionSha256": sha(Path(provision).read_bytes()),
                  "handoffRequest": reference(request_file, False),
                  "handoffReceipt": reference(receipt_file, False),
                  "provisionBackupPath": str(root / "never-backup"),
                  "provisionReceiptPath": str(root / "never-receipt"),
                  "coldProcessPath": str(root / "never-process"), "retiredProcessPath": retired_file,
                  "installedFiles": {}, "source": "source", "build": "build",
                  "autorunOriginals": [reference(file) for file in inputs[:2]],
                  "discoveryOriginals": [reference(inputs[2])]}
        if case != "no-explicit-replacement":
            normal["replacement"] = proof
        helper, installed = root / "helper", root / "installed"
        for folder in (helper, installed):
            folder.mkdir()
            (folder / "source.py").write_text("# fixture source")
        executable, python = root / "executable", root / "python"
        executable.write_bytes(b"exe")
        python.write_bytes(b"python")
        retired["oldExe"] = str(executable)
        write(Path(retired_file), retired)
        if "replacement" in normal:
            normal["replacement"]["retiredProcess"] = reference(retired_file)
        paths = {"provision": provision, **{key: str(root / key) for key in ("intent", "entry", "returned")}}
        p = {"owned": normal, "paths": paths, "originalPaths": inputs + [prior_file, bound_file, retired_file],
             "sourceDirectory": str(helper), "installedDirectory": str(installed),
             "executable": str(executable), "executableSha256": sha(b"exe"),
             "nativePython": str(python), "nativePythonSha256": sha(b"python")}
        p["mainWindowClass"] = "fixture"

        def inventory(folder, *args):
            return {file.name: sha(file.read_bytes()) for file in Path(folder).iterdir()}

        def dead(process):
            if case == "registered-process-still-alive" and process["pid"] == 34:
                raise ValueError("Original process still alive")

        env = {"p": p, "request": {"old": {"pid": 38, "birth": "38"}}, "strict": json.loads,
               "snapshot": snapshot, "base64": base64, "Path": Path, "os": os, "sqlite3": sqlite3,
               "json": json, "held": [], "owned_state": None, "owned_replacement": None,
               "owned_database_handles": [], "open_file": open_file,
               "identity": lambda fd: "fixture-native-identity", "check_acl": lambda *a, **k: None,
               "digest": sha, "dead": dead, "inventory": inventory, "private_directory": lambda _: None,
               "file_bytes": lambda file: (Path(file).read_bytes(), "fixture-native-identity"),
               "k": types.SimpleNamespace(CloseHandle=os.close)}
        names = {"owned_reference", "owned_database", "owned_fence", "owned_prepare",
                 "owned_before_generation", "owned_registered_before", "owned_replacement_file",
                 "owned_replacement_before", "owned_inputs_fence"}
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name in names:
                if node.name == "owned_prepare" and "owned_prepare" in env:
                    env["owned_base_prepare"] = env["owned_prepare"]
                exec(compile(ast.Module(body=[node], type_ignores=[]), "<generated-owned-contract>", "exec"), env)
        real_fence = env["owned_fence"]

        def verified_fence(source):
            real_fence(source)
            raise VerifiedFence()

        env["owned_fence"] = verified_fence
        source = {"helper": inventory(helper), "installed": inventory(installed)}
        before = {file: sha(file.read_bytes()) for file in root.iterdir() if file.is_file()}
        try:
            env["owned_prepare"](source)
            raise AssertionError("Pre-mutation fence was not reached or denied")
        except VerifiedFence:
            assert case == "replacement-valid", case
            outcome = "VERIFIED_PRE_MUTATION_FENCE"
        except ValueError as error:
            assert case != "replacement-valid", str(error)
            outcome = str(error)
        finally:
            for fd in handles:
                try:
                    os.close(fd)
                except OSError:
                    pass
        assert before == {file: sha(file.read_bytes()) for file in root.iterdir() if file.is_file()}
        assert not list(root.glob("never-*"))
        return {"case": case, "outcome": outcome, "SDK": 0, "processOperations": 0}


cases = ["replacement-valid", "no-explicit-replacement", "wrong-original-process",
         "forced-retirement", "changed-original-bytes", "wrong-registered-process",
         "existing-current-owner", "registered-process-still-alive"]
results = [scenario(case) for case in cases]
print(json.dumps({"cases": results, "count": len(results), "actualFusion": "NOTRUN"}, sort_keys=True))

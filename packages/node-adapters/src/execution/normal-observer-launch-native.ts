/** Uses the existing native OS/file primitives; no SDK, grant or host proof. */
export const normalObserverLaunchNative = String.raw`
normal_state = None
normal_database_handles = []

def normal_checkpoint(phase, process=None, provision=None):
    message = {"kind": "normal-observer-checkpoint-v1", "phase": phase,
               "nonce": request["nonce"], "process": process, "provision": provision}
    print(json.dumps(message, separators=(",", ":")), flush=True)
    raw = sys.stdin.buffer.readline(65537)
    if len(raw) > 65536:
        raise ValueError("Resume decision exceeds budget")
    decision = strict(raw)
    if decision != {"kind": "normal-observer-continue-v1", **{
            key: message[key] for key in ("phase", "nonce", "process", "provision")}}:
        raise ValueError("Original parent boundary refused; do not resume")

def normal_reference(ref):
    if set(ref) != {"nativePath", "sha256"}:
        raise ValueError("Exact normal original reference required")
    value = snapshot(ref["nativePath"])
    if value["sha256"] != ref["sha256"]:
        raise ValueError("Original normal input bytes changed")
    return value, strict(base64.b64decode(value["base64"]))

def normal_database():
    import sqlite3
    n = p["normal"]
    handle = open_file(n["database"]["nativePath"])
    held.append(("handle", handle))
    normal_database_handles.append(handle)
    check_acl(None, handle=handle)
    if identity(handle) != n["database"]["identity"]:
        raise ValueError("Original native database identity changed")
    db = sqlite3.connect(Path(n["database"]["nativePath"]).as_uri() + "?mode=ro", uri=True)
    try:
        generation = db.execute("SELECT instance,epoch FROM generation WHERE singleton=1").fetchone()
        if generation != (normal_state["next"]["instance"], normal_state["next"]["epoch"]):
            raise ValueError("Original committed generation changed")
        row = db.execute("SELECT result FROM physical_handoffs WHERE id=?",
                         (normal_state["request"]["handoffId"],)).fetchone()
        from lib.request_admission import _encode
        if row is None or row[0] != _encode(normal_state["receipt"]):
            raise ValueError("Original committed handoff absent or changed")
        registered = db.execute("SELECT binding FROM physical_runtime_binding WHERE singleton=1").fetchone()
        registered = strict(registered[0]) if registered is not None else None
        database_path = Path(n["database"]["nativePath"]).resolve()
        info = database_path.stat()
        before = normal_state["before"]
        if (type(registered) is not dict or registered.get("protocol") != "fmcad-provision-fence-v1"
                or registered.get("database") != {
                    "path": str(database_path), "device": info.st_dev, "inode": info.st_ino}
                or registered.get("generation") != normal_state["request"]["generation"]
                or type(registered.get("physicalRuntime")) is not dict
                or set(registered["physicalRuntime"]) != {"pid", "birth", "version", "source", "build"}
                or any(registered["physicalRuntime"][key] != before[key]
                       for key in ("pid", "birth", "source", "build"))
                or type(registered["physicalRuntime"]["version"]) is not str
                or not registered["physicalRuntime"]["version"]
                or type(registered.get("endpointURL")) is not str or not registered["endpointURL"]):
            raise ValueError("Original registered physical runtime/source/build/database differs")
        next_encoded = _encode(normal_state["next"])
        if db.execute("SELECT 1 FROM physical_owners WHERE generation=?",
                      (next_encoded,)).fetchone():
            raise ValueError("New generation already has an owner/grant")
        for state, raw in db.execute("SELECT state,binding FROM admissions"):
            binding = strict(raw)
            if (state in ("accepted", "claimed") or
                    {"instance": binding["instance"], "epoch": binding["epoch"]} == normal_state["next"]):
                raise ValueError("Admissions prevent a normal observer bootstrap")
        for state, raw in db.execute("SELECT state,binding FROM physical_turns"):
            if state != "released" or strict(raw)["generation"] == normal_state["next"]:
                raise ValueError("Unreleased or new-generation turn prevents bootstrap")
    finally:
        db.close()

def normal_fence(source):
    dead(request["old"])
    if normal_state is not None:
        normal_database()
    if inventory(p["sourceDirectory"], True) != source["helper"]:
        raise ValueError("Normal helper bytes/identity changed")
    if inventory(p["installedDirectory"], True, p["normal"]["installedFiles"]) != source["installed"]:
        raise ValueError("Normal installed bytes/identity changed")
    raw, _ = file_bytes(p["executable"])
    if digest(raw) != p["executableSha256"]:
        raise ValueError("Normal executable changed")
    raw, _ = file_bytes(p["nativePython"])
    if digest(raw) != p["nativePythonSha256"]:
        raise ValueError("Normal interpreter changed")

def normal_release_database():
    # The resumed, correctly provisioned runtime must register itself in this
    # SAME database. Its legitimate writes are not a stale-source violation.
    for handle in normal_database_handles:
        held.remove(("handle", handle))
        k.CloseHandle(handle)
    normal_database_handles.clear()

def normal_profile(raw, planned):
    import ntpath
    value, candidate = strict(raw), strict(planned)
    if set(value) != {"loadedScripts"} or type(value["loadedScripts"]) is not list:
        raise ValueError("Closed original registration required")
    rows, names, selected = [], set(), 0
    expected = ntpath.normcase(ntpath.join(p["installedDirectory"], "AutodeskFusionMCP.py"))
    for row in value["loadedScripts"]:
        if (type(row) is not dict or set(row) != {
                "name", "path", "location", "isRemoved", "isFavorite", "runOnStartup"}
                or type(row["name"]) is not str or not row["name"]
                or type(row["path"]) is not str or not row["path"] or "\0" in row["path"]
                or type(row["location"]) not in (int, float)
                or not math.isfinite(row["location"]) or int(row["location"]) != row["location"]
                or abs(row["location"]) > 9007199254740991
                or any(type(row[key]) is not bool for key in ("isRemoved", "isFavorite", "runOnStartup"))):
            raise ValueError("Closed original registration row required")
        name = (ntpath.normcase(ntpath.normpath(row["path"])) if ntpath.isabs(row["path"])
                else row["path"].replace("\\", "/").lower())
        if name in names:
            raise ValueError("Duplicate original registration")
        names.add(name)
        copy = dict(row)
        if ntpath.isabs(row["path"]) and name == expected:
            if row["isRemoved"]:
                raise ValueError("Normal observer fork is removed")
            selected += 1
            copy["runOnStartup"] = True
        rows.append(copy)
    if (type(candidate) is not dict or set(candidate) != {"loadedScripts"}
            or type(candidate["loadedScripts"]) is not list
            or any(type(row) is not dict or set(row) != {
                       "name", "path", "location", "isRemoved", "isFavorite", "runOnStartup"}
                   or type(row["location"]) not in (int, float)
                   or any(type(row[key]) is not bool for key in ("isRemoved", "isFavorite", "runOnStartup"))
                   for row in candidate["loadedScripts"])
            or selected != 1 or candidate != {"loadedScripts": rows}):
        raise ValueError("Normal plan must preserve every foreign flag and only enable the exact fork")

def normal_prepare(source):
    global normal_state
    import msvcrt
    n = p["normal"]
    if set(n) != {"database", "provisionSha256", "handoffRequest", "handoffReceipt",
                  "provisionBackupPath", "provisionReceiptPath", "installedFiles",
                  "retiredProcessPath", "coldProcessPath", "source", "build"}:
        raise ValueError("Closed normal pins required")
    if set(n["database"]) != {"nativePath", "identity"}:
        raise ValueError("Original database identity required")
    original_request, handoff = normal_reference(n["handoffRequest"])
    original_receipt, receipt = normal_reference(n["handoffReceipt"])
    if (set(handoff) != {"handoffId", "generation", "nextGeneration"}
            or not isinstance(handoff["handoffId"], str) or not handoff["handoffId"]
            or any(type(handoff[key]) is not dict or set(handoff[key]) != {"instance", "epoch"}
                   or any(type(v) is not str or not v for v in handoff[key].values())
                   for key in ("generation", "nextGeneration"))
            or handoff["generation"] == handoff["nextGeneration"]
            or receipt != {"handoffId": handoff["handoffId"], "state": "completed",
                           "generation": handoff["generation"], "nextGeneration": handoff["nextGeneration"]}):
        raise ValueError("Exact original committed handoff required")
    h = open_file(p["paths"]["provision"], write=True)
    try:
        check_acl(None, handle=h)
        ident = identity(h)
        fd = msvcrt.open_osfhandle(h, os.O_RDWR | os.O_BINARY)
        h = None
        held.append(("fd", fd))
        raw = bytearray()
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            raw.extend(chunk)
            if len(raw) > 8388608:
                raise ValueError("Original provision budget exceeded")
        if digest(raw) != n["provisionSha256"]:
            raise ValueError("Original provision CAS differs")
        before = strict(raw)
        if (set(before) != {"database", "pid", "birth", "instance", "epoch", "source", "build", "credentials"}
                or type(before["pid"]) is not int
                or {"pid": before["pid"], "birth": before["birth"]} != request["old"]
                or {"instance": before["instance"], "epoch": before["epoch"]} != handoff["generation"]
                or before["source"] != n["source"] or before["build"] != n["build"]
                or Path(before["database"]).resolve() != Path(n["database"]["nativePath"]).resolve()):
            raise ValueError("Original provision process/source/generation/database differs")
        normal_state = {"fd": fd, "identity": ident, "raw": bytes(raw), "before": before,
                        "request": handoff, "receipt": {**receipt, "state": "committed"},
                        "next": handoff["nextGeneration"],
                        "handoffRequest": original_request, "handoffReceipt": original_receipt}
        normal_fence(source)
        for name in (n["provisionBackupPath"], n["provisionReceiptPath"], n["coldProcessPath"]):
            if os.path.lexists(name):
                raise ValueError("Normal output already exists; no replay")
        planned = base64.b64decode(request["base64"], validate=True)
        original = snapshot(p["paths"]["profile"])
        if any(original[key] != request["original"][key] for key in ("nativePath", "identity", "sha256")):
            raise ValueError("Normal original profile differs")
        normal_profile(base64.b64decode(original["base64"]), planned)
        # Release the temporary profile reader before acquiring its write FD.
        kind, reader = held.pop()
        if kind != "fd":
            raise ValueError("Profile reader ownership differs")
        os.close(reader)
        return replace_profile()
    finally:
        if h is not None:
            k.CloseHandle(h)

def normal_bind(created, source, profile):
    global normal_state
    import msvcrt
    n, s = p["normal"], normal_state
    value = {"pid": created.pid, "birth": process_birth(created.process)}
    normal_checkpoint("created-before-bind", value)
    normal_fence(source)
    require_profile(profile)
    fd = s["fd"]
    if identity(msvcrt.get_osfhandle(fd)) != s["identity"]:
        raise ValueError("Held provision identity changed before CAS")
    os.lseek(fd, 0, os.SEEK_SET)
    if os.read(fd, len(s["raw"]) + 1) != s["raw"]:
        raise ValueError("Held provision bytes changed before CAS")
    backup = publish(n["provisionBackupPath"], s["raw"])
    after = {**s["before"], **value, **s["next"]}
    if {key for key in after if after[key] != s["before"][key]} != {"pid", "birth", "instance", "epoch"}:
        raise ValueError("Only four normal provision fields may change")
    raw = json.dumps(after, sort_keys=True, separators=(",", ":")).encode("utf-8")
    os.lseek(fd, 0, os.SEEK_SET)
    view = memoryview(raw)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("Partial normal provision write")
        view = view[written:]
    os.ftruncate(fd, len(raw))
    os.fsync(fd)
    check_acl(None, handle=msvcrt.get_osfhandle(fd))
    held.remove(("fd", fd))
    os.close(fd)
    s["fd"] = None
    provision = snapshot(p["paths"]["provision"])
    if base64.b64decode(provision["base64"]) != raw:
        raise ValueError("Normal provision readback differs")
    if json.loads(provision["identity"])[:5] != json.loads(s["identity"])[:5]:
        raise ValueError("Normal provision file identity changed")
    receipt = publish(n["provisionReceiptPath"], json.dumps({
        "kind": "normal-observer-provision-bound-v1", "isolation": "NOT_PROVEN",
        "nonce": request["nonce"], "old": request["old"], "process": value,
        "handoffId": s["request"]["handoffId"], "generation": s["next"],
        "database": n["database"], "beforeSha256": digest(s["raw"]),
        "backup": {key: backup[key] for key in ("nativePath", "sha256", "identity")},
        "after": {key: provision[key] for key in ("nativePath", "sha256", "identity")},
        "handoffRequest": n["handoffRequest"], "handoffReceipt": n["handoffReceipt"],
    }, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    normal_checkpoint("bound-before-resume", value, provision["sha256"])
    normal_fence(source)
    require_profile(profile)
    if snapshot(p["paths"]["provision"]) != provision:
        raise ValueError("Normal provision changed before resume")
    return {"backup": backup, "provision": provision, "receipt": receipt}
`;

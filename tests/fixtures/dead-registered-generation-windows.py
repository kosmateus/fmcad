# Test-only extension. All files/SQLite writes are in fresh private fixtures.
# It calls the production adapter after the unchanged native program fences.
def exercise_dead_registered_fixture(source):
    global request
    import tempfile
    import uuid
    from lib.physical_authority import private_directory as ensure_private_directory
    from lib.request_admission import AdmissionStore, _encode
    case = request["fixtureCase"]
    if case not in ("registered-dead", "registered-alive"):
        raise ValueError("Closed native fixture case required")
    original = request["originalProcess"]
    if case == "registered-alive":
        h = k.OpenProcess(0x1000 | 0x00100000, False, os.getpid())
        if not h:
            raise OSError("Fixture self handle unavailable")
        try:
            original = {"pid": os.getpid(), "birth": process_birth(h)}
        finally:
            k.CloseHandle(h)
    root = Path(tempfile.gettempdir()) / ("root-dead-cas-fixture-" + uuid.uuid4().hex)
    ensure_private_directory(root)
    mailbox = ensure_private_directory(root / "mailbox")
    database = root / "admission.sqlite3"
    current = {"instance": uuid.uuid4().hex, "epoch": uuid.uuid4().hex}
    successor = {"instance": uuid.uuid4().hex, "epoch": uuid.uuid4().hex}
    with AdmissionStore(database, **current) as store:
        store._db.executescript("""
            CREATE TABLE physical_runtime_binding(singleton INTEGER,binding TEXT);
            CREATE TABLE physical_owners(generation TEXT,binding TEXT);
            CREATE TABLE physical_turns(state TEXT,binding TEXT);
            CREATE TABLE physical_handoffs(id TEXT PRIMARY KEY,result TEXT);
        """)
        info = database.stat()
        runtime = {**original, "source": "a" * 40, "build": "b" * 64, "version": "fixture"}
        registered = {
            "protocol": "fmcad-provision-fence-v1",
            "database": {"path": str(database), "device": info.st_dev, "inode": info.st_ino},
            "generation": current, "physicalRuntime": runtime,
            "endpointURL": "http://fixture.invalid/mcp",
        }
        store._db.execute("INSERT INTO physical_runtime_binding VALUES(1,?)", (_encode(registered),))
        store._db.execute(
            "INSERT INTO admissions VALUES('historical','original','terminal',NULL,?)",
            ('{"state":"UNKNOWN"}',))
    h = open_file(str(database))
    try:
        db_identity = identity(h)
    finally:
        k.CloseHandle(h)
    provision = {"database": str(database), **original, **current,
                 "source": runtime["source"], "build": runtime["build"],
                 "credentials": {"fixture": "not-real"}}
    provision_file = publish(str(root / "provision.json"), _encode(provision).encode())
    request = {
        "database": str(database), "databaseIdentity": db_identity,
        "registeredBindingJson": _encode(registered),
        "provision": {key: provision_file[key] for key in ("nativePath", "sha256", "identity")},
        "mailbox": str(mailbox),
        "outputDirectory": str(Path(tempfile.gettempdir()) /
                               ("root-dead-registered-handoff-" + uuid.uuid4().hex)),
        "handoff": {"handoffId": uuid.uuid4().hex,
                    "generation": current, "nextGeneration": successor},
    }
    try:
        result = dead_registered_handoff(source)
    except ValueError as error:
        if case != "registered-alive" or str(error) != "Original process is still alive":
            raise
        result = {"rejected": str(error)}
    else:
        if case != "registered-dead":
            raise AssertionError("A live process passed the native death fence")
    import sqlite3
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as db:
        generation = db.execute("SELECT instance,epoch FROM generation").fetchone()
        expected = successor if case == "registered-dead" else current
        if generation != (expected["instance"], expected["epoch"]):
            raise AssertionError("Actual native generation differs")
        if db.execute("SELECT result FROM admissions WHERE request='historical'").fetchone() != (
                '{"state":"UNKNOWN"}',):
            raise AssertionError("Historical UNKNOWN changed")
    return {"fixtureCase": case, "fixtureRoot": str(root), "result": result,
            "SDK": 0, "sharedDatabaseWrites": 0, "historicalOutcome": "UNKNOWN_UNCHANGED"}

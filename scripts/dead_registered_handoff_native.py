# Private extension of the pinned controlledFusionLaunchNative program.
# The dispatch is inserted AFTER its interpreter/source/ACL/executable fences.
# It cannot launch Fusion, issue a grant, run SDK work or settle old UNKNOWN.

def dead_registered_handoff(source):
    import re
    import tempfile
    from lib.physical_authority import private_directory as ensure_private_directory

    if (set(request) != {
            "database", "databaseIdentity", "registeredBindingJson", "provision",
            "mailbox", "outputDirectory", "handoff"}
            or e["expectedSource"] is None
            or source != e["expectedSource"]
            or p.get("normal") is not None):
        raise ValueError("Closed source-bound dead-runtime handoff required")
    registered = strict(request["registeredBindingJson"])
    if type(registered) is not dict or type(registered.get("physicalRuntime")) is not dict:
        raise ValueError("Exact registered runtime required")
    original = {key: registered["physicalRuntime"][key] for key in ("pid", "birth")}
    handoff = request["handoff"]
    if handoff["generation"] != registered["generation"]:
        raise ValueError("Current registered generation required")
    provision_ref = request["provision"]
    if set(provision_ref) != {"nativePath", "sha256", "identity"}:
        raise ValueError("Exact current provision reference required")
    database = canonical(request["database"])
    output = Path(request["outputDirectory"])
    if (str(output.parent.resolve(strict=True)).casefold() !=
            str(Path(tempfile.gettempdir()).resolve(strict=True)).casefold()
            or re.fullmatch(r"root-dead-registered-handoff-[a-f0-9]{32}", output.name) is None
            or output.exists() or output.is_symlink()):
        raise ValueError("Fresh private output directory required; no replay")

    # Sharing READ|WRITE permits this process's SQLite connection, but omitting
    # DELETE retains the exact database file object across its CAS transaction.
    h = k.CreateFileW(str(database), 0x80020000, 3, None, 3, 0x00200000, None)
    if h in (None, INVALID):
        raise OSError(ctypes.get_last_error(), "Stable native database unavailable")
    try:
        info = FileInfo()
        if (k.GetFileType(h) != 1
                or not k.GetFileInformationByHandle(h, ctypes.byref(info))
                or info.attributes & 0x410 or info.links != 1
                or identity(h) != request["databaseIdentity"]):
            raise ValueError("Original private database identity differs")
        check_acl(None, handle=h)

        def fence():
            dead(original)
            check_acl(None, handle=h)
            if identity(h) != request["databaseIdentity"]:
                raise ValueError("Original database identity changed before CAS")
            if inventory(p["sourceDirectory"], True) != source["helper"]:
                raise ValueError("Pinned helper source changed")
            if inventory(p["installedDirectory"], True) != source["installed"]:
                raise ValueError("Pinned installed source changed")
            raw, ident = file_bytes(provision_ref["nativePath"], True)
            if digest(raw) != provision_ref["sha256"] or ident != provision_ref["identity"]:
                raise ValueError("Original provision bytes or identity changed")
            provision = strict(raw)
            if (set(provision) != {
                    "database", "pid", "birth", "instance", "epoch", "source", "build", "credentials"}
                    or Path(provision["database"]).resolve(strict=True) != database
                    or any(provision[key] != registered["physicalRuntime"][key]
                           for key in ("pid", "birth", "source", "build"))
                    or {key: provision[key] for key in ("instance", "epoch")} != handoff["generation"]):
                raise ValueError("Registered process and current provision differ")
            mailbox = canonical(request["mailbox"])
            check_acl(mailbox)
            if any(mailbox.glob("*.request.json")):
                raise ValueError("Pending native mailbox prevents handoff")
            for name, expected in (
                    (p["nativePython"], p["nativePythonSha256"]),
                    (p["executable"], p["executableSha256"])):
                raw, _ = file_bytes(name)
                if digest(raw) != expected:
                    raise ValueError("Pinned native interpreter or executable changed")

        fence()
        ensure_private_directory(output)
        request_file = publish(str(output / "handoff-request.json"),
                               json.dumps(handoff, sort_keys=True, separators=(",", ":")).encode())
        committed = advance_dead_registered_generation(
            str(database), request["registeredBindingJson"], handoff, fence)
        if committed != {**handoff, "state": "committed"}:
            raise ValueError("Actual native CAS result differs; preserve originals")
        # This is a NEW operation's real commit, never settlement of old UNKNOWN.
        receipt_file = publish(str(output / "handoff-receipt.json"),
                               json.dumps({**handoff, "state": "completed"},
                                          sort_keys=True, separators=(",", ":")).encode())
        dead(original)
        return {"request": request_file, "receipt": receipt_file,
                "committed": committed, "SDK": 0, "processControl": 0,
                "historicalOutcome": "UNKNOWN_UNCHANGED"}
    finally:
        k.CloseHandle(h)

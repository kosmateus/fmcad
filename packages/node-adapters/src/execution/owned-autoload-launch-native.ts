import { normalObserverFusionLaunchNative } from "./controlled-fusion-launch-native";
import { ownedIdentityPreparationNative } from "./owned-identity-preparation-native";
import { ownedHistoricalProcessNative } from "./owned-historical-process-native";

/**
 * Separate private program, reusing the reviewed original native DB/handoff/CAS
 * primitives. No NORMAL invocation can select these policies or emit this intent.
 */
export function ownedAutoloadLaunchNative() {
  let base = normalObserverFusionLaunchNative()
    .replaceAll("normal-launch", "owned-autoload-launch")
    .replaceAll("normal-observer", "owned-autoload")
    .replaceAll('p["normal"]', 'p["owned"]')
    .replaceAll('p.get("normal")', 'p.get("owned")')
    .replace(/\bnormal_/g, "owned_");
  const environment = 'environment.pop("FUSION_MCP_BOOTSTRAP_INTENT", None)';
  if (base.split(environment).length !== 2)
    throw new Error("Pinned native owned environment boundary changed");
  base = base.replace(
    environment,
    'environment["FUSION_MCP_BOOTSTRAP_INTENT"] = paths["intent"]',
  );
  const marker = "\ntry:\n    if str(Path(sys.executable)";
  if (base.split(marker).length !== 2)
    throw new Error("Pinned native extension boundary changed");
  const program = base.replace(
    marker,
    ownedIdentityPreparationNative +
      "\n" +
      ownedHistoricalProcessNative +
      "\n" +
      ownedExtension +
      marker,
  );
  const beforeResume =
    "        if normal:\n            owned_release_database()\n";
  if (program.split(beforeResume).length !== 2)
    throw new Error("Pinned native resume boundary changed");
  const result =
    '        result = {"process": value, "journal": journal, "attempt": attempt, "sourceClosure": closure}';
  if (program.split(result).length !== 2)
    throw new Error("Pinned native owned result boundary changed");
  return program
    .replace(
      beforeResume,
      "        if normal:\n            identity_preparation = owned_final_resume(created, source, profile, bound, attempt, closure)\n            owned_release_database()\n",
    )
    .replace(
      result,
      '        result = {"process": value, "journal": journal, "attempt": attempt, "sourceClosure": closure}\n        if normal:\n            result.update({"identityAttempt": identity_preparation["attempt"],\n                           "identityJournal": identity_preparation["journal"],\n                           "identityPreparationFile": identity_preparation["terminal"],\n                           "identityPreparation": {key: identity_preparation["preparation"][key]\n                               for key in ("state", "origin", "process", "executable", "sha256",\n                                           "version", "arguments", "commandLine", "inputIdleCode", "logEvent")}})\n            result["intent"] = owned_intent',
    );
}

const ownedExtension = String.raw`
# OWNED_AUTOLOAD_ONLY_PRIVATE_EXTENSION: separate policy/wire, not NORMAL proof.
if action not in ("preflight", "dead", "read-profile", "owned-autoload-launch"):
    raise ValueError("Separate owned native role refuses manual/NORMAL actions")
if (type(p.get("installedSource")) is not str or len(p["installedSource"]) != 40
        or any(c not in "0123456789abcdef" for c in p["installedSource"])):
    raise ValueError("Pinned native installed source required")
owned_inputs = []
owned_intent = None
owned_binding_source = None
owned_binding_profile = None
owned_replacement = None
owned_base_prepare = owned_prepare
owned_base_bind = owned_bind

def owned_before_generation(handoff):
    # NORMAL retains its original-generation contract. Only this private role
    # can verify an original, already-bound, unregistered process replacement.
    return handoff["nextGeneration"] if owned_replacement is not None else handoff["generation"]

def owned_registered_before():
    return owned_replacement["registeredBefore"] if owned_replacement is not None else owned_state["before"]

def owned_check_provision_identity(ident):
    if owned_replacement is not None and ident != owned_replacement["provisionIdentity"]:
        raise ValueError("Original replacement provision identity changed before write acquire")

def owned_bind_fields():
    return {"pid", "birth"} if owned_replacement is not None else {"pid", "birth", "instance", "epoch"}

def owned_replacement_file(ref):
    if type(ref) is not dict or set(ref) != {"nativePath", "sha256", "identity"}:
        raise ValueError("Original owned replacement reference required")
    original = snapshot(ref["nativePath"])
    if any(original[key] != ref[key] for key in ("nativePath", "sha256", "identity")):
        raise ValueError("Original owned replacement bytes/identity changed")
    return strict(base64.b64decode(original["base64"]))

def owned_retirement_matches(retired, process):
    common = {"exited", "oldPidPresent", "oldPid", "oldBirth",
              "observation", "oldExe", "oldExeSha256"}
    if (type(retired) is not dict or not common.issubset(retired)
            or retired["exited"] is not True or retired["oldPidPresent"] is not False
            or {"pid": retired["oldPid"], "birth": retired["oldBirth"]} != process
            or type(retired["oldExe"]) is not str
            or retired["oldExe"].casefold() != p["executable"].casefold()
            or retired["oldExeSha256"] != p["executableSha256"]):
        return False
    if retired["observation"] == "exact-original-process-signaled-after-one-WM_CLOSE":
        return (set(retired) == common | {"forceUsed", "windowHandle", "windowVisibleAtInput", "windowClass"}
                and retired["forceUsed"] is False and retired["windowVisibleAtInput"] is True
                and retired["windowClass"] == p["mainWindowClass"]
                and type(retired["windowHandle"]) is int and retired["windowHandle"] > 0)
    if retired["observation"] == "exact-original-provision-process-verified-dead":
        return (set(retired) == common | {"processControl", "originalTerminationOutcome"}
                and type(retired["processControl"]) is int and retired["processControl"] == 0
                and retired["originalTerminationOutcome"] == "UNKNOWN_UNCHANGED")
    return False

def owned_replacement_steps(proof):
    if type(proof) is not dict:
        raise ValueError("Closed original owned replacement required")
    if proof.get("kind") == "unregistered-created-process-v1":
        if set(proof) != {"kind", "priorProvision", "provisionReceipt", "retiredProcess"}:
            raise ValueError("Closed original owned replacement required")
        return [{key: proof[key] for key in ("priorProvision", "provisionReceipt", "retiredProcess")}]
    if (set(proof) != {"kind", "steps"}
            or proof["kind"] != "unregistered-created-process-chain-v1"
            or type(proof["steps"]) is not list or len(proof["steps"]) < 2):
        raise ValueError("Two or more original owned replacement steps required")
    for step in proof["steps"]:
        if type(step) is not dict or set(step) != {"priorProvision", "provisionReceipt", "retiredProcess"}:
            raise ValueError("Closed original owned replacement step required")
    return proof["steps"]

def owned_provision_identity(value):
    parsed = strict(value)
    if (type(parsed) is not list or len(parsed) != 11
            or any(type(item) is not int or item < 0 or item > 0xffffffff for item in parsed)):
        raise ValueError("Original native provision identity required")
    # File object/creation, link count and attributes must survive every in-place
    # bind. Write time and length change legitimately; the final ref is exact.
    return tuple(parsed[index] for index in (0, 1, 2, 3, 4, 9, 10))

def owned_replacement_chain(n, steps):
    _, handoff = owned_reference(n["handoffRequest"])
    current_raw, current_identity = file_bytes(p["paths"]["provision"], True, False)
    current_file = {"nativePath": str(Path(p["paths"]["provision"])),
                    "sha256": digest(current_raw), "identity": current_identity}
    current = strict(current_raw)
    root = previous = previous_ref = None
    seen_processes, seen_nonces = set(), set()
    for index, step in enumerate(steps):
        prior = owned_replacement_file(step["priorProvision"])
        receipt = owned_replacement_file(step["provisionReceipt"])
        retired = owned_replacement_file(step["retiredProcess"])
        if (type(prior) is not dict
                or set(prior) != {"database", "pid", "birth", "instance", "epoch", "source", "build", "credentials"}
                or type(receipt) is not dict
                or set(receipt) != {"kind", "isolation", "nonce", "old", "process", "generation",
                                    "handoffId", "handoffRequest", "handoffReceipt", "database",
                                    "beforeSha256", "backup", "after"}):
            raise ValueError("Closed original owned replacement chain records required")
        process = receipt["process"]
        if (type(process) is not dict or set(process) != {"pid", "birth"}
                or type(process["pid"]) is not int or not 0 < process["pid"] <= 0xffffffff
                or type(process["birth"]) is not str or not process["birth"]
                or any(c not in "0123456789" for c in process["birth"])
                or int(process["birth"]) <= 0
                or type(prior["pid"]) is not int or not 0 < prior["pid"] <= 0xffffffff
                or type(prior["birth"]) is not str or not prior["birth"]
                or any(c not in "0123456789" for c in prior["birth"])
                or int(prior["birth"]) <= 0):
            raise ValueError("Exact original owned replacement process required")
        before_process = {"pid": prior["pid"], "birth": prior["birth"]}
        if index == 0:
            root = prior
            seen_processes.add((prior["pid"], prior["birth"]))
        elif (prior != previous or step["priorProvision"]["sha256"] != previous_ref["sha256"]):
            raise ValueError("Original owned replacement continuity differs")
        after = {**prior, **process, **handoff["nextGeneration"]}
        last = index == len(steps) - 1
        if (receipt["kind"] != "owned-autoload-provision-bound-v1"
                or receipt["isolation"] != "NOT_PROVEN"
                or type(receipt["nonce"]) is not str or len(receipt["nonce"]) != 32
                or any(c not in "0123456789abcdef" for c in receipt["nonce"])
                or receipt["nonce"] in seen_nonces
                or (process["pid"], process["birth"]) in seen_processes
                or receipt["old"] != before_process
                or receipt["generation"] != handoff["nextGeneration"]
                or {"instance": prior["instance"], "epoch": prior["epoch"]} != (
                    handoff["generation"] if index == 0 else handoff["nextGeneration"])
                or receipt["handoffId"] != handoff["handoffId"]
                or receipt["handoffRequest"] != n["handoffRequest"]
                or receipt["handoffReceipt"] != n["handoffReceipt"]
                or receipt["backup"] != step["priorProvision"]
                or receipt["beforeSha256"] != step["priorProvision"]["sha256"]
                or type(receipt["after"]) is not dict
                or set(receipt["after"]) != {"nativePath", "sha256", "identity"}
                or receipt["after"]["nativePath"] != current_file["nativePath"]
                or owned_provision_identity(receipt["after"]["identity"]) != owned_provision_identity(current_identity)
                or (last and (receipt["after"] != current_file or after != current
                              or process != request["old"]
                              or step["retiredProcess"]["nativePath"] != n["retiredProcessPath"]))
                or current_file["sha256"] != n["provisionSha256"]
                or type(receipt["database"]) is not dict
                or set(receipt["database"]) != {"nativePath", "identity"}
                or receipt["database"].get("nativePath") != n["database"]["nativePath"]
                or owned_provision_identity(receipt["database"]["identity"]) != owned_provision_identity(n["database"]["identity"])
                or Path(prior["database"]).resolve() != Path(n["database"]["nativePath"]).resolve()
                or prior["source"] != n["source"] or prior["build"] != n["build"]
                or not owned_retirement_matches(retired, process)):
            raise ValueError("Original owned replacement chain differs")
        owned_historical_dead(before_process)
        owned_historical_dead(process)
        seen_nonces.add(receipt["nonce"])
        seen_processes.add((process["pid"], process["birth"]))
        previous, previous_ref = after, receipt["after"]
    return {"registeredBefore": root, "provisionIdentity": current_identity}

def owned_replacement_before(n):
    proof = n.get("replacement")
    steps = owned_replacement_steps(proof)
    if proof["kind"] == "unregistered-created-process-chain-v1":
        return owned_replacement_chain(n, steps)
    if (type(proof) is not dict or set(proof) != {
            "kind", "priorProvision", "provisionReceipt", "retiredProcess"}
            or proof["kind"] != "unregistered-created-process-v1"
            or proof["retiredProcess"]["nativePath"] != n["retiredProcessPath"]):
        raise ValueError("Explicit original owned replacement contract required")
    prior = owned_replacement_file(proof["priorProvision"])
    receipt = owned_replacement_file(proof["provisionReceipt"])
    retired = owned_replacement_file(proof["retiredProcess"])
    _, handoff = owned_reference(n["handoffRequest"])
    # Do not retain a FILE_SHARE_READ-only reader across the upcoming writable
    # acquisition. Recheck its exact identity on that held writable handle.
    current_raw, current_identity = file_bytes(p["paths"]["provision"], True, False)
    current_file = {"nativePath": str(Path(p["paths"]["provision"])),
                    "sha256": digest(current_raw), "identity": current_identity}
    current = strict(current_raw)
    process = request["old"]
    if (set(prior) != {"database", "pid", "birth", "instance", "epoch", "source", "build", "credentials"}
            or type(prior["pid"]) is not int or type(prior["birth"]) is not str
            or set(receipt) != {"kind", "isolation", "nonce", "old", "process", "generation",
                               "handoffId", "handoffRequest", "handoffReceipt", "database",
                               "beforeSha256", "backup", "after"}
            or receipt["kind"] != "owned-autoload-provision-bound-v1"
            or receipt["isolation"] != "NOT_PROVEN"
            or type(receipt["nonce"]) is not str or len(receipt["nonce"]) != 32
            or any(c not in "0123456789abcdef" for c in receipt["nonce"])
            or receipt["old"] != {"pid": prior["pid"], "birth": prior["birth"]}
            or receipt["process"] != process or receipt["old"] == process
            or receipt["generation"] != handoff["nextGeneration"]
            or {"instance": prior["instance"], "epoch": prior["epoch"]} != handoff["generation"]
            or receipt["handoffId"] != handoff["handoffId"]
            or receipt["handoffRequest"] != n["handoffRequest"]
            or receipt["handoffReceipt"] != n["handoffReceipt"]
            or receipt["backup"] != proof["priorProvision"]
            or receipt["beforeSha256"] != proof["priorProvision"]["sha256"]
            or receipt["after"] != {key: current_file[key] for key in ("nativePath", "sha256", "identity")}
            or current_file["sha256"] != n["provisionSha256"]
            or receipt["database"]["nativePath"] != n["database"]["nativePath"]
            or Path(prior["database"]).resolve() != Path(n["database"]["nativePath"]).resolve()
            or prior["source"] != n["source"] or prior["build"] != n["build"]
            or current != {**prior, **process, **handoff["nextGeneration"]}
            or not owned_retirement_matches(retired, process)):
        raise ValueError("Original owned replacement chain differs")
    # Neither a retired registry entry nor the unregistered created process may
    # still be alive. No registration, handoff or UNKNOWN settlement is written.
    owned_historical_dead({"pid": prior["pid"], "birth": prior["birth"]})
    owned_historical_dead(process)
    return {"registeredBefore": prior, "provisionIdentity": current_identity}

def owned_profile(raw, planned):
    import ntpath
    before, after = strict(raw), strict(planned)
    if (type(before) is not dict or set(before) != {"loadedScripts"}
            or type(before["loadedScripts"]) is not list
            or type(after) is not dict or set(after) != {"loadedScripts"}
            or type(after["loadedScripts"]) is not list):
        raise ValueError("Closed owned registration required")
    rows, seen, count = [], set(), 0
    target = ntpath.normcase(ntpath.join(p["installedDirectory"], "AutodeskFusionMCP.py"))
    for row in before["loadedScripts"]:
        if (type(row) is not dict or set(row) != {
                "name", "path", "location", "isRemoved", "isFavorite", "runOnStartup"}
                or type(row["name"]) is not str or not row["name"]
                or type(row["path"]) is not str or not row["path"] or "\0" in row["path"]
                or type(row["location"]) not in (int, float)
                or not math.isfinite(row["location"]) or int(row["location"]) != row["location"]
                or abs(row["location"]) > 9007199254740991
                or any(type(row[key]) is not bool for key in ("isRemoved", "isFavorite", "runOnStartup"))):
            raise ValueError("Closed owned registration row required")
        name = ntpath.normcase(ntpath.normpath(row["path"])) if ntpath.isabs(row["path"]) else row["path"].replace("\\", "/").lower()
        if name in seen:
            raise ValueError("Duplicate owned registration")
        seen.add(name)
        own = ntpath.isabs(row["path"]) and name == target
        if own:
            if row["isRemoved"]:
                raise ValueError("Owned entry removed")
            count += 1
        rows.append({**row, "runOnStartup": own})
    for row in after["loadedScripts"]:
        if (type(row) is not dict or set(row) != {
                "name", "path", "location", "isRemoved", "isFavorite", "runOnStartup"}
                or type(row["location"]) not in (int, float)
                or any(type(row[key]) is not bool for key in ("isRemoved", "isFavorite", "runOnStartup"))):
            raise ValueError("Closed planned owned registration row required")
    if count != 1 or after != {"loadedScripts": rows}:
        raise ValueError("Only exact owned startup ON and every foreign startup OFF required")

def owned_inputs_fence():
    for ref in owned_inputs:
        current = snapshot(ref["nativePath"])
        if any(current[key] != ref[key] for key in ("nativePath", "sha256", "identity")):
            raise ValueError("Original owned autorun/discovery input changed")

def owned_prepare(source):
    global owned_inputs, owned_replacement
    n = p["owned"]
    if (type(n.get("autorunOriginals")) is not list or len(n["autorunOriginals"]) != 2
            or type(n.get("discoveryOriginals")) is not list or not n["discoveryOriginals"]):
        raise ValueError("Two original autorun inputs and nonempty discovery refs required")
    owned_inputs = n["autorunOriginals"] + n["discoveryOriginals"]
    if "replacement" in n:
        proof = n["replacement"]
        owned_inputs += [step[key] for step in owned_replacement_steps(proof)
                         for key in ("priorProvision", "provisionReceipt", "retiredProcess")]
    names = set()
    for ref in owned_inputs:
        if (type(ref) is not dict or set(ref) != {"nativePath", "sha256", "identity"}
                or ref["nativePath"] not in p["originalPaths"]
                or ref["nativePath"].casefold() in names
                or ref["nativePath"].casefold() in {str(v).casefold() for v in p["paths"].values()}):
            raise ValueError("Distinct allowlisted original owned input required")
        names.add(ref["nativePath"].casefold())
    owned_inputs_fence()
    owned_replacement = owned_replacement_before(n) if "replacement" in n else None
    for name in ("intent", "entry", "returned"):
        private_directory(str(Path(p["paths"][name]).parent))
        if os.path.lexists(p["paths"][name]):
            raise ValueError("Fresh owned intent/receipt paths required; no replay")
    # Preserve the exact closed shape of the shared lifecycle implementation.
    lifecycle = {key: value for key, value in n.items()
                 if key not in ("autorunOriginals", "discoveryOriginals", "replacement")}
    p["owned"] = lifecycle
    try:
        return owned_base_prepare(source)
    finally:
        p["owned"] = n

def owned_bind(created, source, profile):
    global owned_binding_source, owned_binding_profile
    owned_binding_source, owned_binding_profile = source, profile
    owned_inputs_fence()
    return owned_base_bind(created, source, profile)

def owned_checkpoint(phase, process=None, provision=None):
    global owned_intent
    owned_inputs_fence()
    provision_ref, intent_ref = None, None
    if phase == "bound-before-resume":
        provision_file = snapshot(p["paths"]["provision"])
        if provision_file["sha256"] != provision:
            raise ValueError("Original owned provision readback changed")
        profile = owned_binding_profile
        require_profile(profile)
        owned_fence(owned_binding_source)
        value = {
            "kind": "fmcad-bootstrap-entry-intent", "version": 3,
            "mode": "owned-autoload-v1", "nonce": request["nonce"],
            "process": process, "purpose": "isolated-stdout-v1", "engineVersion": 2,
            "executable": {"path": p["executable"], "sha256": p["executableSha256"]},
            "installed": {"directory": p["installedDirectory"], "source": p["installedSource"],
                          "files": p["installedFiles"]},
            "profile": {"path": p["paths"]["profile"], "sha256": profile["sha256"]},
            "provision": {"path": p["paths"]["provision"], "sha256": provision_file["sha256"]},
            "generation": owned_state["next"],
            "receipts": {"directory": p["paths"]["receiptDirectory"],
                         "entry": p["paths"]["entry"], "returned": p["paths"]["returned"]},
        }
        owned_intent = publish(p["paths"]["intent"], json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        if snapshot(p["paths"]["intent"]) != owned_intent:
            raise ValueError("Original exclusive owned intent readback differs")
        provision_ref = {key: provision_file[key] for key in ("nativePath", "sha256", "identity")}
        intent_ref = {key: owned_intent[key] for key in ("nativePath", "sha256", "identity")}
    message = {"kind": "owned-autoload-checkpoint-v1", "phase": phase,
               "nonce": request["nonce"], "process": process,
               "provision": provision_ref, "intent": intent_ref}
    print(json.dumps(message, separators=(",", ":")), flush=True)
    raw = sys.stdin.buffer.readline(65537)
    if len(raw) > 65536:
        raise ValueError("Owned continuation budget exceeded")
    if strict(raw) != {**message, "kind": "owned-autoload-continue-v1"}:
        raise ValueError("Original parent owned boundary refused; no resume")
    owned_inputs_fence()

def owned_final_resume(created, source, profile, bound, launch_attempt, closure):
    value = {"pid": created.pid, "birth": process_birth(created.process)}
    if (image(created.process).casefold() != p["executable"].casefold()
            or k.WaitForSingleObject(created.process, 0) != 0x102):
        raise ValueError("Original suspended owned process changed")
    owned_fence(source)
    owned_inputs_fence()
    require_profile(profile)
    if (snapshot(p["paths"]["provision"]) != bound["provision"]
            or owned_intent is None or snapshot(p["paths"]["intent"]) != owned_intent):
        raise ValueError("Original owned provision/intent changed before resume")
    intent_value = strict(base64.b64decode(owned_intent["base64"]))
    if intent_value["process"] != value:
        raise ValueError("Original owned intent process differs")
    # Identity exits after about 31 idle seconds without a product connection.
    # Prepare it once, after the potentially slow parent/source/binding fences,
    # while Fusion is still suspended. Never restart an expired attempt.
    identity_preparation = owned_identity_attempt(
        source, request["old"], profile, request["nonce"],
        p["paths"], launch_attempt, closure,
    )
    owned_identity_assert_current()
    require_profile(profile)
    if (snapshot(p["paths"]["provision"]) != bound["provision"]
            or snapshot(p["paths"]["intent"]) != owned_intent
            or process_birth(created.process) != value["birth"]
            or image(created.process).casefold() != p["executable"].casefold()
            or k.WaitForSingleObject(created.process, 0) != 0x102):
        raise ValueError("Original owned binding/process changed during Identity preparation")
    return identity_preparation
`;

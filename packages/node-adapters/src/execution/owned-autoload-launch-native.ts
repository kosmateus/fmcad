import { normalObserverFusionLaunchNative } from "./controlled-fusion-launch-native";

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
  const program = base.replace(marker, ownedExtension + marker);
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
      "        if normal:\n            owned_final_resume(created, source, profile, bound)\n            owned_release_database()\n",
    )
    .replace(
      result,
      '        result = {"process": value, "journal": journal, "attempt": attempt, "sourceClosure": closure}\n        if normal:\n            result["intent"] = owned_intent',
    );
}

const ownedExtension = String.raw`
# OWNED_AUTOLOAD_ONLY_PRIVATE_EXTENSION: separate policy/wire, not NORMAL proof.
if action not in ("preflight", "dead", "read-profile", "owned-autoload-launch"):
    raise ValueError("Separate owned native role refuses manual/NORMAL actions")
owned_inputs = []
owned_intent = None
owned_binding_source = None
owned_binding_profile = None
owned_base_prepare = owned_prepare
owned_base_bind = owned_bind

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
    global owned_inputs
    n = p["owned"]
    if (type(n.get("autorunOriginals")) is not list or len(n["autorunOriginals"]) != 2
            or type(n.get("discoveryOriginals")) is not list or not n["discoveryOriginals"]):
        raise ValueError("Two original autorun inputs and nonempty discovery refs required")
    owned_inputs = n["autorunOriginals"] + n["discoveryOriginals"]
    names = set()
    for ref in owned_inputs:
        if (type(ref) is not dict or set(ref) != {"nativePath", "sha256", "identity"}
                or ref["nativePath"] not in p["originalPaths"]
                or ref["nativePath"].casefold() in names
                or ref["nativePath"].casefold() in {str(v).casefold() for v in p["paths"].values()}):
            raise ValueError("Distinct allowlisted original owned input required")
        names.add(ref["nativePath"].casefold())
    owned_inputs_fence()
    for name in ("intent", "entry", "returned"):
        private_directory(str(Path(p["paths"][name]).parent))
        if os.path.lexists(p["paths"][name]):
            raise ValueError("Fresh owned intent/receipt paths required; no replay")
    # Preserve the exact closed shape of the shared lifecycle implementation.
    lifecycle = {key: value for key, value in n.items()
                 if key not in ("autorunOriginals", "discoveryOriginals")}
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
            "installed": {"directory": p["installedDirectory"], "source": p["owned"]["source"],
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

def owned_final_resume(created, source, profile, bound):
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
`;

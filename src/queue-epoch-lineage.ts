import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
const load = createRequire(__filename);
const { hash, priorProcessAlive } = load("./queue-instance") as {
  hash(value: string | Uint8Array): string;
  priorProcessAlive(value: unknown): boolean | null;
};
const { readBytes } = load(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");
const { fileHash, directory } = load("./queue-atomic-migration-files") as {
  fileHash(file: string): { sha256: string };
  directory(dir: string): unknown;
};
const { hash: digest } = load(
  "./dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "EPOCH_LINEAGE_INVALID" });
}
const limit = 256 * 1024 * 1024;
export interface Reference {
  path: string;
  sha256: string;
}
export interface BackendTransitionProof {
  head: Reference;
  lifecycle: Reference;
}
export interface EffectivePredecessorIdentity {
  buildHash: string;
  configHash: string;
  instance: { pid: number; birth: string; version: string };
}
export interface EpochPointer {
  root: string;
  epochId: string;
  ownerClientId: string;
  ownerTokenHash: string;
  historicalSnapshotHash: string;
  historicalIdentityHash: string;
  document: { fileId: unknown };
  currentInstance: { pid: number; birth: string };
  qualificationReceipt: Reference;
  qualificationEvidence: Reference[];
  succession?: Reference;
  [key: string]: unknown;
}
interface Predecessor {
  pointer: Reference;
  epochId: string;
  state: Reference;
  identity: Reference;
  rootState: Reference;
  rootIdentity: Reference;
  grants: Reference[];
  qualification: Reference[];
}
export interface SuccessionAuthority {
  version: number;
  kind: string;
  requestId: string;
  clientId: string;
  ownerTokenHash: string;
  sourceCommit: string;
  buildHash: string;
  previousBuildHash: string;
  previousBrokerTerminated: boolean;
  previousProcessTerminated: boolean;
  permission: string;
  historicalOutcome: string;
  predecessor: Predecessor;
  qualification: Reference;
  closedEpochProof?: Reference;
  expectedProcess?: { pid: number; birth: string };
  backendTransition?: BackendTransitionProof;
  [key: string]: unknown;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!object(value)) fail("Epoch evidence must be a JSON object");
  return value;
}
function referenceValue(value: unknown): value is Reference {
  return (
    object(value) &&
    typeof value["path"] === "string" &&
    typeof value["sha256"] === "string"
  );
}
function references(value: unknown): value is Reference[] {
  return Array.isArray(value) && value.every(referenceValue);
}
function processIdentity(
  value: unknown,
): value is { pid: number; birth: string } {
  return (
    object(value) &&
    typeof value["pid"] === "number" &&
    typeof value["birth"] === "string"
  );
}
function isPointer(value: unknown): value is EpochPointer {
  return (
    object(value) &&
    typeof value["root"] === "string" &&
    typeof value["epochId"] === "string" &&
    typeof value["ownerClientId"] === "string" &&
    typeof value["ownerTokenHash"] === "string" &&
    typeof value["historicalSnapshotHash"] === "string" &&
    typeof value["historicalIdentityHash"] === "string" &&
    object(value["document"]) &&
    "fileId" in value["document"] &&
    processIdentity(value["currentInstance"]) &&
    referenceValue(value["qualificationReceipt"]) &&
    references(value["qualificationEvidence"]) &&
    (value["succession"] === undefined || referenceValue(value["succession"]))
  );
}
function pointerRecord(value: unknown): EpochPointer {
  if (!isPointer(value)) fail("Invalid epoch pointer evidence");
  return value;
}
function predecessor(value: unknown): value is Predecessor {
  return (
    object(value) &&
    typeof value["epochId"] === "string" &&
    referenceValue(value["pointer"]) &&
    referenceValue(value["state"]) &&
    referenceValue(value["identity"]) &&
    referenceValue(value["rootState"]) &&
    referenceValue(value["rootIdentity"]) &&
    references(value["grants"]) &&
    references(value["qualification"])
  );
}
function isAuthority(value: unknown): value is SuccessionAuthority {
  return (
    object(value) &&
    typeof value["version"] === "number" &&
    typeof value["kind"] === "string" &&
    typeof value["requestId"] === "string" &&
    typeof value["clientId"] === "string" &&
    typeof value["ownerTokenHash"] === "string" &&
    typeof value["sourceCommit"] === "string" &&
    typeof value["buildHash"] === "string" &&
    typeof value["previousBuildHash"] === "string" &&
    typeof value["previousBrokerTerminated"] === "boolean" &&
    typeof value["previousProcessTerminated"] === "boolean" &&
    typeof value["permission"] === "string" &&
    typeof value["historicalOutcome"] === "string" &&
    predecessor(value["predecessor"]) &&
    referenceValue(value["qualification"]) &&
    (value["closedEpochProof"] === undefined ||
      referenceValue(value["closedEpochProof"])) &&
    (value["expectedProcess"] === undefined ||
      processIdentity(value["expectedProcess"]))
  );
}
function authorityRecord(value: unknown): SuccessionAuthority {
  if (!isAuthority(value))
    fail("Invalid owner-bound succession authority evidence");
  return value;
}
export const reference = (file: string): Reference => ({
  path: file,
  sha256: fileHash(file).sha256,
});

function verified(entry: Reference | undefined, expectedPath: string): unknown {
  if (
    !entry ||
    entry.path !== expectedPath ||
    !/^[a-f0-9]{64}$/.test(entry.sha256 || "") ||
    !path.isAbsolute(entry.path) ||
    fs.realpathSync(entry.path) !== entry.path
  )
    fail("Retired epoch evidence changed or escaped its namespace");
  directory(path.dirname(entry.path));
  // Hash and decode the SAME opened bytes. Reopening after fileHash admitted a
  // different record during a filesystem race. The existing descriptor-path
  // evidence also fences a parent-directory substitution on the Linux broker.
  const bytes = readBytes(entry.path, limit, fs, expectedPath);
  if (hash(bytes) !== entry.sha256)
    fail("Retired epoch evidence changed or escaped its namespace");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}
// Private to one synchronous traversal: never retain authenticated records across
// requests or accept a caller-supplied cache as authority. Recheck namespace and
// inode metadata on reuse; changed files still require the original byte proof.
function traversalReader(): typeof verified {
  const records = new Map<string, { stamp: string; value: unknown }>();
  const stamp = (file: string) => {
    const s = fs.lstatSync(file, { bigint: true });
    return [
      s.dev,
      s.ino,
      s.mode,
      s.uid,
      s.gid,
      s.nlink,
      s.size,
      s.mtimeNs,
      s.ctimeNs,
    ].join(":");
  };
  return (entry, expectedPath) => {
    if (
      !entry ||
      entry.path !== expectedPath ||
      fs.realpathSync(entry.path) !== entry.path
    )
      return verified(entry, expectedPath);
    directory(path.dirname(entry.path));
    const key = entry.path + ":" + entry.sha256;
    const before = stamp(entry.path);
    const previous = records.get(key);
    if (previous?.stamp === before) return previous.value;
    const value = verified(entry, expectedPath);
    if (stamp(entry.path) !== before)
      fail("Retired epoch evidence changed during traversal");
    records.set(key, { stamp: before, value });
    return value;
  };
}
function grantReferences(root: string): Reference[] {
  return fs
    .readdirSync(root)
    .filter((name) => /^access-[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .map((name) => reference(path.join(root, name)));
}
// Publish only into a new authenticated owner transaction; retired stores stay
// untouched, including running/unknown work and their original result bytes.
export function predecessorSnapshot(
  root: string,
  audit: string,
  publish = false,
): Predecessor {
  const pointerFile = path.join(root, "isolated-admission-epoch.json");
  const bytes = fs.readFileSync(pointerFile),
    pointer = pointerRecord(JSON.parse(bytes.toString("utf8")) as unknown);
  if (
    pointer.root !== path.join(root, "admission-epochs", pointer.epochId || "")
  )
    fail("Invalid predecessor namespace");
  const archived = path.join(audit, "predecessor-pointer.json");
  if (publish) {
    directory(audit);
    if (!fs.existsSync(archived)) {
      fs.copyFileSync(pointerFile, archived, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(archived, 0o600);
      const fd = fs.openSync(archived, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const dir = fs.openSync(audit, "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    }
    if (fileHash(archived).sha256 !== hash(bytes))
      fail("The original pointer archive differs");
  }
  return {
    pointer: { path: archived, sha256: hash(bytes) },
    epochId: pointer.epochId,
    state: reference(path.join(pointer.root, "queue-state.json")),
    identity: reference(path.join(pointer.root, "instance.json")),
    grants: grantReferences(pointer.root),
    rootState: reference(path.join(root, "queue-state.json")),
    rootIdentity: reference(path.join(root, "instance.json")),
    qualification: [
      pointer.qualificationReceipt,
      ...pointer.qualificationEvidence,
    ],
  };
}
export function successionAuthority(root: string, entry: Reference) {
  return readSuccessionAuthority(root, entry, traversalReader());
}
interface CheckedSuccession {
  authority: SuccessionAuthority;
  audit: string;
  pointer: EpochPointer;
  state: unknown;
  identity: Record<string, unknown>;
  effectiveIdentity?: EffectivePredecessorIdentity;
}
function assertEpochLink(
  current: EpochPointer,
  previous: CheckedSuccession,
): void {
  if (
    current.ownerClientId !== previous.authority.clientId ||
    current.ownerTokenHash !== previous.authority.ownerTokenHash ||
    current.historicalSnapshotHash !==
      previous.pointer.historicalSnapshotHash ||
    current.historicalIdentityHash !==
      previous.pointer.historicalIdentityHash ||
    current.qualificationReceipt?.path !==
      path.join(previous.audit, "isolated-scratch-qualification", "result.json")
  )
    fail(
      "Epoch lineage does not bind the owner, original history or new qualification",
    );
}

function checkedIdentity(value: unknown): EffectivePredecessorIdentity {
  const identity = record(value),
    instance = record(identity["instance"]);
  if (
    typeof identity["buildHash"] !== "string" ||
    typeof identity["configHash"] !== "string" ||
    typeof instance["pid"] !== "number" ||
    typeof instance["birth"] !== "string" ||
    typeof instance["version"] !== "string"
  )
    fail("Physical backend has no complete SDK process identity");
  return {
    buildHash: identity["buildHash"],
    configHash: identity["configHash"],
    instance: {
      pid: instance["pid"],
      birth: instance["birth"],
      version: instance["version"],
    },
  };
}
/** The bootstrap build is the scratch CREATION build, not necessarily its
 * later runtime identity. A refresh never rewrites this physical qualification. */
function verifyCreationBuild(
  pointer: EpochPointer,
  authority: SuccessionAuthority,
  read: typeof verified,
): void {
  const dir = path.dirname(pointer.qualificationReceipt.path);
  const evidence = pointer.qualificationEvidence;
  const load = (name: string) => {
    const file = path.join(dir, name),
      entry = evidence.find((ref) => ref.path === file);
    if (!entry)
      fail("Runtime origin lacks original scratch qualification evidence");
    return record(read(entry, file));
  };
  if (
    evidence.length !== 5 ||
    new Set(evidence.map((ref) => ref.path)).size !== 5 ||
    evidence.some((ref) => path.dirname(ref.path) !== dir)
  )
    fail("Runtime origin qualification namespace changed");
  for (const ref of evidence) read(ref, ref.path);
  const result = record(
    read(pointer.qualificationReceipt, path.join(dir, "result.json")),
  );
  const intent = load("intent.json"),
    start = load("start.json"),
    sdk = load("sdk-qualified.json");
  load("wire.json");
  const binding = record(intent["binding"]),
    physical = record(start["binding"]);
  const jobs = pointer["quarantinedJobIds"];
  // Normal succession observes its separately authorized current-store job.
  // The inherited quarantine pair remains historical and is not its SDK key.
  let creationJobs: unknown[] = Array.isArray(jobs) ? jobs : [];
  if (authority["normalCurrentStore"] !== undefined) {
    const normal = record(authority["normalCurrentStore"]);
    if (
      normal["kind"] !== "normal-currentstore-v1" ||
      !referenceValue(normal["jobAuthorization"])
    )
      fail("Normal creation origin requires its immutable job authorization");
    const entry = normal["jobAuthorization"];
    const authorization = record(read(entry, entry.path));
    const profile = record(authorization["profile"]);
    if (
      authorization["kind"] !== "normal-currentstore-job-owner-authorization" ||
      authorization["requestId"] !== authority.requestId ||
      typeof profile["jobClientId"] !== "string" ||
      !profile["jobClientId"] ||
      !/^[a-f0-9]{64}$/.test(
        String(record(authorization["snapshot"])["jobOwnerTokenHash"]),
      ) ||
      profile["kind"] !== "normal-currentstore-target-v1" ||
      profile["epochClientId"] !== authority.clientId ||
      ![profile["jobId"], profile["rpcId"]].every(
        (id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id),
      )
    )
      fail("Normal creation origin owner or logical RPC binding changed");
    creationJobs = [profile["jobId"], profile["rpcId"]];
  }
  const instance = (value: unknown) => {
    const p = record(value),
      expected = record(pointer.currentInstance);
    return ["pid", "birth", "version"].every((key) => p[key] === expected[key]);
  };
  const receiptPath = path.join(
    dir,
    `remote-${String(physical["rpcId"])}.json`,
  );
  const receipt = load(path.basename(receiptPath));
  if (
    result["kind"] !== "isolated-scratch-qualification" ||
    result["status"] !== "complete" ||
    result["sdkRequestsSent"] !== 1 ||
    result["endpointVerified"] !== true ||
    result["clientId"] !== pointer.ownerClientId ||
    !instance(result["currentInstance"]) ||
    !object(result["summary"]) ||
    digest(result["summary"]) !== digest(sdk) ||
    binding["purpose"] !== "isolated-scratch-epoch-v1" ||
    binding["epochId"] !== pointer.epochId ||
    binding["clientId"] !== pointer.ownerClientId ||
    !instance(binding["currentInstance"]) ||
    !Array.isArray(jobs) ||
    binding["targetJobId"] !== creationJobs[0] ||
    binding["observationJobId"] !== creationJobs[1] ||
    physical["jobId"] !== binding["targetJobId"] ||
    binding["sdkProofPath"] !== path.join(dir, "sdk-qualified.json") ||
    binding["successorAuthorityHash"] !== pointer.succession?.sha256 ||
    record(binding["control"])["buildHash"] !== authority.buildHash ||
    physical["buildHash"] !== authority.buildHash ||
    physical["purpose"] !== binding["purpose"] ||
    physical["auditBindingHash"] !== digest(binding) ||
    physical["pythonOriginHash"] !== intent["sourceArtifactHash"] ||
    !instance(physical["auditExpectedInstance"]) ||
    !instance(start["instance"]) ||
    record(start["pythonCheck"])["status"] !== "passed" ||
    start["receipt"] !== receiptPath ||
    receipt["terminal"] !== true ||
    receipt["outcome"] !== "succeeded" ||
    !instance(receipt["instance"]) ||
    Object.keys(physical).some(
      (key) =>
        !Object.hasOwn(receipt, key) ||
        digest(receipt[key]) !== digest(physical[key]),
    ) ||
    sdk["purpose"] !== binding["purpose"] ||
    sdk["epochId"] !== pointer.epochId ||
    sdk["bindingHash"] !== digest(binding) ||
    digest(sdk["document"]) !== digest(pointer.document) ||
    sdk["independent"] !== true ||
    sdk["empty"] !== true ||
    sdk["unsaved"] !== true
  )
    fail(
      "Runtime identity has no matching qualified creation-build provenance",
    );
}
function readEpochOrigin(
  root: string,
  pointer: EpochPointer,
  snapshot: SuccessionAuthority["predecessor"],
  read: typeof verified,
  ancestryDepth: number,
): { identity: EffectivePredecessorIdentity; predecessor?: CheckedSuccession } {
  if (ancestryDepth >= 32) fail("Inherited backend lineage bound exceeded");
  const rawIdentity = record(
    read(snapshot.identity, path.join(pointer.root, "instance.json")),
  );
  const identity = checkedIdentity(rawIdentity);
  let creationIdentity = identity;
  const hasRestart = rawIdentity["normalRestart"] !== undefined;
  if (hasRestart) {
    const restartReference = rawIdentity["normalRestart"];
    if (!referenceValue(restartReference))
      fail("Normal restart reference is invalid");
    const restart = record(read(restartReference, restartReference.path));
    const closedReference = restart["closedReference"];
    if (!referenceValue(closedReference))
      fail("Normal restart closed reference is invalid");
    const pointerFile = path.join(root, "isolated-admission-epoch.json");
    const archivedPointer = fs.existsSync(snapshot.pointer.path)
      ? snapshot.pointer
      : { path: pointerFile, sha256: snapshot.pointer.sha256 };
    const pinnedPointer = read(archivedPointer, archivedPointer.path);
    if (!isDeepStrictEqual(pinnedPointer, pointer))
      fail("Normal restart archived pointer differs from its epoch");
    const state = record(
      read(snapshot.state, path.join(pointer.root, "queue-state.json")),
    );
    const { authenticateNormalRestart } = load(
      "./dist/node-adapters/broker-ipc/normal-restart",
    ) as typeof import("../packages/node-adapters/src/broker-ipc/normal-restart");
    const result = authenticateNormalRestart(
      root,
      pointer,
      {
        ...identity,
        normalRestart: restartReference,
      },
      { jobs: record(state["jobs"]) },
      {
        read(file) {
          if (file === pointerFile) return record(pinnedPointer);
          if (file === path.join(pointer.root, "closed.json"))
            return record(read(closedReference, file));
          fail("Normal restart attempted an unbound historical read");
        },
        checked(entry, file) {
          if (!referenceValue(entry))
            fail("Normal restart evidence reference is invalid");
          if (file === pointerFile) {
            if (
              entry.path !== pointerFile ||
              entry.sha256 !== snapshot.pointer.sha256
            )
              fail("Normal restart pointer reference differs from its archive");
            return record(read(archivedPointer, archivedPointer.path));
          }
          return record(read(entry, file));
        },
      },
    );
    creationIdentity = checkedIdentity(result.origin);
  }
  if (
    creationIdentity.instance.pid !== pointer.currentInstance.pid ||
    creationIdentity.instance.birth !== pointer.currentInstance.birth ||
    creationIdentity.instance.version !==
      record(pointer.currentInstance)["version"]
  )
    fail("Epoch identity differs from its qualified SDK process");
  const rootIdentity = record(
    read(snapshot.rootIdentity, path.join(root, "instance.json")),
  );
  if (!pointer.succession) {
    if (identity.configHash !== rootIdentity["configHash"])
      fail(
        "Physical backend genesis differs from immutable root configuration",
      );
    return { identity };
  }
  const predecessor = readSuccessionAuthority(
    root,
    pointer.succession,
    read,
    ancestryDepth + 1,
  );
  assertEpochLink(pointer, predecessor);
  const originConfig =
    predecessor.authority["configHash"] ?? predecessor.identity["configHash"];
  const expected = predecessor.authority.expectedProcess;
  if (
    identity.configHash !== originConfig ||
    !expected ||
    creationIdentity.instance.pid !== expected.pid ||
    creationIdentity.instance.birth !== expected.birth
  )
    fail(
      "Inherited backend differs from its qualified epoch/process authority",
    );
  if (
    hasRestart ||
    creationIdentity.buildHash !== predecessor.authority.buildHash
  )
    verifyCreationBuild(pointer, predecessor.authority, read);
  return { identity, predecessor };
}
/** A different root configuration needs authenticated qualification ancestry,
 * even when this epoch has not itself transitioned physical backends. */
export function successorEpochIdentity(
  root: string,
  pointer: EpochPointer,
  snapshot: SuccessionAuthority["predecessor"],
  read: typeof verified = traversalReader(),
  ancestryDepth = 0,
): EffectivePredecessorIdentity {
  return readEpochOrigin(root, pointer, snapshot, read, ancestryDepth).identity;
}

/** Verify the preserved physical transition, never substitute scalar identity
 * fields. Historical pointer references resolve to the authenticated archive,
 * so publication of a new epoch cannot retarget an old SDK request. */
export function successorBackendIdentity(
  root: string,
  pointer: EpochPointer,
  snapshot: SuccessionAuthority["predecessor"],
  proof: BackendTransitionProof,
  previousOwner: unknown,
  configHash: string,
  read: typeof verified = traversalReader(),
  ancestryDepth = 0,
): EffectivePredecessorIdentity {
  if (ancestryDepth >= 32) fail("Inherited backend lineage bound exceeded");
  const identity = record(
    read(snapshot.identity, path.join(pointer.root, "instance.json")),
  );
  const livePointer = path.join(root, "isolated-admission-epoch.json");
  const pointerRef = fs.existsSync(snapshot.pointer.path)
    ? snapshot.pointer
    : { path: livePointer, sha256: snapshot.pointer.sha256 };
  const anchors = [
    snapshot.identity,
    snapshot.rootIdentity,
    { path: livePointer, sha256: snapshot.pointer.sha256 },
  ];
  const config = (value: unknown) => {
    const result = { ...record(value) };
    for (const key of ["backend", "url", "headers", "tool", "protocolVersion"])
      delete result[key];
    return digest(result);
  };
  const { brokerConfigHash } = load("./queue-instance") as {
    brokerConfigHash(value: unknown): string;
  };
  const sameProcess = (value: unknown) => {
    const process = record(value);
    return ["pid", "birth", "version"].every(
      (key) => process[key] === record(pointer.currentInstance)[key],
    );
  };
  const validInstance = (value: unknown) => {
    const process = record(value);
    return (
      Number.isSafeInteger(process["pid"]) &&
      (process["pid"] as number) > 0 &&
      typeof process["birth"] === "string" &&
      !!process["birth"] &&
      typeof process["version"] === "string" &&
      !!process["version"]
    );
  };
  const sameIdentity = (left: unknown, right: unknown) =>
    ["pid", "birth", "version"].every(
      (key) => record(left)[key] === record(right)[key],
    );
  const authenticatedRefs = new Map<string, Reference>();
  const remember = (entry: Reference): void => {
    if (!referenceValue(entry))
      fail("Physical backend evidence reference is invalid");
    const previous = authenticatedRefs.get(entry.path);
    if (previous && previous.sha256 !== entry.sha256)
      fail("Physical backend contains ambiguous evidence references");
    authenticatedRefs.set(entry.path, entry);
  };
  remember(proof.lifecycle);
  const anchored = (file: string): Reference => {
    const entry = authenticatedRefs.get(file);
    if (!entry) fail("Physical backend omits required lifecycle evidence");
    return entry;
  };
  const physicalStartup = (
    head: Record<string, unknown>,
    identity: Record<string, unknown>,
    requireReady: boolean,
  ) => {
    if (!references(head["observation"]))
      fail("Runtime upgrade startup observations are invalid");
    const receipts = head["observation"].filter(
      (ref) =>
        path.dirname(ref.path) === root &&
        /^broker-startup-[a-f0-9-]{36}\.receipt\.json$/.test(
          path.basename(ref.path),
        ),
    );
    if (receipts.length !== 1)
      fail("Runtime upgrade requires one original physical startup");
    const entry = receipts[0]!;
    const receipt = record(read(entry, entry.path));
    const nonce = receipt["brokerNonce"];
    if (typeof nonce !== "string" || !/^[a-f0-9-]{36}$/.test(nonce))
      fail("Runtime upgrade startup nonce is invalid");
    const lifecycleFile = path.join(root, `broker-lifecycle-${nonce}.json`);
    const lifecycleReference = anchored(lifecycleFile);
    const lifecycle = record(read(lifecycleReference, lifecycleFile));
    const owner = record(lifecycle["owner"]);
    const binding = record(lifecycle["binding"]);
    const observation = record(receipt["probeObservation"]);
    if (
      !(requireReady
        ? lifecycle["stage"] === "ready"
        : ["ready", "recovery"].includes(String(lifecycle["stage"]))) ||
      lifecycle["buildHash"] !== identity["buildHash"] ||
      lifecycle["configHash"] !== identity["configHash"] ||
      lifecycle["receipt"] !== entry.path ||
      owner["nonce"] !== nonce ||
      binding["brokerNonce"] !== nonce ||
      binding["ownerPid"] !== owner["pid"] ||
      binding["ownerBirth"] !== owner["birth"] ||
      binding["buildHash"] !== identity["buildHash"] ||
      binding["stage"] !== "startup" ||
      receipt["terminal"] !== true ||
      receipt["outcome"] !== "succeeded" ||
      !Object.entries(binding).every(([key, value]) =>
        isDeepStrictEqual(receipt[key], value),
      ) ||
      !sameIdentity(receipt["instance"], identity["instance"]) ||
      observation["schema"] !== "fmcad-instance-probe-v1" ||
      !isDeepStrictEqual(observation["identity"], identity["instance"])
    )
      fail("Runtime upgrade original physical startup changed");
    return { entry, receipt, lifecycleReference };
  };
  const verifyDeadPredecessor = (
    head: Record<string, unknown>,
    destination: string,
    refs: Reference[],
  ): false | { previous: Record<string, unknown>; sourceRef: Reference } => {
    if (head["deadPredecessor"] === undefined) return false;
    const proofRef = head["deadPredecessor"];
    const proofFile = path.join(destination, "dead-predecessor.json");
    if (
      !referenceValue(proofRef) ||
      proofRef.path !== proofFile ||
      !refs.some(
        (ref) => ref.path === proofFile && ref.sha256 === proofRef.sha256,
      )
    )
      fail("Dead-SDK proof is not anchored by its backend transition");
    const dead = record(read(proofRef, proofFile));
    const previous = record(dead["previous"]);
    const owner = record(dead["previousOwner"]);
    const epoch = record(dead["epoch"]);
    const queue = record(dead["queue"]);
    const jobs = record(dead["jobs"]);
    const evidence = dead["evidence"];
    const sourceRef = dead["sourceIdentityReference"];
    const requestId = dead["stopRequestId"];
    if (
      dead["kind"] !== "settled-normal-dead-predecessor-v1" ||
      typeof requestId !== "string" ||
      !requestId ||
      !referenceValue(sourceRef) ||
      !references(evidence) ||
      !refs.some(
        (ref) => ref.path === sourceRef.path && ref.sha256 === sourceRef.sha256,
      ) ||
      epoch["root"] !== pointer.root ||
      epoch["epochId"] !== pointer.epochId ||
      epoch["ownerClientId"] !== pointer.ownerClientId ||
      !isDeepStrictEqual(epoch["currentInstance"], pointer.currentInstance) ||
      previous["configHash"] !== head["previousConfigHash"] ||
      typeof previous["buildHash"] !== "string" ||
      !validInstance(previous["instance"]) ||
      !isDeepStrictEqual(read(sourceRef, sourceRef.path), previous) ||
      priorProcessAlive(previous["instance"]) !== false ||
      priorProcessAlive(owner) !== false ||
      typeof owner["nonce"] !== "string" ||
      !/^[a-f0-9-]{36}$/.test(owner["nonce"])
    )
      fail("Dead-SDK source or epoch binding is invalid");
    if (
      queue["active"] !== null ||
      queue["blocked"] !== null ||
      queue["lease"] !== null ||
      queue["localUnknown"] !== null ||
      queue["controlBlocked"] !== null ||
      queue["paused"] !== true ||
      !Number.isSafeInteger(queue["controlGeneration"])
    )
      fail("Dead-SDK predecessor was not settled under an owner stop");
    const controlRequest = record(queue["controlRequest"]);
    if (
      controlRequest["paused"] !== true ||
      controlRequest["generation"] !== queue["controlGeneration"]
    )
      fail("Owner stop pause generation is invalid");
    for (const job of Object.values(jobs))
      if (
        !["succeeded", "failed", "cancelled", "expired"].includes(
          String(record(job)["state"]),
        )
      )
        fail("Dead-SDK predecessor contains unfinished or UNKNOWN work");
    const digest = hash(requestId);
    const adminFile = path.join(root, `console-admin-${digest}.json`);
    const releaseFile = path.join(root, `console-release-${digest}.json`);
    const lifecycleFile = path.join(
      root,
      `broker-lifecycle-${String(owner["nonce"])}.json`,
    );
    const startupFile = path.join(
      root,
      `broker-startup-${String(owner["nonce"])}.receipt.json`,
    );
    const pointerFile = path.join(root, "isolated-admission-epoch.json");
    const closedFile = path.join(pointer.root, "closed.json");
    const admin = record(read(findEvidence(evidence, adminFile), adminFile));
    const release = record(
      read(findEvidence(evidence, releaseFile), releaseFile),
    );
    const lifecycle = record(
      read(findEvidence(evidence, lifecycleFile), lifecycleFile),
    );
    const startup = record(
      read(findEvidence(evidence, startupFile), startupFile),
    );
    read(findEvidence(evidence, pointerFile), pointerFile);
    read(findEvidence(evidence, closedFile), closedFile);
    const lifecycleOwner = record(lifecycle["owner"]);
    const binding = record(lifecycle["binding"]);
    const expectedGeneration = admin["expectedGeneration"];
    const controlGeneration = queue["controlGeneration"];
    if (
      lifecycle["stage"] !== "ready" ||
      lifecycle["buildHash"] !== previous["buildHash"] ||
      lifecycle["configHash"] !== previous["configHash"] ||
      lifecycleOwner["nonce"] !== owner["nonce"] ||
      lifecycleOwner["pid"] !== owner["pid"] ||
      lifecycleOwner["birth"] !== owner["birth"] ||
      binding["brokerNonce"] !== owner["nonce"] ||
      binding["ownerPid"] !== owner["pid"] ||
      binding["ownerBirth"] !== owner["birth"] ||
      binding["buildHash"] !== previous["buildHash"] ||
      binding["stage"] !== "startup" ||
      lifecycle["receipt"] !== startupFile ||
      startup["terminal"] !== true ||
      startup["outcome"] !== "succeeded" ||
      !Object.entries(binding).every(([key, value]) =>
        isDeepStrictEqual(startup[key], value),
      ) ||
      !sameIdentity(startup["instance"], previous["instance"]) ||
      admin["action"] !== "console-stop" ||
      admin["clientId"] !== pointer.ownerClientId ||
      admin["requestId"] !== requestId ||
      admin["instanceId"] !== owner["nonce"] ||
      admin["buildHash"] !== previous["buildHash"] ||
      admin["status"] !== "accepted" ||
      record(admin["result"])["releaseFile"] !== releaseFile ||
      release["terminal"] !== true ||
      release["outcome"] !== "released" ||
      release["requestId"] !== requestId ||
      release["instanceId"] !== owner["nonce"] ||
      release["buildHash"] !== previous["buildHash"] ||
      (expectedGeneration !== controlGeneration &&
        (expectedGeneration as number) + 1 !== controlGeneration)
    )
      fail("Owner stop, predecessor lifecycle or startup receipt is invalid");
    const workerEvidence = dead["workerEvidence"];
    if (!references(workerEvidence))
      fail("Dead-SDK worker evidence is invalid");
    for (const [id] of Object.entries(jobs)) {
      const workerFile = path.join(root, "jobs", id, "worker-identity.json");
      const ref = workerEvidence.find((entry) => entry.path === workerFile);
      if (fs.existsSync(workerFile)) {
        if (!ref || priorProcessAlive(read(ref, workerFile)) !== false)
          fail("A predecessor worker is alive or its death is unproven");
      } else if (ref) fail("Predecessor worker evidence disappeared");
    }
    for (const ref of evidence) read(ref, ref.path);
    const transitionIdentity = record(
      read(
        head["identity"] as Reference,
        path.join(destination, "instance.json"),
      ),
    );
    if (
      !validInstance(transitionIdentity["instance"]) ||
      sameIdentity(transitionIdentity["instance"], previous["instance"])
    )
      fail("Dead-SDK transition did not bind a fresh target process");
    return { previous, sourceRef };
  };
  const findEvidence = (value: unknown, expectedPath: string): Reference => {
    if (!references(value)) fail("Dead-SDK source evidence list is invalid");
    const entry = value.find((ref) => ref.path === expectedPath);
    if (!entry) fail("Dead-SDK proof omits required source evidence");
    return entry;
  };
  const verifyRuntimeUpgrade = (
    head: Record<string, unknown>,
    destination: string,
    refs: Reference[],
    effective: Record<string, unknown>,
    prior: EffectivePredecessorIdentity,
    priorHead: Record<string, unknown>,
    priorReference: Reference,
  ): void => {
    const proofFile = path.join(destination, "runtime-upgrade.json");
    const entry = head["runtimeUpgrade"];
    const headRefs = new Map(refs.map((ref) => [ref.path, ref.sha256]));
    if (
      head["deadPredecessor"] !== undefined ||
      !referenceValue(entry) ||
      entry.path !== proofFile ||
      headRefs.get(entry.path) !== entry.sha256
    )
      fail("Runtime upgrade is not anchored by its physical transition");
    const upgrade = record(read(entry, proofFile));
    const previous = record(upgrade["previous"]);
    const owner = record(upgrade["previousOwner"]);
    const epoch = record(upgrade["epoch"]);
    const sourceIdentity = upgrade["sourceIdentityReference"];
    const evidence = upgrade["evidence"];
    const requestId = upgrade["stopRequestId"];
    if (
      upgrade["kind"] !== "settled-normal-runtime-upgrade-v1" ||
      !referenceValue(sourceIdentity) ||
      !isDeepStrictEqual(sourceIdentity, priorHead["identity"]) ||
      !isDeepStrictEqual(read(sourceIdentity, sourceIdentity.path), previous) ||
      !references(evidence) ||
      typeof requestId !== "string" ||
      !requestId ||
      previous["buildHash"] !== prior.buildHash ||
      previous["configHash"] !== prior.configHash ||
      !/^[a-f0-9]{64}$/.test(String(previous["buildHash"])) ||
      effective["buildHash"] === previous["buildHash"] ||
      !sameIdentity(previous["instance"], prior.instance) ||
      !sameIdentity(effective["instance"], prior.instance) ||
      !isDeepStrictEqual(head["previousConfig"], head["nextConfig"]) ||
      !isDeepStrictEqual(head["previousConfig"], priorHead["nextConfig"]) ||
      previous["configHash"] !== head["previousConfigHash"] ||
      effective["configHash"] !== previous["configHash"] ||
      epoch["root"] !== pointer.root ||
      epoch["epochId"] !== pointer.epochId ||
      epoch["ownerClientId"] !== pointer.ownerClientId ||
      !isDeepStrictEqual(epoch["currentInstance"], pointer.currentInstance) ||
      owner["protocol"] !== 2 ||
      !Number.isSafeInteger(owner["pid"]) ||
      (owner["pid"] as number) <= 0 ||
      typeof owner["birth"] !== "string" ||
      !owner["birth"] ||
      typeof owner["nonce"] !== "string" ||
      !/^[a-f0-9-]{36}$/.test(owner["nonce"]) ||
      priorProcessAlive(owner) !== false
    )
      fail(
        "Runtime upgrade source, owner, configuration or SDK continuity changed",
      );
    for (const ref of evidence) {
      if (headRefs.get(ref.path) !== ref.sha256)
        fail("Runtime upgrade source evidence is not anchored");
      read(ref, ref.path);
    }
    const ownLifecycleFile = path.join(
      root,
      `broker-lifecycle-${owner["nonce"]}.json`,
    );
    const ownStartupFile = path.join(
      root,
      `broker-startup-${owner["nonce"]}.receipt.json`,
    );
    const lifecycle = record(
      read(findEvidence(evidence, ownLifecycleFile), ownLifecycleFile),
    );
    const binding = record(lifecycle["binding"]);
    if (
      lifecycle["stage"] !== "ready" ||
      !isDeepStrictEqual(lifecycle["owner"], owner) ||
      lifecycle["configHash"] !== previous["configHash"] ||
      lifecycle["buildHash"] !== previous["buildHash"] ||
      lifecycle["receipt"] !== ownStartupFile ||
      binding["brokerNonce"] !== owner["nonce"] ||
      binding["ownerPid"] !== owner["pid"] ||
      binding["ownerBirth"] !== owner["birth"] ||
      binding["stage"] !== "startup" ||
      binding["buildHash"] !== previous["buildHash"]
    )
      fail("Runtime upgrade source owner lifecycle changed");
    const sourceStartup = record(upgrade["sourceStartup"]);
    if (sourceStartup["kind"] === "pinned-head-reopen") {
      const original = physicalStartup(priorHead, previous, true);
      if (
        !isDeepStrictEqual(sourceStartup["headReference"], priorReference) ||
        !isDeepStrictEqual(sourceStartup["receiptReference"], original.entry) ||
        !isDeepStrictEqual(
          sourceStartup["lifecycleReference"],
          original.lifecycleReference,
        ) ||
        !["headReference", "receiptReference", "lifecycleReference"].every(
          (key) =>
            evidence.some((ref) => isDeepStrictEqual(ref, sourceStartup[key])),
        ) ||
        record(original.receipt)["brokerNonce"] === owner["nonce"] ||
        !isDeepStrictEqual(
          Object.keys(binding).sort(),
          [
            "brokerNonce",
            "ownerPid",
            "ownerBirth",
            "buildHash",
            "stage",
          ].sort(),
        )
      )
        fail(
          "Runtime upgrade metadata reopen differs from its immediate physical source",
        );
    } else if (
      sourceStartup["kind"] !== "owner-startup-probe" ||
      !isDeepStrictEqual(
        sourceStartup["receiptReference"],
        findEvidence(evidence, ownStartupFile),
      )
    )
      fail("Runtime upgrade source startup proof is invalid");
    if (
      sourceStartup["kind"] === "owner-startup-probe" ||
      fs.existsSync(ownStartupFile)
    ) {
      const startup = record(
        read(findEvidence(evidence, ownStartupFile), ownStartupFile),
      );
      if (
        startup["terminal"] !== true ||
        startup["outcome"] !== "succeeded" ||
        !Object.entries(binding).every(([key, value]) =>
          isDeepStrictEqual(startup[key], value),
        ) ||
        !sameIdentity(startup["instance"], previous["instance"])
      )
        fail("Runtime upgrade source owner startup receipt changed");
    }
    const queue = record(upgrade["queue"]);
    const control = record(queue["controlRequest"]);
    const jobs = record(upgrade["jobs"]);
    if (
      queue["active"] !== null ||
      queue["blocked"] !== null ||
      queue["lease"] !== null ||
      queue["localUnknown"] !== null ||
      queue["controlBlocked"] !== null ||
      queue["paused"] !== true ||
      !Number.isSafeInteger(queue["controlGeneration"]) ||
      control["paused"] !== true ||
      control["generation"] !== queue["controlGeneration"]
    )
      fail("Runtime upgrade source was not settled under its owner stop");
    for (const job of Object.values(jobs))
      if (
        !["succeeded", "failed", "cancelled", "expired"].includes(
          String(record(job)["state"]),
        ) ||
        record(job)["executionOutcome"] === "unknown"
      )
        fail("Runtime upgrade source contains unfinished or UNKNOWN work");
    const digest = hash(requestId);
    const adminFile = path.join(root, `console-admin-${digest}.json`);
    const releaseFile = path.join(root, `console-release-${digest}.json`);
    const admin = record(read(findEvidence(evidence, adminFile), adminFile));
    const release = record(
      read(findEvidence(evidence, releaseFile), releaseFile),
    );
    const closedFile = path.join(pointer.root, "closed.json");
    const closed = record(read(findEvidence(evidence, closedFile), closedFile));
    read(findEvidence(evidence, livePointer), livePointer);
    if (
      closed["admissionMode"] !== "normal-multidocument" ||
      admin["action"] !== "console-stop" ||
      admin["clientId"] !== pointer.ownerClientId ||
      admin["requestId"] !== requestId ||
      admin["instanceId"] !== owner["nonce"] ||
      admin["buildHash"] !== previous["buildHash"] ||
      admin["status"] !== "accepted" ||
      record(admin["result"])["releaseFile"] !== releaseFile ||
      release["terminal"] !== true ||
      release["outcome"] !== "released" ||
      release["requestId"] !== requestId ||
      release["instanceId"] !== owner["nonce"] ||
      release["buildHash"] !== previous["buildHash"] ||
      (admin["expectedGeneration"] !== queue["controlGeneration"] &&
        (admin["expectedGeneration"] as number) + 1 !==
          queue["controlGeneration"])
    )
      fail("Runtime upgrade owner stop, release or generation changed");
    const workers = upgrade["workerEvidence"];
    if (!references(workers))
      fail("Runtime upgrade worker evidence is invalid");
    const evidenceRefs = new Map(evidence.map((ref) => [ref.path, ref.sha256]));
    const workerRefs = new Map(workers.map((ref) => [ref.path, ref]));
    if (workerRefs.size !== workers.length)
      fail("Runtime upgrade worker evidence is ambiguous");
    for (const worker of workers)
      if (evidenceRefs.get(worker.path) !== worker.sha256)
        fail("Runtime upgrade worker identity is not anchored");
    for (const id of Object.keys(jobs)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id))
        fail("Runtime upgrade job namespace is invalid");
      const workerFile = path.join(root, "jobs", id, "worker-identity.json");
      const worker = workerRefs.get(workerFile);
      if (fs.existsSync(workerFile)) {
        if (!worker || priorProcessAlive(read(worker, workerFile)) !== false)
          fail("Runtime upgrade worker is alive or its death is unproven");
      } else if (worker) fail("Runtime upgrade worker identity disappeared");
    }
    const expectedWorkers = new Set(
      Object.keys(jobs).map((id) =>
        path.join(root, "jobs", id, "worker-identity.json"),
      ),
    );
    if (workers.some((ref) => !expectedWorkers.has(ref.path)))
      fail("Runtime upgrade contains unrelated worker evidence");
    const startup = physicalStartup(head, effective, false);
    if (!sameIdentity(startup.receipt["auditExpectedInstance"], prior.instance))
      fail(
        "Runtime upgrade target startup differs from its prior effective SDK",
      );
  };
  const visit = (
    entry: Reference,
    depth: number,
  ): EffectivePredecessorIdentity => {
    if (depth >= 32) fail("Physical backend lineage bound exceeded");
    const head = record(read(entry, entry.path));
    const requestId = head["requestId"];
    if (
      typeof requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)
    )
      fail("Invalid predecessor backend request");
    const destination = path.join(
      root,
      "physical-backend-transitions",
      requestId,
    );
    if (
      entry.path !== path.join(destination, "transition.json") ||
      head["version"] !== 1 ||
      head["kind"] !== "owner-bound-physical-backend-transition" ||
      head["epochId"] !== pointer.epochId ||
      head["ownerClientId"] !== pointer.ownerClientId ||
      head["ownerTokenHash"] !== pointer.ownerTokenHash ||
      !references(head["predecessor"]) ||
      !references(head["observation"]) ||
      !referenceValue(head["identity"])
    )
      fail("Physical backend owner, epoch or namespace changed");
    const refs = head["predecessor"];
    for (const anchor of anchors)
      if (
        !refs.some(
          (ref) => ref.path === anchor.path && ref.sha256 === anchor.sha256,
        )
      )
        fail("Physical backend lineage omits an immutable root/epoch anchor");
    for (const ref of [...refs, ...head["observation"]]) {
      if (!ref.path.startsWith(root + path.sep))
        fail("Physical backend evidence escaped its queue");
      if (ref.path === livePointer) {
        if (ref.sha256 !== pointerRef.sha256)
          fail("Physical backend pointer changed");
        read(pointerRef, pointerRef.path);
      } else read(ref, ref.path);
      remember(ref);
    }
    const effective = record(
      read(head["identity"], path.join(destination, "instance.json")),
    );
    const deadPredecessor = verifyDeadPredecessor(head, destination, refs);
    const escrow = refs.find(
      (ref) => ref.path === path.join(destination, "predecessor-head.json"),
    );
    let runtimePrior: EffectivePredecessorIdentity | undefined;
    const runtimeUpgrade = head["runtimeUpgrade"] !== undefined;
    if (runtimeUpgrade) {
      if (!escrow)
        fail(
          "Runtime upgrade requires its authenticated immediate predecessor",
        );
      const priorHead = record(read(escrow, escrow.path));
      const priorReference = {
        path: path.join(
          root,
          "physical-backend-transitions",
          String(priorHead["requestId"]),
          "transition.json",
        ),
        sha256: escrow.sha256,
      };
      runtimePrior = visit(priorReference, depth + 1);
      verifyRuntimeUpgrade(
        head,
        destination,
        refs,
        effective,
        runtimePrior,
        priorHead,
        priorReference,
      );
    }
    const previousConfig = record(head["previousConfig"]),
      nextConfig = record(head["nextConfig"]);
    if (
      brokerConfigHash(previousConfig) !== head["previousConfigHash"] ||
      brokerConfigHash(nextConfig) !== head["nextConfigHash"] ||
      effective["configHash"] !== head["nextConfigHash"] ||
      !/^[a-f0-9]{64}$/.test(String(effective["buildHash"])) ||
      !validInstance(effective["instance"]) ||
      (!deadPredecessor &&
        !runtimeUpgrade &&
        !sameProcess(effective["instance"])) ||
      !["addin", "mcp"].includes(String(previousConfig["backend"])) ||
      !["addin", "mcp"].includes(String(nextConfig["backend"])) ||
      (!runtimeUpgrade &&
        previousConfig["backend"] === nextConfig["backend"]) ||
      config(previousConfig) !== config(nextConfig)
    )
      fail("Physical backend configuration, build or SDK identity changed");
    if (escrow) {
      const priorHead = record(read(escrow, escrow.path));
      const prior =
        runtimePrior ||
        visit(
          {
            path: path.join(
              root,
              "physical-backend-transitions",
              String(priorHead["requestId"]),
              "transition.json",
            ),
            sha256: escrow.sha256,
          },
          depth + 1,
        );
      if (
        head["previousConfigHash"] !== prior.configHash ||
        (deadPredecessor &&
          (!isDeepStrictEqual(
            deadPredecessor.sourceRef,
            priorHead["identity"],
          ) ||
            !isDeepStrictEqual(
              checkedIdentity(deadPredecessor.previous),
              prior,
            ))) ||
        !refs.some(
          (ref) =>
            ref.path === record(priorHead["identity"])["path"] &&
            ref.sha256 === record(priorHead["identity"])["sha256"],
        )
      )
        fail("Physical backend predecessor identity/configuration changed");
    } else {
      if (head["previousConfigHash"] !== identity["configHash"])
        fail("Physical backend genesis differs from immutable epoch identity");
      const origin = readEpochOrigin(
        root,
        pointer,
        snapshot,
        read,
        ancestryDepth,
      );
      if (
        deadPredecessor &&
        (!isDeepStrictEqual(deadPredecessor.sourceRef, snapshot.identity) ||
          !isDeepStrictEqual(
            checkedIdentity(deadPredecessor.previous),
            origin.identity,
          ))
      )
        fail("Dead-SDK source differs from its authenticated effective epoch");
      const inheritedHead =
        origin.predecessor?.authority.backendTransition?.head;
      if (
        inheritedHead &&
        pointer.succession &&
        ![pointer.succession, inheritedHead].every((anchor) =>
          refs.some(
            (ref) => ref.path === anchor.path && ref.sha256 === anchor.sha256,
          ),
        )
      )
        fail(
          "Inherited backend omits its authenticated predecessor authority/head",
        );
    }
    if (
      !head["observation"].some((ref) => {
        if (!/^broker-startup-.*\.receipt\.json$/.test(path.basename(ref.path)))
          return false;
        const receipt = record(read(ref, ref.path));
        return (
          receipt["terminal"] === true &&
          receipt["outcome"] === "succeeded" &&
          receipt["stage"] === "startup" &&
          receipt["buildHash"] === effective["buildHash"] &&
          ref.path ===
            path.join(
              root,
              `broker-startup-${String(receipt["brokerNonce"])}.receipt.json`,
            ) &&
          sameIdentity(receipt["instance"], effective["instance"]) &&
          (deadPredecessor
            ? !Object.hasOwn(receipt, "auditExpectedInstance")
            : runtimeUpgrade
              ? sameIdentity(
                  receipt["auditExpectedInstance"],
                  runtimePrior!.instance,
                )
              : sameProcess(receipt["auditExpectedInstance"]))
        );
      })
    )
      fail("Physical backend lacks its original terminal startup observation");
    return checkedIdentity(effective);
  };
  const effective = visit(proof.head, 0);
  const owner = record(previousOwner);
  const lifecycle = record(
    read(
      proof.lifecycle,
      path.join(root, `broker-lifecycle-${String(owner["nonce"])}.json`),
    ),
  );
  const head = record(read(proof.head, proof.head.path));
  const receiptPath = path.join(
    root,
    `broker-startup-${String(owner["nonce"])}.receipt.json`,
  );
  const receiptRef = (head["observation"] as Reference[]).find(
    (ref) => ref.path === receiptPath,
  );
  const receipt = receiptRef && record(read(receiptRef, receiptPath));
  if (
    digest(lifecycle["owner"]) !== digest(previousOwner) ||
    lifecycle["buildHash"] !== effective.buildHash ||
    lifecycle["configHash"] !== effective.configHash ||
    !["ready", "recovery"].includes(String(lifecycle["stage"])) ||
    effective.configHash !== configHash ||
    !receipt ||
    receipt["brokerNonce"] !== owner["nonce"] ||
    receipt["ownerPid"] !== owner["pid"] ||
    receipt["ownerBirth"] !== owner["birth"]
  )
    fail(
      "Physical backend lifecycle differs from the original broker owner/config/build",
    );
  return effective;
}
function readSuccessionAuthority(
  root: string,
  entry: Reference,
  read: typeof verified,
  ancestryDepth = 0,
): CheckedSuccession {
  if (ancestryDepth >= 32) fail("Inherited backend lineage bound exceeded");
  if (!entry || !path.isAbsolute(entry.path || ""))
    fail("Missing credential-bound succession authority");
  if (
    path.dirname(path.dirname(entry.path)) !==
      path.join(root, "epoch-successions") ||
    !/^[a-f0-9]{64}$/.test(path.basename(path.dirname(entry.path))) ||
    path.basename(entry.path) !== "authority.json" ||
    fs.realpathSync(entry.path) !== entry.path
  )
    fail("Succession authority escaped its owner journal");
  // Derive the owner journal from the authenticated record, not an earlier,
  // unverified read which can name a different request during replacement.
  const authority = authorityRecord(read(entry, entry.path));
  const audit = path.join(
    root,
    "epoch-successions",
    hash(authority.requestId || ""),
  );
  if (entry.path !== path.join(audit, "authority.json"))
    fail("Succession authority escaped its owner journal");
  const closedSuccessor =
    authority.kind === "owner-authenticated-closed-epoch-successor";
  if (
    authority.version !== 1 ||
    (!closedSuccessor &&
      authority.kind !== "owner-authenticated-dead-epoch-successor") ||
    !authority.clientId ||
    !/^[a-f0-9]{64}$/.test(authority.ownerTokenHash || "") ||
    !/^[a-f0-9]{40}$/.test(authority.sourceCommit || "") ||
    !/^[a-f0-9]{64}$/.test(authority.buildHash || "") ||
    authority.previousBrokerTerminated !== !closedSuccessor ||
    authority.previousProcessTerminated !== !closedSuccessor ||
    authority.permission !== "one-proven-new-document-only" ||
    authority.historicalOutcome !== "unknown"
  )
    fail("Invalid owner-bound dead-process authority");
  const snapshot = authority.predecessor;
  if (!snapshot || !/^[a-f0-9-]{36}$/.test(snapshot.epochId || ""))
    fail("Missing exact predecessor");
  const pointer = pointerRecord(
    read(snapshot.pointer, path.join(audit, "predecessor-pointer.json")),
  );
  const epochRoot = path.join(root, "admission-epochs", snapshot.epochId);
  const identity = record(
    read(snapshot.identity, path.join(epochRoot, "instance.json")),
  );
  if (
    pointer.root !== epochRoot ||
    pointer.epochId !== snapshot.epochId ||
    pointer.ownerClientId !== authority.clientId ||
    pointer.ownerTokenHash !== authority.ownerTokenHash ||
    pointer.document.fileId !== null ||
    authority.previousBuildHash !== identity["buildHash"]
  )
    fail("Succession authority differs from the original owner or epoch");
  const state = read(snapshot.state, path.join(epochRoot, "queue-state.json"));
  read(snapshot.rootState, path.join(root, "queue-state.json"));
  const rootIdentity = read(
    snapshot.rootIdentity,
    path.join(root, "instance.json"),
  );
  if (
    snapshot.rootState.sha256 !== pointer.historicalSnapshotHash ||
    snapshot.rootIdentity.sha256 !== pointer.historicalIdentityHash ||
    digest(snapshot.grants) !== digest(grantReferences(epochRoot)) ||
    digest(snapshot.qualification) !==
      digest([pointer.qualificationReceipt, ...pointer.qualificationEvidence])
  )
    fail("Predecessor history, grants or qualification changed");
  for (const proof of snapshot.qualification) read(proof, proof.path);
  let effectiveIdentity: EffectivePredecessorIdentity | undefined;
  if (authority.backendTransition) {
    effectiveIdentity = successorBackendIdentity(
      root,
      pointer,
      snapshot,
      authority.backendTransition,
      authority["previousOwner"],
      String(authority["configHash"]),
      read,
      ancestryDepth,
    );
  } else if (!closedSuccessor) {
    // Old history records authenticate identity bytes, but do not claim a new
    // runtime/configuration origin. Preserve that read contract; only a changed
    // declared configuration needs the stronger inherited-origin certificate.
    const config = authority["configHash"];
    if (config !== undefined || identity["configHash"] !== undefined) {
      if (typeof config !== "string" || config !== identity["configHash"])
        fail(
          "Changed predecessor backend requires immutable transition evidence",
        );
      if (config !== record(rootIdentity)["configHash"])
        successorEpochIdentity(root, pointer, snapshot, read, ancestryDepth);
    }
    const headFile = path.join(root, "physical-backend-head.json");
    const head = fs.existsSync(headFile)
      ? record(
          JSON.parse(
            readBytes(headFile, limit, fs, headFile).toString("utf8"),
          ) as unknown,
        )
      : null;
    if (head?.["epochId"] === pointer.epochId)
      fail(
        "Changed predecessor backend requires immutable transition evidence",
      );
  }
  if (closedSuccessor) {
    (
      load("./queue-closed-epoch-proof") as {
        closedEpochProof(
          root: string,
          pointer: EpochPointer,
          entry?: Reference,
        ): unknown;
      }
    ).closedEpochProof(root, pointer, authority.closedEpochProof);
    if (
      authority.expectedProcess?.pid !== pointer.currentInstance.pid ||
      authority.expectedProcess?.birth !== pointer.currentInstance.birth
    )
      fail(
        "A closed-epoch successor must retain the exact living Fusion process",
      );
  }
  const qualified = record(
    read(
      authority.qualification,
      path.join(audit, "installed-qualification.json"),
    ),
  );
  if (
    qualified["passed"] !== true ||
    qualified["productionAdmission"] !== true ||
    qualified["liveSdkRequestsSent"] !== 0 ||
    qualified["sourceCommit"] !== authority.sourceCommit ||
    qualified["buildHash"] !== authority.buildHash ||
    qualified["deadEpochSuccessorReadQualified"] !== true ||
    qualified["deadEpochSuccessorRestoreQualified"] !== true ||
    (closedSuccessor && qualified["closedEpochSuccessorQualified"] !== true)
  )
    fail(
      "Successor runtime has no pinned installed production-checker qualification",
    );
  return {
    authority: (
      load(
        "./dist/composition/queue-epoch-successor-retained",
      ) as typeof import("./composition/queue-epoch-successor-retained")
    ).retainedEvaluatorAuthority(root, authority, entry),
    audit,
    pointer,
    state,
    identity,
    ...(effectiveIdentity ? { effectiveIdentity } : {}),
  };
}
export function epochLineage(root: string, pointer: EpochPointer) {
  const read = traversalReader();
  const result: ReturnType<typeof successionAuthority>[] = [],
    seen = new Set([pointer.epochId]);
  let current = pointer;
  while (current.succession !== undefined) {
    if (result.length >= 32) fail("Epoch lineage bound exceeded");
    const previous = readSuccessionAuthority(root, current.succession, read);
    if (seen.has(previous.pointer.epochId))
      fail("Epoch lineage is cyclic or does not bind the new qualification");
    assertEpochLink(current, previous);
    seen.add(previous.pointer.epochId);
    result.push(previous);
    current = previous.pointer;
  }
  if (
    current.qualificationReceipt?.path !==
    path.join(root, "isolated-scratch-qualification", "result.json")
  )
    fail("Epoch lineage has no original qualified genesis");
  return result;
}
export function epochControlDirectory(
  root: string,
  pointer?: { succession?: Reference } | null,
): string {
  if (!pointer?.succession) return root;
  return successionAuthority(root, pointer.succession).audit;
}

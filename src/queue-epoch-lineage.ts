import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const { hash } = load("./queue-instance") as {
  hash(value: string | Uint8Array): string;
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
function readEpochOrigin(
  root: string,
  pointer: EpochPointer,
  snapshot: SuccessionAuthority["predecessor"],
  read: typeof verified,
  ancestryDepth: number,
): { identity: EffectivePredecessorIdentity; predecessor?: CheckedSuccession } {
  if (ancestryDepth >= 32) fail("Inherited backend lineage bound exceeded");
  const identity = checkedIdentity(
    read(snapshot.identity, path.join(pointer.root, "instance.json")),
  );
  if (
    identity.instance.pid !== pointer.currentInstance.pid ||
    identity.instance.birth !== pointer.currentInstance.birth ||
    identity.instance.version !== record(pointer.currentInstance)["version"]
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
    identity.buildHash !== predecessor.authority.buildHash ||
    !expected ||
    identity.instance.pid !== expected.pid ||
    identity.instance.birth !== expected.birth
  )
    fail(
      "Inherited backend differs from its qualified epoch/process authority",
    );
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
    }
    const effective = record(
      read(head["identity"], path.join(destination, "instance.json")),
    );
    const previousConfig = record(head["previousConfig"]),
      nextConfig = record(head["nextConfig"]);
    if (
      brokerConfigHash(previousConfig) !== head["previousConfigHash"] ||
      brokerConfigHash(nextConfig) !== head["nextConfigHash"] ||
      effective["configHash"] !== head["nextConfigHash"] ||
      !/^[a-f0-9]{64}$/.test(String(effective["buildHash"])) ||
      !sameProcess(effective["instance"]) ||
      !["addin", "mcp"].includes(String(previousConfig["backend"])) ||
      !["addin", "mcp"].includes(String(nextConfig["backend"])) ||
      previousConfig["backend"] === nextConfig["backend"] ||
      config(previousConfig) !== config(nextConfig)
    )
      fail("Physical backend configuration, build or SDK identity changed");
    const escrow = refs.find(
      (ref) => ref.path === path.join(destination, "predecessor-head.json"),
    );
    if (escrow) {
      const priorHead = record(read(escrow, escrow.path));
      const prior = visit(
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
          sameProcess(receipt["instance"]) &&
          sameProcess(receipt["auditExpectedInstance"])
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
  read(snapshot.rootIdentity, path.join(root, "instance.json"));
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
    successorEpochIdentity(root, pointer, snapshot, read, ancestryDepth);
    const headFile = path.join(root, "physical-backend-head.json");
    const head = fs.existsSync(headFile)
      ? record(
          JSON.parse(
            readBytes(headFile, limit, fs, headFile).toString("utf8"),
          ) as unknown,
        )
      : null;
    if (
      authority["configHash"] !== identity["configHash"] ||
      head?.["epochId"] === pointer.epochId
    )
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
    authority,
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

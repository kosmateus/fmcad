import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { durable } from "../persistence/records";

type Data = Record<string, unknown>;
export interface RestartReference {
  path: string;
  sha256: string;
}
interface Identity {
  configHash: string;
  buildHash: string;
  instance: object;
  normalRestart?: RestartReference;
}
interface Epoch {
  root: string;
  currentInstance: object;
  ownerClientId?: string;
  epochId?: string;
  ownerTokenHash?: string;
}
interface State {
  jobs: Record<string, unknown>;
  active?: unknown | undefined;
  blocked?: unknown | undefined;
  lease?: unknown | undefined;
  localUnknown?: unknown | undefined;
  controlBlocked?: unknown | undefined;
  paused?: boolean | undefined;
  controlGeneration?: number | undefined;
  controlRequests?: Record<string, unknown> | undefined;
}
export interface RestartPorts {
  priorProcessAlive(value: object): boolean | null;
}
export interface SettledNormalRestart {
  sameLiveInstance?: true;
  runtimeUpgradeRecord?: Data;
  root: string;
  epoch: Epoch;
  previous: Identity;
  previousOwner: Data;
  ownerReference?: RestartReference;
  stopRequestId?: string;
  stopAdminReference?: RestartReference;
  stopReleaseReference?: RestartReference;
  sourceIdentityReference?: RestartReference;
  workerEvidence: RestartReference[];
  lifecycleReference: RestartReference;
  sourceStartup:
    | { kind: "owner-startup-probe"; receiptReference: RestartReference }
    | {
        kind: "pinned-head-reopen";
        headReference: RestartReference;
        receiptReference: RestartReference;
        lifecycleReference: RestartReference;
      };
  pointerReference: RestartReference;
  closedReference: RestartReference;
  jobs: Record<string, unknown>;
  evidence: RestartReference[];
  deadPredecessorRecord?: Data;
}
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "NORMAL_RESTART_UNPROVEN",
  });
}
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Object-shaped normal restart evidence required");
  return value as Data;
}
function read(file: string): Data {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
      fail("Unsafe normal restart evidence file");
    return object(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    fail(
      `Normal restart evidence is unavailable or invalid: ${path.basename(file)}`,
    );
  }
}
function reference(file: string): RestartReference {
  read(file);
  return { path: file, sha256: hash(fs.readFileSync(file)) };
}
function checked(value: unknown, expected: string): Data {
  const ref = object(value);
  if (ref["path"] !== expected || ref["sha256"] !== reference(expected).sha256)
    fail("Normal restart reference changed");
  return read(expected);
}
function sameProcess(left: object, right: object): boolean {
  const a = object(left),
    b = object(right);
  return (
    Number.isSafeInteger(a["pid"]) &&
    (a["pid"] as number) > 0 &&
    typeof a["birth"] === "string" &&
    !!a["birth"] &&
    typeof a["version"] === "string" &&
    !!a["version"] &&
    a["pid"] === b["pid"] &&
    a["birth"] === b["birth"] &&
    a["version"] === b["version"]
  );
}
function settled(state: State): void {
  if (
    state.active ||
    state.blocked ||
    state.lease ||
    state.localUnknown ||
    state.controlBlocked ||
    Object.values(state.jobs).some(
      (job) =>
        !["succeeded", "failed", "cancelled", "expired"].includes(
          String(object(job)["state"]),
        ),
    )
  )
    fail(
      "Normal restart requires known settled work; pending or UNKNOWN work cannot be replayed",
    );
}
function workersGone(
  root: string,
  jobs: Record<string, unknown>,
  ports: RestartPorts,
): RestartReference[] {
  const evidence: RestartReference[] = [];
  for (const id of Object.keys(jobs)) {
    const file = path.join(root, "jobs", id, "worker-identity.json");
    if (fs.existsSync(file)) {
      if (ports.priorProcessAlive(read(file)) !== false)
        fail("A prior normal worker is alive or its death is unproven");
      evidence.push(reference(file));
    }
  }
  return evidence;
}
/** Resolves only a released normal epoch's authenticated process continuation.
 * The original pointer, qualification, closed scratch and old jobs never change. */
export function normalRestartInstance(
  root: string,
  epoch: Epoch,
  identity: Identity,
  state: State,
): object {
  return authenticateNormalRestart(root, epoch, identity, state, {
    read,
    checked,
  }).instance;
}
/** Shared live/historical verifier. Historical readers must authenticate every
 * reference and may only remap the pinned pointer to its exact archived bytes. */
export function authenticateNormalRestart(
  root: string,
  epoch: Epoch,
  identity: Identity,
  state: State,
  reader: {
    read(file: string): Data;
    checked(reference: unknown, file: string): Data;
  },
): { instance: object; origin: Identity } {
  const { read, checked } = reader;
  const pointer = read(path.join(root, "isolated-admission-epoch.json"));
  if (
    pointer["root"] !== epoch.root ||
    !same(pointer["currentInstance"], epoch.currentInstance) ||
    read(path.join(epoch.root, "closed.json"))["admissionMode"] !==
      "normal-multidocument"
  )
    fail("Only this exact released normal epoch can restart");
  const result = identity.instance;
  let current = identity;
  const visited = new Set<string>();
  while (current.normalRestart) {
    const ref = current.normalRestart;
    const directory = path.dirname(ref.path);
    if (
      path.dirname(directory) !== path.join(root, "normal-restarts") ||
      !/^[a-f0-9-]{36}$/.test(path.basename(directory)) ||
      fs.realpathSync(directory) !== directory ||
      visited.has(ref.path) ||
      visited.size >= 32
    )
      fail("Invalid or cyclic normal restart lineage");
    visited.add(ref.path);
    const proof = checked(ref, path.join(directory, "authority.json"));
    if (
      proof["kind"] !== "settled-normal-restart-v1" ||
      proof["configHash"] !== current.configHash ||
      !sameProcess(object(proof["current"]), current.instance)
    )
      fail("Normal restart identity differs from its proof");
    checked(
      proof["pointerReference"],
      path.join(root, "isolated-admission-epoch.json"),
    );
    checked(proof["closedReference"], path.join(epoch.root, "closed.json"));
    const previous = checked(
      proof["previousIdentity"],
      path.join(directory, "previous-identity.json"),
    ) as unknown as Identity;
    if (previous.configHash !== current.configHash)
      fail("Normal restart configuration continuity changed");
    const ownerReference = object(proof["ownerReference"]);
    const ownerFile = ownerReference["path"];
    if (
      typeof ownerFile !== "string" ||
      path.dirname(ownerFile) !== root ||
      !/^reclaimed-[a-f0-9-]{36}\.json$/.test(path.basename(ownerFile))
    )
      fail("Invalid predecessor owner reference");
    const predecessorOwner = checked(ownerReference, ownerFile);
    const predecessorLife = checked(
      proof["lifecycleReference"],
      path.join(
        root,
        `broker-lifecycle-${String(predecessorOwner["nonce"])}.json`,
      ),
    );
    if (
      !same(predecessorLife["owner"], predecessorOwner) ||
      predecessorLife["stage"] !== "ready" ||
      predecessorLife["buildHash"] !== previous.buildHash ||
      predecessorLife["configHash"] !== previous.configHash
    )
      fail("Normal restart predecessor source or owner changed");
    const snapshot = checked(
      proof["previousState"],
      path.join(directory, "previous-state.json"),
    );
    const jobs = object(snapshot["jobs"]);
    settled({ jobs });
    if (!Object.entries(jobs).every(([id, job]) => same(state.jobs[id], job)))
      fail("Historical normal jobs changed");
    const binding = object(proof["binding"]);
    const nonce = binding["brokerNonce"];
    if (
      typeof nonce !== "string" ||
      !/^[a-f0-9-]{36}$/.test(nonce) ||
      nonce !== path.basename(directory)
    )
      fail("Normal restart owner binding differs");
    if (
      binding["buildHash"] !== current.buildHash ||
      binding["stage"] !== "startup" ||
      !Number.isSafeInteger(binding["ownerPid"]) ||
      (binding["ownerPid"] as number) <= 0 ||
      typeof binding["ownerBirth"] !== "string" ||
      !binding["ownerBirth"]
    )
      fail("Normal restart build or process binding differs");
    const receipt = checked(
      proof["startupReceipt"],
      path.join(root, `broker-startup-${nonce}.receipt.json`),
    );
    if (
      receipt["terminal"] !== true ||
      receipt["outcome"] !== "succeeded" ||
      !Object.entries(binding).every(([key, value]) =>
        same(receipt[key], value),
      ) ||
      !sameProcess(object(receipt["instance"]), object(proof["current"]))
    )
      fail("Normal restart native receipt differs");
    const observation = object(receipt["probeObservation"]);
    if (
      observation["schema"] !== "fmcad-instance-probe-v1" ||
      !same(observation["identity"], proof["current"])
    )
      fail("Normal restart observation differs");
    current = previous;
  }
  if (!sameProcess(current.instance, epoch.currentInstance))
    fail("Normal restart is not anchored to this epoch");
  return { instance: result, origin: current };
}

/** SDK0 admission before the single startup observation, called by ordinary
 * autostart. A dead broker alone never authorizes switching a live SDK. */
export function inspectSettledNormalRestart(
  root: string,
  epoch: Epoch,
  previous: Identity,
  state: State,
  ports: RestartPorts,
  stopRequestId?: string,
  sourceIdentityFile?: string,
): SettledNormalRestart | undefined {
  return inspectSettledOwner(
    root,
    epoch,
    previous,
    state,
    ports,
    stopRequestId,
    sourceIdentityFile,
    false,
  );
}

/** The caller must bind this source to the verified active backend head. This
 * proof releases only the stopped broker, never the still-live SDK identity. */
export function inspectSettledRuntimeUpgrade(
  root: string,
  epoch: Epoch,
  previous: Identity,
  state: State,
  ports: RestartPorts,
  stopRequestId: string,
  sourceIdentityFile: string,
  pinnedHead?: RestartReference,
): SettledNormalRestart | undefined {
  return inspectSettledOwner(
    root,
    epoch,
    previous,
    state,
    ports,
    stopRequestId,
    sourceIdentityFile,
    true,
    pinnedHead,
  );
}

/** A matching-head SDK0 reopen inherits the head's physical observation, not a
 * fictitious owner probe. Legacy ready lifecycles have no explicit SDK0 field:
 * their exact five-field binding and distinct head-publisher owner identify this
 * source variant. This is selected by lineage, never by a missing receipt. */
function pinnedReopenStartup(
  root: string,
  epoch: Epoch,
  previous: Identity,
  lifecycle: Data,
  headReference: RestartReference,
): SettledNormalRestart["sourceStartup"] | undefined {
  const head = checked(headReference, headReference.path);
  const requestId = head["requestId"];
  if (
    typeof requestId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId) ||
    headReference.path !==
      path.join(
        root,
        "physical-backend-transitions",
        requestId,
        "transition.json",
      ) ||
    !same(read(path.join(root, "physical-backend-head.json")), head) ||
    head["version"] !== 1 ||
    head["kind"] !== "owner-bound-physical-backend-transition" ||
    !epoch.epochId ||
    !epoch.ownerTokenHash ||
    head["epochId"] !== epoch.epochId ||
    head["ownerClientId"] !== epoch.ownerClientId ||
    head["ownerTokenHash"] !== epoch.ownerTokenHash ||
    head["nextConfigHash"] !== previous.configHash ||
    !same(
      checked(
        head["identity"],
        path.join(path.dirname(headReference.path), "instance.json"),
      ),
      previous,
    ) ||
    !Array.isArray(head["observation"]) ||
    !Array.isArray(head["predecessor"])
  )
    fail("Pinned reopen differs from its verified current head");
  const observations = head["observation"] as unknown[];
  for (const value of [
    ...observations,
    ...(head["predecessor"] as unknown[]),
  ]) {
    const ref = object(value);
    if (typeof ref["path"] !== "string") fail("Invalid pinned head evidence");
    checked(ref, ref["path"]);
  }
  const receipts = observations.filter((value) => {
    const file = object(value)["path"];
    return (
      typeof file === "string" &&
      path.dirname(file) === root &&
      /^broker-startup-[a-f0-9-]{36}\.receipt\.json$/.test(path.basename(file))
    );
  });
  if (receipts.length !== 1)
    fail("Pinned head requires its original physical startup receipt");
  const receiptReference = object(receipts[0]) as unknown as RestartReference;
  const receipt = checked(receiptReference, receiptReference.path);
  const nonce = receipt["brokerNonce"];
  if (typeof nonce !== "string" || !/^[a-f0-9-]{36}$/.test(nonce))
    fail("Pinned head startup owner is invalid");
  const sourceFile = path.join(root, `broker-lifecycle-${nonce}.json`);
  const source = read(sourceFile);
  const owner = object(source["owner"]);
  const binding = object(source["binding"]);
  const observation = object(receipt["probeObservation"]);
  if (
    source["stage"] !== "ready" ||
    source["buildHash"] !== previous.buildHash ||
    source["configHash"] !== previous.configHash ||
    source["receipt"] !== receiptReference.path ||
    owner["nonce"] !== nonce ||
    binding["brokerNonce"] !== nonce ||
    binding["ownerPid"] !== owner["pid"] ||
    binding["ownerBirth"] !== owner["birth"] ||
    binding["stage"] !== "startup" ||
    binding["buildHash"] !== previous.buildHash ||
    receipt["terminal"] !== true ||
    receipt["outcome"] !== "succeeded" ||
    !Object.entries(binding).every(([key, value]) =>
      same(receipt[key], value),
    ) ||
    !sameProcess(object(receipt["instance"]), previous.instance) ||
    object(receipt["instance"])["activeCommand"] !==
      object(previous.instance)["activeCommand"] ||
    observation["schema"] !== "fmcad-instance-probe-v1" ||
    !same(observation["identity"], previous.instance)
  )
    fail("Pinned head original physical startup proof differs");
  if (object(lifecycle["owner"])["nonce"] === nonce) return undefined;
  const reopened = object(lifecycle["binding"]);
  if (
    !same(
      Object.keys(reopened).sort(),
      ["brokerNonce", "ownerPid", "ownerBirth", "buildHash", "stage"].sort(),
    )
  )
    fail("Pinned reopen is not a metadata-only startup binding");
  return {
    kind: "pinned-head-reopen",
    headReference,
    receiptReference,
    lifecycleReference: reference(sourceFile),
  };
}

function inspectSettledOwner(
  root: string,
  epoch: Epoch,
  previous: Identity,
  state: State,
  ports: RestartPorts,
  stopRequestId: string | undefined,
  sourceIdentityFile: string | undefined,
  sameLiveInstance: boolean,
  pinnedHead?: RestartReference,
): SettledNormalRestart | undefined {
  if (!sameLiveInstance) normalRestartInstance(root, epoch, previous, state);
  else {
    const pointer = read(path.join(root, "isolated-admission-epoch.json"));
    if (
      !stopRequestId ||
      !sourceIdentityFile ||
      pointer["root"] !== epoch.root ||
      !same(pointer["currentInstance"], epoch.currentInstance) ||
      read(path.join(epoch.root, "closed.json"))["admissionMode"] !==
        "normal-multidocument"
    )
      fail(
        "Runtime upgrade requires the exact released normal epoch and owner stop",
      );
  }
  const alive = ports.priorProcessAlive(previous.instance);
  if (!sameLiveInstance && alive === true) return undefined;
  if (alive !== sameLiveInstance) fail("Previous Fusion lifecycle is unproven");
  try {
    settled(state);
  } catch {
    return undefined;
  } // Preserve existing metadata-only pending/UNKNOWN recovery.
  const workerEvidence = workersGone(root, state.jobs, ports);
  const sourceIdentityReference = sourceIdentityFile
    ? reference(sourceIdentityFile)
    : undefined;
  if (
    stopRequestId !== undefined &&
    (!sourceIdentityReference ||
      !same(read(sourceIdentityReference.path), previous))
  )
    fail("Exact source identity is required for a dead-SDK owner-stop proof");
  const stopEvidence: RestartReference[] = [];
  let owner: Data;
  let ownerReference: RestartReference | undefined;
  let stopAdminReference: RestartReference | undefined;
  let stopReleaseReference: RestartReference | undefined;
  let lifecycleFile: string;
  if (stopRequestId !== undefined) {
    if (
      typeof stopRequestId !== "string" ||
      stopRequestId.length === 0 ||
      stopRequestId.length > 256
    )
      fail("Exact completed owner stop request required");
    const digest = createHash("sha256").update(stopRequestId).digest("hex");
    const adminFile = path.join(root, `console-admin-${digest}.json`);
    const releaseFile = path.join(root, `console-release-${digest}.json`);
    const admin = read(adminFile);
    const release = read(releaseFile);
    const ownerNonce = admin["instanceId"];
    if (
      admin["action"] !== "console-stop" ||
      admin["clientId"] !== epoch.ownerClientId ||
      admin["requestId"] !== stopRequestId ||
      admin["status"] !== "accepted" ||
      typeof ownerNonce !== "string" ||
      !/^[a-f0-9-]{36}$/.test(ownerNonce) ||
      object(admin["result"])["releaseFile"] !== releaseFile ||
      release["terminal"] !== true ||
      release["outcome"] !== "released" ||
      release["requestId"] !== stopRequestId ||
      release["instanceId"] !== ownerNonce ||
      release["buildHash"] !== previous.buildHash
    )
      fail("Owner stop/release evidence differs from the predecessor");
    const pause = object(state.controlRequests?.[stopRequestId]);
    if (
      state.paused !== true ||
      pause["paused"] !== true ||
      pause["generation"] !== state.controlGeneration ||
      (admin["expectedGeneration"] !== state.controlGeneration &&
        (admin["expectedGeneration"] as number) + 1 !== state.controlGeneration)
    )
      fail("Owner stop pause changed before the dead-SDK transition");
    lifecycleFile = path.join(root, `broker-lifecycle-${ownerNonce}.json`);
    const lifecycle = read(lifecycleFile);
    owner = object(lifecycle["owner"]);
    if (
      owner["nonce"] !== ownerNonce ||
      admin["buildHash"] !== previous.buildHash ||
      ports.priorProcessAlive(owner) !== false
    )
      fail("Exact stopped broker owner is alive or unproven");
    stopEvidence.push(reference(adminFile), reference(releaseFile));
    stopAdminReference = reference(adminFile);
    stopReleaseReference = reference(releaseFile);
  } else {
    const head = read(path.join(root, "broker-reclaimed-head.json"));
    const ownerRef = object(head["ownerReference"]);
    const file = ownerRef["path"];
    if (
      typeof file !== "string" ||
      path.dirname(file) !== root ||
      !/^reclaimed-[a-f0-9-]{36}\.json$/.test(path.basename(file))
    )
      fail("Exact reclaimed normal owner evidence required");
    owner = checked(ownerRef, file);
    ownerReference = reference(file);
    if (
      ports.priorProcessAlive(owner) !== false ||
      typeof owner["nonce"] !== "string"
    )
      fail("Previous normal owner is alive or unproven");
    lifecycleFile = path.join(
      root,
      `broker-lifecycle-${String(owner["nonce"])}.json`,
    );
  }
  const lifecycle = read(lifecycleFile);
  if (
    !same(lifecycle["owner"], owner) ||
    lifecycle["stage"] !== "ready" ||
    lifecycle["buildHash"] !== previous.buildHash ||
    lifecycle["configHash"] !== previous.configHash
  )
    fail("Previous normal owner, source or configuration differs");
  const binding = object(lifecycle["binding"]);
  const receiptFile = path.join(
    root,
    `broker-startup-${String(owner["nonce"])}.receipt.json`,
  );
  if (
    lifecycle["receipt"] !== receiptFile ||
    binding["brokerNonce"] !== owner["nonce"] ||
    binding["ownerPid"] !== owner["pid"] ||
    binding["ownerBirth"] !== owner["birth"] ||
    binding["buildHash"] !== previous.buildHash ||
    binding["stage"] !== "startup"
  )
    fail("Previous normal startup binding is unproven");
  const sourceStartup =
    sameLiveInstance && pinnedHead
      ? pinnedReopenStartup(root, epoch, previous, lifecycle, pinnedHead)
      : undefined;
  // If this owner did produce a receipt, it remains mandatory evidence too.
  // Corruption is never hidden by the inherited physical observation.
  if (!sourceStartup || fs.existsSync(receiptFile)) {
    const receipt = read(receiptFile);
    if (
      receipt["terminal"] !== true ||
      receipt["outcome"] !== "succeeded" ||
      !Object.entries(binding).every(([key, value]) =>
        same(receipt[key], value),
      ) ||
      !sameProcess(object(receipt["instance"]), previous.instance)
    )
      fail("Previous normal startup receipt is unproven");
  }
  const lifecycleReference = reference(lifecycleFile);
  const startupProof: SettledNormalRestart["sourceStartup"] = sourceStartup || {
    kind: "owner-startup-probe",
    receiptReference: reference(receiptFile),
  };
  const pointerReference = reference(
    path.join(root, "isolated-admission-epoch.json"),
  );
  const closedReference = reference(path.join(epoch.root, "closed.json"));
  const evidence = [
    ...(ownerReference ? [ownerReference] : []),
    ...(sourceIdentityReference ? [sourceIdentityReference] : []),
    lifecycleReference,
    startupProof.receiptReference,
    ...(startupProof.kind === "pinned-head-reopen"
      ? [
          startupProof.headReference,
          startupProof.lifecycleReference,
          ...(fs.existsSync(receiptFile) ? [reference(receiptFile)] : []),
        ]
      : []),
    pointerReference,
    closedReference,
    ...workerEvidence,
    ...stopEvidence,
  ];
  const deadPredecessorRecord: Data | undefined =
    stopRequestId === undefined
      ? undefined
      : {
          kind: sameLiveInstance
            ? "settled-normal-runtime-upgrade-v1"
            : "settled-normal-dead-predecessor-v1",
          previous,
          previousOwner: owner,
          sourceStartup: startupProof,
          sourceIdentityReference,
          stopRequestId,
          epoch: {
            root: epoch.root,
            epochId: read(path.join(root, "isolated-admission-epoch.json"))[
              "epochId"
            ],
            currentInstance: epoch.currentInstance,
            ownerClientId: epoch.ownerClientId,
          },
          evidence,
          jobs: structuredClone(state.jobs),
          workerEvidence,
          queue: {
            active: state.active ?? null,
            blocked: state.blocked ?? null,
            lease: state.lease ?? null,
            localUnknown: state.localUnknown ?? null,
            controlBlocked: state.controlBlocked ?? null,
            paused: state.paused,
            controlGeneration: state.controlGeneration,
            controlRequest: state.controlRequests?.[stopRequestId] ?? null,
          },
        };
  return {
    ...(sameLiveInstance
      ? {
          sameLiveInstance: true as const,
          runtimeUpgradeRecord: deadPredecessorRecord!,
        }
      : {}),
    root,
    epoch,
    previous,
    previousOwner: owner,
    ...(ownerReference ? { ownerReference } : {}),
    ...(stopRequestId !== undefined
      ? {
          stopRequestId,
          stopAdminReference: stopAdminReference!,
          stopReleaseReference: stopReleaseReference!,
          sourceIdentityReference: sourceIdentityReference!,
          ...(!sameLiveInstance
            ? { deadPredecessorRecord: deadPredecessorRecord! }
            : {}),
        }
      : {}),
    workerEvidence,
    lifecycleReference,
    sourceStartup: startupProof,
    pointerReference,
    closedReference,
    jobs: structuredClone(state.jobs),
    evidence,
  };
}

/** Revalidates the exact dead predecessor at each transition fence. This is a
 * proof-specific exception, not general permission to ignore epoch liveness. */
export function assertSettledNormalRestartPredecessor(
  proof: SettledNormalRestart,
  state: State,
  ports: RestartPorts,
): void {
  const { root, epoch } = proof;
  settled(state);
  if (
    !same(proof.jobs, state.jobs) ||
    ports.priorProcessAlive(proof.previous.instance) !==
      (proof.sameLiveInstance === true) ||
    ports.priorProcessAlive(proof.previousOwner) !== false
  )
    fail("Normal restart predecessor changed or is not dead");
  const pointer = checked(
    proof.pointerReference,
    path.join(root, "isolated-admission-epoch.json"),
  );
  if (
    pointer["root"] !== epoch.root ||
    !same(pointer["currentInstance"], epoch.currentInstance)
  )
    fail("Normal restart epoch pointer changed");
  checked(proof.closedReference, path.join(epoch.root, "closed.json"));
  const lifecycle = checked(
    proof.lifecycleReference,
    proof.lifecycleReference.path,
  );
  if (
    !same(lifecycle["owner"], proof.previousOwner) ||
    lifecycle["stage"] !== "ready" ||
    lifecycle["buildHash"] !== proof.previous.buildHash ||
    lifecycle["configHash"] !== proof.previous.configHash
  )
    fail("Normal restart predecessor owner or source changed");
  if (proof.sourceIdentityReference) {
    if (
      !same(
        checked(
          proof.sourceIdentityReference,
          proof.sourceIdentityReference.path,
        ),
        proof.previous,
      )
    )
      fail("Normal restart source identity changed");
  }
  if (proof.ownerReference) {
    const ownerFile = proof.ownerReference.path;
    if (
      path.dirname(ownerFile) !== root ||
      !/^reclaimed-[a-f0-9-]{36}\.json$/.test(path.basename(ownerFile))
    )
      fail("Invalid reclaimed predecessor owner reference");
    if (!same(checked(proof.ownerReference, ownerFile), proof.previousOwner))
      fail("Reclaimed predecessor owner changed");
  }
  const startupReceiptFile = path.join(
    root,
    `broker-startup-${String(proof.previousOwner["nonce"])}.receipt.json`,
  );
  if (proof.sourceStartup.kind === "pinned-head-reopen") {
    if (
      !proof.sameLiveInstance ||
      !same(
        pinnedReopenStartup(
          root,
          epoch,
          proof.previous,
          lifecycle,
          proof.sourceStartup.headReference,
        ),
        proof.sourceStartup,
      )
    )
      fail("Pinned reopen source authority changed");
  } else {
    const startupReceipt = checked(
      proof.sourceStartup.receiptReference,
      startupReceiptFile,
    );
    const binding = object(lifecycle["binding"]);
    if (
      lifecycle["receipt"] !== startupReceiptFile ||
      startupReceipt["terminal"] !== true ||
      startupReceipt["outcome"] !== "succeeded" ||
      !Object.entries(binding).every(([key, value]) =>
        same(startupReceipt[key], value),
      ) ||
      !sameProcess(object(startupReceipt["instance"]), proof.previous.instance)
    )
      fail("Previous normal startup receipt changed");
  }
  const currentWorkers = workersGone(root, proof.jobs, ports);
  if (!same(currentWorkers, proof.workerEvidence))
    fail("Previous normal worker evidence changed");
  for (const ref of proof.evidence) checked(ref, ref.path);
  if (proof.stopRequestId !== undefined) {
    const digest = createHash("sha256")
      .update(proof.stopRequestId)
      .digest("hex");
    const adminFile = path.join(root, `console-admin-${digest}.json`);
    const releaseFile = path.join(root, `console-release-${digest}.json`);
    if (
      !proof.stopAdminReference ||
      !proof.stopReleaseReference ||
      proof.stopAdminReference.path !== adminFile ||
      proof.stopReleaseReference.path !== releaseFile
    )
      fail("Exact owner stop evidence is unavailable");
    const admin = checked(proof.stopAdminReference, adminFile);
    const release = checked(proof.stopReleaseReference, releaseFile);
    const pause = object(state.controlRequests?.[proof.stopRequestId]);
    if (
      admin["action"] !== "console-stop" ||
      admin["clientId"] !== epoch.ownerClientId ||
      admin["requestId"] !== proof.stopRequestId ||
      admin["instanceId"] !== proof.previousOwner["nonce"] ||
      admin["buildHash"] !== proof.previous.buildHash ||
      admin["status"] !== "accepted" ||
      object(admin["result"])["releaseFile"] !== releaseFile ||
      release["terminal"] !== true ||
      release["outcome"] !== "released" ||
      release["requestId"] !== proof.stopRequestId ||
      release["instanceId"] !== proof.previousOwner["nonce"] ||
      release["buildHash"] !== proof.previous.buildHash ||
      state.paused !== true ||
      pause["paused"] !== true ||
      pause["generation"] !== state.controlGeneration ||
      (admin["expectedGeneration"] !== state.controlGeneration &&
        (admin["expectedGeneration"] as number) + 1 !== state.controlGeneration)
    )
      fail("Exact completed owner stop or durable pause changed");
  }
}

export function commitSettledNormalRestart(
  proof: SettledNormalRestart,
  state: State,
  current: object,
  binding: Data,
  receiptFile: string,
  ports: RestartPorts,
): RestartReference {
  if (proof.sameLiveInstance)
    fail("Runtime upgrade cannot authorize a replacement SDK");
  const { root } = proof;
  assertSettledNormalRestartPredecessor(proof, state, ports);
  if (
    ports.priorProcessAlive(current) !== true ||
    sameProcess(proof.previous.instance, current)
  )
    fail("Normal restart admission changed during observation");
  const observed = object(current),
    documents = observed["documents"];
  if (
    !sameProcess(current, current) ||
    !["", "SelectCommand"].includes(String(observed["activeCommand"])) ||
    !Array.isArray(documents) ||
    documents.some((value) => {
      const doc = object(value);
      return (
        typeof doc["id"] !== "string" ||
        !doc["id"] ||
        doc["isModified"] !== false ||
        typeof doc["isSaved"] !== "boolean" ||
        !(doc["fileId"] === null || typeof doc["fileId"] === "string")
      );
    }) ||
    new Set(documents.map((value) => object(value)["id"])).size !==
      documents.length
  )
    fail(
      "Normal restart requires a complete idle observation and unmodified user documents",
    );
  if (!proof.ownerReference)
    fail("Reclaimed owner evidence is required for a normal restart receipt");
  const nonce = binding["brokerNonce"];
  if (
    typeof nonce !== "string" ||
    !/^[a-f0-9-]{36}$/.test(nonce) ||
    binding["stage"] !== "startup" ||
    receiptFile !== path.join(root, `broker-startup-${nonce}.receipt.json`)
  )
    fail("Fresh normal restart binding required");
  const receipt = read(receiptFile);
  const observation = object(receipt["probeObservation"]);
  if (
    receipt["terminal"] !== true ||
    receipt["outcome"] !== "succeeded" ||
    !Object.entries(binding).every(([key, value]) =>
      same(receipt[key], value),
    ) ||
    !sameProcess(object(receipt["instance"]), current) ||
    observation["schema"] !== "fmcad-instance-probe-v1" ||
    Object.keys(observation).length !== 2 ||
    !same(observation["identity"], current)
  )
    fail("Fresh normal restart observation is unproven");
  const directory = path.join(root, "normal-restarts", nonce);
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  if (fs.realpathSync(path.dirname(directory)) !== path.dirname(directory))
    fail("Normal restart evidence directory is not canonical");
  fs.mkdirSync(directory, { mode: 0o700 });
  durable(path.join(directory, "previous-identity.json"), proof.previous, true);
  durable(
    path.join(directory, "previous-state.json"),
    { jobs: proof.jobs },
    true,
  );
  durable(
    path.join(directory, "authority.json"),
    {
      kind: "settled-normal-restart-v1",
      configHash: proof.previous.configHash,
      current,
      binding,
      pointerReference: proof.pointerReference,
      closedReference: proof.closedReference,
      ownerReference: proof.ownerReference,
      lifecycleReference: proof.lifecycleReference,
      previousIdentity: reference(
        path.join(directory, "previous-identity.json"),
      ),
      previousState: reference(path.join(directory, "previous-state.json")),
      startupReceipt: reference(receiptFile),
    },
    true,
  );
  return reference(path.join(directory, "authority.json"));
}

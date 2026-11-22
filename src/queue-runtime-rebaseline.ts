import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { createRequire } from "node:module";
const { durableBytes, readBytes, syncDirectory } = createRequire(__filename)(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");

type Data = Record<string, unknown>;
export interface RebaselineReference {
  path: string;
  sha256: string;
}
export interface RuntimeRebaselineRequest {
  handoffId: string;
  expectedHead: string;
  requestId: string;
}
export interface RuntimePins {
  handoffId: string;
  admissionStore: string;
  generation: { epoch: string; instance: string };
  process: { pid: number; birth: string };
  source: string;
  build: string;
  endpoint: string;
}
export interface RuntimeBarrierBinding extends RuntimePins {
  retiredProcess: { pid: number; birth: string };
  retirement: "process_dead";
  ingress: "pinned_all_sdk_ingress";
  grantCount: 0;
  admissionCount: 0;
  writerGeneration: string;
}
export interface RuntimeActivationPublication {
  store: string;
  storeDevice: number;
  storeInode: number;
  expectedHead: string;
  expectedFiles: Record<string, string | null>;
  activationFile: string;
  activationBytes: string;
  record: RebaselineReference;
}
export interface RuntimeActivationCompletion {
  binding: {
    requestId: string;
    newHead: string;
    publicationDigest: string;
    initiatorOperatorId: string;
  };
  evidence: RebaselineReference[];
}
/** Implemented by the local lifecycle authority, never decoded from client JSON.
 * verifyCurrentBarrier must verify original OS death/process/listener evidence,
 * host-store committed handoff, current head and pinned SDK ingress bytes under
 * the held no-provision barrier. Archived HTTP 401 samples are not this proof.
 * Evidence includes a byte-bound attestation equal to binding plus its original
 * source references. No host CAS, provisioning or SDK port exists here. */
export interface RuntimeBarrierLease {
  /** Frozen by the native begin record, not the current resumer's identity. */
  readonly initiatorOperatorId: string;
  assertWriterAndProvisionLock(): void;
  verifyCurrentBarrier(): Promise<{
    binding: RuntimeBarrierBinding;
    evidence: RebaselineReference[];
  }>;
  /** Final recheck + durable local CAS must execute at the authority holding
   * both barriers, not a callback in a different process after a heartbeat ACK.
   * Loss of either lock holder must make publication impossible. */
  publishActivation(publication: RuntimeActivationPublication): Promise<void>;
  /** Verify exact native consumed receipt after publication/re-fsync. Idempotent
   * query/resume uses native durable identity, never the initiator's lost token. */
  consumeActivation(
    publication: RuntimeActivationPublication,
  ): Promise<RuntimeActivationCompletion>;
}
export interface RuntimeRebaselineAuthorityPorts {
  store: string;
  operatorId: string;
  pins: RuntimePins;
  withExclusiveBarrier<T>(
    request: RuntimeRebaselineRequest,
    work: (lease: RuntimeBarrierLease) => Promise<T>,
  ): Promise<T>;
}
const authorities = new WeakMap<object, RuntimeRebaselineAuthorityPorts>();
declare const authorityBrand: unique symbol;
export interface RuntimeRebaselineAuthority {
  readonly [authorityBrand]: true;
}
/** Only trusted local composition receives these ports. A modeling client,
 * request payload, boolean or deserialized lookalike cannot be an authority. */
export function createRuntimeRebaselineAuthority(
  ports: RuntimeRebaselineAuthorityPorts,
): RuntimeRebaselineAuthority {
  if (
    !ports.operatorId ||
    fs.realpathSync(ports.store) !== path.resolve(ports.store)
  )
    fail("NOT_AUTHORIZED", "A local operator and canonical store are required");
  const capability = Object.freeze({}) as RuntimeRebaselineAuthority;
  authorities.set(capability, { ...ports, pins: structuredClone(ports.pins) });
  return capability;
}
export interface RuntimeRebaselineReceipt {
  rebaselineId: string;
  oldHead: string;
  newHead: string;
  handoffId: string;
  carriedExposures: number;
  history: "preserved_unproven";
  grantIssued: false;
  sdkSubmitted: false;
}
interface Disposition {
  outcome: "unknown" | "not_started";
  executionFence: { kind: "runtime_retired"; handoffId: string };
  replay: false;
}
interface RebaselineRecord {
  version: 1;
  kind: "runtime-rebaseline-root";
  store: string;
  storeDevice: number;
  storeInode: number;
  request: RuntimeRebaselineRequest;
  operatorId: string;
  history: "preserved_unproven";
  frozen: Record<string, RebaselineReference | null>;
  evidence: RebaselineReference[];
  binding: RuntimeBarrierBinding;
  dispositions: Record<string, Disposition>;
  carriedExposures: Data;
  receipt: RuntimeRebaselineReceipt;
}
const inputs = [
  "physical-backend-head.json",
  "isolated-admission-epoch.json",
  "instance.json",
  "queue-state.json",
  "runtime-rebaseline-head.json",
] as const;
const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("RUNTIME_BARRIER_UNPROVEN", "Object-shaped evidence required");
  return value as Data;
}
function bytes(file: string): Buffer {
  return readBytes(file, 128 * 1024 * 1024, fs, file);
}
function optional(file: string): Buffer | null {
  try {
    return bytes(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function ref(file: string): RebaselineReference {
  return { path: file, sha256: sha(bytes(file)) };
}
function verify(reference: RebaselineReference): Buffer {
  if (
    !reference ||
    !path.isAbsolute(reference.path) ||
    !/^[a-f0-9]{64}$/.test(reference.sha256)
  )
    fail("RUNTIME_BARRIER_UNPROVEN", "Invalid evidence reference");
  const value = bytes(reference.path);
  if (sha(value) !== reference.sha256)
    fail("RUNTIME_BARRIER_CHANGED", "Immutable evidence bytes changed");
  return value;
}
function attests(reference: RebaselineReference, binding: unknown): boolean {
  const value = verify(reference);
  try {
    return same(JSON.parse(value.toString("utf8")), binding);
  } catch {
    return false;
  }
}
/** Literal metadata only: deliberately does not resolve historical lineage. */
export function literalRuntimeHead(directory: string) {
  const store = fs.realpathSync(directory),
    stat = fs.statSync(store);
  const files: Record<string, Buffer | null> = {};
  for (const name of inputs) files[name] = optional(path.join(store, name));
  if (!files["queue-state.json"])
    fail(
      "STORAGE_UNAVAILABLE",
      "Existing canonical queue snapshot is required",
    );
  const manifest = Object.fromEntries(
    inputs.map((name) => [
      name,
      files[name] === null ? null : sha(files[name]!),
    ]),
  );
  return {
    store,
    device: stat.dev,
    inode: stat.ino,
    files,
    digest: sha(
      JSON.stringify({ store, device: stat.dev, inode: stat.ino, manifest }),
    ),
  };
}
function validateRequest(value: RuntimeRebaselineRequest): void {
  if (
    !same(Object.keys(value).sort(), [
      "expectedHead",
      "handoffId",
      "requestId",
    ]) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.handoffId) ||
    !/^[a-f0-9]{64}$/.test(value.expectedHead)
  )
    fail(
      "INVALID_REQUEST",
      "Expected handoffId, expectedHead and requestId only",
    );
}
function dispositions(
  snapshot: Data,
  handoffId: string,
): Record<string, Disposition> {
  const result: Record<string, Disposition> = {};
  for (const [id, value] of Object.entries(object(snapshot["jobs"]))) {
    const job = object(value);
    if (
      ["succeeded", "failed", "cancelled", "expired"].includes(
        String(job["state"]),
      )
    )
      continue;
    // Missing dispatch metadata is not evidence that a sent/active job never ran.
    const neverStarted =
      job["state"] === "queued" &&
      job["dispatch"] === undefined &&
      job["startedAt"] === undefined &&
      !job["physicalTurns"] &&
      !job["physicalDispatchCount"] &&
      (job["physicalDispatches"] === undefined ||
        (Array.isArray(job["physicalDispatches"]) &&
          job["physicalDispatches"].length === 0));
    result[id] = {
      outcome: neverStarted ? "not_started" : "unknown",
      executionFence: { kind: "runtime_retired", handoffId },
      replay: false,
    };
  }
  return result;
}
function exposures(snapshot: Data, handoffId: string): Data {
  const result = structuredClone(object(snapshot["quarantined"] ?? {}));
  function add(key: string, value: unknown) {
    while (Object.hasOwn(result, key)) key += ":";
    result[key] = value;
  }
  for (const [jobId, disposition] of Object.entries(
    dispositions(snapshot, handoffId),
  )) {
    if (disposition.outcome === "unknown" && !Object.hasOwn(result, jobId))
      add(`runtime:${jobId}`, { jobId, target: null, ...disposition });
  }
  // Unknown local/control effects cannot acquire an invented document scope.
  for (const key of ["localUnknown", "controlBlocked"] as const) {
    if (snapshot[key])
      add(`runtime:${key}`, {
        target: null,
        original: snapshot[key],
        executionFence: { kind: "runtime_retired", handoffId },
      });
  }
  return result;
}
function activatedFile(dir: string) {
  return path.join(dir, "runtime-rebaseline-head.json");
}
/** A native publisher can outlive its Linux parent and its writer lock.
 * The native authority owns this durable reservation and its exact-death
 * recovery. Never remove it merely because the parent broker disappeared.
 * Ordinary bootstrap must call this before claiming a writer or a grant. */
export function assertNoPendingRuntimePublication(directory: string): void {
  const marker = path.join(
    fs.realpathSync(directory),
    "runtime-rebaseline-publication.json",
  );
  try {
    fs.lstatSync(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fail(
    "RUNTIME_PUBLICATION_PENDING",
    "Native runtime activation requires read-only outcome recovery before any writer or grant",
  );
}
/** New roots are verified on their own authority. Old lineage is immutable
 * history_unproven, never an adopted/passed predecessor or per-turn release. */
function readRuntimeRebaselineRoot(directory: string): {
  record: RebaselineRecord;
  snapshot: Data;
} | null {
  const store = fs.realpathSync(directory),
    active = optional(activatedFile(store));
  if (!active) return null;
  const pointer = object(JSON.parse(active.toString("utf8")));
  const reference = pointer["record"] as RebaselineReference;
  const record = object(
    JSON.parse(verify(reference).toString("utf8")),
  ) as unknown as RebaselineRecord;
  const stat = fs.statSync(store);
  if (
    record.version !== 1 ||
    record.kind !== "runtime-rebaseline-root" ||
    record.store !== store ||
    record.storeDevice !== stat.dev ||
    record.storeInode !== stat.ino ||
    reference.path !==
      path.join(
        store,
        "runtime-rebaselines",
        record.request.requestId,
        "record.json",
      ) ||
    pointer["newHead"] !== record.receipt.newHead
  )
    fail("RUNTIME_BARRIER_CHANGED", "Rebaseline root/store binding changed");
  validateRequest(record.request);
  if (!same(Object.keys(record.frozen).sort(), [...inputs].sort()))
    fail("RUNTIME_BARRIER_CHANGED", "Incomplete frozen canonical metadata");
  for (const [name, reference] of Object.entries(record.frozen)) {
    if (
      !inputs.includes(name as (typeof inputs)[number]) ||
      (reference &&
        reference.path !==
          path.join(
            path.dirname((pointer["record"] as RebaselineReference).path),
            name,
          ))
    )
      fail("RUNTIME_BARRIER_CHANGED", "Frozen state escaped its root");
    if (reference) verify(reference);
  }
  let bound = false;
  for (const reference of record.evidence) {
    if (attests(reference, record.binding)) bound = true;
  }
  if (!bound)
    fail(
      "RUNTIME_BARRIER_UNPROVEN",
      "Rebaseline root lost its verified attestation",
    );
  const snapshot = object(
    JSON.parse(verify(record.frozen["queue-state.json"]!).toString("utf8")),
  );
  const manifest = Object.fromEntries(
    inputs.map((name) => [name, record.frozen[name]?.sha256 ?? null]),
  );
  const originalHead = sha(
    JSON.stringify({
      store,
      device: stat.dev,
      inode: stat.ino,
      manifest,
    }),
  );
  const newHead = sha(
    JSON.stringify({
      request: record.request,
      frozen: record.frozen,
      binding: record.binding,
      evidence: record.evidence,
      operatorId: record.operatorId,
    }),
  );
  if (
    originalHead !== record.request.expectedHead ||
    record.receipt.oldHead !== originalHead ||
    record.receipt.newHead !== newHead ||
    record.receipt.rebaselineId !== record.request.requestId ||
    record.receipt.handoffId !== record.request.handoffId ||
    record.history !== "preserved_unproven" ||
    record.receipt.history !== record.history ||
    record.receipt.grantIssued !== false ||
    record.receipt.sdkSubmitted !== false ||
    record.binding.handoffId !== record.request.handoffId ||
    record.binding.retirement !== "process_dead" ||
    record.binding.ingress !== "pinned_all_sdk_ingress" ||
    record.binding.grantCount !== 0 ||
    record.binding.admissionCount !== 0
  )
    fail(
      "RUNTIME_BARRIER_CHANGED",
      "Rebaseline root digest or authority changed",
    );
  if (
    !same(
      dispositions(snapshot, record.request.handoffId),
      record.dispositions,
    ) ||
    !same(
      exposures(snapshot, record.request.handoffId),
      record.carriedExposures,
    ) ||
    record.receipt.carriedExposures !==
      Object.keys(record.carriedExposures).length
  )
    fail(
      "RUNTIME_BARRIER_CHANGED",
      "Outstanding work or exposure disposition changed",
    );
  return { record, snapshot };
}
function publicationFor(
  record: RebaselineRecord,
): RuntimeActivationPublication {
  const recordFile = path.join(
    record.store,
    "runtime-rebaselines",
    record.request.requestId,
    "record.json",
  );
  const reference = ref(recordFile);
  return {
    store: record.store,
    storeDevice: record.storeDevice,
    storeInode: record.storeInode,
    expectedHead: record.request.expectedHead,
    expectedFiles: Object.fromEntries(
      inputs.map((name) => [name, record.frozen[name]?.sha256 ?? null]),
    ),
    activationFile: activatedFile(record.store),
    activationBytes: JSON.stringify({
      version: 1,
      newHead: record.receipt.newHead,
      record: reference,
    }),
    record: reference,
  };
}
function completionBinding(record: RebaselineRecord) {
  return {
    requestId: record.request.requestId,
    newHead: record.receipt.newHead,
    publicationDigest: sha(JSON.stringify(publicationFor(record))),
    initiatorOperatorId: record.operatorId,
  };
}
function validateCompletion(
  value: RuntimeActivationCompletion,
  record: RebaselineRecord,
): void {
  if (
    !value ||
    !same(value.binding, completionBinding(record)) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.length
  )
    fail(
      "RUNTIME_ACTIVATION_INCOMPLETE",
      "Native consume is not bound to this exact activation",
    );
  let bound = false;
  for (const reference of value.evidence)
    if (attests(reference, value.binding)) bound = true;
  if (!bound)
    fail(
      "RUNTIME_ACTIVATION_INCOMPLETE",
      "Native consume attestation lacks byte provenance",
    );
}
function completionFile(record: RebaselineRecord) {
  return path.join(
    record.store,
    "runtime-rebaselines",
    record.request.requestId,
    "completion.json",
  );
}
function completed(record: RebaselineRecord): boolean {
  const value = optional(completionFile(record));
  if (!value) return false;
  validateCompletion(
    JSON.parse(value.toString("utf8")) as RuntimeActivationCompletion,
    record,
  );
  return true;
}
/** Only a completed, native-consumed root authorizes ordinary bootstrap. */
export function runtimeRebaselineRoot(directory: string) {
  const root = readRuntimeRebaselineRoot(directory);
  if (!root) return null;
  if (!completed(root.record))
    fail(
      "RUNTIME_ACTIVATION_INCOMPLETE",
      "Local head is published but native consume requires same-ID resume",
    );
  assertNoPendingRuntimePublication(directory);
  return root;
}
function pendingForRequest(store: string, request: RuntimeRebaselineRequest) {
  const marker = optional(
    path.join(store, "runtime-rebaseline-publication.json"),
  );
  if (!marker) return false;
  try {
    const value = object(JSON.parse(marker.toString("utf8")));
    if (
      value["requestId"] === request.requestId &&
      value["expectedHead"] === request.expectedHead
    )
      return true;
  } catch {
    // A damaged marker is never permission to clear or re-issue a publication.
  }
  fail(
    "RUNTIME_PUBLICATION_PENDING",
    "Another or unproven native publication requires exact outcome recovery",
  );
}
async function finishActivation(
  record: RebaselineRecord,
  lease: RuntimeBarrierLease,
  fault?: (
    point: "after_staging" | "before_activation" | "after_activation",
  ) => void,
): Promise<RuntimeRebaselineReceipt> {
  if (lease.initiatorOperatorId !== record.operatorId)
    fail(
      "RUNTIME_BARRIER_CHANGED",
      "Native begin initiator changed during resume",
    );
  const publication = publicationFor(record);
  await lease.publishActivation(publication);
  const committed = readRuntimeRebaselineRoot(record.store);
  if (!committed || !same(committed.record.receipt, record.receipt))
    fail(
      "RUNTIME_ACTIVATION_UNKNOWN",
      "Publication result is unproven; resume the original request ID",
    );
  fault?.("after_activation");
  const completion = await lease.consumeActivation(publication);
  validateCompletion(completion, record);
  if (!completed(record))
    immutableBytes(
      completionFile(record),
      Buffer.from(JSON.stringify(completion)),
    );
  assertNoPendingRuntimePublication(record.store);
  return record.receipt;
}
async function barrier(lease: RuntimeBarrierLease, pins: RuntimePins) {
  lease.assertWriterAndProvisionLock();
  const observation = await lease.verifyCurrentBarrier();
  lease.assertWriterAndProvisionLock();
  const binding = structuredClone(observation.binding);
  if (
    !same(
      Object.fromEntries(
        Object.keys(pins).map((key) => [
          key,
          (binding as unknown as Data)[key],
        ]),
      ),
      pins,
    ) ||
    binding.retirement !== "process_dead" ||
    binding.ingress !== "pinned_all_sdk_ingress" ||
    binding.grantCount !== 0 ||
    binding.admissionCount !== 0 ||
    !binding.writerGeneration ||
    !Number.isSafeInteger(binding.process.pid) ||
    binding.process.pid <= 0 ||
    !binding.process.birth ||
    !binding.retiredProcess?.birth ||
    binding.retiredProcess.pid <= 0 ||
    same(binding.process, binding.retiredProcess) ||
    !observation.evidence.length
  )
    fail(
      "RUNTIME_BARRIER_UNPROVEN",
      "Contemporary host barrier does not match pinned authority",
    );
  let bound = false;
  for (const reference of observation.evidence) {
    if (attests(reference, binding)) bound = true;
  }
  if (!bound)
    fail(
      "RUNTIME_BARRIER_UNPROVEN",
      "Host verifier attestation lacks byte provenance",
    );
  return { binding, evidence: structuredClone(observation.evidence) };
}
export async function rebaselineRuntime(
  directory: string,
  request: RuntimeRebaselineRequest,
  authority: RuntimeRebaselineAuthority,
  testing: {
    fault?(
      point: "after_staging" | "before_activation" | "after_activation",
    ): void;
  } = {},
): Promise<RuntimeRebaselineReceipt> {
  validateRequest(request);
  request = structuredClone(request);
  const ports = authorities.get(authority);
  const store = fs.realpathSync(directory);
  if (!ports || path.resolve(ports.store) !== store)
    fail(
      "NOT_AUTHORIZED",
      "Local operator capability is not bound to this store",
    );
  const prior = readRuntimeRebaselineRoot(store);
  if (prior?.record.request.requestId === request.requestId) {
    if (!same(prior.record.request, request))
      fail("REQUEST_CONFLICT", "Rebaseline request ID has different inputs");
    if (completed(prior.record) && !pendingForRequest(store, request))
      return prior.record.receipt;
  }
  pendingForRequest(store, request);
  return ports.withExclusiveBarrier(request, async (lease) => {
    // Another same-ID process may have committed while this caller waited.
    const concurrent = readRuntimeRebaselineRoot(store);
    if (concurrent?.record.request.requestId === request.requestId) {
      if (!same(concurrent.record.request, request))
        fail("REQUEST_CONFLICT", "Rebaseline request ID has different inputs");
      if (completed(concurrent.record) && !pendingForRequest(store, request))
        return concurrent.record.receipt;
      return finishActivation(concurrent.record, lease, testing.fault);
    }
    pendingForRequest(store, request);
    const old = literalRuntimeHead(store);
    if (
      old.digest !== request.expectedHead ||
      ports.pins.handoffId !== request.handoffId
    )
      fail("RUNTIME_BARRIER_CHANGED", "Literal head or handoff does not match");
    const current = await barrier(lease, ports.pins);
    if (!lease.initiatorOperatorId)
      fail(
        "RUNTIME_BARRIER_UNPROVEN",
        "Native begin must freeze its initiator",
      );
    const destination = path.join(
      store,
      "runtime-rebaselines",
      request.requestId,
    );
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(destination) !== destination)
      fail(
        "STORAGE_UNAVAILABLE",
        "Rebaseline destination escaped canonical store",
      );
    syncDirectory(store);
    syncDirectory(path.dirname(destination));
    const frozen: Record<string, RebaselineReference | null> = {};
    for (const name of inputs) {
      const value = old.files[name],
        file = path.join(destination, name);
      if (value === null) {
        frozen[name] = null;
        continue;
      }
      immutableBytes(file, value!);
      frozen[name] = ref(file);
    }
    const snapshot = object(
      JSON.parse(old.files["queue-state.json"]!.toString("utf8")),
    );
    const carriedExposures = exposures(snapshot, request.handoffId);
    // A root digest binds exact frozen bytes, host evidence and administrator.
    const newHead = sha(
      JSON.stringify({
        request,
        frozen,
        ...current,
        operatorId: lease.initiatorOperatorId,
      }),
    );
    const receipt: RuntimeRebaselineReceipt = {
      rebaselineId: request.requestId,
      oldHead: old.digest,
      newHead,
      handoffId: request.handoffId,
      carriedExposures: Object.keys(carriedExposures).length,
      history: "preserved_unproven",
      grantIssued: false,
      sdkSubmitted: false,
    };
    const record: RebaselineRecord = {
      version: 1,
      kind: "runtime-rebaseline-root",
      store,
      storeDevice: old.device,
      storeInode: old.inode,
      request,
      operatorId: lease.initiatorOperatorId,
      history: "preserved_unproven",
      frozen,
      ...current,
      dispositions: dispositions(snapshot, request.handoffId),
      carriedExposures,
      receipt,
    };
    const recordFile = path.join(destination, "record.json");
    immutableBytes(recordFile, Buffer.from(JSON.stringify(record)));
    testing.fault?.("after_staging");
    const rechecked = await barrier(lease, ports.pins);
    if (
      !same(rechecked, current) ||
      literalRuntimeHead(store).digest !== request.expectedHead
    )
      fail(
        "RUNTIME_BARRIER_CHANGED",
        "Host or canonical state changed before activation",
      );
    testing.fault?.("before_activation");
    lease.assertWriterAndProvisionLock();
    if (literalRuntimeHead(store).digest !== request.expectedHead)
      fail(
        "RUNTIME_BARRIER_CHANGED",
        "Canonical state changed before activation",
      );
    return finishActivation(record, lease, testing.fault);
  });
}
function immutableBytes(file: string, value: Buffer) {
  const existing = optional(file);
  if (existing) {
    if (!existing.equals(value))
      fail("REQUEST_CONFLICT", "Staged rebaseline ID has different bytes");
  } else durableBytes(file, value, true);
}

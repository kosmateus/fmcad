import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { createRequire } from "node:module";
const { durableBytes, readBytes, syncDirectory } = createRequire(__filename)(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");
const { runtimeRebaselineManifestNames: inputNames } = createRequire(
  __filename,
)(
  "./dist/node-adapters/persistence/runtime-rebaseline-scope",
) as typeof import("../packages/node-adapters/src/persistence/runtime-rebaseline-scope");

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
  nativeReceipt: {
    kind: "native-runtime-rebaseline-consume-v1";
    reference: RebaselineReference;
  };
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
  /** Authenticated native QUERY phase; CONSUMED is not an active no-grant fence. */
  readonly fenceState: "pending" | "consumed";
  /** Frozen by the native begin record, not the current resumer's identity. */
  readonly initiatorOperatorId: string;
  assertWriterAndProvisionLock(): void;
  verifyCurrentBarrier(): Promise<{
    binding: RuntimeBarrierBinding;
    evidence: RebaselineReference[];
  }>;
  /** Final recheck + durable local CAS must execute at the authority holding
   * both barriers, not a callback in a different process after a heartbeat ACK.
   * A durable native provision fence may survive a remote process's death;
   * losing a transient remote lock must never permit unfenced publication.
   * Exact NEW resumes re-verify and POSIX re-fsync; they do not perform a CAS. */
  publishActivation(publication: RuntimeActivationPublication): Promise<void>;
  /** Verify exact native consumed receipt after publication/re-fsync. Idempotent
   * query/resume uses native durable identity, never the initiator's lost token. */
  consumeActivation(
    publication: RuntimeActivationPublication,
  ): Promise<RuntimeActivationCompletion>;
  verifyNativeConsumeReceipt(
    publication: RuntimeActivationPublication,
    completion: RuntimeActivationCompletion,
  ): Promise<void>;
}
export interface RuntimeRebaselineAuthorityPorts {
  store: string;
  operatorId: string;
  pins: RuntimePins;
  withExclusiveBarrier<T>(
    request: RuntimeRebaselineRequest,
    mode: "publish-or-resume" | "verify-completed",
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
  layers: ReturnType<typeof scopedState>["layers"];
  receipt: RuntimeRebaselineReceipt;
}
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
function readLiteralRuntimeHead(directory: string) {
  const store = fs.realpathSync(directory),
    stat = fs.statSync(store);
  const files: Record<string, Buffer | null> = {};
  const pointer = optional(path.join(store, "isolated-admission-epoch.json"));
  const names = inputNames(store, pointer);
  for (const name of names) files[name] = optional(path.join(store, name));
  if (!same(pointer, files["isolated-admission-epoch.json"]))
    fail("RUNTIME_BARRIER_CHANGED", "Active epoch changed during literal read");
  for (const name of names.filter(
    (name) => name.includes("/") && !name.endsWith(".pending.json"),
  ))
    if (!files[name])
      fail("STORAGE_UNAVAILABLE", "Active epoch snapshot/identity is missing");
  if (!files["queue-state.json"])
    fail(
      "STORAGE_UNAVAILABLE",
      "Existing canonical queue snapshot is required",
    );
  const manifest = Object.fromEntries(
    names.map((name) => [
      name,
      files[name] === null ? null : sha(files[name]!),
    ]),
  );
  return {
    store,
    device: stat.dev,
    inode: stat.ino,
    files,
    manifest,
    digest: sha(
      JSON.stringify({ store, device: stat.dev, inode: stat.ino, manifest }),
    ),
  };
}
/** Public preflight returns metadata only, never snapshot/configuration bytes. */
export function literalRuntimeHead(directory: string) {
  const value = readLiteralRuntimeHead(directory);
  return {
    store: value.store,
    device: value.device,
    inode: value.inode,
    digest: value.digest,
    manifest: value.manifest,
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
      snapshot["active"] !== id &&
      (!snapshot["lease"] ||
        (job["clientId"] !== undefined &&
          object(snapshot["lease"])["clientId"] !== job["clientId"])) &&
      (!snapshot["blocked"] || object(snapshot["blocked"])["id"] !== id) &&
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
function scopedState(files: Record<string, Buffer | null>, handoffId: string) {
  const snapshots: Record<string, Data> = {};
  const allDispositions: Record<string, Disposition> = {};
  const allExposures: Data = {};
  const layers: Record<
    string,
    { dispositions: Record<string, Disposition>; carriedExposures: Data }
  > = {};
  for (const [name, value] of Object.entries(files)) {
    if (!name.endsWith("queue-state.json") || !value) continue;
    const layer = name === "queue-state.json" ? "root" : path.dirname(name);
    const snapshot = object(JSON.parse(value.toString("utf8")));
    snapshots[layer] = snapshot;
    const decisions = dispositions(snapshot, handoffId),
      carried = exposures(snapshot, handoffId);
    layers[layer] = { dispositions: decisions, carriedExposures: carried };
    for (const [id, decision] of Object.entries(decisions)) {
      let key = layer === "root" ? id : `${layer}/${id}`;
      while (Object.hasOwn(allDispositions, key)) key += ":";
      Object.defineProperty(allDispositions, key, {
        value: decision,
        enumerable: true,
      });
    }
    for (const [id, exposure] of Object.entries(carried)) {
      let key = layer === "root" ? id : `${layer}/${id}`;
      while (Object.hasOwn(allExposures, key)) key += ":";
      Object.defineProperty(allExposures, key, {
        value: exposure,
        enumerable: true,
      });
    }
  }
  return {
    snapshots,
    layers,
    dispositions: allDispositions,
    carriedExposures: allExposures,
  };
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
  snapshots: Record<string, Data>;
} | null {
  const store = fs.realpathSync(directory),
    active = optional(activatedFile(store));
  if (!active) {
    const archive = path.join(store, "runtime-rebaselines");
    if (fs.existsSync(archive)) {
      if (fs.realpathSync(archive) !== archive)
        fail(
          "STORAGE_UNAVAILABLE",
          "Rebaseline archive escaped canonical store",
        );
      for (const entry of fs.readdirSync(archive, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
          fail(
            "STORAGE_UNAVAILABLE",
            "Rebaseline archive entry is not a canonical directory",
          );
        if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name))
          continue;
        if (
          optional(path.join(archive, entry.name, "completion.json")) !== null
        )
          fail(
            "RUNTIME_BARRIER_CHANGED",
            "Approved runtime activation pointer is missing",
          );
      }
    }
    return null;
  }
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
    pointer["version"] !== 1 ||
    active.toString("utf8") !==
      JSON.stringify({
        version: 1,
        newHead: record.receipt.newHead,
        record: { path: reference.path, sha256: reference.sha256 },
      }) ||
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
  const frozenPointer = record.frozen["isolated-admission-epoch.json"];
  const names = inputNames(store, frozenPointer ? verify(frozenPointer) : null);
  if (!same(Object.keys(record.frozen).sort(), [...names].sort()))
    fail("RUNTIME_BARRIER_CHANGED", "Incomplete frozen canonical metadata");
  for (const [name, reference] of Object.entries(record.frozen)) {
    if (
      !names.includes(name) ||
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
  const frozenFiles = Object.fromEntries(
    Object.entries(record.frozen).map(([name, reference]) => [
      name,
      reference ? verify(reference) : null,
    ]),
  );
  if (
    Object.entries(frozenFiles).some(
      ([name, value]) =>
        name.endsWith("queue-state.pending.json") && value !== null,
    )
  )
    fail(
      "RUNTIME_BARRIER_UNPROVEN",
      "Frozen snapshot has unresolved durability journal",
    );
  const scoped = scopedState(frozenFiles, record.request.handoffId);
  const snapshot = scoped.snapshots["root"]!;
  const manifest = Object.fromEntries(
    names.map((name) => [name, record.frozen[name]?.sha256 ?? null]),
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
    !same(scoped.dispositions, record.dispositions) ||
    !same(scoped.carriedExposures, record.carriedExposures) ||
    !same(scoped.layers, record.layers) ||
    record.receipt.carriedExposures !==
      Object.keys(record.carriedExposures).length
  )
    fail(
      "RUNTIME_BARRIER_CHANGED",
      "Outstanding work or exposure disposition changed",
    );
  return { record, snapshot, snapshots: scoped.snapshots };
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
      Object.entries(record.frozen).map(([name, reference]) => [
        name,
        reference?.sha256 ?? null,
      ]),
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
    value.nativeReceipt?.kind !== "native-runtime-rebaseline-consume-v1" ||
    !same(value.binding, completionBinding(record)) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.length
  )
    fail(
      "RUNTIME_ACTIVATION_INCOMPLETE",
      "Native consume is not bound to this exact activation",
    );
  verify(value.nativeReceipt.reference);
  let bound = false;
  for (const reference of value.evidence) {
    if (same(reference, value.nativeReceipt.reference)) continue;
    if (attests(reference, value.binding)) bound = true;
  }
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
export async function runtimeRebaselineRoot(
  directory: string,
  authority: RuntimeRebaselineAuthority,
) {
  const root = readRuntimeRebaselineRoot(directory);
  if (!root) {
    assertNoPendingRuntimePublication(directory);
    return null;
  }
  if (!completed(root.record))
    fail(
      "RUNTIME_ACTIVATION_INCOMPLETE",
      "Local head is published but native consume requires same-ID resume",
    );
  assertNoPendingRuntimePublication(directory);
  const ports = authorities.get(authority);
  if (!ports || fs.realpathSync(ports.store) !== root.record.store)
    fail(
      "NOT_AUTHORIZED",
      "Root approval requires its trusted native receipt verifier",
    );
  return ports.withExclusiveBarrier(
    root.record.request,
    "verify-completed",
    async (lease) => {
      if (lease.fenceState !== "consumed")
        fail(
          "RUNTIME_ACTIVATION_INCOMPLETE",
          "Completed-root verification requires the original native consumed phase",
        );
      const current = readRuntimeRebaselineRoot(directory);
      if (!current || !same(current.record.receipt, root.record.receipt))
        fail(
          "RUNTIME_BARRIER_CHANGED",
          "Root changed while acquiring approval lock",
        );
      await approveCompletion(current.record, lease);
      return current;
    },
  );
}
function readCompletion(record: RebaselineRecord): RuntimeActivationCompletion {
  const value = optional(completionFile(record));
  if (!value)
    fail(
      "RUNTIME_ACTIVATION_INCOMPLETE",
      "Native consume completion is missing",
    );
  const completion = JSON.parse(
    value.toString("utf8"),
  ) as RuntimeActivationCompletion;
  validateCompletion(completion, record);
  return completion;
}
function flushReferences(store: string, references: RebaselineReference[]) {
  const directories = new Set<string>([store]);
  for (const reference of references) {
    verify(reference);
    const fd = fs.openSync(
      reference.path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    verify(reference);
    let directory = path.dirname(reference.path);
    directories.add(directory);
    while (directory.startsWith(store + path.sep)) {
      directory = path.dirname(directory);
      directories.add(directory);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length))
    syncDirectory(directory);
}
function activationReferences(record: RebaselineRecord) {
  const publication = publicationFor(record);
  return [
    ...Object.values(record.frozen).filter(
      (value): value is RebaselineReference => value !== null,
    ),
    ...record.evidence,
    publication.record,
    ref(publication.activationFile),
  ];
}
function refsync(
  record: RebaselineRecord,
  completion: RuntimeActivationCompletion,
) {
  flushReferences(record.store, [
    ...activationReferences(record),
    ...completion.evidence,
    completion.nativeReceipt.reference,
    ref(completionFile(record)),
  ]);
}
async function approveCompletion(
  record: RebaselineRecord,
  lease: RuntimeBarrierLease,
) {
  const completion = readCompletion(record);
  lease.assertWriterAndProvisionLock();
  refsync(record, completion);
  await lease.verifyNativeConsumeReceipt(publicationFor(record), completion);
  lease.assertWriterAndProvisionLock();
  assertNoPendingRuntimePublication(record.store);
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
  pins: RuntimePins,
  fault?: (
    point: "after_staging" | "before_activation" | "after_activation",
  ) => void,
): Promise<RuntimeRebaselineReceipt> {
  if (lease.initiatorOperatorId !== record.operatorId)
    fail(
      "RUNTIME_BARRIER_CHANGED",
      "Native begin initiator changed during resume",
    );
  const pending = lease.fenceState === "pending";
  if (pending) {
    const current = await barrier(lease, pins);
    if (!same(current, { binding: record.binding, evidence: record.evidence }))
      fail(
        "RUNTIME_BARRIER_CHANGED",
        "Current barrier differs from the frozen activation authority",
      );
  } else if (lease.fenceState === "consumed") {
    const existing = readRuntimeRebaselineRoot(record.store);
    if (!existing || !same(existing.record.receipt, record.receipt))
      fail(
        "RUNTIME_BARRIER_CHANGED",
        "Consumed native fence requires the exact already-published activation",
      );
  } else
    fail(
      "RUNTIME_BARRIER_UNPROVEN",
      "Authenticated native fence phase is required",
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
  lease.assertWriterAndProvisionLock();
  flushReferences(record.store, activationReferences(record));
  if (pending) {
    const beforeConsume = await barrier(lease, pins);
    if (
      !same(beforeConsume, {
        binding: record.binding,
        evidence: record.evidence,
      })
    )
      fail(
        "RUNTIME_BARRIER_CHANGED",
        "Host barrier changed before native consume",
      );
  }
  const completion = await lease.consumeActivation(publication);
  validateCompletion(completion, record);
  if (!completed(record))
    immutableBytes(
      completionFile(record),
      Buffer.from(JSON.stringify(completion)),
    );
  await approveCompletion(record, lease);
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
  }
  pendingForRequest(store, request);
  const mode =
    prior?.record.request.requestId === request.requestId &&
    completed(prior.record)
      ? "verify-completed"
      : "publish-or-resume";
  return ports.withExclusiveBarrier(request, mode, async (lease) => {
    // Another same-ID process may have committed while this caller waited.
    const concurrent = readRuntimeRebaselineRoot(store);
    if (concurrent?.record.request.requestId === request.requestId) {
      if (!same(concurrent.record.request, request))
        fail("REQUEST_CONFLICT", "Rebaseline request ID has different inputs");
      if (completed(concurrent.record)) {
        if (lease.fenceState !== "consumed")
          fail(
            "RUNTIME_ACTIVATION_INCOMPLETE",
            "Completed receipt requires an authenticated consumed native fence",
          );
        await approveCompletion(concurrent.record, lease);
        return concurrent.record.receipt;
      }
      return finishActivation(
        concurrent.record,
        lease,
        ports.pins,
        testing.fault,
      );
    }
    pendingForRequest(store, request);
    if (lease.fenceState !== "pending")
      fail(
        "RUNTIME_BARRIER_UNPROVEN",
        "Unpublished activation requires an authenticated pending fence",
      );
    const old = readLiteralRuntimeHead(store);
    if (
      Object.entries(old.files).some(
        ([name, value]) =>
          name.endsWith("queue-state.pending.json") && value !== null,
      )
    )
      fail(
        "STORAGE_UNAVAILABLE",
        "Unresolved snapshot durability journal requires explicit recovery",
      );
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
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(parent) !== parent)
      fail("STORAGE_UNAVAILABLE", "Rebaseline parent escaped canonical store");
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(destination) !== destination)
      fail(
        "STORAGE_UNAVAILABLE",
        "Rebaseline destination escaped canonical store",
      );
    syncDirectory(store);
    syncDirectory(path.dirname(destination));
    const frozen: Record<string, RebaselineReference | null> = {};
    for (const name of Object.keys(old.files)) {
      const value = old.files[name],
        file = path.join(destination, name);
      if (value === null) {
        frozen[name] = null;
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (fs.realpathSync(path.dirname(file)) !== path.dirname(file))
        fail(
          "STORAGE_UNAVAILABLE",
          "Frozen snapshot namespace escaped canonical store",
        );
      immutableBytes(file, value!);
      frozen[name] = ref(file);
    }
    const scoped = scopedState(old.files, request.handoffId);
    const carriedExposures = scoped.carriedExposures;
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
      dispositions: scoped.dispositions,
      layers: scoped.layers,
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
    return finishActivation(record, lease, ports.pins, testing.fault);
  });
}
function immutableBytes(file: string, value: Buffer) {
  const existing = optional(file);
  if (existing) {
    if (!existing.equals(value))
      fail("REQUEST_CONFLICT", "Staged rebaseline ID has different bytes");
  } else durableBytes(file, value, true);
}

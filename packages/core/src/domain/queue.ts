import { decodePersistedJob } from "./codec";
import type {
  QueueDomainOptions,
  QueueSnapshot,
  QueueRequest,
  QueueJob,
  QueueDetails,
  SequenceMode,
  AtomicWorkflowObservation,
} from "./queue-model";
import { initialQueueSnapshot } from "./queue-model";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const STATES = new Set([
  "preparing",
  "processing",
  "queued",
  "running",
  "sending",
  "needs_reconciliation",
  ...TERMINAL,
]);
export const terminal = (state: string) => TERMINAL.has(state);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function validWorkflowObservation(value: unknown): value is AtomicWorkflowObservation {
  if (!plain(value)) return false;
  const keys = [
    "version", "kind", "targetJobId", "targetRequestId", "targetClientId", "targetJobHash", "observerJobHash",
    "targetBuildHash", "observerBuildHash", "projectDirectory", "paused", "controlGeneration", "contextEpoch",
    "reportPath", "reportFingerprint", "commandId", "sessionNonce", "docId",
  ];
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)) &&
    value["version"] === 1 && value["kind"] === "atomic-holder-status" &&
    ["targetJobId", "targetRequestId", "targetClientId", "projectDirectory", "reportPath", "targetBuildHash", "observerBuildHash", "docId"].every(
      (key) => identifier(value[key]),
    ) &&
      typeof value["targetJobHash"] === "string" && /^[a-f0-9]{64}$/.test(value["targetJobHash"]) &&
      typeof value["observerJobHash"] === "string" && /^[a-f0-9]{64}$/.test(value["observerJobHash"]) &&
      typeof value["reportFingerprint"] === "string" && /^[a-f0-9]{64}$/.test(value["reportFingerprint"]) &&
      typeof value["paused"] === "boolean" && integer(value["controlGeneration"]) && integer(value["contextEpoch"]) &&
    typeof value["commandId"] === "string" && /^fmcad_atomic_[a-f0-9]{32}$/.test(value["commandId"]) &&
    typeof value["sessionNonce"] === "string" && /^[a-f0-9]{32}$/.test(value["sessionNonce"]);
}
function cadInvocation(request: QueueRequest) {
  const payload = request.payload;
  if (!plain(payload)) return null;
  if (payload["kind"] === "cad") return payload;
  const invocation = payload["invocation"];
  return payload["kind"] === "cad-command" && payload["version"] === 1 && plain(invocation)
    ? invocation
    : null;
}
function workflowObservationFor(d: QueueSnapshot, id: string) {
  const observer = d.jobs[id];
  const marker = observer?.workflowObservation;
  const target = marker && d.jobs[marker.targetJobId];
  const current = !!(target && d.blocked?.id === target.id && target.state === "needs_reconciliation");
  const historical = !!(target && terminal(target.state) && terminal(observer?.state || ""));
  if (!target || (!current && !historical) || !marker || !validWorkflowObservation(marker) || marker.targetJobId !== target.id ||
      marker.targetRequestId !== target.requestId || marker.targetClientId !== target.clientId ||
      marker.targetJobHash !== target.hash || marker.targetBuildHash !== target.request.buildHash ||
      marker.observerJobHash !== observer.hash || marker.observerBuildHash !== observer.request.buildHash || observer.clientId !== target.clientId ||
      observer.kind !== "command" || observer.request.phased === true ||
      observer.request.sequence !== undefined) return null;
  const payload = cadInvocation(observer.request);
  if (!payload || payload["operation"] !== "batch.reconcile" || !plain(payload["data"])) return null;
  const data = payload["data"];
  if (data["reportPath"] !== marker.reportPath || data["blockedJobId"] !== target.id ||
      data["commandId"] !== marker.commandId || data["sessionNonce"] !== marker.sessionNonce ||
      (data["operations"] !== undefined && (!Array.isArray(data["operations"]) || data["operations"].length !== 0)) ||
      payload["docId"] !== marker.docId || observer.request.buildHash !== marker.observerBuildHash) return null;
  return marker;
}
function normalizeDescription(value: string): string | undefined {
  if (
    typeof value !== "string" ||
    /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value) ||
    Array.from(value).length > 1000
  )
    throw new Error(
      "--purpose requires at most 1000 Unicode characters without control characters",
    );
  return value.trim() || undefined;
}

// Only JSON data crosses this boundary; canonicalize every immutable input field.
export function canonical(
  value: unknown,
  ancestors = new Set<object>(),
): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (
    !value ||
    typeof value !== "object" ||
    ancestors.has(value) ||
    (!Array.isArray(value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  ) {
    fail(
      "INVALID_REQUEST",
      "Use finite JSON values without cycles or live objects",
    );
  }
  ancestors.add(value);
  const result = Array.isArray(value)
    ? "[" +
      Array.from(value, (item) => canonical(item, ancestors)).join(",") +
      "]"
    : "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonical((value as Record<string, unknown>)[key], ancestors),
        )
        .join(",") +
      "}";
  ancestors.delete(value);
  return result;
}

export function validateQueueOptions({
  maxQueued = 1000,
  maxPerClient = 100,
  idleMs = 60000,
  leaseMs = 600000,
  now,
}: Pick<
  QueueDomainOptions,
  "maxQueued" | "maxPerClient" | "idleMs" | "leaseMs" | "now"
>): void {
  for (const value of [maxQueued, maxPerClient, idleMs, leaseMs]) {
    if (!integer(value) || value === 0)
      fail(
        "INVALID_OPTIONS",
        "Limits and lease durations must be positive safe integers",
      );
  }
  if (typeof now !== "function")
    fail("INVALID_OPTIONS", "now must be a clock function");
}

export class QueueDomain {
  data: QueueSnapshot;
  readonly maxQueued: number;
  readonly maxPerClient: number;
  readonly idleMs: number;
  readonly leaseMs: number;
  readonly now: () => number;
  readonly newId: () => string;
  readonly hash: (canonicalInput: string) => string;
  readonly commit: ((snapshot: QueueSnapshot) => void) | undefined;
  _fault: unknown;
  _writing = false;
  _waiting: QueueJob[] = [];
  constructor({
    snapshot,
    recover = true,
    maxQueued = 1000,
    maxPerClient = 100,
    idleMs = 60000,
    leaseMs = 600000,
    now,
    newId,
    hash,
    commit,
  }: QueueDomainOptions) {
    validateQueueOptions({ maxQueued, maxPerClient, idleMs, leaseMs, now });
    this.maxQueued = maxQueued;
    this.maxPerClient = maxPerClient;
    this.idleMs = idleMs;
    this.leaseMs = leaseMs;
    this.now = now;
    this.newId = newId;
    this.hash = hash;
    this.commit = commit;
    this.data =
      snapshot === undefined ? initialQueueSnapshot() : copy(snapshot);
    if (!recover) {
      this._waiting = Object.values(this.data.jobs).filter(
        (job) => job.state === "queued",
      );
      return;
    }
    const d = this.data;
    if (
      !d ||
      d.version !== 1 ||
      typeof d.paused !== "boolean" ||
      !integer(d.revision) ||
      !integer(d.epoch) ||
      !d.jobs ||
      typeof d.jobs !== "object" ||
      Array.isArray(d.jobs) ||
      (d.active !== null && !identifier(d.active)) ||
      (d.lastClient !== null && !identifier(d.lastClient))
    ) {
      fail("CORRUPT_STATE", "Unsupported queue snapshot");
    }
    const jobs = Object.values(d.jobs);
    if (
      jobs.some(
        (j) =>
          !j ||
          !identifier(j.id) ||
          d.jobs[j.id] !== j ||
          !STATES.has(j.state) ||
          !j.request ||
          !identifier(j.clientId) ||
          !integer(j.order) ||
          !identifier(j.requestId) ||
          j.request.requestId !== j.requestId ||
          j.request.clientId !== j.clientId ||
          !identifier(j.hash),
      )
    )
      fail("CORRUPT_STATE", "Invalid persisted job");
    if (
      d.lease &&
      (!identifier(d.lease.id) ||
        !identifier(d.lease.clientId) ||
        d.lease.epoch !== d.epoch ||
        ![d.lease.createdAt, d.lease.idleUntil, d.lease.holdUntil].every(
          integer,
        ))
    ) {
      fail("CORRUPT_STATE", "Invalid sequence lease");
    }
    for (const job of jobs) {
      if (job.workflowObservation !== undefined && !validWorkflowObservation(job.workflowObservation))
        fail("CORRUPT_STATE", "Invalid scoped workflow observation marker");
      if (job.workflowObservation && !workflowObservationFor(d, job.id))
        fail("CORRUPT_STATE", "Scoped workflow observation marker does not match its blocked owner job");
    }
    const uncertain = jobs.filter((j) =>
      ["running", "sending", "needs_reconciliation"].includes(j.state),
    );
    const activeObservation = d.active ? workflowObservationFor(d, d.active) : null;
    if (activeObservation) {
      const observer = d.jobs[d.active!]!;
      const original = d.jobs[activeObservation.targetJobId]!;
      if (d.blocked?.id !== original.id || original.state !== "needs_reconciliation" ||
          !["running", "sending", "needs_reconciliation"].includes(observer.state) ||
          uncertain.length !== 2 || !uncertain.includes(observer) || !uncertain.includes(original))
        fail("CORRUPT_STATE", "Scoped observation no longer matches the single blocked atomic job");
    } else if (
      uncertain.length > 1 ||
      (d.active && !uncertain.some((j) => j.id === d.active)) ||
      (d.blocked && !uncertain.some((j) => j.id === d.blocked?.id))
    ) {
      fail("CORRUPT_STATE", "Inconsistent active job; recovery required");
    }
    if (uncertain.length && !activeObservation) {
      const job = uncertain[0]!;
      job.state = "needs_reconciliation";
      job.sequenceState = job.sequenceId ? "needs_reconciliation" : null;
      d.active = job.id;
      d.blocked = d.blocked || {
        id: job.id,
        reason: "Broker restarted with an unfinished job",
        at: this._time(),
      };
    } else if (activeObservation && ["running", "sending"].includes(d.jobs[d.active!]!.state)) {
      const observer = d.jobs[d.active!]!;
      observer.state = "needs_reconciliation";
      observer.code = "ATOMIC_OBSERVATION_INTERRUPTED";
      observer.details = {
        state: "needs_reconciliation",
        code: "ATOMIC_OBSERVATION_INTERRUPTED",
        executionOutcome: "unknown",
        mayHaveMutated: false,
        reason: "Broker restarted during the one-shot read-only atomic holder observation; no replay is allowed",
      };
    }
    for (const job of jobs) {
      if (
        job.request.phased &&
        job.id !== d.localUnknown?.id &&
        ["preparing", "processing", "queued"].includes(job.state)
      ) {
        Object.assign(job, {
          state: "failed",
          code: "LOCAL_WORKER_INTERRUPTED",
          finishedAt: this._time(),
          sequenceState: job.sequenceId ? "ended" : null,
        });
        if (d.lease?.clientId === job.clientId) d.lease = null;
      }
    }
    this._promoteLocalUnknown(d);
    this._commit(() => null);
  }

  _time() {
    const value = this.now();
    if (!integer(value))
      fail(
        "INVALID_CLOCK",
        "now() must return nonnegative integer milliseconds",
      );
    return value;
  }

  _commit<T>(change: (draft: QueueSnapshot) => T): T {
    if (this._fault)
      fail(
        "STORAGE_UNAVAILABLE",
        "A durable write failed; reopen and reconcile this queue before continuing",
      );
    if (this._writing)
      fail("WRITE_IN_PROGRESS", "QueueState writes cannot be reentered");
    this._writing = true;
    try {
      const draft = copy(this.data);
      const result = change(draft);
      try {
        this.commit?.(draft);
      } catch (error) {
        this._fault = error;
        throw error;
      }
      this.data = draft;
      // Index only real transactions; idle ticks never scan terminal history.
      this._waiting = Object.values(draft.jobs).filter(
        (job) => job.state === "queued",
      );
      return copy(result);
    } finally {
      this._writing = false;
    }
  }

  _job(d: QueueSnapshot, id: string): QueueJob {
    if (!Object.hasOwn(d.jobs, id)) fail("JOB_NOT_FOUND", "Unknown job id");
    return d.jobs[id]!;
  }

  _active(d: QueueSnapshot, id: string, recovering = false): QueueJob {
    const job = this._job(d, id);
    if (terminal(job.state) || d.active !== id)
      fail("NOT_ACTIVE", "Only the active, unfinished job can be updated");
    if (d.blocked && !recovering && !workflowObservationFor(d, id))
      fail(
        "RECONCILIATION_REQUIRED",
        "Resolve the blocked active job using proven recovery evidence",
      );
    return job;
  }

  _promoteLocalUnknown(d: QueueSnapshot): void {
    if (!d.localUnknown || d.active || d.blocked) return;
    const record = d.localUnknown,
      job = this._job(d, record.id);
    job.state = "needs_reconciliation";
    job.sequenceState = job.sequenceId ? "needs_reconciliation" : null;
    d.active = job.id;
    d.blocked = record;
    delete d.localUnknown;
  }

  blockLocal(id: string, reason: unknown) {
    return this._commit((d) => {
      const job = this._job(d, id);
      if (!job.request.phased || terminal(job.state))
        fail(
          "INVALID_STATE",
          "Only an unfinished phased command can remain unknown",
        );
      if (d.localUnknown && d.localUnknown.id !== id)
        fail(
          "RECONCILIATION_REQUIRED",
          "Another workflow already awaits reconciliation",
        );
      d.localUnknown = { id, reason, at: this._time() };
      this._promoteLocalUnknown(d);
      return this._public(job);
    });
  }

  // Public views are allowlists: requests, tokens, hashes and opaque worker details stay private.
  _public(job: QueueJob) {
    const result: Record<string, unknown> = {};
    // Additive versioned projection shared by broker, CLI/MCP and console readers.
    result["operationResult"] = decodePersistedJob(job, this.data.version);
    for (const key of [
      "id",
      "requestId",
      "clientId",
      "description",
      "kind",
      "state",
      "order",
      "submittedAt",
      "queueDeadline",
      "startedAt",
      "finishedAt",
      "timeoutMs",
      "runDeadline",
      "code",
      "sequenceId",
      "sequenceState",
      "revision",
      "contextRefreshRequired",
      "physicalTurns",
      "sdkRemainingMs",
      "sdkReadyAt",
    ]) {
      if ((job as unknown as Record<string, unknown>)[key] !== undefined)
        result[key] = (job as unknown as Record<string, unknown>)[key];
    }
    if (job.sequenceMode) result["sequenceMode"] = job.sequenceMode;
    if (job.dispatch)
      result["dispatch"] = {
        dispatchCount: job.dispatch.dispatchCount,
        rpcCount: job.dispatch.rpcCount,
        completedCount: job.dispatch.completedCount,
        updatedAt: job.dispatch.updatedAt,
      };
    for (const key of [
      "executionOutcome",
      "userScriptSubmitted",
      "mayHaveMutated",
      "preflightCompleted",
    ]) {
      if (["string", "boolean"].includes(typeof job.details?.[key]))
        result[key] = job.details?.[key];
    }
    return result;
  }

  _matches(d: QueueSnapshot, request: QueueRequest, time: number) {
    const lease = d.lease;
    return !!(
      lease &&
      request.sequence?.id === lease.id &&
      request.clientId === lease.clientId &&
      (request.ownerToken ?? null) === lease.ownerToken &&
      lease.epoch === d.epoch &&
      (d.active ||
        ((d.paused ? (d.pauseStartedAt ?? time) : time) < lease.idleUntil &&
          (d.paused ? (d.pauseStartedAt ?? time) : time) < lease.holdUntil))
    );
  }

  _sequenceHead(d: QueueSnapshot, id: string) {
    let head: QueueJob | undefined;
    for (const job of Object.values(d.jobs)) {
      if (job.sequenceId === id && (!head || job.order > head.order))
        head = job;
    }
    return head;
  }

  _automaticMatches(
    d: QueueSnapshot,
    job: Pick<
      QueueJob,
      "sequenceId" | "clientId" | "request" | "sequenceParentId"
    >,
    time: number,
  ) {
    const parent = job.sequenceParentId
      ? d.jobs[job.sequenceParentId]
      : undefined;
    return !!(
      parent &&
      parent.sequenceMode === "automatic" &&
      parent.sequenceState === "yielded" &&
      parent.state === "succeeded" &&
      parent.sequenceId === job.sequenceId &&
      parent.clientId === job.clientId &&
      (parent.request.ownerToken ?? null) ===
        (job.request.ownerToken ?? null) &&
      (d.paused ? (d.pauseStartedAt ?? time) : time) <
        parent.finishedAt! + (parent.sequencePauseMs || 0) + this.leaseMs
    );
  }

  _expire(d: QueueSnapshot, time: number) {
    if (d.paused) return;
    if (
      d.lease &&
      !d.active &&
      !d.blocked &&
      (time >= d.lease.idleUntil || time >= d.lease.holdUntil)
    )
      d.lease = null;
    for (const job of Object.values(d.jobs)) {
      if (job.state !== "queued") continue;
      const r = job.request;
      const code = job.contextEnded
        ? "SEQUENCE_EXPIRED"
        : job.queueDeadline !== null && time >= job.queueDeadline
          ? "QUEUE_EXPIRED"
          : !job.physicalTurns &&
              r.expectedRevision !== undefined &&
              r.expectedRevision !== d.revision
            ? "STALE_REVISION"
            : !(
                  r.phased &&
                  job.physicalTurns &&
                  job.sequenceMode === "automatic"
                ) &&
                r.sequence &&
                r.sequence.action !== "begin" &&
                !(job.sequenceMode === "automatic"
                  ? this._automaticMatches(d, job, time)
                  : this._matches(d, r, time))
              ? "SEQUENCE_EXPIRED"
              : null;
      if (code)
        Object.assign(job, {
          state: code === "QUEUE_EXPIRED" ? "expired" : "failed",
          code,
          finishedAt: time,
          revision: d.revision,
          sequenceState: job.sequenceId ? "ended" : null,
          details: {
            executionOutcome: job.physicalTurns
              ? "previous_turns_complete_current_not_started"
              : "not_started",
            userScriptSubmitted: !!job.dispatch?.rpcCount,
            mayHaveMutated: !!job.dispatch?.rpcCount,
          },
        });
    }
  }

  submit(request: unknown, preparedId?: string) {
    if (
      preparedId !== undefined &&
      (!identifier(preparedId) || this.data.jobs[preparedId])
    )
      fail(
        "INVALID_PREPARED_ID",
        "Prepared job identity must be new and nonempty",
      );
    const text = canonical(request);
    const r = JSON.parse(text) as QueueRequest;
    if (
      !r ||
      !identifier(r.requestId) ||
      !identifier(r.clientId) ||
      !["command", "rpc"].includes(r.kind)
    ) {
      fail(
        "INVALID_REQUEST",
        "requestId, clientId and kind (command or rpc) are required",
      );
    }
    if (r.description !== undefined)
      r.description = normalizeDescription(r.description);
    if (
      !integer(r.timeoutMs) ||
      r.timeoutMs === 0 ||
      (r.queueTimeoutMs !== undefined && !integer(r.queueTimeoutMs)) ||
      (r.expectedRevision !== undefined && !integer(r.expectedRevision)) ||
      (r.ownerToken !== undefined && !identifier(r.ownerToken))
    )
      fail("INVALID_REQUEST", "Invalid timeout, revision or owner token");
    if (
      r.kind === "command" &&
      (!Array.isArray(r.argv) ||
        !r.argv.length ||
        r.argv.some((arg) => typeof arg !== "string") ||
        typeof r.cwd !== "string" ||
        !r.cwd.trim())
    )
      fail("INVALID_REQUEST", "Commands require argv and cwd");
    if (
      r.kind === "rpc" &&
      (!r.payload || typeof r.payload !== "object" || Array.isArray(r.payload))
    ) {
      fail("INVALID_REQUEST", "RPC jobs require a JSON object payload");
    }
    if (r.phased !== undefined && (r.phased !== true || r.kind !== "command"))
      fail("INVALID_REQUEST", "Only command jobs support phased execution");
    const seq = r.sequence;
    if (
      seq !== undefined &&
      (!seq ||
        !["begin", "continue", "end"].includes(seq.action) ||
        (seq.action === "begin" ? seq.id !== undefined : !identifier(seq.id)) ||
        (seq.mode !== undefined &&
          !["automatic", "exclusive"].includes(seq.mode)))
    )
      fail(
        "INVALID_SEQUENCE",
        "Begin without id, or continue/end with an id; mode is automatic or exclusive",
      );
    const identity = { ...r };
    delete identity.description;
    const hash = this.hash(canonical(identity));
    const existing = Object.values(this.data.jobs).find(
      (job) => job.requestId === r.requestId,
    );
    if (existing) {
      if (existing.hash !== hash)
        fail(
          "REQUEST_CONFLICT",
          "requestId already exists with different immutable input",
        );
      return this.status(existing.id);
    }
    // Expiry is its own transaction so rejected submissions cannot undo maintenance.
    this._commit((d) => {
      this._expire(d, this._time());
      return null;
    });
    return this._commit((d) => {
      const time = this._time();
      if (r.expectedRevision !== undefined && r.expectedRevision !== d.revision)
        fail(
          "STALE_REVISION",
          "Read status and submit a new requestId with the current revision",
        );
      let sequenceMode: SequenceMode = seq?.mode || "automatic",
        sequenceParent: QueueJob | undefined;
      if (seq && seq.action !== "begin") {
        if (
          Object.values(d.jobs).some(
            (j) => !terminal(j.state) && j.sequenceId === seq.id,
          )
        ) {
          fail(
            "SEQUENCE_BUSY",
            "Wait for the outstanding sequence job before submitting its continuation",
          );
        }
        sequenceParent = this._sequenceHead(d, seq.id!);
        sequenceMode = sequenceParent?.sequenceMode || "exclusive";
        if (seq.mode && seq.mode !== sequenceMode)
          fail("SEQUENCE_MISMATCH", "Cannot change sequence mode");
        const automatic = sequenceMode === "automatic";
        if (
          !(automatic
            ? this._automaticMatches(
                d,
                {
                  sequenceParentId: sequenceParent?.id,
                  sequenceId: seq.id!,
                  clientId: r.clientId,
                  request: r,
                },
                time,
              )
            : this._matches(d, r, time))
        ) {
          fail(
            "SEQUENCE_MISMATCH",
            "Sequence expired, ended or belongs to another client/owner",
          );
        }
      } else if (seq && d.lease && d.lease.clientId === r.clientId)
        fail(
          "SEQUENCE_MISMATCH",
          "Release or finish the held sequence before beginning another",
        );
      const queued = Object.values(d.jobs).filter((job) =>
        ["preparing", "processing", "queued"].includes(job.state),
      );
      if (queued.length >= this.maxQueued)
        fail("QUEUE_FULL", "Global queue limit reached");
      if (
        queued.filter((job) => job.clientId === r.clientId).length >=
        this.maxPerClient
      )
        fail("CLIENT_QUEUE_FULL", "Client queue limit reached");
      const job: QueueJob = {
        id: preparedId ?? this.newId(),
        requestId: r.requestId,
        clientId: r.clientId,
        kind: r.kind,
        request: r,
        hash,
        order: Math.max(0, ...Object.values(d.jobs).map((j) => j.order)) + 1,
        state: r.phased ? "preparing" : "queued",
        submittedAt: time,
        queueDeadline:
          r.phased || r.queueTimeoutMs === undefined
            ? null
            : time + r.queueTimeoutMs,
        timeoutMs: r.timeoutMs,
        sequenceId: seq && seq.action !== "begin" ? seq.id! : null,
        sequenceState: seq ? "queued" : null,
      };
      if (r.description) job.description = r.description;
      if (seq) job.sequenceMode = sequenceMode;
      if (sequenceParent && sequenceMode === "automatic") {
        job.sequenceParentId = sequenceParent.id;
      }
      d.jobs[job.id] = job;
      return this._public(job);
    });
  }

  /** Broker-only marker that lets the existing scheduler select one scoped observer past a block. */
  armWorkflowObservation(id: string, marker: AtomicWorkflowObservation) {
    if (!validWorkflowObservation(marker))
      fail("INVALID_WORKFLOW_SCOPE", "Invalid broker-authored atomic observation marker");
    return this._commit((d) => {
      const observer = this._job(d, id);
      const target = d.jobs[marker.targetJobId];
      if (observer.workflowObservation) {
        if (canonical(observer.workflowObservation) !== canonical(marker))
          fail("REQUEST_CONFLICT", "Observation request is already bound to another workflow");
        return this._public(observer);
      }
      const invocation = cadInvocation(observer.request);
      if (!target || d.blocked?.id !== target.id || d.active !== target.id || target.state !== "needs_reconciliation" ||
          target.clientId !== marker.targetClientId || target.clientId !== observer.clientId ||
          target.requestId !== marker.targetRequestId || target.hash !== marker.targetJobHash ||
          marker.observerJobHash !== observer.hash || target.request.buildHash !== marker.targetBuildHash ||
          observer.state !== "queued" || observer.kind !== "command" || observer.request.phased === true ||
          observer.request.sequence !== undefined || observer.request.buildHash !== marker.observerBuildHash ||
          !invocation || invocation["operation"] !== "batch.reconcile" || !plain(invocation["data"]) ||
          invocation["data"]["reportPath"] !== marker.reportPath ||
          invocation["data"]["blockedJobId"] !== target.id ||
          invocation["data"]["commandId"] !== marker.commandId ||
          invocation["data"]["sessionNonce"] !== marker.sessionNonce ||
          invocation["docId"] !== marker.docId || observer.request.cwd !== marker.projectDirectory ||
          target.request.cwd !== marker.projectDirectory || marker.paused !== d.paused ||
          marker.controlGeneration !== (d.controlGeneration || 0) || marker.contextEpoch !== (d.contextEpoch || 0)) {
        fail("WORKFLOW_OWNER_OR_JOB_MISMATCH", "Observer does not bind to the exact blocked atomic owner job");
      }
      const prior = Object.values(d.jobs).find(job => job.id !== id && job.workflowObservation?.targetJobId === target.id);
      if (prior && !(prior.state === "failed" && prior.details?.["executionOutcome"] === "not_started" &&
          prior.details?.["mayHaveMutated"] === false && (prior.dispatch?.rpcCount || 0) === 0))
        fail("WORKFLOW_OBSERVATION_EXISTS", "A scoped observation was already sent or has an uncertain receipt");
      observer.workflowObservation = marker;
      return this._public(observer);
    });
  }

  next() {
    if (this._fault)
      fail(
        "STORAGE_UNAVAILABLE",
        "A durable write failed; reopen and reconcile this queue before continuing",
      );
    if (this._writing)
      fail("WRITE_IN_PROGRESS", "QueueState writes cannot be reentered");
    const d = this.data,
      time = this._time();
    if (d.controlBlocked || d.localUnknown) return null;
    if (d.blocked) {
      const observers = Object.values(d.jobs).filter(
        (job) => job.state === "queued" && workflowObservationFor(d, job.id)?.targetJobId === d.blocked?.id,
      );
      if (observers.length > 1)
        fail("WORKFLOW_OBSERVATION_AMBIGUOUS", "More than one scoped observer is queued for the blocked atomic job");
      if (observers.length === 1) {
        return this._commit((draft) => {
          if (draft.controlBlocked || draft.localUnknown || !draft.blocked || draft.active !== draft.blocked.id)
            return null;
          const candidates = Object.values(draft.jobs).filter(
            (job) => job.state === "queued" && workflowObservationFor(draft, job.id)?.targetJobId === draft.blocked?.id,
          );
          if (candidates.length !== 1 || candidates[0]!.id !== observers[0]!.id)
            fail("WORKFLOW_OBSERVATION_AMBIGUOUS", "Scoped observer selection changed before its durable grant");
          const job = candidates[0]!;
          const now = this._time();
          if (draft.lease && draft.lease.clientId !== job.clientId) return null;
          Object.assign(job, {
            state: "running",
            startedAt: job.startedAt ?? now,
            runDeadline: now + (job.sdkRemainingMs ?? job.timeoutMs),
            revision: draft.revision,
          });
          draft.active = job.id;
          draft.lastClient = job.clientId;
          return job;
        });
      }
      if (d.paused) return null;
      const deadlineDue = this._waiting.some(
        (job) => job.queueDeadline !== null && time >= job.queueDeadline,
      );
      if (!deadlineDue) return null;
      return this._commit((draft) => {
        const now = this._time();
        this._expire(draft, now);
        if (draft.paused || draft.controlBlocked || draft.localUnknown || !draft.blocked || draft.active !== draft.blocked.id)
          return null;
        return null;
      });
    }
    const leaseDue =
      d.lease &&
      !d.active &&
      !d.blocked &&
      (time >= d.lease.idleUntil || time >= d.lease.holdUntil);
    const canGrant = !d.blocked && !d.paused && !d.active;
    const workDue = this._waiting.some((job) => {
      const r = job.request;
      return (
        (job.queueDeadline !== null && time >= job.queueDeadline) ||
        (!job.physicalTurns &&
          r.expectedRevision !== undefined &&
          r.expectedRevision !== d.revision) ||
        (!(r.phased && job.physicalTurns && job.sequenceMode === "automatic") &&
          r.sequence &&
          r.sequence.action !== "begin" &&
          !(job.sequenceMode === "automatic"
            ? this._automaticMatches(d, job, time)
            : this._matches(d, r, time))) ||
        (canGrant &&
          (!d.lease ||
            (r.sequence &&
              r.sequence.action !== "begin" &&
              this._matches(d, r, time)) ||
            (r.phased &&
              job.physicalTurns &&
              d.lease?.id === job.sequenceId &&
              d.lease.clientId === job.clientId)))
      );
    });
    if (!leaseDue && !workDue) return null;
    return this._commit((d) => {
      const time = this._time();
      this._expire(d, time);
      if (d.blocked || d.paused || d.active) return null;
      const eligible = Object.values(d.jobs).filter(
        (j) =>
          j.state === "queued" &&
          (!d.lease ||
            (j.request.sequence &&
              j.request.sequence.action !== "begin" &&
              this._matches(d, j.request, time)) ||
            (j.request.phased &&
              j.physicalTurns &&
              d.lease?.id === j.sequenceId &&
              d.lease.clientId === j.clientId)),
      );
      const clients = [...new Set(eligible.map((j) => j.clientId))].sort();
      if (!clients.length) return null;
      const client =
        clients.find((id) => d.lastClient === null || id > d.lastClient) ||
        clients[0]!;
      const job = eligible
        .filter((j) => j.clientId === client)
        .sort((a, b) => a.order - b.order)[0]!;
      const r = job.request;
      if (r.sequence && r.sequence.action === "begin" && !job.sequenceId) {
        job.sequenceId = this.newId();
        if (job.sequenceMode !== "automatic") {
          d.lease = {
            id: job.sequenceId,
            clientId: client,
            ownerToken: r.ownerToken ?? null,
            epoch: ++d.epoch,
            createdAt: time,
            idleUntil: time + Math.min(this.idleMs, this.leaseMs),
            holdUntil: time + this.leaseMs,
          };
        }
      }
      Object.assign(job, {
        state: "running",
        startedAt: job.startedAt ?? time,
        runDeadline: time + (job.sdkRemainingMs ?? job.timeoutMs),
        sequenceState: job.sequenceId ? "active" : null,
        revision: d.revision,
      });
      d.active = job.id;
      d.lastClient = client;
      return job; // Detached INTERNAL job, including request, only after durable commit.
    });
  }

  readyTurn(id: string) {
    return this._commit((d) => {
      const job = this._job(d, id);
      if (
        !job.request.phased ||
        !["preparing", "processing"].includes(job.state)
      )
        fail("INVALID_STATE", "Worker is not preparing an SDK turn");
      if (job.contextEnded)
        fail(
          "SEQUENCE_EXPIRED",
          "The owner ended this command context before another SDK turn",
        );
      if (job.sdkRemainingMs === 0)
        fail(
          "RUN_TIMEOUT",
          "The command has exhausted its SDK execution budget",
        );
      const time = this._time();
      Object.assign(job, {
        state: "queued",
        order: Math.max(0, ...Object.values(d.jobs).map((j) => j.order)) + 1,
        sdkReadyAt: time,
        queueDeadline:
          job.request.queueTimeoutMs === undefined
            ? null
            : time + job.request.queueTimeoutMs,
      });
      return this._public(job);
    });
  }

  releaseTurn(id: string, sdkRemainingMs: number) {
    if (!integer(sdkRemainingMs))
      fail("INVALID_TIMEOUT", "SDK remaining budget must be nonnegative");
    return this._commit((d) => {
      const job = this._active(d, id);
      if (!job.request.phased) fail("INVALID_STATE", "Not a phased command");
      Object.assign(job, {
        state: "processing",
        sdkRemainingMs,
        physicalTurns: (job.physicalTurns || 0) + 1,
        revision: ++d.revision,
        sequenceState: job.sequenceId ? (d.lease ? "held" : "yielded") : null,
      });
      d.active = null;
      if (d.lease)
        d.lease.idleUntil = Math.min(
          this._time() + this.idleMs,
          d.lease.holdUntil,
        );
      this._promoteLocalUnknown(d);
      return this._public(job);
    });
  }

  finishLocal(
    id: string,
    { state = "succeeded", ...details }: QueueDetails = {},
  ) {
    if (!["succeeded", "failed"].includes(state))
      fail("INVALID_STATE", "Finish local work with a proven terminal result");
    return this._commit((d) => {
      const job = this._job(d, id);
      if (
        !job.request.phased ||
        !["preparing", "processing", "queued"].includes(job.state) ||
        d.active === id
      )
        fail("NOT_LOCAL", "SDK work is not settled");
      Object.assign(job, {
        state,
        details: copy(details),
        finishedAt: this._time(),
        revision: d.revision,
      });
      if (details.code) job.code = details.code;
      if (
        d.lease?.id === job.sequenceId &&
        (state === "failed" || job.request.sequence?.action === "end")
      )
        d.lease = null;
      job.sequenceState = job.sequenceId
        ? state === "succeeded" &&
          !job.contextEnded &&
          job.request.sequence?.action !== "end"
          ? d.lease?.id === job.sequenceId
            ? "held"
            : "yielded"
          : "ended"
        : null;
      return this._public(job);
    });
  }

  finish(id: string, { state = "succeeded", ...details }: QueueDetails = {}) {
    if (!["succeeded", "failed", "needs_reconciliation"].includes(state))
      fail(
        "INVALID_STATE",
        "Finish with succeeded, failed or needs_reconciliation",
      );
    const record = JSON.parse(canonical(details)) as QueueDetails;
    return this._commit((d) => {
      const job = this._active(d, id);
      const time = this._time();
      Object.assign(job, { state, details: record, revision: ++d.revision });
      if (typeof record.code === "string") job.code = record.code;
      const observation = workflowObservationFor(d, id);
      if (observation && d.blocked?.id === observation.targetJobId) {
        if (state === "needs_reconciliation") {
          d.blocked = {
            ...d.blocked,
            reason: record.reason || "Scoped atomic status observation outcome is unknown",
            at: time,
          };
          job.sequenceState = null;
          return this._public(job);
        }
        job.finishedAt = time;
        job.sequenceState = null;
        d.active = observation.targetJobId;
        return this._public(job);
      }
      if (state === "needs_reconciliation") {
        d.blocked = {
          id,
          reason: record.reason || "Worker outcome is unknown",
          at: time,
        };
        job.sequenceState = job.sequenceId ? "needs_reconciliation" : null;
      } else {
        d.active = null;
        job.finishedAt = time;
        if (
          state === "failed" ||
          !job.request.sequence ||
          job.request.sequence.action === "end"
        )
          d.lease = null;
        if (d.lease) {
          if (d.paused) {
            d.lease.holdUntil += Math.max(
              0,
              time -
                Math.max(
                  d.pauseStartedAt ?? time,
                  d.lease.pauseBase || d.lease.createdAt,
                ),
            );
            d.lease.pauseBase = time;
          }
          d.lease.idleUntil = Math.min(time + this.idleMs, d.lease.holdUntil);
          if (time >= d.lease.holdUntil && !d.paused) d.lease = null;
        }
        job.sequenceState = job.sequenceId
          ? job.sequenceMode === "automatic" &&
            state === "succeeded" &&
            job.request.sequence?.action !== "end"
            ? "yielded"
            : d.lease
              ? "held"
              : "ended"
          : null;
        this._promoteLocalUnknown(d);
      }
      return this._public(job);
    });
  }

  markDispatch(id: string, details: QueueDetails = {}) {
    const record = JSON.parse(canonical(details)) as QueueDetails;
    if (!record || Array.isArray(record) || typeof record !== "object")
      fail("INVALID_DISPATCH", "Dispatch details must be an object");
    return this._commit((d) => {
      const job = this._active(d, id);
      const old = job.dispatch || {
        dispatchCount: 0,
        rpcCount: 0,
        completedCount: 0,
      };
      const rpcCount = record.rpcCount ?? old.rpcCount + 1;
      const completedCount = record.completedCount ?? old.completedCount;
      if (
        !integer(rpcCount) ||
        rpcCount < old.rpcCount ||
        !integer(completedCount) ||
        completedCount < old.completedCount ||
        completedCount > rpcCount
      )
        fail(
          "INVALID_DISPATCH",
          "RPC counters must be monotonic and completedCount <= rpcCount",
        );
      job.dispatch = {
        rpcState: record.rpcState ?? record.state ?? "sending",
        dispatchCount: old.dispatchCount + 1,
        rpcCount,
        completedCount,
        updatedAt: this._time(),
        details: record,
      };
      job.state = "sending";
      return this._public(job);
    });
  }

  advanceInstanceEpoch(transitionId: string) {
    if (!identifier(transitionId))
      fail("INVALID_TRANSITION", "A stable instance transition id is required");
    return this._commit((d) => {
      if (d.paused)
        fail(
          "MANUAL_PAUSE",
          "Automatic instance recovery does not clear a manual pause",
        );
      if (
        d.active ||
        d.blocked ||
        d.lease ||
        Object.values(d.jobs).some((job) => !terminal(job.state))
      ) {
        fail(
          "QUEUE_NOT_QUIESCENT",
          "Automatic instance recovery requires terminal jobs and no active job, block or lease",
        );
      }
      if (d.lastInstanceTransitionId === transitionId)
        return { alreadyApplied: true, revision: d.revision, epoch: d.epoch };
      const previous = { revision: d.revision, epoch: d.epoch };
      d.revision++;
      d.epoch++;
      d.lastInstanceTransitionId = transitionId;
      return {
        alreadyApplied: false,
        previous,
        revision: d.revision,
        epoch: d.epoch,
      };
    });
  }

  block(id: string, reason: unknown) {
    return this.finish(id, {
      state: "needs_reconciliation",
      reason: JSON.parse(canonical(reason)),
    });
  }

  resolve(id: string, details: unknown) {
    const record = JSON.parse(canonical(details)) as QueueDetails;
    if (!record || (record.state !== "succeeded" && record.state !== "failed"))
      fail(
        "INVALID_STATE",
        "Recovery must explicitly provide state succeeded or failed",
      );
    return this._commit((d) => {
      const job = this._active(d, id, true);
      if (
        !d.blocked ||
        d.blocked.id !== id ||
        job.state !== "needs_reconciliation"
      )
        fail("NOT_BLOCKED", "Only the blocked active job can be resolved");
      Object.assign(job, {
        state: record.state,
        details: record,
        finishedAt: this._time(),
        revision: ++d.revision,
        sequenceState: job.sequenceId ? "ended" : null,
      });
      if (typeof record.code === "string") job.code = record.code;
      d.blocked = d.active = d.lease = null;
      this._promoteLocalUnknown(d);
      return this._public(job);
    });
  }

  cancel(id: string, clientId: string) {
    return this._commit((d) => {
      const job = this._job(d, id);
      if (job.clientId !== clientId)
        fail("NOT_OWNER", "Only the submitting client can cancel this job");
      if (job.state !== "queued")
        fail("NOT_QUEUED", "Only queued jobs can be cancelled");
      if (job.physicalTurns || job.dispatch?.rpcCount)
        fail(
          "ALREADY_STARTED",
          "Cannot cancel a command after its first SDK turn",
        );
      Object.assign(job, {
        state: "cancelled",
        finishedAt: this._time(),
        revision: d.revision,
        code: "CANCELLED",
        details: {
          executionOutcome: "not_started",
          userScriptSubmitted: false,
          mayHaveMutated: false,
        },
        sequenceState: job.sequenceId ? "ended" : null,
      });
      return this._public(job);
    });
  }

  release(sequenceId: string, clientId: string) {
    this._commit((d) => {
      this._expire(d, this._time());
      return null;
    });
    return this._commit((d) => {
      if (d.active || d.blocked)
        fail(
          "QUEUE_BUSY",
          "Cannot release while a job is active or requires reconciliation",
        );
      if (!d.lease || d.lease.id !== sequenceId) {
        const head = this._sequenceHead(d, sequenceId);
        if (
          head?.sequenceMode === "automatic" &&
          head.sequenceState === "yielded"
        ) {
          if (head.clientId !== clientId)
            fail("NOT_OWNER", "Only the sequence owner can release it");
          head.sequenceState = "ended";
          for (const job of Object.values(d.jobs))
            if (job.sequenceId === sequenceId && !terminal(job.state))
              job.contextEnded = true;
          this._expire(d, this._time());
          return {
            sequenceId,
            sequenceState: "released",
            revision: d.revision,
          };
        }
      }
      if (!d.lease || d.lease.id !== sequenceId)
        fail("SEQUENCE_MISMATCH", "Sequence is no longer held");
      if (d.lease.clientId !== clientId)
        fail("NOT_OWNER", "Only the sequence owner can release it");
      d.lease = null;
      for (const job of Object.values(d.jobs))
        if (job.sequenceId === sequenceId && !terminal(job.state)) {
          job.contextEnded = true;
          job.sequenceState = "ended";
        }
      this._expire(d, this._time());
      return { sequenceId, sequenceState: "released", revision: d.revision };
    });
  }

  summary() {
    if (this._fault)
      fail(
        "STORAGE_UNAVAILABLE",
        "Reopen and reconcile after the failed durable write",
      );
    const d = this.data;
    const lease = d.lease && {
      id: d.lease.id,
      clientId: d.lease.clientId,
      epoch: d.lease.epoch,
      createdAt: d.lease.createdAt,
      idleUntil: d.lease.idleUntil,
      holdUntil: d.lease.holdUntil,
    };
    return copy({
      version: d.version,
      paused: d.paused,
      revision: d.revision,
      epoch: d.epoch,
      active: d.active,
      blocked: d.blocked && {
        id: d.blocked.id,
        code: "NEEDS_RECONCILIATION",
        at: d.blocked.at,
      },
      lease,
      lastClient: d.lastClient,
    });
  }

  status(id?: string) {
    if (this._fault)
      fail(
        "STORAGE_UNAVAILABLE",
        "Reopen and reconcile after the failed durable write",
      );
    if (id !== undefined) return copy(this._public(this._job(this.data, id)));
    return {
      ...this.summary(),
      jobs: Object.fromEntries(
        Object.values(this.data.jobs).map((j) => [j.id, copy(this._public(j))]),
      ),
    };
  }

  pause(paused: boolean, requestId?: string) {
    if (typeof paused !== "boolean")
      fail("INVALID_PAUSE", "pause expects a boolean");
    this._commit((d) => {
      const time = this._time();
      if (paused !== d.paused) {
        if (paused) d.pauseStartedAt = time;
        else {
          const start = d.pauseStartedAt ?? time;
          for (const job of Object.values(d.jobs)) {
            if (["queued", "preparing", "processing"].includes(job.state)) {
              job.contextRefreshRequired = true;
              if (job.state === "queued" && job.queueDeadline !== null)
                job.queueDeadline += Math.max(
                  0,
                  time - Math.max(start, job.sdkReadyAt ?? job.submittedAt),
                );
            }
            if (job.sequenceState === "yielded" && integer(job.finishedAt))
              job.sequencePauseMs =
                (job.sequencePauseMs || 0) +
                Math.max(0, time - Math.max(start, job.finishedAt));
          }
          if (d.lease) {
            const elapsed = Math.max(
              0,
              time - Math.max(start, d.lease.pauseBase || d.lease.createdAt),
            );
            d.lease.idleUntil += elapsed;
            d.lease.holdUntil += elapsed;
            delete d.lease.pauseBase;
          }
          d.contextEpoch = (d.contextEpoch || 0) + 1;
          delete d.pauseStartedAt;
        }
        d.paused = paused;
        d.controlGeneration = (d.controlGeneration || 0) + 1;
      }
      if (requestId) {
        d.controlRequests ||= {};
        Object.defineProperty(d.controlRequests, requestId, {
          value: { paused, generation: d.controlGeneration || 0 },
          enumerable: true,
          configurable: true,
          writable: true,
        });
        const keys = Object.keys(d.controlRequests);
        for (const key of keys.slice(0, Math.max(0, keys.length - 128)))
          delete d.controlRequests[key];
      }
      return null;
    });
    return this.status();
  }
}

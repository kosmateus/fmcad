import * as fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { availableParallelism } from "node:os";
import { nextLocalWorker } from "@fmcad/core";
import type {
  QueueJob,
  QueueDetails,
  WorkerRequest,
  WorkerResult,
  WorkerBackendMethod,
} from "@fmcad/core";

type Job = QueueJob & { request: WorkerRequest };
interface WorkerMessage {
  jobId: string;
  workerToken: string;
  method: WorkerBackendMethod;
  args: unknown[];
}
interface Pending {
  message: WorkerMessage;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
interface WorkerRecord {
  job: Job;
  token: string;
  pending: Pending | null;
  localRemaining: number;
  localStarted: number;
  timer: NodeJS.Timeout | null;
  checkAbort?: AbortController | undefined;
  child?: ChildProcess;
  closed: Promise<void>;
  resolveClosed(): void;
  localFailure?: string | undefined;
  pythonCheck?: unknown;
  preparationRejected?: boolean;
  sdkFailed?: boolean;
}
interface PhasedState {
  readyTurn(id: string): unknown;
  status(id: string): QueueJob;
  finishLocal(id: string, details: QueueDetails): unknown;
}
export interface PhasedWorkerOptions {
  /** Independent of Fusion scenario owners and the single SDK queue. */
  preparationConcurrency?: number | undefined;
  state: PhasedState;
  /** Measured local boundaries only; failures cannot affect worker ownership. */
  onLocalPhase?(job: QueueJob, phase: "prepare" | "finalize" | null): void;
  dir: string;
  cfg: {
    backend?: string;
    tool?: unknown;
    transport?: unknown;
    protocolVersion?: unknown;
  };
  codeHash: string;
  properties(): unknown;
  /** Local analysis must finish before the request becomes SDK-ready. */
  checkSdkRequest?(message: WorkerMessage, signal: AbortSignal): Promise<void>;
  prepareRequest(job: Job): WorkerRequest;
  onUnknown(job: Job, reason: string): void;
  onFault(error: unknown): void;
  spawnWorker?: typeof spawn | undefined;
  entrypoint: string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  readResult(file: string): WorkerResult | null;
  processBirth(pid: number): string;
  workflowNonterminal(value: unknown): boolean;
  responsePath(dir: string, job: Job, name: string, create: boolean): string;
}

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
function errorCode(error: unknown): string | undefined {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Four CPU slots per complete helper checker; existing worker ceiling remains
 * the default upper bound. Explicit configuration keeps parallel preparation
 * available independently of the number of connected Fusion owners. */
export function resolvePreparationConcurrency(
  value?: unknown,
  cpuCount = availableParallelism(),
): number {
  if (!Number.isSafeInteger(cpuCount) || cpuCount < 1)
    throw failure(
      "INVALID_PREPARATION_CONCURRENCY",
      "Available CPU capacity must be a positive integer",
    );
  if (value === undefined)
    return Math.min(4, Math.max(1, Math.floor(cpuCount / 4)));
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 10
  )
    throw failure(
      "INVALID_PREPARATION_CONCURRENCY",
      "queue.preparationConcurrency must be 1..10",
    );
  return value;
}

/** Process adapter for parallel local phases. It never constructs a transport. */
export class PhasedWorkers {
  readonly workers = new Map<string, WorkerRecord>();
  readonly backlog = new Map<string, Job>();
  stopping = false;
  lastLocalClient: string | null = null;

  readonly preparationConcurrency: number;
  constructor(readonly ports: PhasedWorkerOptions) {
    this.preparationConcurrency = resolvePreparationConcurrency(
      ports.preparationConcurrency,
    );
  }

  start(job: Job): void {
    if (this.workers.has(job.id) || this.backlog.has(job.id)) return;
    this.backlog.set(job.id, job);
    this.pump();
  }
  pump(): void {
    while (
      !this.stopping &&
      this.workers.size < this.preparationConcurrency &&
      this.backlog.size
    ) {
      const job = nextLocalWorker(
        [...this.backlog.values()],
        this.lastLocalClient,
      );
      if (!job) return;
      this.backlog.delete(job.id);
      this.lastLocalClient = job.clientId;
      this.startWorker(job);
    }
  }
  startWorker(job: Job): void {
    const p = this.ports;
    const directory = path.join(p.dir, "jobs", job.id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    let request: WorkerRequest;
    try {
      request = p.prepareRequest(job);
    } catch (error) {
      const details = {
        state: "failed",
        code: errorCode(error) || "LOCAL_PREPARATION_FAILED",
        executionOutcome: "not_started",
        mayHaveMutated: false,
        sdkSettled: true,
        publicationOutcome: "unavailable",
      };
      fs.writeFileSync(
        p.responsePath(p.dir, job, "stderr.txt", true),
        `ERROR ${error instanceof Error ? error.message : String(error)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      p.durable(path.join(directory, "outcome.json"), details);
      p.state.finishLocal(job.id, details);
      queueMicrotask(() => this.pump());
      return;
    }
    const token = randomBytes(32).toString("hex");
    let resolveClosed = (): void => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const record: WorkerRecord = {
      job,
      token,
      pending: null,
      localRemaining: job.timeoutMs,
      localStarted: 0,
      timer: null,
      closed,
      resolveClosed,
    };
    this.workers.set(job.id, record);
    const config = {
      backend: p.cfg.backend || "mcp",
      tool: p.cfg.tool,
      transport: p.cfg.transport,
      timeoutMs: job.timeoutMs,
      protocolVersion: p.cfg.protocolVersion,
      url: "http://queue.invalid",
      headers: {},
    };
    p.durable(
      path.join(directory, "request.json"),
      {
        id: job.id,
        request,
        buildHash: p.codeHash,
        properties: p.properties(),
        deadline: Date.now() + job.timeoutMs,
      },
      true,
    );
    const out = fs.openSync(
      p.responsePath(p.dir, job, "stdout.txt", true),
      "wx",
      0o600,
    );
    const err = fs.openSync(
      p.responsePath(p.dir, job, "stderr.txt", true),
      "wx",
      0o600,
    );
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "LANG",
      "LC_ALL",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "FMCAD_CONFIG",
      "FMCAD_PYTHON",
      "WSL_DISTRO_NAME",
      "TMPDIR",
      "SYSTEMROOT",
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, {
      FMCAD_QUEUE_WORKER_JOB: job.id,
      FMCAD_QUEUE_WORKER_TOKEN: token,
      FMCAD_QUEUE_DIR: p.dir,
      FMCAD_QUEUE_WORKER_CONFIG: JSON.stringify(config),
      FMCAD_QUEUE: "worker",
    });
    const finish = (code: number): void => {
      try {
        fs.fsyncSync(out);
        fs.fsyncSync(err);
        this.finish(record, code, directory);
      } catch (error) {
        p.onFault(error);
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
        record.resolveClosed();
      }
    };
    try {
      p.durable(
        path.join(directory, "worker-start.json"),
        {
          jobId: job.id,
          buildHash: p.codeHash,
          at: Date.now(),
          phase: "offline_prepare",
        },
        true,
      );
      const child = (p.spawnWorker ?? spawn)(
        process.execPath,
        [p.entrypoint, path.join(directory, "request.json")],
        {
          cwd: job.request.cwd,
          shell: false,
          env,
          stdio: ["ignore", out, err],
        },
      );
      record.child = child;
      child.once("spawn", () => {
        try {
          if (child.pid === undefined)
            throw failure(
              "WORKER_IDENTITY_UNAVAILABLE",
              "Worker has no process identity",
            );
          p.durable(
            path.join(directory, "worker-identity.json"),
            { pid: child.pid, birth: p.processBirth(child.pid) },
            true,
          );
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes(errorCode(error) || "")) {
            record.localFailure = errorCode(error);
            child.kill("SIGKILL");
          }
        }
      });
      child.once("error", (error) => {
        record.localFailure = errorCode(error) || "WORKER_SPAWN_FAILED";
      });
      child.once("close", (code) => finish(code ?? 1));
      this.resumeLocal(record);
    } catch (error) {
      record.localFailure = errorCode(error) || "WORKER_SPAWN_FAILED";
      finish(1);
    }
  }
  reportLocalPhase(
    record: WorkerRecord,
    phase: "prepare" | "finalize" | "local" | null,
  ): void {
    try {
      const job = this.ports.state.status(record.job.id);
      this.ports.onLocalPhase?.(
        job,
        phase === "local"
          ? (job.physicalTurns ?? 0) > 0
            ? "finalize"
            : "prepare"
          : phase,
      );
    } catch {
      /* Passive telemetry. */
    }
  }
  pauseLocal(record: WorkerRecord): void {
    this.reportLocalPhase(record, null);
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    record.localRemaining = Math.max(
      0,
      record.localRemaining -
        Math.max(0, performance.now() - record.localStarted),
    );
  }
  resumeLocal(record: WorkerRecord): void {
    this.reportLocalPhase(record, "local");
    record.localStarted = performance.now();
    record.timer = setTimeout(
      () => {
        record.localFailure = "LOCAL_PHASE_TIMEOUT";
        record.checkAbort?.abort();
        // Only local phases arm this timer. Killing observation is not SDK cancel.
        record.child?.kill("SIGKILL");
      },
      Math.max(1, record.localRemaining),
    );
    record.timer.unref();
  }
  authorize(
    message: Pick<WorkerMessage, "jobId" | "workerToken">,
  ): WorkerRecord {
    const record = this.workers.get(message.jobId);
    if (
      !record ||
      typeof message.workerToken !== "string" ||
      Buffer.byteLength(message.workerToken) !==
        Buffer.byteLength(record.token) ||
      !timingSafeEqual(
        Buffer.from(message.workerToken),
        Buffer.from(record.token),
      )
    )
      throw failure("INVALID_CAPABILITY", "No preparing worker capability");
    return record;
  }
  enqueue(message: WorkerMessage): Promise<unknown> {
    const record = this.authorize(message);
    if (this.stopping)
      throw Object.assign(
        failure(
          "BROKER_STOPPING",
          "Local worker may not submit another SDK turn while draining",
        ),
        { notStarted: true },
      );
    if (record.pending)
      throw failure(
        "WORKER_BUSY",
        "Only one SDK turn per command may be outstanding",
      );
    if (
      !["callTool", "listTools", "executeUiGuardedScript"].includes(
        message.method,
      ) ||
      !Array.isArray(message.args)
    )
      throw failure(
        "INVALID_BACKEND_METHOD",
        "Unsupported worker backend method",
      );
    const phase = this.ports.state.status(message.jobId);
    if (!["preparing", "processing"].includes(phase.state))
      throw Object.assign(
        failure(
          phase.code || "INVALID_STATE",
          "Worker is not preparing a new SDK turn",
        ),
        { notStarted: true },
      );
    return new Promise((resolve, reject) => {
      const checkAbort = new AbortController();
      record.checkAbort = checkAbort;
      record.pending = { message, resolve, reject };
      const prepare = async (): Promise<void> => {
        await this.ports.checkSdkRequest?.(message, checkAbort.signal);
        if (
          checkAbort.signal.aborted ||
          record.pending?.message !== message ||
          !this.workers.has(message.jobId)
        )
          throw failure(
            record.localFailure || "WORKER_CLOSED",
            "Worker closed during local Python analysis",
          );
        this.pauseLocal(record);
        if (record.checkAbort === checkAbort) record.checkAbort = undefined;
        this.ports.state.readyTurn(message.jobId);
      };
      void prepare().catch((error: unknown) => {
        if (record.pending?.message !== message) return;
        if (record.checkAbort === checkAbort) record.checkAbort = undefined;
        record.pending = null;
        record.localFailure ??= errorCode(error);
        record.preparationRejected = true;
        if (error && typeof error === "object" && "pythonCheck" in error)
          record.pythonCheck = error.pythonCheck;
        if (this.workers.has(message.jobId)) {
          this.pauseLocal(record);
          this.resumeLocal(record);
        }
        reject(
          Object.assign(
            error instanceof Error ? error : new Error(String(error)),
            { notStarted: true },
          ),
        );
      });
    });
  }
  pending(jobId: string): Pending | null | undefined {
    return this.workers.get(jobId)?.pending;
  }
  token(jobId: string): string | undefined {
    return this.workers.get(jobId)?.token;
  }
  resolve(jobId: string, value: unknown, { sdkFailed = false } = {}): void {
    const record = this.workers.get(jobId),
      pending = record?.pending;
    if (!record || !pending) return;
    record.pending = null;
    record.sdkFailed ||= sdkFailed;
    this.resumeLocal(record);
    pending.resolve(value);
  }
  reject(jobId: string, error: unknown): void {
    const record = this.workers.get(jobId),
      pending = record?.pending;
    if (!record || !pending) return;
    record.checkAbort?.abort();
    record.checkAbort = undefined;
    record.pending = null;
    record.localFailure = errorCode(error);
    this.resumeLocal(record);
    pending.reject(error);
  }
  finish(record: WorkerRecord, code: number, directory: string): void {
    this.reportLocalPhase(record, null);
    const p = this.ports;
    if (record.timer) clearTimeout(record.timer);
    record.checkAbort?.abort();
    record.checkAbort = undefined;
    const job = p.state.status(record.job.id);
    if (["running", "sending"].includes(job.state)) {
      p.onUnknown(record.job, "Local worker exited during its SDK turn");
    } else if (["preparing", "processing", "queued"].includes(job.state)) {
      const file = path.join(directory, "worker-result.json");
      const result = fs.existsSync(file) ? p.readResult(file) : null;
      if (
        result?.nonterminal ||
        p.workflowNonterminal(result?.workflowOutcome)
      ) {
        p.onUnknown(
          record.job,
          "Typed local workflow result remains unknown/nonterminal",
        );
      } else {
        const details = {
          state:
            code === 0 &&
            !record.sdkFailed &&
            result?.terminal &&
            result.jobId === record.job.id
              ? "succeeded"
              : "failed",
          code:
            record.localFailure ||
            (record.sdkFailed
              ? "SDK_EXECUTION_FAILED"
              : code === 0
                ? "EXECUTION_COMPLETE"
                : "LOCAL_EXECUTION_FAILED"),
          exitCode: code,
          ...(record.pythonCheck ? { pythonCheck: record.pythonCheck } : {}),
          ...(record.preparationRejected
            ? {
                executionOutcome: job.dispatch?.rpcCount
                  ? "previous_turns_complete_current_not_started"
                  : "not_started",
                userScriptSubmitted: !!job.dispatch?.rpcCount,
              }
            : {}),
          sdkSettled: true,
          mayHaveMutated: !!job.dispatch?.rpcCount,
          publicationOutcome:
            code === 0 && result?.terminal ? "published" : "failed",
        };
        p.durable(path.join(directory, "outcome.json"), details);
        // Full diagnostics belong to the owner-only result artifact, not every
        // future queue snapshot rewrite or the public status projection.
        const { pythonCheck: _report, ...stateDetails } = details;
        void _report;
        p.state.finishLocal(record.job.id, stateDetails);
      }
    }
    const pending = record.pending;
    record.pending = null;
    pending?.reject(
      failure("WORKER_CLOSED", "Local worker closed; request is not replayed"),
    );
    this.workers.delete(record.job.id);
    queueMicrotask(() => this.pump());
  }
  async close(): Promise<void> {
    this.stopping = true;
    for (const [id] of this.backlog)
      this.ports.state.finishLocal(id, {
        state: "failed",
        code: "BROKER_STOPPING",
        executionOutcome: "not_started",
        mayHaveMutated: false,
      });
    this.backlog.clear();
    for (const [id] of this.workers) {
      if (this.ports.state.status(id).state === "queued")
        this.reject(
          id,
          failure("BROKER_STOPPING", "Broker draining before SDK dispatch"),
        );
    }
    await Promise.all(
      [...this.workers.values()].map((record) => record.closed),
    );
  }
}

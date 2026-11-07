import fs from "node:fs";
import path from "node:path";
import { currentProcessIdentity } from "./client-presence";
import type { ConsoleTelemetryAvailability } from "@fmcad/core";

type Data = Record<string, unknown>;

export interface PassiveTelemetryRead<T> {
  readonly status: ConsoleTelemetryAvailability;
  readonly value: T | null;
  readonly source: string;
  readonly observedAtMs: number | null;
  readonly readAtMs: number;
  readonly reason: string | null;
  readonly truncated: boolean;
}

export interface WorkerIdentityObservation {
  readonly jobId: string;
  readonly pid: number;
  readonly birth: string;
  readonly alive: boolean | null;
  readonly observedAtMs: number;
}

export interface ExistingFusionReceiptObservation {
  readonly jobId: string;
  readonly source: "preflight" | "postflight";
  readonly receipt: unknown;
  readonly observedAtMs: number;
  readonly readAtMs: number;
}

export interface PassiveCollectorOptions {
  readonly now?: () => number;
  readonly maxRecords?: number;
  readonly processAlive?: (identity: {
    readonly pid: number;
    readonly birth: string;
  }) => boolean | null;
}

const asRecord = (value: unknown): Data | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : null;

function result<T>(
  status: ConsoleTelemetryAvailability,
  value: T | null,
  source: string,
  readAtMs: number,
  observedAtMs: number | null,
  reason: string | null = null,
  truncated = false,
): PassiveTelemetryRead<T> {
  return { status, value, source, readAtMs, observedAtMs, reason, truncated };
}

function timestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Telemetry clock returned an invalid timestamp");
  return value;
}

function readJson(
  file: string,
  maxBytes = 32_768,
): { value: unknown; mtimeMs: number } {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes)
      throw Object.assign(new Error("Invalid or oversized telemetry receipt"), {
        code: "INVALID_TELEMETRY_RECEIPT",
      });
    return {
      value: JSON.parse(fs.readFileSync(fd, "utf8")),
      mtimeMs: Math.floor(stat.mtimeMs),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function existsOrThrow(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return false;
  throw error;
}

function checkedDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Object.assign(
        new Error("Telemetry directory is not a real directory"),
        {
          code: "UNSAFE_TELEMETRY_DIRECTORY",
        },
      );
    return true;
  } catch (error) {
    if (!existsOrThrow(error)) return false;
    throw error;
  }
}

function defaultProcessAlive(identity: {
  readonly pid: number;
  readonly birth: string;
}): boolean | null {
  const current = currentProcessIdentity(identity.pid);
  if (current) return current.birth === identity.birth;
  if (process.platform !== "linux") return null;
  try {
    fs.statSync(`/proc/${identity.pid}`);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? false : null;
  }
}

function boundedNames(
  directory: string,
  maxRecords: number,
  accept: (name: string, entry: fs.Dirent) => boolean,
): { names: string[]; truncated: boolean } {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => accept(entry.name, entry))
    .map((entry) => entry.name)
    .sort();
  return {
    names: names.slice(0, maxRecords),
    truncated: names.length > maxRecords,
  };
}

/** Reads the complete bounded project heartbeat directory, not the legacy recent-256 page. */
export function readProjectClientPresenceRecords(
  projectDirectory: string,
  options: PassiveCollectorOptions = {},
): PassiveTelemetryRead<readonly unknown[]> {
  const now = options.now ?? Date.now;
  const readAtMs = timestamp(now);
  const maxRecords = options.maxRecords ?? 4096;
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0)
    throw new Error("Presence record bound must be a positive integer");
  const root = path.resolve(projectDirectory);
  const directory = path.join(root, ".cad", "telemetry", "clients");
  try {
    if (!checkedDirectory(root))
      return result<readonly unknown[]>(
        "missing",
        null,
        "project-client-process-heartbeats",
        readAtMs,
        null,
        "PROJECT_DIRECTORY_NOT_AVAILABLE",
      );
    if (!checkedDirectory(path.join(root, ".cad")))
      return result(
        "missing",
        [],
        "project-client-process-heartbeats",
        readAtMs,
        null,
        "NO_PROJECT_CLIENT_HEARTBEATS",
      );
    if (!checkedDirectory(path.join(root, ".cad", "telemetry")))
      return result(
        "missing",
        [],
        "project-client-process-heartbeats",
        readAtMs,
        null,
        "NO_PROJECT_CLIENT_HEARTBEATS",
      );
    if (!checkedDirectory(directory))
      return result(
        "missing",
        [],
        "project-client-process-heartbeats",
        readAtMs,
        null,
        "NO_PROJECT_CLIENT_HEARTBEATS",
      );
    const { names, truncated } = boundedNames(
      directory,
      maxRecords,
      (name, entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        /^[a-f0-9]{64}\.json$/u.test(name),
    );
    if (truncated)
      return result<readonly unknown[]>(
        "unknown",
        null,
        "project-client-process-heartbeats",
        readAtMs,
        null,
        "PRESENCE_RECORD_BOUND_EXCEEDED",
        true,
      );
    const records: unknown[] = [];
    let observedAtMs: number | null = null;
    for (const name of names) {
      const read = readJson(path.join(directory, name), 16_384);
      const record = asRecord(read.value);
      if (!record || record["version"] !== 1 || record["project"] !== root)
        throw Object.assign(
          new Error("Invalid project client presence record"),
          { code: "INVALID_PRESENCE_RECORD" },
        );
      records.push(read.value);
      observedAtMs =
        observedAtMs === null
          ? read.mtimeMs
          : Math.max(observedAtMs, read.mtimeMs);
    }
    return result(
      "available",
      records,
      "project-client-process-heartbeats",
      readAtMs,
      observedAtMs,
    );
  } catch (error) {
    return result<readonly unknown[]>(
      "error",
      null,
      "project-client-process-heartbeats",
      readAtMs,
      null,
      (error as NodeJS.ErrnoException).code ?? "PRESENCE_READ_FAILED",
    );
  }
}

/** OpenCode presence remains optional and source-scoped; absent is not zero AI agents. */
export function readOpenCodePresenceRecords(
  directoryInput: string,
  projectDirectory: string | readonly string[],
  options: PassiveCollectorOptions = {},
): PassiveTelemetryRead<readonly unknown[]> {
  const now = options.now ?? Date.now;
  const readAtMs = timestamp(now);
  const maxRecords = options.maxRecords ?? 1024;
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0)
    throw new Error(
      "OpenCode presence record bound must be a positive integer",
    );
  const directory = path.resolve(directoryInput);
  const targetProjects = new Set(
    (typeof projectDirectory === "string"
      ? [projectDirectory]
      : projectDirectory
    ).map((project) => path.resolve(project)),
  );
  try {
    if (!checkedDirectory(directory))
      return result(
        "missing",
        [],
        "opencode-diagnostic-presence",
        readAtMs,
        null,
        "OPENCODE_PRESENCE_DIRECTORY_NOT_AVAILABLE",
      );
    const { names, truncated } = boundedNames(
      directory,
      maxRecords,
      (name, entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        /^\d+-[a-f0-9-]+\.json$/iu.test(name),
    );
    if (truncated)
      return result<readonly unknown[]>(
        "unknown",
        null,
        "opencode-diagnostic-presence",
        readAtMs,
        null,
        "OPENCODE_PRESENCE_BOUND_EXCEEDED",
        true,
      );
    const records: unknown[] = [];
    let observedAtMs: number | null = null;
    for (const name of names) {
      const read = readJson(path.join(directory, name), 256 * 1024);
      const record = asRecord(read.value);
      if (record?.["schemaVersion"] !== 1 || !Array.isArray(record["sessions"]))
        throw Object.assign(new Error("Invalid OpenCode presence record"), {
          code: "INVALID_OPENCODE_PRESENCE",
        });
      const sessions = record["sessions"].filter((session) => {
        const row = asRecord(session);
        return (
          !!row &&
          typeof row["project"] === "string" &&
          targetProjects.has(path.resolve(row["project"]))
        );
      });
      if (sessions.length) records.push({ ...record, sessions });
      observedAtMs =
        observedAtMs === null
          ? read.mtimeMs
          : Math.max(observedAtMs, read.mtimeMs);
    }
    return result(
      "available",
      records,
      "opencode-diagnostic-presence",
      readAtMs,
      observedAtMs,
    );
  } catch (error) {
    return result<readonly unknown[]>(
      "error",
      null,
      "opencode-diagnostic-presence",
      readAtMs,
      null,
      (error as NodeJS.ErrnoException).code ?? "OPENCODE_PRESENCE_READ_FAILED",
    );
  }
}

/** Reads an existing worker-identity receipt and passively verifies PID birth identity. */
export function readWorkerIdentity(
  queueDirectory: string,
  jobId: string,
  options: PassiveCollectorOptions = {},
): PassiveTelemetryRead<WorkerIdentityObservation> {
  const now = options.now ?? Date.now;
  const readAtMs = timestamp(now);
  const source = "existing-worker-identity-receipt";
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(jobId))
    return result<WorkerIdentityObservation>(
      "error",
      null,
      source,
      readAtMs,
      null,
      "INVALID_JOB_ID",
    );
  const file = path.join(
    path.resolve(queueDirectory),
    "jobs",
    jobId,
    "worker-identity.json",
  );
  try {
    const read = readJson(file, 16_384);
    const record = asRecord(read.value);
    const pid = record?.["pid"];
    const birth = record?.["birth"];
    if (
      !Number.isSafeInteger(pid) ||
      (pid as number) <= 0 ||
      typeof birth !== "string" ||
      !birth
    )
      return result<WorkerIdentityObservation>(
        "error",
        null,
        source,
        readAtMs,
        read.mtimeMs,
        "INVALID_WORKER_IDENTITY_RECEIPT",
      );
    const alive = (options.processAlive ?? defaultProcessAlive)({
      pid: pid as number,
      birth,
    });
    return result(
      alive === null ? "unknown" : "available",
      { jobId, pid: pid as number, birth, alive, observedAtMs: read.mtimeMs },
      source,
      readAtMs,
      read.mtimeMs,
      alive === null ? "WORKER_PROCESS_BIRTH_NOT_CONFIRMABLE" : null,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return result<WorkerIdentityObservation>(
        "missing",
        null,
        source,
        readAtMs,
        null,
        "WORKER_IDENTITY_NOT_RECORDED",
      );
    return result<WorkerIdentityObservation>(
      "error",
      null,
      source,
      readAtMs,
      null,
      (error as NodeJS.ErrnoException).code ?? "WORKER_IDENTITY_READ_FAILED",
    );
  }
}

/** Reads only preflight/postflight receipts already present for explicit job IDs. */
export function readExistingFusionReceipts(
  queueDirectory: string,
  jobs: readonly { readonly jobId: string; readonly state: string }[],
  options: PassiveCollectorOptions = {},
): PassiveTelemetryRead<readonly ExistingFusionReceiptObservation[]> {
  const now = options.now ?? Date.now;
  const readAtMs = timestamp(now);
  const maxRecords = options.maxRecords ?? 512;
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0)
    throw new Error("Fusion receipt bound must be a positive integer");
  if (jobs.length > maxRecords)
    return result<readonly ExistingFusionReceiptObservation[]>(
      "unknown",
      null,
      "existing-fusion-preflight-postflight-receipts",
      readAtMs,
      null,
      "FUSION_RECEIPT_BOUND_EXCEEDED",
      true,
    );
  const jobIds = jobs
    .filter(({ state }) =>
      ["succeeded", "failed", "cancelled", "expired", "completed"].includes(
        state,
      ),
    )
    .map(({ jobId }) => jobId);
  const found: ExistingFusionReceiptObservation[] = [];
  try {
    const jobsRoot = path.join(path.resolve(queueDirectory), "jobs");
    if (!checkedDirectory(jobsRoot))
      return result<readonly ExistingFusionReceiptObservation[]>(
        "missing",
        null,
        "existing-fusion-preflight-postflight-receipts",
        readAtMs,
        null,
        "QUEUE_JOB_DIRECTORY_NOT_AVAILABLE",
      );
    for (const jobId of jobIds) {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(jobId))
        return result<readonly ExistingFusionReceiptObservation[]>(
          "error",
          null,
          "existing-fusion-preflight-postflight-receipts",
          readAtMs,
          null,
          "INVALID_JOB_ID",
        );
      const directory = path.join(jobsRoot, jobId);
      if (!checkedDirectory(directory)) continue;
      for (const kind of ["preflight", "postflight"] as const) {
        const file = path.join(directory, `${kind}.json`);
        let read: { value: unknown; mtimeMs: number };
        try {
          read = readJson(file, 256 * 1024);
        } catch (error) {
          if (!existsOrThrow(error)) continue;
          throw error;
        }
        found.push({
          jobId,
          source: kind,
          receipt: read.value,
          observedAtMs: read.mtimeMs,
          readAtMs,
        });
      }
    }
    const observedAtMs = found.reduce<number | null>(
      (latest, item) =>
        latest === null
          ? item.observedAtMs
          : Math.max(latest, item.observedAtMs),
      null,
    );
    return result(
      "available",
      found,
      "existing-fusion-preflight-postflight-receipts",
      readAtMs,
      observedAtMs,
    );
  } catch (error) {
    return result<readonly ExistingFusionReceiptObservation[]>(
      "error",
      null,
      "existing-fusion-preflight-postflight-receipts",
      readAtMs,
      null,
      (error as NodeJS.ErrnoException).code ?? "FUSION_RECEIPT_READ_FAILED",
    );
  }
}

/** Scans only existing per-job worker identity receipts with an explicit bound. */
export function readWorkerIdentitySet(
  queueDirectory: string,
  options: PassiveCollectorOptions = {},
): PassiveTelemetryRead<readonly WorkerIdentityObservation[]> {
  const now = options.now ?? Date.now;
  const readAtMs = timestamp(now);
  const maxRecords = options.maxRecords ?? 4096;
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0)
    throw new Error("Worker record bound must be a positive integer");
  const jobsRoot = path.join(path.resolve(queueDirectory), "jobs");
  try {
    if (!checkedDirectory(jobsRoot))
      return result<readonly WorkerIdentityObservation[]>(
        "missing",
        null,
        "existing-worker-identity-receipts",
        readAtMs,
        null,
        "QUEUE_JOB_DIRECTORY_NOT_AVAILABLE",
      );
    const { names, truncated } = boundedNames(
      jobsRoot,
      maxRecords,
      (_name, entry) => entry.isDirectory() && !entry.isSymbolicLink(),
    );
    if (truncated)
      return result<readonly WorkerIdentityObservation[]>(
        "unknown",
        null,
        "existing-worker-identity-receipts",
        readAtMs,
        null,
        "WORKER_IDENTITY_BOUND_EXCEEDED",
        true,
      );
    const records: WorkerIdentityObservation[] = [];
    let observedAtMs: number | null = null;
    for (const jobId of names) {
      const read = readWorkerIdentity(queueDirectory, jobId, {
        ...options,
        now,
      });
      if (read.status === "error")
        return result<readonly WorkerIdentityObservation[]>(
          "unknown",
          null,
          "existing-worker-identity-receipts",
          readAtMs,
          observedAtMs,
          read.reason ?? "WORKER_IDENTITY_READ_FAILED",
        );
      if (!read.value) continue;
      records.push(read.value);
      observedAtMs =
        observedAtMs === null
          ? read.value.observedAtMs
          : Math.max(observedAtMs, read.value.observedAtMs);
    }
    return result(
      "available",
      records,
      "existing-worker-identity-receipts",
      readAtMs,
      observedAtMs,
    );
  } catch (error) {
    return result<readonly WorkerIdentityObservation[]>(
      "error",
      null,
      "existing-worker-identity-receipts",
      readAtMs,
      null,
      (error as NodeJS.ErrnoException).code ?? "WORKER_IDENTITY_READ_FAILED",
    );
  }
}

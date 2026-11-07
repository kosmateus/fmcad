import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ClientPresenceSummary,
  Id,
  InvocationContext,
  InstanceId,
  ProcessPresenceRecord,
  ProcessIdentity,
  Presence,
} from "@fmcad/core";

export interface ClientPresenceOptions {
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly instanceId?: string;
}

export interface ClientPresenceHandle {
  readonly file: string;
  readonly instanceId: InstanceId;
  readonly publish: () => void;
  readonly stop: () => void;
  readonly dispose: () => void;
}

export interface ReadClientPresenceOptions {
  readonly now?: () => number;
  readonly alive?: (identity: {
    readonly pid: number;
    readonly birth: string | null;
  }) => boolean | null;
}

export interface ClientPresencePolicy {
  readonly id: <K extends string>(kind: K, value: string) => Id<K>;
  readonly summarizeClientPresence: (
    records: readonly ProcessPresenceRecord[],
    nowMs: number,
    alive: (record: ProcessPresenceRecord) => boolean | null,
  ) => ClientPresenceSummary[];
}

interface PresenceFileData {
  readonly version?: unknown;
  readonly project?: unknown;
  readonly clientId?: unknown;
  readonly instanceId?: unknown;
  readonly pid?: unknown;
  readonly birth?: unknown;
  readonly observedAt?: unknown;
  readonly closed?: unknown;
}

export function createClientPresenceAdapter(policy: ClientPresencePolicy) {
  function startClientPresence(
    clientId: string,
    cwd: string,
    options: ClientPresenceOptions = {},
  ): ClientPresenceHandle {
    if (
      typeof clientId !== "string" ||
      !clientId.trim() ||
      clientId.length > 256
    ) {
      throw new Error("Invalid presence client ID");
    }
    const project = projectDirectory(cwd);
    if (!project || !fs.existsSync(path.join(project, ".cad"))) {
      throw new Error(
        "Client presence requires an existing fmcad project directory",
      );
    }
    const now = options.now ?? Date.now;
    const timestamp = (): number => {
      try {
        const value = now();
        return Number.isFinite(value) ? value : Date.now();
      } catch {
        return Date.now();
      }
    };
    const intervalMs = options.intervalMs ?? 5_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
      throw new Error("Presence interval must be a positive safe integer");

    let birth: string | null = null;
    try {
      birth = processBirth(process.pid);
    } catch {
      /* Unsupported hosts cannot confirm process presence. */
    }
    const scopedInstanceId = options.instanceId ?? randomUUID();
    const directory = path.join(project, ".cad", "telemetry", "clients");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fileId = createHash("sha256").update(scopedInstanceId).digest("hex");
    const file = path.join(directory, `${fileId}.json`);
    const snapshot = {
      version: 1,
      instanceId: scopedInstanceId,
      clientId,
      project,
      pid: process.pid,
      birth,
      observedAt: timestamp(),
      closed: false,
    };
    let stopped = false;
    const publishSnapshot = (): void => {
      try {
        durable(file, snapshot);
      } catch {
        /* Presence cannot gate admission or execution. */
      }
    };
    const publish = (): void => {
      if (stopped) return;
      snapshot.observedAt = timestamp();
      snapshot.closed = false;
      publishSnapshot();
    };
    const timer = setInterval(publish, intervalMs);
    timer.unref();
    const dispose = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      snapshot.observedAt = timestamp();
      snapshot.closed = true;
      publishSnapshot();
    };
    publish();
    return {
      file,
      instanceId: policy.id("instance", scopedInstanceId),
      publish,
      stop: dispose,
      dispose,
    };
  }

  function readClientPresence(
    project: string,
    options: ReadClientPresenceOptions = {},
  ) {
    const now = options.now ?? Date.now;
    const alive = options.alive ?? priorProcessAlive;
    const result = {
      clients: [] as ClientPresenceSummary[],
      filesRead: 0,
      filesOmitted: 0,
      errors: 0,
      source: "project-client-process-heartbeats" as const,
    };
    const directory = path.join(project, ".cad/telemetry/clients");
    let files: { readonly file: string; readonly time: number }[];
    try {
      files = fs
        .readdirSync(directory, { withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name),
        )
        .map((entry) => {
          const file = path.join(directory, entry.name);
          return { file, time: fs.statSync(file).mtimeMs };
        })
        .sort(
          (left, right) =>
            right.time - left.time || left.file.localeCompare(right.file),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.errors++;
      return result;
    }
    result.filesOmitted = Math.max(0, files.length - 256);
    const records: ProcessPresenceRecord[] = [];
    for (const { file } of files.slice(0, 256)) {
      try {
        const value = readJson(file);
        if (
          value.version !== 1 ||
          value.project !== project ||
          typeof value.clientId !== "string" ||
          !value.clientId.trim() ||
          value.clientId.length > 256 ||
          typeof value.pid !== "number" ||
          !Number.isSafeInteger(value.pid) ||
          value.pid <= 0 ||
          !(value.birth === null || typeof value.birth === "string") ||
          typeof value.observedAt !== "number" ||
          !Number.isFinite(value.observedAt) ||
          typeof value.closed !== "boolean"
        ) {
          throw new Error("Invalid client presence record");
        }
        const instanceId = value.instanceId ?? path.basename(file, ".json");
        if (typeof instanceId !== "string")
          throw new Error("Invalid client presence record");
        records.push({
          version: 1,
          clientId: policy.id("client", value.clientId),
          instanceId: policy.id("instance", instanceId),
          pid: value.pid,
          birth: value.birth,
          observedAtMs: value.observedAt,
          closed: value.closed,
        });
        result.filesRead++;
      } catch {
        result.errors++;
      }
    }
    result.clients = policy.summarizeClientPresence(records, now(), (record) =>
      alive(record),
    );
    return result;
  }

  return { startClientPresence, readClientPresence };
}

export function createProjectPresencePort(
  project: string,
  policy: ClientPresencePolicy,
): Presence {
  const adapter = createClientPresenceAdapter(policy);
  let instanceId: string | null = null;
  let handle: ClientPresenceHandle | null = null;
  let observedAtMs = 0;
  return {
    async heartbeat(
      invocation: InvocationContext,
      atMs: number,
    ): Promise<void> {
      if (!invocation.clientId) return;
      if (instanceId !== null && instanceId !== invocation.instanceId)
        throw new Error(
          "Presence adapter is owned by a different invocation instance",
        );
      if (!Number.isFinite(atMs))
        throw new Error("Presence timestamp must be finite");
      observedAtMs = atMs;
      if (!handle) {
        instanceId = invocation.instanceId;
        handle = adapter.startClientPresence(invocation.clientId, project, {
          instanceId,
          now: () => observedAtMs,
        });
      } else handle.publish();
    },
    async dispose(invocation: InvocationContext, atMs: number): Promise<void> {
      if (!handle || invocation.instanceId !== instanceId) return;
      if (Number.isFinite(atMs)) observedAtMs = atMs;
      handle.dispose();
      handle = null;
      instanceId = null;
    },
  };
}

function projectDirectory(cwd: string): string | null {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  const original = fs.realpathSync(cwd);
  let current = original;
  for (;;) {
    try {
      if (fs.statSync(path.join(current, ".cad")).isDirectory()) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return original;
    current = parent;
  }
}

function processBirth(pid: number): string {
  if (process.platform !== "linux")
    throw Object.assign(new Error("Linux /proc process identity unavailable"), {
      code: "UNSUPPORTED_HOST",
    });
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  if (["Z", "X"].includes(fields[0] ?? ""))
    throw Object.assign(new Error("Process has exited"), { code: "ESRCH" });
  const ticks = fields[19];
  if (!ticks || !/^\d+$/u.test(ticks))
    throw Object.assign(new Error("Process birth ticks unavailable"), {
      code: "INVALID_PROCESS_IDENTITY",
    });
  return `${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
}

export function currentProcessIdentity(
  pid = process.pid,
): ProcessIdentity | null {
  try {
    return { pid, birth: processBirth(pid) };
  } catch {
    return null;
  }
}

function priorProcessAlive(identity: {
  readonly pid: number;
  readonly birth: string | null;
}): boolean | null {
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    typeof identity.birth !== "string"
  )
    return null;
  try {
    return processBirth(identity.pid) === identity.birth;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? false : null;
  }
}

function readJson(file: string): PresenceFileData {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384)
      throw new Error("Presence record too large or not a regular file");
    const value: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid client presence record");
    return value as PresenceFileData;
  } finally {
    fs.closeSync(fd);
  }
}

function durable(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

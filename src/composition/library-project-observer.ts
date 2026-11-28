// Passive diagnostics only. This observer never mutates queue or Fusion state.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createRequire } from "node:module";
import {
  locations,
  readJson,
  ipc,
  createEventSink,
  type QueueLocations,
  type ObserverResponse,
} from "./library-project-events";
const load = createRequire(__filename);
const { createDiagnosticLog } = load(
  "../node-adapters/telemetry/diagnostic-log",
) as typeof import("../../packages/node-adapters/src/telemetry/diagnostic-log");
type Fields = Record<string, unknown>;
export interface ProjectLoggerOptions {
  queueDir?: string;
  pollMs?: number;
  heartbeatMs?: number;
  protectedRoot?: string;
  cwd?: string;
  nodePath?: string;
}
interface ObserverConfig extends QueueLocations {
  pollMs: number;
  heartbeatMs: number;
  protectedRoot?: string | undefined;
}
interface ObserverJob {
  id: string;
  state: string;
  order: number;
  clientId?: unknown;
  kind?: unknown;
  code?: unknown;
  sequenceId?: unknown;
  startedAt?: number;
  finishedAt?: number;
  submittedAt: number;
  request?: {
    cwd?: unknown;
    timeoutMs?: unknown;
    argv?: unknown[];
    payload?: { method?: unknown };
  };
  details?: { executionOutcome?: unknown; reason?: unknown };
  dispatch?: {
    rpcCount?: unknown;
    completedCount?: unknown;
    updatedAt?: number;
    details?: { rpcId?: unknown };
  };
}
interface ObserverSnapshot {
  version?: number;
  jobs: Record<string, ObserverJob>;
  active?: unknown;
  blocked?: { id?: unknown; reason?: unknown } | null;
  lease?: { clientId?: unknown } | null;
  paused?: unknown;
}
interface ObserverCursor {
  lastOrder?: number;
  tracked?: Record<string, string>;
  projects?: unknown[];
}
interface QueueDiagnostics {
  held?: unknown;
  recovery?: { jobId?: unknown; status?: unknown; code?: unknown };
  buildHash?: unknown;
  at?: number;
}
interface Observation {
  version: 1;
  atMs: number;
  name: string;
  invocation: {
    version: 1;
    source: string;
    instanceId: string;
    purpose: string | null;
    [key: string]: unknown;
  };
  data: Fields;
}
interface DashboardValue {
  data: { modifiedAt?: unknown; stale?: unknown; error?: unknown };
  [key: string]: unknown;
}
interface DiagnosticProvider {
  setArchive(archive: unknown): void;
  get(options: { queueData: ObserverSnapshot }): Promise<DashboardValue>;
  close(): void;
}
interface Dashboard {
  provider: DiagnosticProvider;
  at: number;
  value: DashboardValue | null;
  pending: Promise<DashboardValue> | null;
}
function recordFields(value: unknown): Fields {
  return value !== null && typeof value === "object" ? (value as Fields) : {};
}
function listed(values: readonly string[], value: unknown): value is string {
  return typeof value === "string" && values.includes(value);
}
function errorCode(error: unknown): unknown {
  return recordFields(error)["code"];
}
let diagnosticLog: ReturnType<typeof createDiagnosticLog> | undefined;
function diagnosticWriter() {
  return (diagnosticLog ||= createDiagnosticLog("project-observer"));
}

const SDK_ROOT = path.resolve(__dirname, "../..");
const OBSERVER_ENTRYPOINT = path.join(
  SDK_ROOT,
  "opencode",
  "project-logger.cjs",
);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const STATES = new Set([
  "queued",
  "running",
  "sending",
  "needs_reconciliation",
  ...TERMINAL,
]);
const CLIENT_EVENTS = new Set([
  "client_requested",
  "client_finished",
  "client_failed",
]);
const sha = (value: unknown) =>
  createHash("sha256").update(String(value)).digest("hex");
const safeCode = (value: unknown) =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
    ? value
    : "UNSPECIFIED";
const id = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value)
    ? value
    : "h" + sha(value || "").slice(0, 16);
const ms = (value: unknown) =>
  Number.isFinite(value) ? Math.max(0, Math.round(Number(value))) : 0;
const sleep = (value: number) =>
  new Promise((resolve) => setTimeout(resolve, value));
const inside = (value: string, parent: string) =>
  value === parent || value.startsWith(parent + path.sep);

function privateDirectory(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(dir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw Object.assign(Error("Unsafe diagnostics directory"), {
      code: "UNSAFE_DIRECTORY",
    });
  fs.chmodSync(dir, 0o700);
}

function saveJson(file: string, data: unknown) {
  const temp = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, file);
}

function processAlive(pid: unknown, expectedBirth: unknown) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    if (["Z", "X"].includes(fields[0]!)) return false;
    const birth =
      fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() +
      ":" +
      fields[19];
    return birth === expectedBirth;
  } catch {
    return false;
  }
}

function line(event: string, fields: Fields = {}, warn = false) {
  const values = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(
      ([key, value]) =>
        `${key}=${String(value)
          .replace(/[^A-Za-z0-9_.:@+-]/g, "_")
          .slice(0, 100)}`,
    );
  return `${new Date().toISOString()} ${warn ? "WARN" : "INFO"} ${event} ${values.join(" ")}\n`;
}

export function workspaceLog(
  cwd: unknown,
  config: QueueLocations & { protectedRoot?: string | undefined },
): string | null {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  try {
    let directory = fs.realpathSync(cwd);
    if (
      !fs.statSync(directory).isDirectory() ||
      directory === path.parse(directory).root ||
      directory === os.homedir()
    )
      return null;
    // Never create a log inside directories included in the SDK build pin.
    for (const root of [SDK_ROOT, config.protectedRoot].filter(
      (value): value is string => typeof value === "string",
    )) {
      if (
        ["src", "bin", "assets"].some((part) =>
          inside(directory, path.join(root, part)),
        )
      )
        directory = root;
    }
    if (inside(directory, config.queueDir)) directory = config.stateDir;
    const parts = directory.split(path.sep),
      reports = parts.indexOf(".fmcad-batch");
    if (reports >= 0)
      directory = parts.slice(0, reports).join(path.sep) || path.sep;
    return path.join(directory, ".cad", "logs", "fmcad.log");
  } catch {
    return null;
  } // Removed/inaccessible workspaces are never recreated.
}

export async function appendSafe(file: string, text: string): Promise<void> {
  privateDirectory(path.dirname(path.dirname(file)));
  privateDirectory(path.dirname(file));
  // One observer serializes each project's writes. Recover the hour from the
  // content on restart, rather than the observer's startup time or file mtime.
  let current;
  try {
    current = await fsp.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (current) {
    let hour;
    try {
      const stat = await current.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw Object.assign(Error("Unsafe project log"), {
          code: "UNSAFE_LOG",
        });
      const prefix = Buffer.alloc(32);
      const { bytesRead } = await current.read(prefix, 0, prefix.length, 0);
      hour = prefix
        .subarray(0, bytesRead)
        .toString()
        .match(/^(\d{4}-\d\d-\d\dT\d\d):/)?.[1];
      if (stat.size && !hour)
        throw Object.assign(Error("Unrecognized log timestamp"), {
          code: "INVALID_LOG",
        });
    } finally {
      await current.close();
    }
    if (hour && hour !== text.slice(0, 13)) {
      const archive = path.join(
        path.dirname(file),
        `fmcad-${hour.replace("T", "_")}.log`,
      );
      // link is exclusive: unlike rename it cannot overwrite an earlier archive.
      await fsp.link(file, archive);
      await fsp.unlink(file);
    }
  }
  const handle = await fsp.open(
    file,
    fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      fs.constants.O_WRONLY |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Object.assign(Error("Unsafe project log"), { code: "UNSAFE_LOG" });
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}

export async function ensureProjectLogger(
  options: ProjectLoggerOptions = {},
): Promise<ObserverResponse | { enabled: false; code?: string }> {
  if (process.env["FMCAD_PROJECT_LOGS"] === "0") return { enabled: false };
  if (process.platform !== "linux")
    return { enabled: false, code: "UNSUPPORTED_LOGGER_HOST" };
  const config = {
    ...locations(options.queueDir),
    pollMs: options.pollMs || 500,
    heartbeatMs: options.heartbeatMs || 30000,
    protectedRoot: options.protectedRoot
      ? path.resolve(options.protectedRoot)
      : undefined,
  };
  async function ready() {
    const result = await ipc(config);
    if (options.cwd) await attachProject(options.cwd, options);
    return result;
  }
  try {
    return await ready();
  } catch {
    /* Only the passive observer is started. */
  }
  privateDirectory(config.stateDir);
  const child = spawn(
    options.nodePath || process.execPath,
    [OBSERVER_ENTRYPOINT, "--observe", JSON.stringify(config)],
    {
      detached: true,
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
    },
  );
  child.on("error", (error) =>
    diagnosticWriter().write(
      line("observer_start_failed", { code: safeCode(errorCode(error)) }, true),
    ),
  );
  child.unref();
  for (let i = 0; i < 12; i++) {
    await sleep(100);
    try {
      return await ready();
    } catch {
      /* Concurrent loaders share one abstract socket. */
    }
  }
  diagnosticWriter().write(
    line("observer_start_unavailable", { code: "LOGGER_NOT_READY" }, true),
  );
  return { enabled: false, code: "LOGGER_NOT_READY" };
}

export async function clientEvent(
  cwd: string,
  event: string,
  fields: Fields = {},
  options: ProjectLoggerOptions = {},
) {
  if (process.env["FMCAD_PROJECT_LOGS"] === "0") return { enabled: false };
  const config = locations(options.queueDir);
  const control = readJson(
    path.join(config.stateDir, "observer.json"),
  ) as Fields;
  return ipc(config, {
    method: "client",
    token: control["token"],
    cwd,
    event,
    fields,
  });
}

export async function attachProject(
  cwd: string,
  options: ProjectLoggerOptions = {},
) {
  const config = locations(options.queueDir),
    control = readJson(path.join(config.stateDir, "observer.json")) as Fields;
  return ipc(config, { method: "attach", token: control["token"], cwd });
}

export async function stopProjectLogger(options: ProjectLoggerOptions = {}) {
  const config = locations(options.queueDir),
    control = readJson(path.join(config.stateDir, "observer.json")) as Fields;
  return ipc(config, { method: "stop", token: control["token"] });
}

async function observe(config: ObserverConfig) {
  if (process.platform !== "linux")
    throw Object.assign(Error("Linux abstract socket required"), {
      code: "UNSUPPORTED_LOGGER_HOST",
    });
  privateDirectory(config.stateDir);
  const writers = new Map<
      string,
      { pending: number; promise: Promise<void> }
    >(),
    projects = new Set<string>(),
    lastErrors = new Map<string, string>();
  const dashboards = new Map<string, Dashboard>();
  let dropped = 0,
    writeErrors = 0,
    lastTick = 0,
    stopping = false,
    polling = false;
  let lastStamp: string | undefined, queueError: string | null | undefined;
  let snapshot: ObserverSnapshot = {
    jobs: {},
    active: null,
    blocked: null,
    lease: null,
    paused: false,
  };
  const cursorFile = path.join(config.stateDir, "cursor.json");
  let cursor: ObserverCursor | null;
  try {
    cursor = readJson(cursorFile) as ObserverCursor | null;
  } catch {
    cursor = null;
  }
  const first = !Number.isSafeInteger(cursor?.lastOrder);
  let lastOrder = first ? 0 : cursor!.lastOrder!,
    tracked =
      cursor?.tracked && typeof cursor.tracked === "object"
        ? cursor.tracked
        : {};
  for (const file of Array.isArray(cursor?.projects) ? cursor.projects : []) {
    if (typeof file !== "string") continue;
    const directory = path.dirname(file);
    const root =
      path.basename(directory) === "logs" &&
      path.basename(path.dirname(directory)) === ".cad"
        ? path.dirname(path.dirname(directory))
        : directory;
    const target = workspaceLog(root, config);
    if (target && (target === file || path.join(root, "fmcad.log") === file))
      projects.add(target);
  }
  const saveCursor = () =>
    saveJson(cursorFile, {
      lastOrder,
      tracked,
      projects: [...projects].slice(-64),
    });
  const token = randomBytes(32).toString("hex");
  function diagnostic(code: string, file: string) {
    writeErrors++;
    if (lastErrors.get(file) === code) return;
    lastErrors.set(file, code);
    if (lastErrors.size > 128)
      lastErrors.delete(lastErrors.keys().next().value!);
    diagnosticWriter().write(
      line(
        "project_log_unavailable",
        { code, project: sha(file).slice(0, 12) },
        true,
      ),
    );
  }
  function write(
    file: string | null,
    event: string,
    fields: Fields,
    warn = false,
  ) {
    if (!file) return;
    if (!projects.has(file) && projects.size >= 64) {
      dropped++;
      return;
    }
    projects.add(file);
    const record = writers.get(file) || {
      pending: 0,
      promise: Promise.resolve(),
    };
    if (record.pending >= 128) {
      dropped++;
      return;
    }
    record.pending++;
    record.promise = record.promise
      .then(() => appendSafe(file, line(event, fields, warn)))
      .catch((error) => diagnostic(safeCode(errorCode(error)), file))
      .finally(() => {
        record.pending--;
        if (!record.pending && writers.get(file) === record)
          writers.delete(file);
      });
    writers.set(file, record);
  }
  function kind(job: ObserverJob) {
    if (job.kind === "rpc") {
      const method = job.request?.payload?.method;
      return listed(
        [
          "initialize",
          "notifications/initialized",
          "tools/list",
          "tools/call",
          "ping",
        ],
        method,
      )
        ? method
        : "rpc";
    }
    const command = job.request?.argv?.[0];
    return listed(
      ["run", "review", "doc", "tools", "doctor", "shot", "batch", "cad"],
      command,
    )
      ? command
      : "command";
  }
  function logJob(job: ObserverJob, attached = false) {
    if (!STATES.has(job.state)) return;
    const file = workspaceLog(job.request?.cwd, config);
    const executionOutcome = job.details?.executionOutcome;
    const outcome = listed(
      ["not_started", "completed", "unknown"],
      executionOutcome,
    )
      ? executionOutcome
      : undefined;
    write(
      file,
      attached ? "job_attached" : "job_" + job.state,
      {
        job: id(job.id),
        client: sha(job.clientId || "").slice(0, 12),
        kind: kind(job),
        state: job.state,
        code: job.code ? safeCode(job.code) : undefined,
        execution: outcome,
        wait_ms: ms(
          (job.startedAt || job.finishedAt || Date.now()) - job.submittedAt,
        ),
        active_ms: job.startedAt
          ? ms((job.finishedAt || Date.now()) - job.startedAt)
          : 0,
        rpc: ms(job.dispatch?.rpcCount),
        ack: ms(job.dispatch?.completedCount),
        sequence: job.sequenceId ? id(job.sequenceId) : undefined,
        rpc_id: job.dispatch?.details?.rpcId
          ? id(job.dispatch.details.rpcId)
          : undefined,
        timeout_ms: job.request?.timeoutMs,
        reason: job.details?.reason,
      },
      ["failed", "expired", "needs_reconciliation"].includes(job.state),
    );
  }
  function broker() {
    try {
      const owner = readJson(
        path.join(config.queueDir, "broker.lock"),
      ) as Fields;
      return {
        broker_process: processAlive(owner["pid"], owner["birth"])
          ? "alive"
          : "dead",
        broker_pid: owner["pid"],
      };
    } catch {
      return { broker_process: "absent" };
    }
  }
  let brokerFingerprint: string | undefined;
  let diagnosticFingerprint: string | undefined,
    queueDiagnostics: QueueDiagnostics = {};
  async function poll() {
    if (polling || stopping) return;
    polling = true;
    try {
      const file = path.join(config.queueDir, "queue-state.json"),
        stat = fs.statSync(file);
      const stamp = stat.ino + ":" + stat.size + ":" + stat.mtimeMs;
      if (stamp !== lastStamp) {
        const data = readJson(file) as ObserverSnapshot;
        if (data.version !== 1 || !data.jobs || typeof data.jobs !== "object")
          throw Object.assign(Error("Unsupported snapshot"), {
            code: "UNSUPPORTED_SNAPSHOT",
          });
        snapshot = data;
        lastStamp = stamp;
        const next: Record<string, string> = {};
        for (const job of Object.values(data.jobs)) {
          const fingerprint = [
            job.state,
            job.code || "",
            job.startedAt || 0,
            job.finishedAt || 0,
          ].join(":");
          if (
            (tracked[job.id] && tracked[job.id] !== fingerprint) ||
            (job.order > lastOrder && (!first || lastTick)) ||
            (!tracked[job.id] && !TERMINAL.has(job.state))
          )
            logJob(job, !lastTick && first);
          if (!TERMINAL.has(job.state)) next[job.id] = fingerprint;
        }
        tracked = next;
        lastOrder = Math.max(
          lastOrder,
          ...Object.values(data.jobs).map((job) =>
            Number.isSafeInteger(job.order) ? job.order : 0,
          ),
        );
        // Attach the currently reserved project's log, without dumping old history.
        if (!lastTick && data.lease) {
          const clientId = data.lease.clientId;
          const recent = Object.values(data.jobs)
            .filter((job) => job.clientId === clientId)
            .sort((a, b) => b.order - a.order)[0];
          const log = workspaceLog(recent?.request?.cwd, config);
          write(log, "sequence_observed", {
            client: sha(data.lease.clientId).slice(0, 12),
            lease_held: true,
          });
        }
        saveCursor();
        if (queueError)
          for (const log of projects) write(log, "snapshot_read_recovered", {});
        queueError = null;
      }
      lastTick = Date.now();
    } catch (error) {
      const code = safeCode(errorCode(error));
      if (queueError !== code)
        for (const log of projects)
          write(log, "snapshot_unavailable", { code }, true);
      queueError = code;
    } finally {
      polling = false;
    }
    const state = broker(),
      fingerprint = JSON.stringify(state);
    if (fingerprint !== brokerFingerprint) {
      for (const log of projects)
        write(log, "broker_observed", state, state.broker_process !== "alive");
      brokerFingerprint = fingerprint;
    }
    try {
      const value = readJson(
        path.join(config.queueDir, "queue-diagnostics.json"),
      ) as QueueDiagnostics;
      const fingerprint = JSON.stringify([
        value.held,
        value.recovery?.jobId,
        value.recovery?.status,
        value.recovery?.code,
      ]);
      queueDiagnostics = value;
      if (fingerprint !== diagnosticFingerprint) {
        for (const log of projects)
          write(log, "queue_diagnostics", diagnosticFields(), !!value.held);
        diagnosticFingerprint = fingerprint;
      }
    } catch {
      /* Older brokers do not publish diagnostic snapshots. */
    }
  }
  function diagnosticFields() {
    let probe = {};
    const blockedId = snapshot.blocked?.id;
    if (typeof blockedId === "string" && /^[a-f0-9-]{36}$/.test(blockedId)) {
      try {
        const directory = path.join(config.queueDir, "jobs", blockedId);
        const record = recordFields(
          readJson(path.join(directory, "reconcile-probe.json")),
        );
        const rpcId = recordFields(record["binding"])["rpcId"];
        if (typeof rpcId === "string" && /^[a-f0-9-]{36}$/.test(rpcId)) {
          const receipt = recordFields(
            readJson(path.join(directory, `reconcile-${rpcId}.receipt.json`)),
          );
          probe = {
            recovery_probe: rpcId,
            probe_outcome: receipt["outcome"],
            probe_error_type: recordFields(receipt["error"])["type"],
            probe_error: recordFields(receipt["error"])["message"],
          };
        }
      } catch {
        /* Missing evidence is not evidence of completion. */
      }
    }
    return {
      ...probe,
      held: queueDiagnostics.held,
      recovery_status: queueDiagnostics.recovery?.status,
      recovery_code: queueDiagnostics.recovery?.code,
      recovery_job: queueDiagnostics.recovery?.jobId,
      build: queueDiagnostics.buildHash,
      diagnostic_age_ms: queueDiagnostics.at
        ? ms(Date.now() - queueDiagnostics.at)
        : undefined,
    };
  }
  function heartbeat() {
    const jobs = Object.values(snapshot.jobs);
    const grouped = new Map<string | null, ObserverJob[]>();
    for (const job of jobs)
      if (!TERMINAL.has(job.state)) {
        const file = workspaceLog(job.request?.cwd, config);
        if (!grouped.has(file)) grouped.set(file, []);
        grouped.get(file)!.push(job);
      }
    for (const file of projects) {
      const mine = grouped.get(file) || [];
      write(file, "heartbeat", {
        ...broker(),
        ...diagnosticFields(),
        blocked_job: snapshot.blocked?.id,
        blocked_reason: snapshot.blocked?.reason,
        queued: mine.filter((job) => job.state === "queued").length,
        active: mine.filter((job) => ["running", "sending"].includes(job.state))
          .length,
        global_blocked: !!snapshot.blocked,
        lease_held: !!snapshot.lease,
        paused: snapshot.paused,
        observer_read_age_ms: lastTick ? ms(Date.now() - lastTick) : undefined,
        snapshot_read: queueError ? "unavailable" : "ok",
        dropped,
        write_errors: writeErrors,
      });
      for (const job of mine)
        write(file, "job_progress", {
          job: id(job.id),
          state: job.state,
          wait_ms: ms((job.startedAt || Date.now()) - job.submittedAt),
          active_ms: job.startedAt ? ms(Date.now() - job.startedAt) : 0,
          rpc: ms(job.dispatch?.rpcCount),
          ack: ms(job.dispatch?.completedCount),
          stage_age_ms: ms(
            Date.now() -
              (job.dispatch?.updatedAt || job.startedAt || job.submittedAt),
          ),
        });
    }
  }
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.setTimeout(1000, () => socket.destroy());
    let buffer = "";
    socket.on("data", (bytes) => {
      buffer += bytes.toString("utf8");
      if (buffer.length > 8192) return socket.destroy();
      if (!buffer.includes("\n")) return;
      const text = buffer.slice(0, buffer.indexOf("\n"));
      buffer = "";
      try {
        const message = recordFields(JSON.parse(text));
        if (message["method"] === "status")
          return socket.end(
            JSON.stringify({
              ok: true,
              pid: process.pid,
              lastTick,
              projects: projects.size,
              writeErrors,
              dropped,
              diagnostics: diagnosticLog?.stats() ?? {
                pending: 0,
                dropped: 0,
                errors: 0,
              },
            }) + "\n",
          );
        const supplied = Buffer.from(
            typeof message["token"] === "string" ? message["token"] : "",
          ),
          expected = Buffer.from(token);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          return socket.end('{"ok":false}\n');
        if (message["method"] === "diagnostic") {
          if (
            message["project"] !== null &&
            message["project"] !== undefined &&
            (typeof message["project"] !== "string" ||
              !path.isAbsolute(message["project"]))
          )
            return socket.end('{"ok":false}\n');
          if (
            message["archive"] &&
            !/^fmcad(?:-\d{4}-\d\d-\d\d_\d\d)?\.log$/.test(
              String(message["archive"]),
            )
          )
            return socket.end('{"ok":false}\n');
          const key = JSON.stringify([
            message["project"] || null,
            message["archive"] || null,
          ]);
          let dashboard = dashboards.get(key);
          if (!dashboard) {
            const { DiagnosticProvider } = load(
              path.join(SDK_ROOT, "src", "diagnostic", "provider"),
            ) as {
              DiagnosticProvider: new (options: {
                root: string;
                project: unknown;
                useObserver: false;
              }) => DiagnosticProvider;
            };
            const provider = new DiagnosticProvider({
              root: path.dirname(config.queueDir),
              project: message["project"],
              useObserver: false,
            });
            provider.setArchive(message["archive"]);
            dashboard = { provider, at: 0, value: null, pending: null };
            dashboards.set(key, dashboard);
            if (dashboards.size > 8) {
              const oldest = dashboards.keys().next().value!;
              dashboards.get(oldest)!.provider.close();
              dashboards.delete(oldest);
            }
          }
          if (!dashboard.pending && Date.now() - dashboard.at >= 1000) {
            dashboard.pending = dashboard.provider
              .get({ queueData: snapshot })
              .then((value) => {
                dashboard.value = {
                  ...value,
                  source: "passive-observer",
                  data: {
                    ...value.data,
                    modifiedAt: lastStamp
                      ? Number(lastStamp.split(":").at(-1))
                      : value.data.modifiedAt,
                    stale: !!queueError || value.data.stale,
                    error: queueError || value.data.error,
                  },
                };
                dashboard.at = Date.now();
                return dashboard.value;
              })
              .finally(() => {
                dashboard.pending = null;
              });
          }
          Promise.resolve(dashboard.pending || dashboard.value).then(
            (value) => {
              if (!socket.destroyed)
                socket.end(
                  JSON.stringify({ ok: true, snapshot: value }) + "\n",
                );
            },
            () => {
              if (!socket.destroyed) socket.end('{"ok":false}\n');
            },
          );
          return;
        }
        if (
          message["method"] === "client" &&
          typeof message["event"] === "string" &&
          CLIENT_EVENTS.has(message["event"])
        ) {
          const clientFields = recordFields(message["fields"]);
          write(workspaceLog(message["cwd"], config), message["event"], {
            call: id(clientFields["callId"]),
            client: sha(clientFields["clientId"] || "").slice(0, 12),
            job: clientFields["jobId"] ? id(clientFields["jobId"]) : undefined,
            state: listed(
              ["CLI_EXITED", "UNKNOWN", "NOT_STARTED"],
              clientFields["state"],
            )
              ? clientFields["state"]
              : undefined,
            exit: Number.isInteger(clientFields["exitCode"])
              ? clientFields["exitCode"]
              : undefined,
            elapsed_ms:
              clientFields["elapsedMs"] !== undefined
                ? ms(clientFields["elapsedMs"])
                : undefined,
          });
          saveCursor();
          return socket.end('{"ok":true}\n');
        }
        if (message["method"] === "observation") {
          if (
            typeof message["cwd"] !== "string" ||
            !path.isAbsolute(message["cwd"]) ||
            !validObservationEvent(message["event"])
          )
            return socket.end('{"ok":false}\n');
          const event = message["event"],
            invocation = event["invocation"];
          const fields = {
            client: logId(invocation["clientId"]),
            request: logId(invocation["requestId"]),
            job: logId(invocation["jobId"]),
            project: logId(invocation["projectId"]),
            document: logId(invocation["documentId"]),
            session: logId(invocation["sessionId"]),
            turn: logId(invocation["turnId"]),
            instance: logId(invocation["instanceId"]),
            source: invocation["source"],
            observed_at_ms: ms(event["atMs"]),
            ...observationFields(event["data"]),
          };
          write(
            workspaceLog(message["cwd"], config),
            "observation_" +
              safeCode(
                event["name"].replace(/[^A-Za-z0-9]+/g, "_").toUpperCase(),
              ).toLowerCase(),
            fields,
          );
          saveCursor();
          return socket.end('{"ok":true}\n');
        }
        if (message["method"] === "attach") {
          write(workspaceLog(message["cwd"], config), "observer_attached", {
            source: "durable_queue",
            sdk_calls: 0,
          });
          saveCursor();
          heartbeat();
          return socket.end('{"ok":true}\n');
        }
        if (message["method"] === "stop") {
          socket.end('{"ok":true}\n');
          void stop();
          return;
        }
        socket.end('{"ok":false}\n');
      } catch {
        socket.end('{"ok":false}\n');
      }
      return;
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.socket, resolve);
    });
  } catch (error) {
    if (errorCode(error) === "EADDRINUSE") return;
    throw error;
  }
  server.on("error", () => {});
  saveJson(path.join(config.stateDir, "observer.json"), {
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  });
  await poll();
  const interval = setInterval(() => {
    void poll();
  }, config.pollMs);
  const pulse = setInterval(heartbeat, config.heartbeatMs);
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    clearInterval(pulse);
    for (const log of projects) write(log, "observer_stopped", {});
    server.close();
    for (const dashboard of dashboards.values()) dashboard.provider.close();
    await Promise.race([
      Promise.allSettled([...writers.values()].map((value) => value.promise)),
      sleep(2000),
    ]);
    await diagnosticLog?.close();
  }
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      void stop();
    });
}

function validObservationEvent(value: unknown): value is Observation {
  const event = recordFields(value);
  const invocation = recordFields(event["invocation"]);
  if (
    !event ||
    event["version"] !== 1 ||
    !Number.isFinite(event["atMs"]) ||
    typeof event["name"] !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(event["name"]) ||
    !event["invocation"] ||
    invocation["version"] !== 1 ||
    !listed(["cli", "mcp", "opencode", "system"], invocation["source"]) ||
    typeof invocation["instanceId"] !== "string" ||
    !event["data"] ||
    typeof event["data"] !== "object" ||
    Array.isArray(event["data"])
  )
    return false;
  for (const key of [
    "clientId",
    "requestId",
    "jobId",
    "projectId",
    "documentId",
    "sessionId",
    "turnId",
  ]) {
    const value = invocation[key];
    if (
      value !== null &&
      (typeof value !== "string" || !value.trim() || value.length > 256)
    )
      return false;
  }
  if (
    invocation["purpose"] !== null &&
    (typeof invocation["purpose"] !== "string" ||
      invocation["purpose"].length > 1000)
  )
    return false;
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8") <= 6144;
  } catch {
    return false;
  }
}

function logId(value: unknown) {
  return typeof value === "string" && value ? id(value) : undefined;
}

function observationFields(data: Fields) {
  const fields: Fields = {};
  for (const [key, value] of Object.entries(data).slice(0, 64)) {
    if (
      !/^(?:status|state|code|kind|method|phase|outcome|transport|exitCode|durationMs|elapsedMs|count)$/.test(
        key,
      )
    )
      continue;
    if (typeof value === "boolean") fields[key] = value;
    else if (typeof value === "number" && Number.isFinite(value))
      fields[key] = value;
    else if (
      typeof value === "string" &&
      /^[A-Za-z0-9_.:@+-]{1,100}$/.test(value)
    )
      fields[key] = value;
  }
  return fields;
}

export function runProjectObserver(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const mode = args[0] || "--start";
  const options = (args[1] ? JSON.parse(args[1]) : {}) as ObserverConfig &
    ProjectLoggerOptions;
  const run =
    mode === "--observe"
      ? observe(options)
      : mode === "--stop"
        ? stopProjectLogger(options)
        : mode === "--status"
          ? ipc(locations(options.queueDir))
          : ensureProjectLogger(options);
  return Promise.resolve(run).then(
    (value) => {
      if (mode !== "--observe") console.log(JSON.stringify(value));
    },
    async (error) => {
      if (mode === "--observe") {
        diagnosticWriter().write("FMCAD_LOGGER " + safeCode(errorCode(error)));
        await diagnosticWriter().close();
      } else console.error("FMCAD_LOGGER " + safeCode(errorCode(error)));
      process.exitCode = 1;
    },
  );
}

export { createEventSink, locations };

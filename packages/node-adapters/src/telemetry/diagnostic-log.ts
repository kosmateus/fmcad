import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { redactDiagnostic } from "@fmcad/core";

export interface DiagnosticLogOptions {
  readonly directory?: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly maxPending?: number;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
  readonly io?: typeof fs;
  readonly isAlive?: (pid: number) => boolean;
}

export type DebugTraceSource = "cli" | "mcp";
export type DebugTraceStage =
  | "request-accepted"
  | "preflight"
  | "sdk-dispatch"
  | "raw-received"
  | "parsed"
  | "native-receipt"
  | "result-published"
  | "caller-received"
  | "stdout-written";

export interface DebugTraceContext {
  readonly version: 1;
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly source: DebugTraceSource;
  readonly requestId: string;
}

export interface DebugTraceEvent {
  readonly stage: DebugTraceStage;
  readonly status?:
    | "started"
    | "passed"
    | "failed"
    | "unknown"
    | "not_observed"
    | "published"
    | "returned"
    | "written"
    | undefined;
  readonly jobId?: string | undefined;
  readonly rpcId?: string | undefined;
  readonly buildHash?: string | undefined;
  readonly sourceHash?: string | undefined;
  readonly code?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly sdkPid?: number | undefined;
  readonly sdkBirth?: string | undefined;
  readonly sdkVersion?: string | undefined;
  readonly artifactRef?: string | undefined;
  readonly rawBytes?: number | undefined;
  readonly rawSha256?: string | undefined;
  readonly responseKeys?: readonly string[] | undefined;
  readonly contentCount?: number | undefined;
  readonly contentTextBytes?: number | undefined;
  readonly structuredBytes?: number | undefined;
  readonly messageBytes?: number | undefined;
  readonly stdoutBytes?: number | undefined;
  readonly frameBytes?: number | undefined;
  readonly httpStatus?: number | undefined;
  readonly stdoutObservation?:
    "not_observed" | "observed_empty" | "observed_nonempty" | undefined;
}

const TRACE_NAMESPACE = "fmcad.debug-trace.v1";
const DEBUG_TRACE_ENV = "FMCAD_DEBUG_TRACE";
const safeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const safeIdentity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export function debugTraceEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment[DEBUG_TRACE_ENV] === "1";
}

/** Deterministic for an immutable request so lost-ACK recovery keeps its trace. */
export function createDebugTraceContext(
  requestId: string,
  clientId: string,
  source: DebugTraceSource,
  enabled = debugTraceEnabled(),
): DebugTraceContext | undefined {
  if (!enabled) return undefined;
  if (
    !safeIdentity(requestId) ||
    !safeIdentity(clientId) ||
    !["cli", "mcp"].includes(source)
  )
    throw new Error("Debug trace requires safe request and client identities");
  const identity = `${TRACE_NAMESPACE}\0${clientId}\0${requestId}`;
  return Object.freeze({
    version: 1,
    traceId: digest(identity).slice(0, 32),
    rootSpanId: digest(`${TRACE_NAMESPACE}\0root\0${identity}`).slice(0, 16),
    source,
    requestId,
  });
}

export function validDebugTraceContext(
  value: unknown,
  expected: { requestId: string; clientId: string },
): value is DebugTraceContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const trace = value as Record<string, unknown>;
  if (
    Object.keys(trace).sort().join(",") !==
      "requestId,rootSpanId,source,traceId,version" ||
    trace["version"] !== 1 ||
    trace["requestId"] !== expected.requestId ||
    !["cli", "mcp"].includes(String(trace["source"])) ||
    typeof trace["traceId"] !== "string" ||
    !/^[a-f0-9]{32}$/.test(trace["traceId"]) ||
    typeof trace["rootSpanId"] !== "string" ||
    !/^[a-f0-9]{16}$/.test(trace["rootSpanId"])
  )
    return false;
  let expectedTrace: DebugTraceContext | undefined;
  try {
    expectedTrace = createDebugTraceContext(
      expected.requestId,
      expected.clientId,
      trace["source"] as DebugTraceSource,
      true,
    );
  } catch {
    return false;
  }
  return (
    trace["traceId"] === expectedTrace?.traceId &&
    trace["rootSpanId"] === expectedTrace.rootSpanId
  );
}

type DebugTraceSink = Pick<ReturnType<typeof createDiagnosticLog>, "write">;
export interface DebugTraceWriterOptions {
  readonly sink?: DebugTraceSink;
  readonly now?: () => number;
  readonly pid?: number;
  readonly newSpanId?: () => string;
}

export interface DebugTraceReadOptions {
  readonly directory?: string;
  readonly io?: typeof fs;
  readonly maxFiles?: number;
  readonly maxEvents?: number;
}

const eventKeys = new Set<keyof DebugTraceEvent>([
  "stage",
  "status",
  "jobId",
  "rpcId",
  "buildHash",
  "sourceHash",
  "code",
  "durationMs",
  "sdkPid",
  "sdkBirth",
  "sdkVersion",
  "artifactRef",
  "rawBytes",
  "rawSha256",
  "responseKeys",
  "contentCount",
  "contentTextBytes",
  "structuredBytes",
  "messageBytes",
  "stdoutBytes",
  "frameBytes",
  "httpStatus",
  "stdoutObservation",
]);
const traceStages = new Set<DebugTraceStage>([
  "request-accepted",
  "preflight",
  "sdk-dispatch",
  "raw-received",
  "parsed",
  "native-receipt",
  "result-published",
  "caller-received",
  "stdout-written",
]);
const traceStatuses = new Set([
  "started",
  "passed",
  "failed",
  "unknown",
  "not_observed",
  "published",
  "returned",
  "written",
]);
const stdoutObservations = new Set([
  "not_observed",
  "observed_empty",
  "observed_nonempty",
]);
const responseFieldKeys = new Set([
  "jsonrpc",
  "id",
  "result",
  "error",
  "content",
  "structuredContent",
  "isError",
  "message",
  "stdout",
  "stderr",
  "success",
  "status",
  "code",
  "outputs",
  "type",
  "text",
  "data",
  "protocolVersion",
  "tools",
  "resourceTemplates",
  "fmcad",
]);

function safeEvent(
  context: DebugTraceContext,
  event: DebugTraceEvent,
  spanId: string,
) {
  const input = event as unknown as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !eventKeys.has(key as keyof DebugTraceEvent),
    )
  )
    return null;
  if (!traceStages.has(event.stage)) return null;
  if (event.status !== undefined && !traceStatuses.has(event.status))
    return null;
  if (
    event.stdoutObservation !== undefined &&
    !stdoutObservations.has(event.stdoutObservation)
  )
    return null;
  const result: Record<string, unknown> = {
    schema: "fmcad-debug-trace-v1",
    traceId: context.traceId,
    spanId,
    ...(event.stage === "request-accepted"
      ? {}
      : { parentSpanId: context.rootSpanId }),
    stage: event.stage,
    at: new Date().toISOString(),
    pid: process.pid,
    source: context.source,
    requestId: safeId(context.requestId)
      ? context.requestId
      : digest(context.requestId).slice(0, 32),
    ...(safeId(context.requestId) ? {} : { requestIdHashed: true }),
  };
  for (const key of ["status", "stdoutObservation"] as const) {
    const value = event[key];
    if (value !== undefined) result[key] = value;
  }
  for (const key of ["jobId", "rpcId"] as const) {
    const value = event[key];
    if (value !== undefined && safeId(value)) result[key] = value;
  }
  if (
    event.artifactRef !== undefined &&
    /^(?:(?:received-response|remote)-[a-f0-9-]{36}\.json|rpc-result\.json|(?:stdout|stderr)\.txt)$/.test(
      event.artifactRef,
    )
  )
    result["artifactRef"] = event.artifactRef;
  for (const key of ["buildHash", "sourceHash", "rawSha256"] as const) {
    const value = event[key];
    if (value !== undefined && /^[a-f0-9]{64}$/.test(value))
      result[key] = value;
  }
  if (event.code !== undefined && /^[A-Z][A-Z0-9_]{0,63}$/.test(event.code))
    result["code"] = event.code;
  for (const key of [
    "durationMs",
    "sdkPid",
    "rawBytes",
    "contentCount",
    "contentTextBytes",
    "structuredBytes",
    "messageBytes",
    "stdoutBytes",
    "frameBytes",
    "httpStatus",
  ] as const) {
    const value = event[key];
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0)
      result[key] = value;
  }
  if (
    event.durationMs !== undefined &&
    Number.isFinite(event.durationMs) &&
    event.durationMs >= 0 &&
    event.durationMs <= 2_147_483_647
  )
    result["durationMs"] = Math.round(event.durationMs * 1000) / 1000;
  if (event.sdkBirth !== undefined && /^\d{1,32}$/.test(event.sdkBirth))
    result["sdkBirth"] = event.sdkBirth;
  if (
    event.sdkVersion !== undefined &&
    /^[A-Za-z0-9._+-]{1,64}$/.test(event.sdkVersion)
  )
    result["sdkVersion"] = event.sdkVersion;
  if (event.responseKeys !== undefined)
    result["responseKeys"] = event.responseKeys
      .filter((key) => responseFieldKeys.has(key))
      .slice(0, 24);
  return result;
}

export function summarizeDebugTraceRaw(raw: string): {
  rawBytes: number;
  rawSha256: string;
  responseKeys: string[];
  contentCount?: number;
  contentTextBytes?: number;
  structuredBytes?: number;
  messageBytes?: number;
  stdoutBytes?: number;
  stdoutObservation: "not_observed" | "observed_empty" | "observed_nonempty";
} {
  const result: ReturnType<typeof summarizeDebugTraceRaw> = {
    rawBytes: Buffer.byteLength(raw, "utf8"),
    rawSha256: digest(raw),
    responseKeys: [],
    stdoutObservation: "not_observed",
  };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return result;
    const response = value as Record<string, unknown>;
    result.responseKeys = Object.keys(response).slice(0, 24);
    const payload = response["result"];
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return result;
    const body = payload as Record<string, unknown>;
    const structured =
      body["structuredContent"] &&
      typeof body["structuredContent"] === "object" &&
      !Array.isArray(body["structuredContent"])
        ? (body["structuredContent"] as Record<string, unknown>)
        : undefined;
    const content = Array.isArray(body["content"]) ? body["content"] : [];
    result.contentCount = content.length;
    result.contentTextBytes = 0;
    let stdout =
      typeof structured?.["stdout"] === "string"
        ? structured["stdout"]
        : undefined;
    for (const item of content) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof (item as Record<string, unknown>)["text"] !== "string"
      )
        continue;
      const text = (item as Record<string, unknown>)["text"] as string;
      result.contentTextBytes += Buffer.byteLength(text, "utf8");
      if (stdout === undefined && text.trimStart().startsWith("{")) {
        try {
          const decoded: unknown = JSON.parse(text);
          if (
            decoded &&
            typeof decoded === "object" &&
            !Array.isArray(decoded) &&
            typeof (decoded as Record<string, unknown>)["stdout"] === "string"
          )
            stdout = (decoded as Record<string, unknown>)["stdout"] as string;
        } catch {
          // Content text is not necessarily a structured public result.
        }
      }
    }
    if (structured) {
      try {
        result.structuredBytes = Buffer.byteLength(
          JSON.stringify(structured),
          "utf8",
        );
      } catch {
        // Keep sizes unavailable instead of inspecting arbitrary values further.
      }
    }
    if (typeof body["message"] === "string")
      result.messageBytes = Buffer.byteLength(body["message"], "utf8");
    if (stdout !== undefined) {
      result.stdoutBytes = Buffer.byteLength(stdout, "utf8");
      result.stdoutObservation =
        stdout.length === 0 ? "observed_empty" : "observed_nonempty";
    }
  } catch {
    // Hash and byte count remain valid even when the raw response is malformed.
  }
  return result;
}

/** A trace is metadata-only and never affects execution or UNKNOWN settlement. */
export function createDebugTraceWriter(options: DebugTraceWriterOptions = {}) {
  const sink = options.sink;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const newSpanId = options.newSpanId ?? (() => randomBytes(8).toString("hex"));
  let sequence = 0;
  return {
    write(
      context: DebugTraceContext | undefined,
      event: DebugTraceEvent,
    ): void {
      if (
        !context ||
        !sink ||
        context.version !== 1 ||
        !safeIdentity(context.requestId) ||
        !["cli", "mcp"].includes(context.source) ||
        !/^[a-f0-9]{32}$/.test(context.traceId) ||
        !/^[a-f0-9]{16}$/.test(context.rootSpanId)
      )
        return;
      try {
        const spanId =
          event.stage === "request-accepted" ? context.rootSpanId : newSpanId();
        if (!/^[a-f0-9]{16}$/.test(spanId) || /^0+$/.test(spanId)) return;
        const value = safeEvent(context, event, spanId);
        if (!value) return;
        value["sequence"] = ++sequence;
        value["at"] = new Date(now()).toISOString();
        value["pid"] = pid;
        sink.write(JSON.stringify(value));
      } catch {
        // Debug evidence must never change request, parser, or UNKNOWN behavior.
      }
    },
  };
}

let debugLog: ReturnType<typeof createDiagnosticLog> | undefined;
const debugSink: DebugTraceSink = {
  write(text) {
    return (debugLog ||= createDiagnosticLog("fmcad-debug-trace", {
      maxBytes: 1024 * 1024,
      maxFiles: 8,
      maxPending: 128,
    })).write(text);
  },
};
const defaultDebugWriter = createDebugTraceWriter({
  sink: debugSink,
});

export function writeDebugTrace(
  context: DebugTraceContext | undefined,
  event: DebugTraceEvent,
): void {
  if (!context) return;
  defaultDebugWriter.write(context, event);
}

export async function flushDebugTrace(): Promise<void> {
  await debugLog?.flush();
}

/** Read a correlated trace from bounded per-process JSONL files without manual joins. */
export function readDebugTrace(
  traceId: string,
  options: DebugTraceReadOptions = {},
): Array<Record<string, unknown>> {
  if (!/^[a-f0-9]{32}$/.test(traceId))
    throw new Error("Invalid debug trace ID");
  const io = options.io ?? fs;
  const directory =
    options.directory ??
    join(tmpdir(), `fmcad-diagnostics-${process.getuid?.() ?? "user"}`);
  const maxFiles = options.maxFiles ?? 256;
  const maxEvents = options.maxEvents ?? 2048;
  if (
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 256 ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1 ||
    maxEvents > 8192
  )
    throw new Error("Invalid debug trace read limits");
  try {
    const stat = io.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe debug trace directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let names: string[];
  try {
    names = io
      .readdirSync(directory)
      .filter((name) =>
        /^fmcad-debug-trace-\d+-\d+-[a-f0-9-]{36}\.log$/.test(name),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (names.length > maxFiles)
    throw new Error("Too many retained debug trace files to inspect safely");
  const events: Array<Record<string, unknown>> = [];
  const retainedKeys = new Set([
    "schema",
    "traceId",
    "spanId",
    "parentSpanId",
    "stage",
    "at",
    "pid",
    "source",
    "requestId",
    "requestIdHashed",
    "sequence",
    ...eventKeys,
  ]);
  for (const name of names.sort()) {
    const file = join(directory, name);
    let fd: number | undefined;
    try {
      const before = io.lstatSync(file);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        (process.getuid && before.uid !== process.getuid()) ||
        before.size > 1024 * 1024
      )
        continue;
      fd = io.openSync(
        file,
        io.constants.O_RDONLY |
          io.constants.O_NOFOLLOW |
          io.constants.O_NONBLOCK,
      );
      const opened = io.fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.nlink !== 1 ||
        opened.size > 1024 * 1024
      )
        continue;
      for (const line of io.readFileSync(fd, "utf8").split("\n")) {
        if (!line) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        const event =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
        if (
          !value ||
          !event ||
          Object.keys(event).some((key) => !retainedKeys.has(key)) ||
          event["schema"] !== "fmcad-debug-trace-v1" ||
          event["traceId"] !== traceId ||
          typeof event["spanId"] !== "string" ||
          !/^[a-f0-9]{16}$/.test(event["spanId"]) ||
          typeof event["stage"] !== "string" ||
          !traceStages.has(event["stage"] as DebugTraceStage) ||
          typeof event["at"] !== "string" ||
          typeof event["pid"] !== "number" ||
          !Number.isSafeInteger(event["pid"]) ||
          (event["sequence"] !== undefined &&
            (!Number.isSafeInteger(event["sequence"]) ||
              Number(event["sequence"]) < 1)) ||
          !["cli", "mcp"].includes(String(event["source"])) ||
          typeof event["requestId"] !== "string"
        )
          continue;
        events.push(event);
        if (events.length > maxEvents)
          throw new Error("Debug trace exceeds the safe event limit");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    } finally {
      if (fd !== undefined) io.closeSync(fd);
    }
  }
  return events.sort((left, right) => {
    const at = String(left["at"] ?? "").localeCompare(
      String(right["at"] ?? ""),
    );
    if (at) return at;
    const pid = Number(left["pid"] ?? 0) - Number(right["pid"] ?? 0);
    if (pid) return pid;
    const sequence =
      Number(left["sequence"] ?? 0) - Number(right["sequence"] ?? 0);
    if (sequence) return sequence;
    return String(left["spanId"] ?? "").localeCompare(
      String(right["spanId"] ?? ""),
    );
  });
}

/** Disposable diagnostics only. Never use this writer for outcomes or receipts. */
export function createDiagnosticLog(
  service: string,
  options: DiagnosticLogOptions = {},
) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(service))
    throw new Error("Invalid diagnostic service");
  const io = options.io ?? fs;
  const now = options.now ?? Date.now;
  const directory =
    options.directory ??
    join(tmpdir(), `fmcad-diagnostics-${process.getuid?.() ?? "user"}`);
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const maxFiles = options.maxFiles ?? 4;
  const maxPending = options.maxPending ?? 128;
  const maxAgeMs = options.maxAgeMs ?? 7 * 86400_000;
  if (
    ![maxBytes, maxFiles, maxPending, maxAgeMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    maxBytes < 128 ||
    maxFiles > 100 ||
    maxPending > 1024
  )
    throw new Error("Invalid diagnostic limits");
  const isAlive =
    options.isAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    });
  type OwnedFile = { path: string; dev: number; ino: number; bytes: number };
  const owned: OwnedFile[] = [];
  let current: OwnedFile | undefined;
  let pending = 0,
    dropped = 0,
    errors = 0,
    closed = false;
  let work = Promise.resolve();
  function safe(stat: fs.Stats): boolean {
    return (
      stat.isFile() &&
      stat.nlink === 1 &&
      (!process.getuid || stat.uid === process.getuid())
    );
  }
  function remove(file: OwnedFile): void {
    try {
      const stat = io.lstatSync(file.path);
      if (safe(stat) && stat.dev === file.dev && stat.ino === file.ino)
        io.unlinkSync(file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  function prepare(): void {
    io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = io.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe diagnostic directory");
    io.chmodSync(directory, 0o700);
  }
  function cleanup(): void {
    const candidates: Array<OwnedFile & { at: number }> = [];
    const dir = io.opendirSync(directory);
    try {
      let entry: fs.Dirent | null;
      let count = 0;
      while ((entry = dir.readSync())) {
        // Do not perform an unbounded directory scan on the observation path.
        if (++count > 256) break;
        const match = entry.name.match(
          new RegExp(`^${service}-(\\d+)-(\\d+)-[a-f0-9-]{36}\\.log$`),
        );
        if (!match || !entry.isFile()) continue;
        const pid = Number(match[2]),
          at = Number(match[1]);
        if (
          !Number.isSafeInteger(pid) ||
          pid < 1 ||
          !Number.isSafeInteger(at) ||
          isAlive(pid)
        )
          continue;
        const file = join(directory, entry.name);
        const stat = io.lstatSync(file);
        if (safe(stat))
          candidates.push({
            path: file,
            dev: stat.dev,
            ino: stat.ino,
            bytes: stat.size,
            at,
          });
      }
    } finally {
      dir.closeSync();
    }
    candidates.sort((a, b) => b.at - a.at);
    for (const [index, file] of candidates.entries())
      if (index >= maxFiles || now() - file.at > maxAgeMs) remove(file);
  }
  function append(text: string): void {
    prepare();
    const bytes = Buffer.from(
      redactDiagnostic(text).slice(0, maxBytes),
      "utf8",
    ).subarray(0, maxBytes - 1);
    const record = Buffer.concat([bytes, Buffer.from("\n")]);
    if (
      !current ||
      current.bytes + record.length > maxBytes ||
      !io.existsSync(current.path)
    ) {
      cleanup();
      const file = join(
        directory,
        `${service}-${now()}-${process.pid}-${randomUUID()}.log`,
      );
      const fd = io.openSync(
        file,
        io.constants.O_CREAT |
          io.constants.O_EXCL |
          io.constants.O_WRONLY |
          io.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = io.fstatSync(fd);
        current = { path: file, dev: stat.dev, ino: stat.ino, bytes: 0 };
        owned.push(current);
      } finally {
        io.closeSync(fd);
      }
      while (owned.length > maxFiles) remove(owned.shift()!);
    }
    const fd = io.openSync(
      current.path,
      io.constants.O_APPEND |
        io.constants.O_WRONLY |
        io.constants.O_NOFOLLOW |
        io.constants.O_NONBLOCK,
    );
    try {
      const stat = io.fstatSync(fd);
      if (
        !safe(stat) ||
        stat.dev !== current.dev ||
        stat.ino !== current.ino ||
        stat.size + record.length > maxBytes
      )
        throw new Error("Diagnostic file identity changed");
      io.writeFileSync(fd, record);
      current.bytes = stat.size + record.length;
    } finally {
      io.closeSync(fd);
    }
  }
  return {
    directory,
    write(text: string): boolean {
      if (closed || pending >= maxPending) {
        dropped++;
        return false;
      }
      // Bound retained input before queueing. Redaction still precedes disk IO.
      const bounded = text.slice(0, Math.min(maxBytes, 8192));
      pending++;
      work = work
        .then(() => append(bounded))
        .catch(() => {
          errors++;
        })
        .finally(() => {
          pending--;
        });
      return true;
    },
    stats: () => ({ pending, dropped, errors }),
    async close(): Promise<void> {
      closed = true;
      await work;
    },
    async flush(): Promise<void> {
      await work;
    },
  };
}

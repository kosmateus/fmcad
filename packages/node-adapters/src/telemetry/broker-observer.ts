import { createRequire } from "node:module";
import path from "node:path";
import type {
  DebugTraceContext,
  DebugTraceEvent,
  DebugTraceIpcStage,
} from "./diagnostic-log";

const load = createRequire(__filename);
let traceLog: typeof import("./diagnostic-log") | undefined;
function debugLog() {
  return (traceLog ??= load(
    "./diagnostic-log",
  ) as typeof import("./diagnostic-log"));
}

interface TraceRequest {
  readonly requestId: string;
  readonly debugTrace?: unknown;
}

export function debugTraceContext(
  request: TraceRequest | undefined,
  clientId: string,
): DebugTraceContext | undefined {
  if (!request?.debugTrace) return undefined;
  try {
    return debugLog().validDebugTraceContext(request.debugTrace, {
      requestId: request.requestId,
      clientId,
    })
      ? request.debugTrace
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeRequestTrace(
  request: TraceRequest | undefined,
  clientId: string,
  event: DebugTraceEvent,
): void {
  try {
    const context = debugTraceContext(request, clientId);
    if (context) debugLog().writeDebugTrace(context, event);
  } catch {
    // Optional debug evidence must not affect queue behavior.
  }
}

export function summarizeBrokerRaw(raw: string) {
  try {
    return debugLog().summarizeDebugTraceRaw(raw);
  } catch {
    return undefined;
  }
}

interface TraceJob extends TraceRequest {
  readonly clientId: string;
  readonly buildHash: string;
}

interface IpcTrace {
  readonly context: DebugTraceContext;
  readonly action: "worker-status" | "backend";
  readonly messageId: string;
  readonly jobId: string;
  readonly buildHash: string;
  readonly monotonicStartMs: number;
  deadlineMonotonicMs?: number;
}

function writeIpcTrace(
  trace: IpcTrace,
  ipcStage: DebugTraceIpcStage,
  fields: Partial<DebugTraceEvent>,
): void {
  try {
    debugLog().writeDebugTrace(trace.context, {
      stage: "ipc",
      ipcStage,
      action: trace.action,
      messageId: trace.messageId,
      jobId: trace.jobId,
      ...(trace.buildHash ? { buildHash: trace.buildHash } : {}),
      monotonicStartMs: trace.monotonicStartMs,
      ...(trace.deadlineMonotonicMs === undefined
        ? {}
        : { deadlineMonotonicMs: trace.deadlineMonotonicMs }),
      ...fields,
    });
  } catch {
    // Optional debug evidence must not affect broker behavior.
  }
}

export function createBrokerIpcObserver(
  lookupJob: (id: string) => TraceJob | undefined,
) {
  const traces = new WeakMap<object, IpcTrace>();

  function readTrace(input: object): IpcTrace | undefined {
    try {
      if (Array.isArray(input)) return undefined;
      const message = input as Record<string, unknown>;
      const action = message["action"];
      const jobId = message["jobId"];
      const messageId = message["debugTraceMessageId"];
      if (
        (action !== "backend" && action !== "worker-status") ||
        typeof jobId !== "string" ||
        typeof messageId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(messageId)
      )
        return undefined;
      const job = lookupJob(jobId);
      const context = job && debugTraceContext(job, job.clientId);
      if (!context) return undefined;
      const monotonicStartMs = performance.now();
      const deadlineBudgetMs = message["rpcTimeoutMs"];
      return {
        context,
        action,
        messageId,
        jobId,
        buildHash: job.buildHash,
        monotonicStartMs,
        ...(action === "backend" &&
        typeof deadlineBudgetMs === "number" &&
        Number.isSafeInteger(deadlineBudgetMs) &&
        deadlineBudgetMs > 0
          ? { deadlineMonotonicMs: monotonicStartMs + deadlineBudgetMs }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  return {
    start(input: unknown) {
      if (!input || typeof input !== "object") return;
      const trace = readTrace(input);
      if (!trace) return;
      traces.set(input, trace);
      writeIpcTrace(trace, "handler-start", { status: "started" });
    },
    accept(input: object, timeoutMs?: number) {
      const stored = traces.get(input);
      if (stored && timeoutMs !== undefined)
        stored.deadlineMonotonicMs = performance.now() + timeoutMs;
      const trace = stored ?? readTrace(input);
      if (trace)
        writeIpcTrace(trace, "request-accepted", {
          status: "passed",
          monotonicAtMs: performance.now(),
        });
    },
    reply(input: unknown, ok: boolean, code?: string) {
      if (!input || typeof input !== "object") return;
      const trace = traces.get(input);
      if (!trace) return;
      const monotonicEndMs = performance.now();
      writeIpcTrace(trace, "reply-emitted", {
        status: ok ? "passed" : "failed",
        ...(typeof code === "string" && code ? { code } : {}),
        monotonicAtMs: monotonicEndMs,
        monotonicEndMs,
        durationMs: monotonicEndMs - trace.monotonicStartMs,
      });
    },
  };
}

/** Publish read-only observations, never authoritative completion evidence. */
export function publishBrokerDiagnostics(
  dir: string,
  write: (file: string, value: unknown) => void,
  queue: () => object,
  console: () => object,
): void {
  try {
    write(path.join(dir, "queue-diagnostics.json"), {
      at: Date.now(),
      ...queue(),
    });
    write(path.join(dir, "console-state.json"), {
      at: Date.now(),
      ...console(),
    });
  } catch {
    // Publication failure cannot change execution or ownership.
  }
}

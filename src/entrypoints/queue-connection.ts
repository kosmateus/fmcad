import { createHash, randomUUID } from "node:crypto";
import * as net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  DebugTraceContext,
  DebugTraceEvent,
  DebugTraceIpcStage,
} from "../../packages/node-adapters/src/telemetry/diagnostic-log";

const runtimeRequire = createRequire(__filename);
const { resolveRuntimePaths } = runtimeRequire(
  "../../dist/config-platform",
) as {
  resolveRuntimePaths(options: { anchor: string }): { state: string };
};

const MAX_MESSAGE = 16 * 1024 * 1024;

interface QueueRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly ipcTrace?: IpcTraceRequest;
}

interface QueueResponseError {
  readonly code?: string;
  readonly message?: string;
  readonly notStarted?: boolean;
  readonly pythonCheck?: unknown;
}

interface QueueResponse extends Record<string, unknown> {
  readonly ok?: boolean;
  readonly error?: QueueResponseError;
  readonly result?: unknown;
}

interface WorkerMessage extends Record<string, unknown> {
  readonly jobId?: string;
  readonly workerToken?: string;
}

interface WorkerRequestOptions {
  readonly pollMs?: number;
  /** Test-only heartbeat deadline override; production keeps request()'s 30 s default. */
  readonly heartbeatTimeoutMs?: number;
  readonly debugTrace?: DebugTraceContext;
  readonly buildHash?: string;
}

interface IpcTraceRequest {
  readonly context: DebugTraceContext;
  readonly action: NonNullable<DebugTraceEvent["action"]>;
  readonly messageId: string;
  readonly jobId?: string;
  readonly buildHash?: string;
  readonly deadlineBudgetMs?: number;
}

type DebugTraceRuntime = {
  writeDebugTrace(
    context: DebugTraceContext | undefined,
    event: DebugTraceEvent,
  ): void;
};

let loadedDebugTraceRuntime: DebugTraceRuntime | undefined;

function writeIpcTrace(
  trace: IpcTraceRequest | undefined,
  ipcStage: DebugTraceIpcStage,
  fields: Partial<DebugTraceEvent> = {},
): void {
  if (!trace) return;
  try {
    const runtime = (loadedDebugTraceRuntime ||= runtimeRequire(
      "../node-adapters/telemetry/diagnostic-log.js",
    ) as DebugTraceRuntime);
    runtime.writeDebugTrace(trace.context, {
      stage: "ipc",
      ipcStage,
      action: trace.action,
      messageId: trace.messageId,
      ...(trace.jobId ? { jobId: trace.jobId } : {}),
      ...(trace.buildHash ? { buildHash: trace.buildHash } : {}),
      ...fields,
    });
  } catch {
    // Optional debug evidence must never change IPC behavior.
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function queueDirectory(): string {
  return path.join(resolveRuntimePaths({ anchor: __filename }).state, "queue");
}

export function queueSocket(dir = queueDirectory()): string {
  if (process.platform === "win32")
    return (
      "\\\\.\\pipe\\fmcad-" +
      createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 24)
    );
  const socket = path.join(dir, "broker.sock");
  if (Buffer.byteLength(socket) > 103)
    throw new Error(
      "Queue state path is too long for a Unix socket; use a shorter XDG_STATE_HOME",
    );
  return socket;
}

export function request(
  dir: string,
  message: Record<string, unknown>,
  { timeoutMs = 30000, signal, ipcTrace }: QueueRequestOptions = {},
): Promise<unknown> {
  const payload = Buffer.from(
    JSON.stringify(
      ipcTrace
        ? { ...message, debugTraceMessageId: ipcTrace.messageId }
        : message,
    ) + "\n",
  );
  if (payload.length > MAX_MESSAGE)
    return Promise.reject(new Error("Queue request exceeds 16 MiB"));
  const monotonicStartMs = performance.now();
  const deadlineBudgetMs =
    timeoutMs > 0 ? timeoutMs : ipcTrace?.deadlineBudgetMs;
  const deadlineMonotonicMs =
    ipcTrace && deadlineBudgetMs !== undefined
      ? monotonicStartMs! + deadlineBudgetMs
      : undefined;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(queueSocket(dir));
    let data = Buffer.alloc(0);
    let settled = false;
    const traceEvent = (
      ipcStage: DebugTraceIpcStage,
      fields: Partial<DebugTraceEvent> = {},
    ) => {
      if (!ipcTrace || monotonicStartMs === undefined) return;
      writeIpcTrace(ipcTrace, ipcStage, {
        monotonicStartMs,
        ...(deadlineMonotonicMs === undefined ? {} : { deadlineMonotonicMs }),
        ...fields,
      });
    };
    const traceEnd = () => {
      const monotonicEndMs = performance.now();
      return {
        monotonicEndMs,
        durationMs: monotonicEndMs - (monotonicStartMs ?? monotonicEndMs),
      };
    };
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      signal?.removeEventListener("abort", abort);
      if (error) {
        if (
          ["register", "submit", "find-request", "result"].includes(
            String(message["action"]),
          )
        ) {
          const input = message["request"],
            requestId =
              input && typeof input === "object" && "requestId" in input
                ? input.requestId
                : (message["requestId"] ?? ipcTrace?.context.requestId),
            jobId = message["jobId"],
            safeIdentity = (value: unknown): value is string =>
              typeof value === "string" &&
              value.length > 0 &&
              value.length <= 256 &&
              !/[\u0000-\u001f\u007f]/u.test(value);
          Object.assign(error, {
            action: message["action"],
            ...(safeIdentity(requestId) ? { requestId } : {}),
            ...(safeIdentity(jobId) ? { jobId } : {}),
            timeoutMs,
            monotonicStartMs,
            ...traceEnd(),
            ...(timeoutMs > 0
              ? { deadlineMonotonicMs: monotonicStartMs + timeoutMs }
              : {}),
          });
        }
        reject(error);
      } else resolve(value);
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (ipcTrace)
              traceEvent("timeout", {
                status: "failed",
                code: "QUEUE_IPC_TIMEOUT",
                ...traceEnd(),
              });
            finish(
              codedError(
                "QUEUE_IPC_TIMEOUT",
                `Queue IPC timeout${["register", "submit", "find-request", "result"].includes(String(message["action"])) ? ` during ${String(message["action"])}` : ""}; an accepted job is not cancelled. Inspect its requestId/jobId before resubmitting.`,
              ),
            );
          }, timeoutMs)
        : undefined;
    const abort = (): void => {
      if (settled) return;
      if (ipcTrace)
        traceEvent("abort", {
          status: "failed",
          code: "WAIT_ABORTED",
          abortReason: errorCode(signal?.reason) || "WAIT_ABORTED",
          ...traceEnd(),
        });
      finish(
        codedError(
          "WAIT_ABORTED",
          "Stopped waiting; the accepted request is not cancelled",
        ),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    socket.once("connect", () =>
      socket.write(payload, () => {
        if (settled || !ipcTrace) return;
        traceEvent("request-written", {
          status: "written",
          monotonicAtMs: performance.now(),
        });
      }),
    );
    socket.on("error", (error) => {
      if (!settled && ipcTrace) {
        const code = errorCode(error);
        traceEvent("response-lost", {
          status: "unknown",
          ...(code ? { code } : {}),
          ...traceEnd(),
        });
      }
      finish(error);
    });
    socket.on("data", (chunk: Buffer) => {
      if (data.length + chunk.length > MAX_MESSAGE) {
        if (ipcTrace)
          traceEvent("response-lost", {
            status: "unknown",
            code: "QUEUE_IPC_RESPONSE_TOO_LARGE",
            ...traceEnd(),
          });
        finish(new Error("Queue response exceeds 16 MiB"));
        return;
      }
      data = Buffer.concat([data, chunk]);
      const newline = data.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(
          data.subarray(0, newline).toString("utf8"),
        ) as QueueResponse;
        if (ipcTrace) {
          const responseCode =
            response.ok === true
              ? undefined
              : response.error?.code || "QUEUE_ERROR";
          traceEvent("reply-received", {
            status: response.ok === true ? "passed" : "failed",
            ...(responseCode ? { code: responseCode } : {}),
            ...traceEnd(),
          });
        }
        if (response.ok !== true) {
          const error = response.error;
          const failure = Object.assign(
            new Error(error?.message || "Queue request failed"),
            {
              code: error?.code || "QUEUE_ERROR",
              ...(error?.notStarted === true ? { notStarted: true } : {}),
              ...(error?.pythonCheck ? { pythonCheck: error.pythonCheck } : {}),
            },
          );
          finish(failure);
          return;
        }
        finish(null, response.result);
      } catch (error) {
        if (ipcTrace)
          traceEvent("reply-received", {
            status: "failed",
            code: "QUEUE_IPC_INVALID_RESPONSE",
            ...traceEnd(),
          });
        finish(error as Error);
      }
    });
    socket.once("end", () => {
      if (!settled) {
        if (ipcTrace)
          traceEvent("response-lost", {
            status: "unknown",
            code: "QUEUE_IPC_RESPONSE_LOST",
            ...traceEnd(),
          });
        finish(
          codedError(
            "QUEUE_IPC_RESPONSE_LOST",
            "Queue response ended without a receipt; inspect the existing job before retry",
          ),
        );
      }
    });
  });
}

export async function acceptedWorkerRequest(
  dir: string,
  message: WorkerMessage,
  {
    pollMs = 1000,
    heartbeatTimeoutMs,
    debugTrace,
    buildHash,
  }: WorkerRequestOptions = {},
): Promise<unknown> {
  const controller = new AbortController();
  let stopped = false;
  let heartbeatError: Error | undefined;
  const heartbeat = async (): Promise<void> => {
    while (!stopped) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        timer.unref();
      });
      if (stopped) break;
      try {
        const heartbeatTrace =
          debugTrace && typeof message.jobId === "string"
            ? {
                context: debugTrace,
                action: "worker-status" as const,
                messageId: randomUUID(),
                jobId: message.jobId,
                ...(buildHash ? { buildHash } : {}),
              }
            : undefined;
        const requestOptions =
          heartbeatTimeoutMs === undefined && !heartbeatTrace
            ? undefined
            : {
                ...(heartbeatTimeoutMs === undefined
                  ? {}
                  : { timeoutMs: heartbeatTimeoutMs }),
                ...(heartbeatTrace ? { ipcTrace: heartbeatTrace } : {}),
              };
        await request(
          dir,
          {
            action: "worker-status",
            jobId: message.jobId,
            workerToken: message.workerToken,
          },
          requestOptions,
        );
      } catch (error) {
        if (!stopped) {
          heartbeatError = error as Error;
          controller.abort(error);
        }
        break;
      }
    }
  };
  void heartbeat();
  try {
    return await request(dir, message, {
      timeoutMs: 0,
      signal: controller.signal,
      ...(debugTrace && typeof message.jobId === "string"
        ? {
            ipcTrace: {
              context: debugTrace,
              action: "backend",
              messageId: randomUUID(),
              jobId: message.jobId,
              ...(typeof message["rpcTimeoutMs"] === "number" &&
              Number.isSafeInteger(message["rpcTimeoutMs"]) &&
              message["rpcTimeoutMs"] > 0
                ? { deadlineBudgetMs: message["rpcTimeoutMs"] }
                : {}),
              ...(buildHash ? { buildHash } : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    throw heartbeatError || error;
  } finally {
    stopped = true;
  }
}

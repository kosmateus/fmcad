import { createHash } from "node:crypto";
import * as net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";

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
  { timeoutMs = 30000, signal }: QueueRequestOptions = {},
): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify(message) + "\n");
  if (payload.length > MAX_MESSAGE)
    return Promise.reject(new Error("Queue request exceeds 16 MiB"));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(queueSocket(dir));
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(
            () =>
              finish(
                codedError(
                  "QUEUE_IPC_TIMEOUT",
                  "Queue IPC timeout; an accepted job is not cancelled. Inspect its requestId/jobId before resubmitting.",
                ),
              ),
            timeoutMs,
          )
        : undefined;
    const abort = (): void =>
      finish(
        codedError(
          "WAIT_ABORTED",
          "Stopped waiting; the accepted request is not cancelled",
        ),
      );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    socket.once("connect", () => socket.write(payload));
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => {
      if (data.length + chunk.length > MAX_MESSAGE) {
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
        finish(error as Error);
      }
    });
    socket.once("end", () => {
      if (!settled)
        finish(
          codedError(
            "QUEUE_IPC_RESPONSE_LOST",
            "Queue response ended without a receipt; inspect the existing job before retry",
          ),
        );
    });
  });
}

export async function acceptedWorkerRequest(
  dir: string,
  message: WorkerMessage,
  { pollMs = 1000 }: WorkerRequestOptions = {},
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
        await request(dir, {
          action: "worker-status",
          jobId: message.jobId,
          workerToken: message.workerToken,
        });
      } catch (error) {
        if (!stopped) {
          heartbeatError = error as Error;
          controller.abort();
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
    });
  } catch (error) {
    throw heartbeatError || error;
  } finally {
    stopped = true;
  }
}

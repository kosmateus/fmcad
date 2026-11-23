import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { CadContext, CadData, QueueRequest } from "@fmcad/core";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact.js";
import type { ParamCheckpointGuardV1 } from "../packages/node-adapters/src/python/cad-script.js";
import type { ContinuationPrograms } from "./document-continuation-broker.js";

const runtimeRequire = createRequire(__filename);
const workerFilename = runtimeRequire.resolve(
  "./broker-source-compiler-worker.js",
);
const DEFAULT_CONCURRENCY = 10;

type CompilerTaskInput =
  | {
      kind: "continuation";
      request: QueueRequest;
      checkpoint: ParamCheckpointGuardV1;
    }
  | {
      kind: "cad";
      operation: string;
      data: CadData;
      context: CadContext;
      checkpoint?: ParamCheckpointGuardV1;
      privateReadback?: "param-checkpoint";
    };
type CompilerTask = CompilerTaskInput & { id: number };
type CompilerResponse =
  | { id: number; ok: true; result: unknown }
  | {
      id: number;
      ok: false;
      error: { name: string; message: string; code?: string };
    };
type CompilerError = Error & { code: string };
type Outcome = { ok: true; value: unknown } | { ok: false; error: Error };
type PendingTask = {
  readonly input: CompilerTask;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly finished: Promise<void>;
  finish(): void;
};
type ActiveTask = {
  readonly worker: Worker;
  readonly task: PendingTask;
  settling: boolean;
};

function compilerError(
  code: string,
  message: string,
  name = "BrokerSourceCompilerError",
): CompilerError {
  const error = new Error(message.slice(0, 2048)) as CompilerError;
  error.name = name.slice(0, 128);
  error.code = code.slice(0, 128);
  return error;
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneInput<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw compilerError(
      "SOURCE_COMPILER_INVALID_INPUT",
      "Compiler input must be structured-cloneable",
    );
  }
}

function isResponse(value: unknown): value is CompilerResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row["id"])) return false;
  if (row["ok"] === true) return Object.hasOwn(row, "result");
  if (row["ok"] !== false) return false;
  const error = row["error"];
  return (
    objectRecord(error) &&
    typeof error["name"] === "string" &&
    typeof error["message"] === "string" &&
    (error["code"] === undefined || typeof error["code"] === "string")
  );
}

function workerError(error: CompilerResponse & { ok: false }): Error {
  return compilerError(
    error.error.code ?? "SOURCE_COMPILATION_FAILED",
    error.error.message,
    error.error.name,
  );
}

/** Run the broker's existing pure source compilers off its main event loop. */
export function createBrokerSourceCompiler(
  options: { concurrency?: number } = {},
) {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw compilerError(
      "INVALID_SOURCE_COMPILER_CONCURRENCY",
      "Source compiler concurrency must be a positive integer",
    );

  const queue: PendingTask[] = [];
  const active = new Set<ActiveTask>();
  let nextId = 0;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  function complete(slot: ActiveTask, outcome: Outcome): void {
    active.delete(slot);
    if (outcome.ok) slot.task.resolve(outcome.value);
    else slot.task.reject(outcome.error);
    slot.task.finish();
    pump();
  }

  function terminate(slot: ActiveTask, outcome: Outcome): Promise<void> {
    if (slot.settling) return slot.task.finished;
    slot.settling = true;
    void slot.worker.terminate().then(
      () => complete(slot, outcome),
      () =>
        complete(slot, {
          ok: false,
          error: compilerError(
            "SOURCE_COMPILER_TERMINATION",
            "Unable to stop compiler worker",
          ),
        }),
    );
    return slot.task.finished;
  }

  function start(task: PendingTask): void {
    let worker: Worker;
    try {
      worker = new Worker(workerFilename, {
        name: "fmcad-source-compiler",
      });
    } catch (error) {
      task.reject(
        compilerError(
          "SOURCE_COMPILER_WORKER_START",
          error instanceof Error
            ? error.message
            : "Unable to start compiler worker",
          error instanceof Error ? error.name : "Error",
        ),
      );
      task.finish();
      return;
    }
    const slot: ActiveTask = { worker, task, settling: false };
    active.add(slot);
    worker.on("message", (value: unknown) => {
      if (slot.settling) return;
      if (!isResponse(value) || value.id !== task.input.id) {
        void terminate(slot, {
          ok: false,
          error: compilerError(
            "SOURCE_COMPILER_PROTOCOL_ERROR",
            "Compiler worker returned an invalid response",
          ),
        });
        return;
      }
      if (!value.ok) {
        void terminate(slot, { ok: false, error: workerError(value) });
        return;
      }
      void terminate(slot, { ok: true, value: value.result });
    });
    worker.on("messageerror", () => {
      void terminate(slot, {
        ok: false,
        error: compilerError(
          "SOURCE_COMPILER_PROTOCOL_ERROR",
          "Compiler worker response could not be decoded",
        ),
      });
    });
    worker.on("error", (error) => {
      void terminate(slot, {
        ok: false,
        error: compilerError(
          "SOURCE_COMPILER_WORKER_ERROR",
          error.message || "Compiler worker failed",
          error.name || "Error",
        ),
      });
    });
    worker.on("exit", (code) => {
      if (slot.settling) return;
      void terminate(slot, {
        ok: false,
        error: compilerError(
          "SOURCE_COMPILER_WORKER_EXIT",
          `Compiler worker exited before returning a result (code ${code})`,
        ),
      });
    });
    worker.ref();
    try {
      worker.postMessage(task.input);
    } catch {
      void terminate(slot, {
        ok: false,
        error: compilerError(
          "SOURCE_COMPILER_INVALID_INPUT",
          "Compiler task could not be sent to its worker",
        ),
      });
    }
  }

  function pump(): void {
    while (!closed && queue.length && active.size < concurrency)
      start(queue.shift()!);
  }

  function submit<T>(input: CompilerTaskInput): Promise<T> {
    if (closed)
      return Promise.reject(
        compilerError("SOURCE_COMPILER_CLOSED", "Source compiler is closed"),
      );
    let cloned: CompilerTaskInput;
    try {
      cloned = cloneInput(input);
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : compilerError(
              "SOURCE_COMPILER_INVALID_INPUT",
              "Compiler task must be plain JSON",
            ),
      );
    }
    if (nextId >= Number.MAX_SAFE_INTEGER)
      return Promise.reject(
        compilerError(
          "SOURCE_COMPILER_TASK_LIMIT",
          "Source compiler task identity space is exhausted",
        ),
      );
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      let finish!: () => void;
      const finished = new Promise<void>((done) => {
        finish = done;
      });
      queue.push({
        input: { ...cloned, id } as CompilerTask,
        resolve: (value) => resolve(value as T),
        reject,
        finished,
        finish,
      });
      pump();
    });
  }

  return {
    continuation(
      request: QueueRequest,
      checkpoint: ParamCheckpointGuardV1,
    ): Promise<ContinuationPrograms> {
      if (!objectRecord(request) || !objectRecord(checkpoint))
        return Promise.reject(
          compilerError(
            "SOURCE_COMPILER_INVALID_INPUT",
            "Continuation requests require object inputs",
          ),
        );
      return submit<ContinuationPrograms>({
        kind: "continuation",
        request,
        checkpoint,
      });
    },
    cad(
      operation: string,
      data: CadData,
      context: CadContext,
      checkpoint?: ParamCheckpointGuardV1,
      privateReadback?: "param-checkpoint",
    ): Promise<PreparedPythonArtifact> {
      if (
        privateReadback !== undefined &&
        privateReadback !== "param-checkpoint"
      )
        return Promise.reject(
          compilerError(
            "SOURCE_COMPILER_INVALID_INPUT",
            "Unsupported private compiler readback",
          ),
        );
      if (
        typeof operation !== "string" ||
        !operation ||
        !objectRecord(data) ||
        !objectRecord(context) ||
        (checkpoint !== undefined && !objectRecord(checkpoint))
      )
        return Promise.reject(
          compilerError(
            "SOURCE_COMPILER_INVALID_INPUT",
            "CAD compilation requires an operation and object inputs",
          ),
        );
      return submit<PreparedPythonArtifact>({
        kind: "cad",
        operation,
        data,
        context,
        ...(checkpoint === undefined ? {} : { checkpoint }),
        ...(privateReadback === undefined ? {} : { privateReadback }),
      });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      const closedError = compilerError(
        "SOURCE_COMPILER_CLOSED",
        "Source compiler is closed",
      );
      for (const task of queue.splice(0)) {
        task.reject(closedError);
        task.finish();
      }
      closePromise = Promise.all(
        [...active].map((slot) => slot.task.finished),
      ).then(() => {});
      return closePromise;
    },
  };
}

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
const MAX_CONCURRENCY = 10;
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
};
type WorkerSlot = {
  readonly worker: Worker;
  readonly exited: Promise<void>;
  readonly resolveExited: () => void;
  task: PendingTask | null;
  retiring: boolean;
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
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_CONCURRENCY
  )
    throw compilerError(
      "INVALID_SOURCE_COMPILER_CONCURRENCY",
      "Source compiler concurrency must be an integer from 1 to 10",
    );

  const queue: PendingTask[] = [];
  const workers = new Set<WorkerSlot>();
  let nextId = 0;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  function settleTask(slot: WorkerSlot, outcome: Outcome): void {
    const task = slot.task;
    if (!task) return;
    slot.task = null;
    if (outcome.ok) task.resolve(outcome.value);
    else task.reject(outcome.error);
  }

  function retire(slot: WorkerSlot): void {
    if (slot.retiring) return;
    slot.retiring = true;
    slot.worker.ref();
    try {
      void slot.worker.terminate().catch(() => {
        // Keep the slot tracked until its exit event confirms termination.
      });
    } catch {
      // Keep the slot tracked until its exit event confirms termination.
    }
  }

  function failWorker(slot: WorkerSlot, error: Error): void {
    if (slot.retiring) return;
    settleTask(slot, { ok: false, error });
    retire(slot);
  }

  function receiveMessage(slot: WorkerSlot, value: unknown): void {
    if (slot.retiring) return;
    if (!isResponse(value) || value.id !== slot.task?.input.id) {
      failWorker(
        slot,
        compilerError(
          "SOURCE_COMPILER_PROTOCOL_ERROR",
          "Compiler worker returned an invalid response",
        ),
      );
      return;
    }
    if (value.ok) settleTask(slot, { ok: true, value: value.result });
    else settleTask(slot, { ok: false, error: workerError(value) });

    if (closed) retire(slot);
    else {
      slot.worker.unref();
      pump();
    }
  }

  function createWorker(): WorkerSlot {
    let worker: Worker;
    try {
      worker = new Worker(workerFilename, {
        name: "fmcad-source-compiler",
      });
    } catch (error) {
      throw compilerError(
        "SOURCE_COMPILER_WORKER_START",
        error instanceof Error
          ? error.message
          : "Unable to start compiler worker",
        error instanceof Error ? error.name : "Error",
      );
    }
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const slot: WorkerSlot = {
      worker,
      exited,
      resolveExited,
      task: null,
      retiring: false,
    };
    workers.add(slot);
    worker.on("message", (value: unknown) => receiveMessage(slot, value));
    worker.on("messageerror", () => {
      failWorker(
        slot,
        compilerError(
          "SOURCE_COMPILER_PROTOCOL_ERROR",
          "Compiler worker response could not be decoded",
        ),
      );
    });
    worker.on("error", (error) => {
      failWorker(
        slot,
        compilerError(
          "SOURCE_COMPILER_WORKER_ERROR",
          error.message || "Compiler worker failed",
          error.name || "Error",
        ),
      );
    });
    worker.on("exit", (code) => {
      if (slot.task)
        settleTask(slot, {
          ok: false,
          error: compilerError(
            "SOURCE_COMPILER_WORKER_EXIT",
            `Compiler worker exited before returning a result (code ${code})`,
          ),
        });
      slot.retiring = true;
      workers.delete(slot);
      slot.resolveExited();
      pump();
    });
    worker.unref();
    return slot;
  }

  function pump(): void {
    while (!closed && queue.length) {
      let slot = [...workers].find(
        (worker) => !worker.retiring && worker.task === null,
      );
      if (!slot) {
        if (workers.size >= concurrency) return;
        const task = queue.shift()!;
        try {
          slot = createWorker();
        } catch (error) {
          task.reject(
            error instanceof Error
              ? error
              : compilerError(
                  "SOURCE_COMPILER_WORKER_START",
                  "Unable to start compiler worker",
                ),
          );
          continue;
        }
        dispatch(slot, task);
        continue;
      }
      dispatch(slot, queue.shift()!);
    }
  }

  function dispatch(slot: WorkerSlot, task: PendingTask): void {
    slot.task = task;
    slot.worker.ref();
    try {
      slot.worker.postMessage(task.input);
    } catch (error) {
      failWorker(
        slot,
        compilerError(
          "SOURCE_COMPILER_WORKER_SEND",
          error instanceof Error
            ? error.message
            : "Compiler task could not be sent to its worker",
          error instanceof Error ? error.name : "Error",
        ),
      );
    }
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
      queue.push({
        input: { ...cloned, id } as CompilerTask,
        resolve: (value) => resolve(value as T),
        reject,
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
      }
      const closingWorkers = [...workers];
      for (const slot of closingWorkers) if (slot.task === null) retire(slot);
      closePromise = Promise.all(
        closingWorkers.map((slot) => slot.exited),
      ).then(() => {});
      return closePromise;
    },
  };
}

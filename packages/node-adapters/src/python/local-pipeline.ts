import {
  spawn,
  type SpawnOptions,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  LocalPipelineFiles,
  LocalWorker,
  LocalWorkerPlan,
  LocalWorkerPort,
  LocalWorkerResult,
} from "../../../core/src/ports/local-pipeline";

export const localPipelineFiles: LocalPipelineFiles = {
  resolve: (value) => path.resolve(value),
  readText: (value) => readFile(value, "utf8"),
};
export interface LocalProcessOptions {
  resolveWorker(worker: LocalWorker): string;
  resolvePython?: (plan: LocalWorkerPlan) => string;
  spawn?: (
    python: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcessWithoutNullStreams;
  stdout?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
  startError?: (error: Error, plan: LocalWorkerPlan) => Error;
  timeoutMs?: number;
  maxOutputBytes?: number;
  redactDiagnostic?: (text: string) => string;
}

// JSON.parse accepts exponent overflow (1e999), unlike the worker wire contract.
export function parseWorkerJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("Non-finite worker JSON number");
    return value;
  }) as unknown;
}
// Paths/assets/interpreter preflight are supplied by the composition root. No
// Fusion config, broker, SDK admission, pip install, retry or output cleanup here.
export function createLocalWorker(
  options: LocalProcessOptions,
): LocalWorkerPort {
  return {
    run(plan): Promise<LocalWorkerResult> {
      const worker = options.resolveWorker(plan.worker);
      const python = options.resolvePython?.(plan) ?? plan.python ?? "python3";
      const timeout =
        options.timeoutMs ??
        Number(process.env["FMCAD_LOCAL_WORKER_TIMEOUT_MS"] ?? 1800000);
      const limit = options.maxOutputBytes ?? 32 * 1024 * 1024;
      if (
        !Number.isSafeInteger(timeout) ||
        timeout <= 0 ||
        timeout > 86400000 ||
        !Number.isSafeInteger(limit) ||
        limit <= 0
      )
        throw new Error("Invalid local worker timeout/output limit");
      const input = JSON.stringify(plan.request);
      if (Buffer.byteLength(input) > limit)
        throw new Error("Local worker input exceeds limit");
      const args = [
        ...(plan.worker === "reference" ? ["-I", "-B"] : ["-B"]),
        worker,
        ...plan.args,
      ];
      return new Promise((resolve, reject) => {
        // The child owns a new Linux/WSL process group, never the caller's group.
        const detached = process.platform === "linux";
        const child = options.spawn
          ? options.spawn(python, args, {
              shell: false,
              stdio: ["pipe", "pipe", "pipe"],
              detached,
            })
          : spawn(python, args, {
              shell: false,
              stdio: ["pipe", "pipe", "pipe"],
              detached,
            });
        let size = 0,
          stopped = false,
          failure: Error | undefined;
        const out: Buffer[] = [],
          err: Buffer[] = [];
        const stop = () => {
          if (stopped) return;
          stopped = true;
          if (detached && child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                failure ??= error as Error;
            }
          } else if (child.exitCode === null) child.kill("SIGKILL");
        };
        const abort = () => {
          stop();
          // Escaped/inherited pipe writers cannot extend a failed request's
          // deadline. This is not a claim to own an escaped process/session.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        };
        const timer = setTimeout(() => {
          failure = new Error(`Local worker timed out after ${timeout} ms`);
          abort();
        }, timeout);
        const capture = (chunk: Buffer, target: Buffer[]) => {
          if (failure) return;
          size += chunk.length;
          if (size > limit) {
            failure = new Error("Local worker output exceeds limit");
            abort();
          } else target.push(Buffer.from(chunk));
        };
        child.stdout.on("data", (chunk: Buffer) => {
          capture(chunk, out);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          capture(chunk, err);
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(options.startError?.(error, { ...plan, python }) ?? error);
        });
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") {
            failure = error;
            abort();
          }
        });
        // A leader can exit while descendants still hold stdout open.
        child.on("exit", stop);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          stop();
          const stdout = Buffer.concat(out).toString("utf8");
          const diagnostic = Buffer.concat(err).toString("utf8");
          const stderr = options.redactDiagnostic?.(diagnostic) ?? diagnostic;
          options.stderr?.(Buffer.from(stderr));
          if (!failure && code === 0) {
            try {
              parseWorkerJson(stdout);
            } catch {
              failure = new Error(
                "Invalid local worker JSON output (expected one finite JSON value to EOF)",
              );
            }
          }
          if (failure) {
            reject(failure);
            return;
          }
          options.stdout?.(Buffer.from(stdout));
          resolve({ code, signal, stdout, stderr });
        });
        child.stdin.end(input);
      });
    },
  };
}

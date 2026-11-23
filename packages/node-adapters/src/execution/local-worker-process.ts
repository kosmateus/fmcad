import * as fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { BrokerRecords } from "../persistence/broker-records";
import { durable } from "../persistence/records";
import { responsePath } from "../persistence/owned-results";

type WorkerIntent = Parameters<BrokerRecords["createIntent"]>[1];

export interface LocalWorkerCompletion {
  exitCode: number;
  publicationFailed: boolean;
}

export interface LocalWorkerProcess {
  /** Local process control only; termination never proves SDK settlement. */
  terminateOwnProcess(): void;
  snapshot(): Readonly<{
    pid: number | null;
    birth: string | null;
    running: boolean;
  }>;
  /** Intent/output-open or close failure rejects after owned FD cleanup.
   * A resolved child exit is local evidence only, never SDK settlement. */
  readonly completion: Promise<LocalWorkerCompletion>;
}

function errorCode(error: unknown): string {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "WORKER_IDENTITY_UNAVAILABLE";
}

/** Own the Node process and its output descriptors, not the command or SDK turn.
 * The existing worker entrypoint remains the sole command executor. */
export function launchLocalWorker(
  input: {
    intent: WorkerIntent;
    brokerDirectory: string;
    entrypoint: string;
    capability: { jobId: string; token: string };
    backend: {
      backend?: string;
      tool?: unknown;
      transport?: unknown;
      protocolVersion?: unknown;
    };
  },
  ports: {
    records: Pick<BrokerRecords, "createIntent">;
    processBirth(pid: number): string;
    onIdentityPublicationFailure(code: string): void;
  },
): LocalWorkerProcess {
  let child: ChildProcess | undefined;
  let pid: number | null = null,
    birth: string | null = null;
  let running = false,
    finished = false,
    publicationFailed = false;
  let spawnFailed = false;
  let outputsOpened = false;
  let flushFailed = false,
    closeFailed = false,
    closeFailure: unknown;
  const descriptors: number[] = [];
  let resolveCompletion!: (value: LocalWorkerCompletion) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<LocalWorkerCompletion>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Setup can fail before the caller receives the handle and awaits it.
  completion.catch(() => {});
  const cleanup = () => {
    if (finished) return;
    finished = true;
    running = false;
    // An error on one stream must not strand the other descriptor.
    for (const fd of descriptors) {
      try {
        fs.fsyncSync(fd);
      } catch {
        flushFailed = true;
        publicationFailed = true;
      }
    }
    for (const fd of descriptors) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        if (!closeFailed) closeFailure = error;
        closeFailed = true;
        publicationFailed = true;
      }
    }
    descriptors.length = 0;
  };
  const finish = (exitCode: number) => {
    if (finished) return;
    cleanup();
    if (closeFailed) rejectCompletion(closeFailure);
    else
      resolveCompletion({
        exitCode: flushFailed ? 1 : exitCode,
        publicationFailed,
      });
  };
  const terminateOwnProcess = () => {
    if (running) child?.kill("SIGKILL");
  };
  const handle = Object.freeze({
    terminateOwnProcess,
    snapshot: () => Object.freeze({ pid, birth, running }),
    completion,
  });
  try {
    const { intent, capability } = input;
    if (capability.jobId !== intent.id || !capability.token)
      throw new Error("Missing original job-bound worker capability");
    const requestFile = ports.records.createIntent(intent.id, intent);
    const job = {
      id: intent.id,
      request:
        intent.request.cwd === undefined ? {} : { cwd: intent.request.cwd },
    };
    for (const name of ["stdout.txt", "stderr.txt"])
      descriptors.push(
        fs.openSync(
          responsePath(input.brokerDirectory, job, name, true),
          "wx",
          0o600,
        ),
      );
    outputsOpened = true;
    const config = {
      backend: input.backend.backend || "addin",
      tool: input.backend.tool,
      transport: input.backend.transport,
      timeoutMs: intent.request.timeoutMs,
      protocolVersion: input.backend.protocolVersion,
      url: "http://queue.invalid",
      headers: {},
    };
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "LANG",
      "LC_ALL",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "FMCAD_CONFIG",
      "FMCAD_PYTHON",
      "WSL_DISTRO_NAME",
      "TMPDIR",
      "SYSTEMROOT",
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, {
      FMCAD_QUEUE_WORKER_JOB: capability.jobId,
      FMCAD_QUEUE_WORKER_TOKEN: capability.token,
      FMCAD_QUEUE_DIR: input.brokerDirectory,
      FMCAD_QUEUE_WORKER_CONFIG: JSON.stringify(config),
      FMCAD_QUEUE: "worker",
    });
    const directory = path.dirname(requestFile);
    durable(
      path.join(directory, "worker-start.json"),
      {
        jobId: intent.id,
        buildHash: intent.buildHash,
        at: Date.now(),
      },
      true,
    );
    child = spawn(process.execPath, [input.entrypoint, requestFile], {
      cwd: intent.request.cwd,
      shell: false,
      env,
      stdio: ["ignore", descriptors[0]!, descriptors[1]!],
    });
    pid = child.pid ?? null;
    running = true;
    child.once("spawn", () => {
      try {
        if (pid === null)
          throw Object.assign(new Error("Worker has no process identity"), {
            code: "WORKER_IDENTITY_UNAVAILABLE",
          });
        birth = ports.processBirth(pid);
        durable(
          path.join(directory, "worker-identity.json"),
          { pid, birth },
          true,
        );
      } catch (error) {
        publicationFailed = true;
        const code = errorCode(error);
        if (!["ENOENT", "ESRCH"].includes(code)) {
          // The caller may hold a dispatched SDK turn. Even a fault in that
          // publication must not keep this owned local process alive.
          try {
            ports.onIdentityPublicationFailure(code);
          } catch {
            publicationFailed = true;
          } finally {
            terminateOwnProcess();
          }
        }
      }
    });
    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", (code) => finish(spawnFailed ? 1 : (code ?? 1)));
  } catch (error) {
    if (!outputsOpened) {
      cleanup();
      rejectCompletion(error);
    } else {
      publicationFailed = true;
      finish(1);
    }
  }
  return handle;
}

import path from "node:path";
import { createRequire } from "node:module";
import type {
  PreparedPythonArtifact,
  WorkerBackend,
  WorkerBackendMethod,
  WorkerEnvelope,
  WorkerRequest,
  WorkerResult,
  WorkerSdkProbeRequest,
  WorkerSdkProbeTarget,
} from "../../packages/core/src";

const runtimeRequire = createRequire(__filename);
const queueInstance = runtimeRequire("../../queue-instance.js") as {
  readJson(file: string): WorkerEnvelope;
  durable(file: string, value: unknown): void;
  buildHash(): string;
  workflowNonterminal(value: unknown): boolean;
};
const workerRuntime = runtimeRequire(
  "../node-adapters/execution/worker.js",
) as {
  runWorker(envelope: WorkerEnvelope, ports: WorkerPorts): Promise<number>;
};
type DebugTraceRuntime = {
  validDebugTraceContext(
    value: unknown,
    expected: { requestId: string; clientId: string },
  ): value is import("../../packages/node-adapters/src/telemetry/diagnostic-log").DebugTraceContext;
  writeDebugTrace: typeof import("../../packages/node-adapters/src/telemetry/diagnostic-log").writeDebugTrace;
};
let loadedDebugTraceRuntime: DebugTraceRuntime | undefined;
const debugTraceRuntime = (): DebugTraceRuntime =>
  (loadedDebugTraceRuntime ||= runtimeRequire(
    "../node-adapters/telemetry/diagnostic-log.js",
  ) as DebugTraceRuntime);

interface WorkerConfiguration {
  timeoutMs: number;
  [key: string]: unknown;
}

interface WorkerPorts {
  prepareSdkProbe?: (
    request: WorkerSdkProbeRequest,
    target: WorkerSdkProbeTarget,
  ) => PreparedPythonArtifact;
  jobId: string | undefined;
  token: string | undefined;
  buildHash(): string;
  configuration: WorkerConfiguration;
  request(message: {
    action: "backend";
    jobId: string;
    workerToken: string;
    method: WorkerBackendMethod;
    args: unknown[];
    rpcTimeoutMs: number;
  }): Promise<{ value: unknown; properties?: Record<string, unknown> }>;
  execute(
    request: WorkerRequest,
    backend: WorkerBackend,
    outcome: (value: unknown) => void,
    verified: {
      jobId: string;
      brokerDirectory: string;
      projectDirectory?: string;
      buildHash: string;
    },
  ): Promise<number>;
  nonterminal(outcome: unknown): boolean;
  persist(result: WorkerResult): void;
}

export interface WorkerDependencies {
  execute?: WorkerPorts["execute"];
}

/** Local worker process composition; every backend call returns to the broker. */
export async function run(
  file: string,
  dependencies: WorkerDependencies = {},
): Promise<number> {
  const job = queueInstance.readJson(file);
  const request = job.request;
  process.env["FMCAD_QUEUE_INPUT_FILES"] = JSON.stringify(
    request.inputFiles ?? [],
  );
  const configuration = JSON.parse(
    process.env["FMCAD_QUEUE_WORKER_CONFIG"] as string,
  ) as WorkerConfiguration;
  const traceRequest = request as unknown as {
    requestId?: string;
    clientId?: string;
    debugTrace?: unknown;
  };
  let runtime: DebugTraceRuntime | undefined;
  let trace:
    | import("../../packages/node-adapters/src/telemetry/diagnostic-log").DebugTraceContext
    | undefined;
  try {
    if (traceRequest.debugTrace !== undefined) runtime = debugTraceRuntime();
    if (
      runtime &&
      traceRequest.requestId &&
      traceRequest.clientId &&
      runtime.validDebugTraceContext(traceRequest.debugTrace, {
        requestId: traceRequest.requestId,
        clientId: traceRequest.clientId,
      })
    )
      trace = traceRequest.debugTrace;
  } catch {
    // Opt-in tracing is diagnostic-only if its runtime is unavailable.
  }
  const preflightStartedAt = trace ? Date.now() : undefined;
  let preflightPassed = false;
  if (trace)
    runtime!.writeDebugTrace(trace, {
      stage: "preflight",
      status: "started",
      jobId: job.id,
      buildHash: job.buildHash,
      stdoutObservation: "not_observed",
    });
  const resultFile = path.join(path.dirname(file), "worker-result.json");
  const anchor = path.resolve(__dirname, "../../queue-worker.js");
  const execute =
    dependencies.execute ??
    (
      runtimeRequire("../composition/execution-worker.js") as {
        execute: WorkerPorts["execute"];
      }
    ).execute;
  try {
    return await workerRuntime.runWorker(job, {
      prepareSdkProbe: (probeRequest, target) => {
        const paths = (
          runtimeRequire("../config-platform/index.js") as {
            resolveRuntimePaths(options: { anchor: string }): {
              assets: string;
            };
          }
        ).resolveRuntimePaths({ anchor });
        return (
          runtimeRequire("../node-adapters/execution/sdk-probe.js") as {
            prepareSdkProbe(
              assets: string,
              request: WorkerSdkProbeRequest,
              target: WorkerSdkProbeTarget,
            ): PreparedPythonArtifact;
          }
        ).prepareSdkProbe(path.dirname(paths.assets), probeRequest, target);
      },
      jobId: process.env["FMCAD_QUEUE_WORKER_JOB"],
      token: process.env["FMCAD_QUEUE_WORKER_TOKEN"],
      buildHash: queueInstance.buildHash,
      configuration,
      nonterminal: queueInstance.workflowNonterminal,
      persist: (result) => queueInstance.durable(resultFile, result),
      request: (message) =>
        (
          runtimeRequire("../../queue-connection.js") as {
            acceptedWorkerRequest(
              directory: string,
              request: Parameters<WorkerPorts["request"]>[0],
            ): Promise<{
              value: unknown;
              properties?: Record<string, unknown>;
            }>;
          }
        ).acceptedWorkerRequest(
          process.env["FMCAD_QUEUE_DIR"] as string,
          message,
        ),
      execute: async (...args) => {
        if (trace) {
          preflightPassed = true;
          runtime!.writeDebugTrace(trace, {
            stage: "preflight",
            status: "passed",
            jobId: job.id,
            buildHash: job.buildHash,
            durationMs: Date.now() - (preflightStartedAt ?? Date.now()),
            stdoutObservation: "not_observed",
          });
        }
        return execute(...args);
      },
    });
  } catch (error) {
    if (trace && !preflightPassed)
      runtime!.writeDebugTrace(trace, {
        stage: "preflight",
        status: "failed",
        jobId: job.id,
        buildHash: job.buildHash,
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : undefined,
        durationMs: Date.now() - (preflightStartedAt ?? Date.now()),
        stdoutObservation: "not_observed",
      });
    throw error;
  }
}

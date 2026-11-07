import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { executeWorker } from "@fmcad/core";
import { createWorkerSdkProbe } from "./sdk-probe";
import { pythonArtifactManifest } from "../python/context-binding.js";
import { projectDirectory } from "../persistence/owned-results";
import type {
  PreparedPythonArtifact,
  WorkerSdkProbeRequest,
  WorkerSdkProbeTarget,
} from "@fmcad/core";
import type {
  WorkerEnvelope,
  WorkerBackendMethod,
  WorkerRequest,
  WorkerBackend,
  WorkerResult,
} from "@fmcad/core";

export interface WorkerConfiguration {
  timeoutMs: number;
  [key: string]: unknown;
}

export interface WorkerNodePorts {
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

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Process/byte verification and capability transport, not a physical SDK client. */
export async function runWorker(
  envelope: WorkerEnvelope,
  ports: WorkerNodePorts,
): Promise<number> {
  const backend = {
    server: ports.configuration,
    ...envelope.properties,
    async invoke(
      method: WorkerBackendMethod,
      args: unknown[],
    ): Promise<unknown> {
      const response = await ports.request({
        action: "backend",
        jobId: envelope.id,
        workerToken: ports.token || "",
        method,
        args,
        rpcTimeoutMs: ports.configuration.timeoutMs,
      });
      Object.assign(this, response.properties);
      return response.value;
    },
    callTool(...args: unknown[]) {
      return this.invoke("callTool", args);
    },
    listTools(...args: unknown[]) {
      return this.invoke("listTools", args);
    },
    executeUiGuardedScript(...args: unknown[]) {
      return this.invoke("executeUiGuardedScript", args);
    },
  };
  if (ports.prepareSdkProbe) {
    Object.assign(backend, {
      brokerSdkProbePort: createWorkerSdkProbe({
        request: envelope.request,
        backend: ports.configuration["backend"],
        prepare: ports.prepareSdkProbe,
        execute: (artifact) =>
          backend.invoke("callTool", [
            {
              featureType: "script",
              object: { script: artifact.script, readOnly: true },
            },
            "fusion_mcp_execute",
            pythonArtifactManifest(artifact),
          ]),
      }),
    });
  }
  return executeWorker(envelope, {
    verify(job) {
      if (job.id !== ports.jobId || !ports.token)
        fail("INVALID_WORKER", "Missing job-bound worker capability");
      if (!Number.isSafeInteger(job.deadline))
        fail("RUN_TIMEOUT", "Invalid worker execution budget");
      if (ports.buildHash() !== job.buildHash)
        fail(
          "BUILD_CHANGED",
          "Executable build changed before worker execution",
        );
      for (const input of job.request.inputFiles || []) {
        const bytes = readFileSync(resolve(job.request.cwd, input.path));
        if (createHash("sha256").update(bytes).digest("hex") !== input.sha256)
          fail("INPUT_CHANGED", `Input changed: ${input.path}`);
      }
    },
    backend,
    execute: (request, workerBackend, outcome) => {
      const project = projectDirectory(envelope.request.cwd);
      return ports.execute(request, workerBackend, outcome, {
        jobId: envelope.id,
        brokerDirectory: process.env["FMCAD_QUEUE_DIR"] ?? "",
        ...(project ? { projectDirectory: project } : {}),
        buildHash: envelope.buildHash,
      });
    },
    nonterminal: ports.nonterminal,
    persist: ports.persist,
  });
}

import {
  decodePersistedJob,
  cadWorkerPolicyArguments,
} from "../../packages/core/src";
import type {
  CadWorkerInvocation,
  DocumentUnlockRequest,
  ExecutionReceipt,
  FmcadConfiguration,
  PythonCheckReport,
  ExecuteOptions,
  StageServices,
  BrokerStatus,
} from "../api/contracts";
import { CompatibilityError } from "../api/compatibility";

interface JobProjection {
  id: string;
  requestId: string;
  state: string;
  clientId?: string;
  sequenceId?: string | null;
  sequenceState?: string | null;
}
interface ResultProjection {
  job: JobProjection;
  stdout?: string;
  pythonChecks?: readonly PythonCheckReport[];
  stderr?: string;
  outputs?: { stdout?: unknown; stderr?: unknown };
}
interface QueueClientPort {
  register(options: { autoStart: false }): Promise<unknown>;
  call(action: string, value?: unknown): Promise<unknown>;
  documentUnlock(request: DocumentUnlockRequest): Promise<unknown>;
  readResult?(action: string, value: Record<string, unknown>): Promise<unknown>;
  submitAdmitted?(request: Record<string, unknown>): Promise<unknown>;
  persistRequestContext?(
    requestId: string,
    context: Record<string, unknown>,
  ): void;
  dispose(): void;
}

/** Pure admission metadata validation, shared by public execute and adapters. */
export function validateExecuteOptions(options: ExecuteOptions): void {
  if (
    options.executionTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.executionTimeoutMs) ||
      options.executionTimeoutMs < 1 ||
      options.executionTimeoutMs > 2147483647)
  )
    throw new Error("Invalid execution timeout");
  if (
    options.queueTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.queueTimeoutMs) ||
      options.queueTimeoutMs < 1 ||
      options.queueTimeoutMs > 2147483647)
  )
    throw new Error("Invalid queue timeout");
  if (
    options.expectedRevision !== undefined &&
    (!Number.isSafeInteger(options.expectedRevision) ||
      options.expectedRevision < 0 ||
      options.expectedRevision > 2147483647)
  )
    throw new Error("Invalid expected revision");
  if (options.sequence) {
    const sequence = options.sequence;
    if (
      !["begin", "continue", "end"].includes(sequence.action) ||
      (sequence.action === "begin"
        ? sequence.id !== undefined
        : typeof sequence.id !== "string" ||
          !sequence.id.trim() ||
          sequence.id.length > 256) ||
      (sequence.mode !== undefined &&
        !["automatic", "exclusive"].includes(sequence.mode))
    )
      throw new Error("Invalid sequence options");
  }
  if (
    options.inputFiles !== undefined &&
    (!Array.isArray(options.inputFiles) ||
      options.inputFiles.some(
        (file) =>
          !file ||
          typeof file.path !== "string" ||
          !require("node:path").isAbsolute(file.path) ||
          typeof file.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(file.sha256),
      ))
  )
    throw new Error("Invalid accepted input file");
}

/** Private composition only. Never exported as a transport or authorization factory. */
export function createQueueSession(
  config: FmcadConfiguration,
  clientId: string,
  cwd: string,
  instanceId: string,
) {
  const fs: typeof import("node:fs") = require("node:fs");
  const path: typeof import("node:path") = require("node:path");
  const { queueDirectory } = require("../queue-connection");
  const directory: string = queueDirectory();
  let client: QueueClientPort;
  let build: string;
  let ready = false;
  function readFence() {
    const marker = JSON.parse(
      fs.readFileSync(path.join(directory, "broker.lock"), "utf8"),
    );
    if (marker.protocol !== 2)
      throw new CompatibilityError("broker", marker.protocol, 2);
    const admissionDirectory: string =
      require("../queue-isolated-epoch").isolatedEpochDirectory(directory);
    const state = JSON.parse(
      fs.readFileSync(
        path.join(admissionDirectory, "queue-state.json"),
        "utf8",
      ),
    );
    if (state.version !== 1)
      throw new CompatibilityError("persistedState", state.version, 1);
    const current: string = require("../queue-instance").buildHash();
    const backend = require("../queue-backend-transition").resolveBackendHead(
      directory,
      () =>
        require("../queue-isolated-epoch").openIsolatedEpoch(directory, {
          recover: false,
        }),
    );
    const identity =
      backend.current?.identity ??
      JSON.parse(
        fs.readFileSync(path.join(admissionDirectory, "instance.json"), "utf8"),
      );
    const configHash: string =
      require("../queue-instance").brokerConfigHash(config);
    if (identity.configHash !== configHash)
      throw new CompatibilityError(
        "configuration",
        identity.configHash,
        configHash,
        {
          backend: config.backend,
          transport: config.transport,
          tool: config.tool,
        },
      );
    if (identity.buildHash !== current)
      throw new CompatibilityError("build", identity.buildHash, current);
    return current;
  }
  // Snapshot commits synchronously publish pending -> atomic snapshot -> remove
  // pending. A client in another process can observe the middle of that write.
  // Retry only this read; never recover storage, register, or resubmit a job here.
  function metadataSample() {
    const pointerFile = path.join(directory, "isolated-admission-epoch.json");
    const pointer = fs.existsSync(pointerFile)
      ? (JSON.parse(fs.readFileSync(pointerFile, "utf8")) as {
          epochId?: string;
        })
      : null;
    const stores = [directory];
    if (pointer?.epochId && /^[a-f0-9-]{36}$/.test(pointer.epochId))
      stores.push(path.join(directory, "admission-epochs", pointer.epochId));
    const stamp = (file: string): string => {
      try {
        const stat = fs.lstatSync(file, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
        throw error;
      }
    };
    const pending = stores.some((store) => {
      const file = path.join(store, "queue-state.pending.json");
      try {
        if (!fs.lstatSync(file).isFile())
          throw Object.assign(new Error("Invalid pending snapshot marker"), {
            code: "EPOCH_PROOF_INVALID",
          });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
    const files = [
      path.join(directory, "broker.lock"),
      pointerFile,
      path.join(directory, "physical-backend-head.json"),
      ...stores.flatMap((store) => [
        path.join(store, "queue-state.json"),
        path.join(store, "instance.json"),
      ]),
    ];
    return {
      pending,
      signature: files.map((file) => `${file}:${stamp(file)}`).join("\n"),
    };
  }
  async function fence() {
    const deadline = Date.now() + config.timeoutMs;
    for (;;) {
      const before = metadataSample();
      let current: string | undefined;
      let error: unknown;
      if (!before.pending) {
        try {
          current = readFence();
        } catch (cause) {
          error = cause;
        }
      }
      const after = metadataSample();
      if (
        !before.pending &&
        !after.pending &&
        before.signature === after.signature
      ) {
        if (current === undefined) throw error;
        build = current;
        return;
      }
      if (Date.now() >= deadline)
        throw (
          error ??
          Object.assign(
            new Error(
              "Queue metadata did not reach a stable committed snapshot; pending storage requires inspection",
            ),
            { code: "EPOCH_PROOF_INVALID" },
          )
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  function receipt(job: JobProjection): ExecutionReceipt {
    return {
      version: 1,
      requestId: job.requestId,
      jobId: job.id,
      ...(typeof job.sequenceId === "string" || job.sequenceId === null
        ? { sequenceId: job.sequenceId }
        : {}),
      ...(typeof job.sequenceState === "string" || job.sequenceState === null
        ? { sequenceState: job.sequenceState }
        : {}),
      state: job.state,
      outcome: decodePersistedJob(job, 1),
      result: null,
    };
  }
  async function rawResult(jobId: string) {
    await fence();
    const value = (await (client.readResult
      ? client.readResult("result", { jobId })
      : client.call("result", { jobId }))) as ResultProjection;
    const result: ExecutionReceipt = {
      ...receipt(value.job),
      pythonChecks: value.pythonChecks ?? [],
    };
    // Only broker-owned artifacts authorize a filesystem read. Never trust paths in output.
    const read = (key: "stdout" | "stderr"): string => {
      const descriptor = value.outputs?.[key] as
        { artifact?: { name?: string }; name?: string } | undefined;
      if (!descriptor) return value[key] ?? "";
      const artifact = descriptor.artifact ?? descriptor;
      if (artifact.name !== key + ".txt")
        throw new Error("Invalid owned application output");
      return require("../queue-response-files")
        .readOwnedResult(directory, { jobId, cwd }, artifact, 128 * 1024 * 1024)
        .toString("utf8") as string;
    };
    const stdout = read("stdout");
    const stderr = read("stderr");
    if (
      ["succeeded", "failed"].includes(result.state) &&
      typeof stdout === "string" &&
      stdout.trim()
    ) {
      let output: ExecutionReceipt["result"];
      try {
        output = JSON.parse(stdout) as ExecutionReceipt["result"];
      } catch {
        output = stdout;
      } // Run supports text as well as JSON output.
      return { ...result, result: output, output: { stdout, stderr } };
    }
    return { ...result, output: { stdout, stderr } };
  }
  return {
    get ready() {
      return ready;
    },
    async start() {
      // All compatibility checks precede credentials, registration and admission.
      await fence();
      const { QueueClient } = require("../queue-client");
      client = new QueueClient(clientId, { cfg: config, instanceId });
      await client.register({ autoStart: false });
      const status = (await client.call("control-status")) as {
        buildHash?: string;
      };
      if (status.buildHash !== build)
        throw new CompatibilityError("build", status.buildHash, build);
      ready = true;
    },
    async status() {
      await fence();
      const value = (await client.call("control-status")) as {
        buildHash?: string;
        unresolved?: boolean;
        activeOperations?: number;
      };
      if (value.buildHash !== build)
        throw new CompatibilityError("build", value.buildHash, build);
      let isolatedScratch: BrokerStatus["isolatedScratch"];
      let sourceCommit: string | undefined;
      if (
        fs.existsSync(path.join(directory, "isolated-admission-epoch.json"))
      ) {
        const summary = (await client.call("queue-summary")) as {
          buildHash?: string;
          sourceCommit?: string;
          isolatedScratchScope?: BrokerStatus["isolatedScratch"];
        };
        const scope = summary.isolatedScratchScope;
        if (
          summary.buildHash !== build ||
          !scope ||
          typeof scope.epochId !== "string" ||
          typeof scope.document?.name !== "string" ||
          typeof scope.document.creationId !== "string" ||
          scope.document.fileId !== null ||
          ![
            "qualified-fresh-scratch-only",
            "normal-multidocument",
            "qualified-first-save-only",
            "saved-publication-or-retention-only",
            "blocked-current-unknown",
            "blocked-process-unavailable",
            "cleanup-pending-or-unknown",
            "closed",
          ].includes(scope.admission)
        )
          throw new CompatibilityError(
            "isolatedScratchScope",
            "invalid",
            "qualified epoch metadata",
          );
        isolatedScratch = scope;
        if (summary.sourceCommit !== undefined) {
          if (!/^[a-f0-9]{40}$/.test(summary.sourceCommit))
            throw new CompatibilityError(
              "sourceCommit",
              summary.sourceCommit,
              "qualified source SHA",
            );
          sourceCommit = summary.sourceCommit;
        }
      }
      return {
        version: 1 as const,
        build,
        blocked:
          value.unresolved === true ||
          (isolatedScratch !== undefined &&
            !["qualified-fresh-scratch-only", "normal-multidocument"].includes(
              isolatedScratch.admission,
            )),
        active: (value.activeOperations ?? 0) > 0,
        ...(isolatedScratch ? { clientId, isolatedScratch } : {}),
        ...(sourceCommit ? { sourceCommit } : {}),
      };
    },
    result: rawResult,
    async request(requestId: string) {
      await fence();
      const found = (await (client.readResult
        ? client.readResult("find-request", { requestId })
        : client.call("find-request", { requestId }))) as {
        job?: JobProjection | null;
        buildHash?: string;
      };
      if (found.buildHash !== build)
        throw new CompatibilityError("build", found.buildHash, build);
      if (found.job && found.job.clientId !== clientId)
        throw new Error("Broker returned a foreign request owner");
      return found.job ? rawResult(found.job.id) : null;
    },
    async stage(jobId: string): Promise<StageServices> {
      await rawResult(jobId); // Existing broker auth rejects foreign client jobs.
      const stages =
        await require("../../composition/stage-dependencies").createAuthenticatedStageDependencies(
          {
            brokerDirectory: directory,
            jobId,
            clientId,
            projectDirectory:
              require("../node-adapters/persistence/owned-results").projectDirectory(
                cwd,
              ) ?? cwd,
          },
        );
      if (!stages)
        throw new Error("This owned job has no supported stage workflow");
      return stages.stage as StageServices;
    },
    async execute(payload: CadWorkerInvocation, options: ExecuteOptions) {
      await fence();
      validateExecuteOptions(options);
      const purpose =
        payload.kind === "cad-command"
          ? payload.invocation.purpose
          : payload.purpose;
      const inputFiles = [...(options.inputFiles ?? [])];
      const hashFile = (file: string): string =>
        require("node:crypto")
          .createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex");
      for (const file of inputFiles) {
        if (!path.isAbsolute(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256))
          throw new Error("Invalid accepted input file");
        if (hashFile(file.path) !== file.sha256)
          throw new Error("Input changed before admission");
      }
      if (payload.kind === "run") {
        if (!path.isAbsolute(payload.request.name))
          throw new Error("Library run requires an absolute source path");
        const existing = inputFiles.find(
          (file) =>
            path.resolve(file.path) === path.resolve(payload.request.name),
        );
        if (!existing)
          inputFiles.push({
            path: payload.request.name,
            sha256: hashFile(payload.request.name),
          });
      }
      // The typed service supplies guard metadata, not argv execution. Do not use
      // QueueClient.submit's legacy parser, auto-start or build-retry path.
      const invocation =
        payload.kind === "cad"
          ? payload
          : payload.kind === "cad-command"
            ? payload.invocation
            : undefined;
      const clientContext = {
        clientId,
        requestId: options.requestId,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        projectDirectory: cwd,
        ...(invocation?.projectId ? { projectId: invocation.projectId } : {}),
        ...(invocation?.doc ? { doc: invocation.doc } : {}),
        ...(invocation?.docId ? { docId: invocation.docId } : {}),
        ...(invocation?.docFileId ? { docFileId: invocation.docFileId } : {}),
        ...(invocation?.purpose ? { purpose: invocation.purpose } : {}),
        ...(options.expectedRevision !== undefined
          ? { expectedRevision: options.expectedRevision }
          : {}),
      };
      client.persistRequestContext?.(options.requestId, clientContext);
      const request = {
        requestId: options.requestId,
        ...(options.sequence ? { sequence: options.sequence } : {}),
        ...(options.expectedRevision !== undefined
          ? { expectedRevision: options.expectedRevision }
          : {}),
        ...(options.queueTimeoutMs !== undefined
          ? { queueTimeoutMs: options.queueTimeoutMs }
          : {}),
        ...(purpose ? { description: purpose } : {}),
        kind: "command",
        payload,
        argv: cadWorkerPolicyArguments(payload),
        cwd,
        clientContext,
        backend: config.backend,
        inputFiles,
        timeoutMs: options.executionTimeoutMs ?? config.timeoutMs,
        buildHash: build,
      };
      const job = await (client.submitAdmitted
        ? client.submitAdmitted(request)
        : client.call("submit", { request }));
      return receipt(job as JobProjection);
    },
    async control(action: "cancel" | "reconcile", jobId: string) {
      await fence();
      return receipt((await client.call(action, { jobId })) as JobProjection);
    },
    async documentUnlock(request: DocumentUnlockRequest) {
      await fence();
      return client.documentUnlock(request);
    },
    dispose() {
      ready = false;
      client?.dispose();
    },
  };
}

import * as fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  Execution,
  Owner,
  Protocol,
  ScenarioBackend,
  ScriptRequest,
} from "./contracts";
import { record } from "./contracts";
import { scenarioArtifactRoot } from "./artifact-root";
import type { ClientModule, Queue } from "../live-recovery-ports";

interface QueueExecProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

interface QueueExecHelpers {
  runQueueExec(input: {
    cliPath: string;
    backend: Protocol;
    clientId: string;
    requestId: string;
    timeoutMs: number;
    argv: string[];
    cwd: string;
  }): Promise<QueueExecProcessResult>;
  readQueueResult(input: {
    cliPath: string;
    backend: Protocol;
    clientId: string;
    jobId: string;
    cwd: string;
  }): Promise<unknown>;
}

interface QueueExecReceipt {
  readonly jobId: string;
  readonly state?: string;
}

/** The same public command submission path for live Fusion and a broker-owned simulator. */
export class QueueScenarioBackend implements ScenarioBackend {
  readonly identity: string;
  readonly qualification = "broker";
  readonly #clients = new Map<
    string,
    Queue & { findRequest(id: string): Promise<unknown> }
  >();
  readonly #jobIds = new Map<string, string>();
  readonly #module: QueueModule;
  readonly #buildHash: () => string;
  readonly #queueExec?: QueueExecHelpers;
  readonly #cliPath?: string;
  readonly #scenarioRoot: string;
  constructor(
    readonly mode: "fusion" | "simulator",
    readonly protocol: Protocol,
    readonly capabilities: ReadonlySet<string>,
    readonly root: string,
    readonly config: Record<string, unknown>,
    readonly pathMapper: (file: string) => string,
    simulatorRuntime?: { readonly root: string; readonly fingerprint: string },
  ) {
    this.#scenarioRoot = scenarioArtifactRoot(root, mode);
    const load = createRequire(path.join(root, "package.json"));
    if (simulatorRuntime && mode !== "simulator")
      throw new Error("Simulator runtime binding cannot be used for Fusion");
    if (mode === "fusion") {
      const { resolveQualifiedLiveRuntime } = load(
        "./tests/helpers/qualified-live-runtime",
      ) as {
        resolveQualifiedLiveRuntime(): {
          dist: string;
          fingerprint: string;
        };
      };
      const runtime = resolveQualifiedLiveRuntime();
      const loadRuntime = createRequire(
        path.join(runtime.dist, "package.json"),
      );
      // Loading the qualified module binds the selected runtime without using
      // its typed client as the live submission path.
      this.#module = loadRuntime("./src/queue-client") as QueueModule;
      this.#buildHash = () => runtime.fingerprint;
      this.#queueExec = load("./tests/helpers/live-broker") as QueueExecHelpers;
      this.#cliPath = path.join(runtime.dist, "bin/fmcad.js");
    } else if (simulatorRuntime) {
      const { resolveQualifiedLiveRuntime } = load(
        "./tests/helpers/qualified-live-runtime",
      ) as {
        resolveQualifiedLiveRuntime(env: NodeJS.ProcessEnv): {
          dist: string;
          fingerprint: string;
        };
      };
      const runtime = resolveQualifiedLiveRuntime({
        FMCAD_LIVE_RUNTIME_ROOT: simulatorRuntime.root,
      });
      if (runtime.fingerprint !== simulatorRuntime.fingerprint)
        throw new Error("Simulator runtime binding fingerprint changed");
      this.#module = createRequire(path.join(runtime.dist, "package.json"))(
        "./src/queue-client",
      ) as QueueModule;
      this.#buildHash = () => runtime.fingerprint;
    } else {
      this.#module = load("./src/queue-client") as QueueModule;
      this.#buildHash = (
        load("./src/queue-instance") as { buildHash(): string }
      ).buildHash;
    }
    const identity = [mode, protocol, this.#buildHash()];
    if (mode === "simulator") {
      const endpoint = config["url"];
      if (typeof endpoint !== "string")
        throw new Error("Simulator queue endpoint is missing");
      identity.push(new URL(endpoint).origin);
    }
    this.identity = identity.join(":");
  }
  fusionPath(local: string): string {
    return this.pathMapper(local);
  }
  async execute(request: ScriptRequest): Promise<Execution> {
    if (
      this.mode === "fusion" &&
      (this.protocol !== "addin" ||
        this.config["backend"] !== "addin" ||
        this.config["url"] !== "http://127.0.0.1:8765/mcp" ||
        this.config["protocolVersion"] !== "2025-06-18" ||
        this.config["tool"] !== "execute_python")
    )
      throw new Error(
        "Live scenario commands require the qualified ADDIN endpoint",
      );
    if (request.command?.spelling) {
      const words = request.command.spelling;
      if (
        !words.length ||
        words.some((word) => !/^[a-z][a-z0-9-]*$/u.test(word))
      )
        throw new Error("Invalid owned CAD command spelling");
      const { findCommand } = createRequire(
        path.join(this.root, "package.json"),
      )(
        "./src/commands",
      ) as typeof import("../../src/composition/library-commands");
      if (findCommand([...words])?.target !== request.command.operation)
        throw new Error(
          "CLI alias does not resolve to the expected canonical operation",
        );
    }
    const filename = path.join(
      request.directory,
      `request-${request.requestId.split(":").at(-1)}.py`,
    );
    fs.writeFileSync(filename, request.source, { flag: "wx", mode: 0o600 });
    const argv = request.inspectCli
      ? request.inspectCli === "active"
        ? ["active"]
        : ["doc", "list"]
      : request.command
        ? [
            ...(request.command.spelling ?? [
              "cad",
              ...request.command.operation.split("."),
            ]),
            "--data",
            JSON.stringify(request.command.data),
            "--doc",
            request.target!.name,
            "--doc-id",
            request.target!.creationId,
            ...(request.command.component
              ? ["--component", request.command.component]
              : []),
            ...(request.target!.file
              ? ["--doc-file-id", request.target!.file.fileId]
              : []),
            "--json",
          ]
        : [
            "run",
            filename,
            ...(request.helpers ? ["--helpers", request.helpers] : []),
            ...(request.target
              ? [
                  "--doc",
                  request.target.name,
                  "--doc-id",
                  request.target.creationId,
                ]
              : []),
            ...(request.target?.file
              ? ["--doc-file-id", request.target.file.fileId]
              : []),
          ];
    if (this.mode === "fusion") {
      const queueExec = this.#queueExec!;
      const cliPath = this.#cliPath!;
      const submitted = await queueExec.runQueueExec({
        cliPath,
        backend: this.protocol,
        clientId: request.owner.clientId,
        requestId: request.requestId,
        timeoutMs: 180000,
        argv,
        cwd: request.directory,
      });
      const receipt = queueExecReceipt(
        submitted.stderr,
        request.owner,
        request.requestId,
      );
      const key = requestKey(request.owner, request.requestId);
      this.#jobIds.set(key, receipt.jobId);
      const original = record(
        await queueExec.readQueueResult({
          cliPath,
          backend: this.protocol,
          clientId: request.owner.clientId,
          jobId: receipt.jobId,
          cwd: this.root,
        }),
      );
      const job = record(original["job"]);
      if (
        job["id"] !== receipt.jobId ||
        (receipt.state !== undefined && job["state"] !== receipt.state)
      )
        throw new Error(
          "Public queue result differs from its original receipt",
        );
      const execution = queueExecution(
        original,
        request.owner,
        request.requestId,
      );
      if (
        execution.state === "succeeded" &&
        submitted.status !== null &&
        submitted.status !== 0
      )
        throw new Error("Successful original queue job has a nonzero CLI exit");
      if (
        execution.state === "failed" &&
        submitted.status !== null &&
        submitted.status !== 1
      )
        throw new Error("Failed original queue job has an unexpected CLI exit");
      return execution;
    }
    let client = this.#clients.get(request.owner.clientId);
    if (!client) {
      client = new this.#module.QueueClient(request.owner.clientId, {
        cfg: this.config,
      });
      this.#clients.set(request.owner.clientId, client);
      await client.register({ autoStart: false });
      const status = record(await client.call("status"));
      if (status["buildHash"] !== this.#buildHash())
        throw new Error(
          "Broker build differs from the qualified runtime; no update was attempted",
        );
    }
    const job = await client.submit({
      requestId: request.requestId,
      kind: "command",
      argv,
      cwd: request.directory,
      timeoutMs: 180000,
      backend: this.protocol,
      buildHash: this.#buildHash(),
      inputFiles: this.#module.inputFiles(argv, request.directory),
    });
    const result = await client.wait(job.id);
    return queueExecution(result, request.owner, request.requestId);
  }
  async lookup(owner: Owner, requestId: string): Promise<Execution | null> {
    if (this.mode === "fusion") {
      const key = requestKey(owner, requestId);
      const jobId =
        this.#jobIds.get(key) ??
        scenarioQueueJobId(this.#scenarioRoot, owner, requestId);
      if (!jobId) return null;
      this.#jobIds.set(key, jobId);
      const original = await this.#queueExec!.readQueueResult({
        cliPath: this.#cliPath!,
        backend: this.protocol,
        clientId: owner.clientId,
        jobId,
        cwd: this.root,
      });
      if (record(record(original)["job"])["id"] !== jobId)
        throw new Error(
          "Public queue result differs from its original job receipt",
        );
      return queueExecution(original, owner, requestId);
    }
    let client = this.#clients.get(owner.clientId);
    if (!client) {
      client = new this.#module.QueueClient(owner.clientId, {
        cfg: this.config,
        existingCredentialsOnly: true,
      });
      this.#clients.set(owner.clientId, client);
      await client.register({ autoStart: false });
    }
    const original = await client.findRequest(requestId);
    if (original === null) return null;
    const value = record(original);
    if (!value["job"]) return null;
    return queueExecution(value, owner, requestId);
  }
  close(): void {
    for (const client of this.#clients.values()) client.dispose();
    this.#clients.clear();
    this.#jobIds.clear();
  }
}

function requestKey(owner: Owner, requestId: string): string {
  return owner.clientId + "\0" + requestId;
}

export function legacyQueueReceipt(
  scenarioRoot: string,
  owner: Owner,
  requestId: string,
): string | undefined {
  const prefix = owner.clientId + ":legacy:";
  const receiptId = requestId.slice(prefix.length);
  if (requestId !== prefix + receiptId || !/^[a-f0-9-]{36}$/u.test(receiptId))
    return undefined;
  const filename = path.join(
    scenarioRoot,
    owner.runId,
    owner.scenarioId,
    "legacy",
    "queue-receipts",
    receiptId + ".json",
  );
  let fd: number;
  try {
    fd = fs.openSync(
      filename,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: Record<string, unknown>;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096)
      throw new Error("Invalid owned public queue receipt file");
    value = record(JSON.parse(fs.readFileSync(fd, "utf8")) as unknown);
  } finally {
    fs.closeSync(fd);
  }
  const receiptOwner = record(value["owner"]);
  if (
    value["version"] !== 1 ||
    value["requestId"] !== requestId ||
    receiptOwner["runId"] !== owner.runId ||
    receiptOwner["scenarioId"] !== owner.scenarioId ||
    receiptOwner["clientId"] !== owner.clientId ||
    typeof value["jobId"] !== "string" ||
    !value["jobId"]
  )
    throw new Error("Foreign original public queue receipt");
  return value["jobId"];
}

export function scenarioQueueJobId(
  scenarioRoot: string,
  owner: Owner,
  requestId: string,
): string | undefined {
  const legacy = legacyQueueReceipt(scenarioRoot, owner, requestId);
  if (legacy) return legacy;
  if (owner.scenarioId === "coordinator") {
    const prefix = owner.clientId + ":";
    if (
      owner.clientId !== "scenario:" + owner.runId + ":coordinator" ||
      !requestId.startsWith(prefix)
    )
      return undefined;
    const phase = requestId.slice(prefix.length);
    if (!/^(before|files-before-\d+)$/u.test(phase)) return undefined;
    const filename = path.join(
      scenarioRoot,
      owner.runId,
      "_coordinator",
      phase + ".result.json",
    );
    let fd: number;
    try {
      fd = fs.openSync(
        filename,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 16 * 1024)
        throw new Error("Invalid original coordinator result");
      const value = record(JSON.parse(fs.readFileSync(fd, "utf8")) as unknown),
        receipt = record(value["brokerReceipt"]);
      if (value["requestId"] !== requestId) return undefined;
      return queueJobIdFromReceipt(receipt, owner, requestId);
    } finally {
      fs.closeSync(fd);
    }
  }
  const filename = path.join(
    scenarioRoot,
    owner.runId,
    owner.scenarioId,
    "report.json",
  );
  let fd: number;
  try {
    fd = fs.openSync(
      filename,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let report: Record<string, unknown>;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new Error("Invalid original scenario report");
    report = record(JSON.parse(fs.readFileSync(fd, "utf8")) as unknown);
  } finally {
    fs.closeSync(fd);
  }
  const reportOwner = record(report["owner"]),
    requests = report["requests"];
  if (
    reportOwner["runId"] !== owner.runId ||
    reportOwner["scenarioId"] !== owner.scenarioId ||
    reportOwner["clientId"] !== owner.clientId ||
    !Array.isArray(requests)
  )
    throw new Error("Foreign original scenario report");
  const matches = requests.filter((entry) => {
    const row = record(entry);
    return row["requestId"] === requestId;
  });
  if (matches.length === 0) return undefined;
  if (matches.length !== 1)
    throw new Error("Duplicate original request report");
  const result = record(record(matches[0])["result"]),
    receipt = record(result["brokerReceipt"]);
  return queueJobIdFromReceipt(receipt, owner, requestId);
}

function queueJobIdFromReceipt(
  receipt: Record<string, unknown>,
  owner: Owner,
  requestId: string,
): string | undefined {
  if (
    receipt["requestId"] !== requestId ||
    receipt["clientId"] !== owner.clientId ||
    !["succeeded", "failed"].includes(String(receipt["state"])) ||
    typeof receipt["jobId"] !== "string" ||
    !receipt["jobId"]
  )
    return undefined;
  return receipt["jobId"];
}

/** Validate the public CLI receipts before reading the original job result. */
export function queueExecReceipt(
  stderr: string,
  owner: Pick<Owner, "clientId">,
  requestId: string,
): QueueExecReceipt {
  const readMarker = (prefix: string): Record<string, unknown>[] =>
    stderr
      .split(/\r?\n/u)
      .filter((line) => line.startsWith(prefix))
      .map((line) => record(JSON.parse(line.slice(prefix.length)) as unknown));
  const requests = readMarker("FMCAD_QUEUE_REQUEST ");
  if (
    requests.length !== 1 ||
    requests[0]!["requestId"] !== requestId ||
    requests[0]!["clientId"] !== owner.clientId
  )
    throw new Error("Public queue request receipt has a foreign identity");
  const jobs = readMarker("FMCAD_QUEUE_JOB ");
  if (
    jobs.length !== 1 ||
    jobs[0]!["requestId"] !== requestId ||
    typeof jobs[0]!["jobId"] !== "string" ||
    !jobs[0]!["jobId"]
  )
    throw new Error("Public queue job receipt is missing or mismatched");
  const results = readMarker("FMCAD_QUEUE_RESULT ");
  if (results.length > 1)
    throw new Error("Public queue returned duplicate terminal receipts");
  const result = results[0];
  if (
    result &&
    (result["id"] !== jobs[0]!["jobId"] ||
      result["requestId"] !== requestId ||
      typeof result["state"] !== "string")
  )
    throw new Error("Public queue terminal receipt has a foreign identity");
  return {
    jobId: jobs[0]!["jobId"] as string,
    ...(result ? { state: result["state"] as string } : {}),
  };
}
type QueueModule = Omit<ClientModule, "QueueClient"> & {
  QueueClient: new (
    id: string,
    options: Record<string, unknown>,
  ) => Queue & { findRequest(id: string): Promise<unknown> };
};

/** A terminal broker job alone cannot prove that its SDK work has settled. */
export function queueExecution(
  original: unknown,
  owner: Pick<Owner, "clientId">,
  requestId: string,
): Execution {
  const value = record(original);
  const job = record(value["job"]);
  if (job["clientId"] !== owner.clientId || job["requestId"] !== requestId)
    throw new Error("Foreign original job result");
  const raw = value["execution"];
  const execution =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? record(raw)
      : {};
  const operation = job["operationResult"];
  const receipt =
    operation !== null &&
    typeof operation === "object" &&
    !Array.isArray(operation)
      ? record(operation)
      : {};
  // Older brokers omit sdkSettled on this authoritative preflight-only outcome.
  // A failed state alone is insufficient: require both bound result envelopes,
  // affirmative no-submission evidence and no contradictory dispatch evidence.
  const notDispatched =
    execution["sdkSettled"] === undefined &&
    typeof job["id"] === "string" &&
    job["id"].length > 0 &&
    job["state"] === "failed" &&
    job["code"] === "NOT_DISPATCHED" &&
    job["dispatch"] == null &&
    (job["physicalTurns"] === undefined || job["physicalTurns"] === 0) &&
    execution["state"] === "failed" &&
    execution["code"] === "NOT_DISPATCHED" &&
    execution["executionOutcome"] === "not_started" &&
    execution["userScriptSubmitted"] === false &&
    execution["mayHaveMutated"] === false &&
    execution["preflightCompleted"] === true &&
    execution["source"] === "durable-preflight-evidence" &&
    receipt["version"] === 1 &&
    receipt["jobId"] === job["id"] &&
    receipt["requestId"] === requestId &&
    receipt["acceptance"] === "accepted" &&
    receipt["executionOutcome"] === "not_started" &&
    receipt["mayHaveMutated"] === false &&
    receipt["code"] === "NOT_DISPATCHED";
  const sdkSettled = execution["sdkSettled"] === true || notDispatched;
  const state =
    sdkSettled && job["state"] === "succeeded"
      ? "succeeded"
      : sdkSettled && job["state"] === "failed"
        ? "failed"
        : "unknown";
  return {
    requestId,
    state,
    sdkSettled,
    mayHaveMutated: execution["mayHaveMutated"] !== false,
    stdout: typeof value["stdout"] === "string" ? value["stdout"] : "",
    ...(typeof value["stderr"] === "string" ? { stderr: value["stderr"] } : {}),
    ...(typeof execution["exitCode"] === "number"
      ? { exitCode: execution["exitCode"] }
      : {}),
    ...(typeof job["id"] === "string" && typeof job["state"] === "string"
      ? {
          brokerReceipt: {
            requestId,
            jobId: job["id"],
            clientId: owner.clientId,
            state: job["state"],
            operationResult: job["operationResult"],
          },
        }
      : {}),
    ...(state === "succeeded" ? {} : { error: JSON.stringify(original) }),
  };
}

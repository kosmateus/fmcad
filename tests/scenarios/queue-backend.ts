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
import type { ClientModule, Queue } from "../live-recovery-ports";

/** The same public command submission path for live Fusion and a broker-owned simulator. */
export class QueueScenarioBackend implements ScenarioBackend {
  readonly identity: string;
  readonly qualification = "broker";
  readonly #clients = new Map<
    string,
    Queue & { findRequest(id: string): Promise<unknown> }
  >();
  readonly #module: QueueModule;
  readonly #buildHash: () => string;
  constructor(
    readonly mode: "fusion" | "simulator",
    readonly protocol: Protocol,
    readonly capabilities: ReadonlySet<string>,
    readonly root: string,
    readonly config: Record<string, unknown>,
    readonly pathMapper: (file: string) => string,
  ) {
    const load = createRequire(path.join(root, "package.json"));
    this.#module = load("./src/queue-client") as QueueModule;
    this.#buildHash = (
      load("./src/queue-instance") as { buildHash(): string }
    ).buildHash;
    this.identity = mode + ":" + protocol + ":" + this.#buildHash();
  }
  fusionPath(local: string): string {
    return this.pathMapper(local);
  }
  async execute(request: ScriptRequest): Promise<Execution> {
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
          "Broker build differs from scenario sources; no update was attempted",
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
  }
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
  const sdkSettled = execution["sdkSettled"] === true;
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

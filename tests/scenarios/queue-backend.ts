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
    const argv = [
      "run",
      filename,
      ...(request.target
        ? ["--doc", request.target.name, "--doc-id", request.target.creationId]
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
    if (
      result.job.clientId !== request.owner.clientId ||
      result.job.requestId !== request.requestId
    )
      throw new Error("Foreign original job result");
    const state =
      result.job.state === "succeeded"
        ? "succeeded"
        : result.job.state === "failed"
          ? "failed"
          : "unknown";
    return {
      requestId: result.job.requestId,
      state,
      sdkSettled: result.execution.sdkSettled === true,
      mayHaveMutated: result.execution.mayHaveMutated !== false,
      stdout: result.stdout,
      ...(state === "succeeded" ? {} : { error: JSON.stringify(result) }),
    };
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
    const job = record(value["job"]),
      execution = record(value["execution"]);
    if (job["clientId"] !== owner.clientId || job["requestId"] !== requestId)
      throw new Error("Foreign recovery result");
    return {
      requestId,
      state:
        job["state"] === "succeeded"
          ? "succeeded"
          : job["state"] === "failed"
            ? "failed"
            : "unknown",
      sdkSettled: execution["sdkSettled"] === true,
      mayHaveMutated: execution["mayHaveMutated"] !== false,
      stdout: typeof value["stdout"] === "string" ? value["stdout"] : "",
      error: String(job["code"] ?? ""),
    };
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

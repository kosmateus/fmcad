import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Queue } from "../live-recovery-ports";
import type { ScenarioSession } from "./runner";
import type {
  ObjectValue,
  Response,
  Server,
} from "../../packages/node-adapters/src/fusion-transport/contracts";
import type { BrokerAddinClient } from "../../packages/node-adapters/src/fusion-transport/addin";
import { QueueScenarioBackend, queueExecution } from "./queue-backend";
import { record, text } from "./contracts";

export type DiagnosticQueue = Queue & {
  readonly dir: string;
  findRequest(requestId: string): Promise<unknown>;
};

/** Reuse the configured broker, its original result, and the existing session ledger. */
export async function nativeDiagnosticQueue(session: ScenarioSession) {
  assert.ok(
    session.backend instanceof QueueScenarioBackend,
    "Native transport diagnostics require the existing broker backend",
  );
  assert.equal(
    session.backend.protocol,
    "addin",
    "This retained native transport fixture is add-in specific",
  );
  const root = session.backend.root;
  const config = session.backend.config;
  const load = createRequire(path.join(root, "package.json"));
  const { QueueClient } = load("./src/queue-client") as {
    QueueClient: new (
      clientId: string,
      options: { cfg: Record<string, unknown> },
    ) => DiagnosticQueue;
  };
  const { buildHash } = load("./src/queue-instance") as { buildHash(): string };
  const queue = new QueueClient(session.report.owner.clientId, { cfg: config });
  try {
    await queue.register({ autoStart: false });
    const status = record(await queue.call("status"));
    assert.equal(
      status["buildHash"],
      buildHash(),
      "Diagnostic candidate differs from the running broker",
    );
  } catch (error) {
    queue.dispose();
    throw error;
  }
  return { root, config, queue, buildHash: buildHash() };
}

export function privateEvidence(
  session: ScenarioSession,
  filename: string,
  value: unknown,
): void {
  assert.equal(path.basename(filename), filename);
  fs.writeFileSync(
    path.join(session.directory, filename),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
}

export async function registeredRpc(
  session: ScenarioSession,
  queue: DiagnosticQueue,
  phase: string,
  payload: ObjectValue,
  buildHash: string,
  timeoutMs: number,
  accepted?: (job: Awaited<ReturnType<DiagnosticQueue["submit"]>>) => void,
) {
  return session.registeredRequest(
    phase,
    { readOnly: true, payload, buildHash },
    async (binding) => {
      assert.equal(queue.auth.clientId, binding.owner.clientId);
      const job = await queue.submit({
        kind: "rpc",
        payload,
        requestId: binding.requestId,
        backend: "addin",
        cwd: binding.directory,
        timeoutMs,
        buildHash,
      });
      assert.equal(job.requestId, binding.requestId);
      assert.equal(job.clientId, binding.owner.clientId);
      accepted?.(job);
      const result = await queue.wait(job.id);
      assert.equal(result.job.id, job.id);
      return {
        execution: queueExecution(result, binding.owner, binding.requestId),
        value: result,
      };
    },
  );
}

export function diagnosticAddinClient(
  session: ScenarioSession,
  native: Awaited<ReturnType<typeof nativeDiagnosticQueue>>,
  timeoutMs: number,
): BrokerAddinClient {
  const load = createRequire(path.join(native.root, "package.json"));
  const { createBackend } = load("./tests/helpers/live-broker") as {
    createBackend(
      server: Server,
      dependencies: {
        clientId: string;
        queue: DiagnosticQueue;
        diagnosticReadOnly: true;
        loadConfig(options: { routing: "queue" }): {
          cfg: Record<string, unknown>;
        };
        registeredRequest: ScenarioSession["registeredRequest"];
      },
    ): BrokerAddinClient;
  };
  assert.equal(native.config["backend"], "addin");
  try {
    return createBackend(
      {
        ...native.config,
        url: text(native.config["url"]),
        backend: "addin",
        timeoutMs,
      },
      {
        clientId: session.report.owner.clientId,
        queue: native.queue,
        diagnosticReadOnly: true,
        loadConfig: () => ({ cfg: native.config }),
        registeredRequest: session.registeredRequest.bind(session),
      },
    );
  } catch (error) {
    native.queue.dispose();
    throw error;
  }
}

export function disposeDiagnosticClient(
  root: string,
  client: BrokerAddinClient,
): void {
  const { disposeBackend } = createRequire(path.join(root, "package.json"))(
    "./tests/helpers/live-broker",
  ) as {
    disposeBackend(value: BrokerAddinClient): void;
  };
  disposeBackend(client);
}

export function rpcPayload(result: unknown): Record<string, unknown> {
  const response = record(record(result)["rpc"]) as unknown as Response;
  const message = record(JSON.parse(text(response.raw)) as unknown);
  assert.equal(message["error"], undefined, JSON.stringify(message["error"]));
  return record(message["result"]);
}

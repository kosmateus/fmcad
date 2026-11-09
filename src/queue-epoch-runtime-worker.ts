import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const api = load("./queue-instance") as {
  buildHash(): string;
  hash(value: string): string;
  processBirth(): string;
  durable(file: string, value: unknown, exclusive: boolean): void;
  readJson(file: string): unknown;
};
type BrokerHost = {
  serve(
    cfg: unknown,
    options: Record<string, unknown>,
  ): Promise<{ dir: string; buildHash: string }>;
};
const host = () => load("./queue-broker") as BrokerHost;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Object-shaped epoch startup evidence required");
  return value as Record<string, unknown>;
}
async function main(): Promise<void> {
  const audit = process.argv[2];
  if (!audit)
    throw new Error("Exact qualified epoch-runtime startup intent required");
  const intent = object(api.readJson(path.join(audit, "intent.json"))),
    approval = object(intent["approval"]);
  const input = object(JSON.parse(fs.readFileSync(0, "utf8")) as unknown);
  if (
    input["nonce"] !== intent["nonce"] ||
    api.buildHash() !== approval["buildHash"] ||
    fs.realpathSync(audit) !== audit ||
    typeof approval["requestId"] !== "string" ||
    path.basename(audit) !== api.hash(approval["requestId"])
  )
    throw new Error("Exact qualified epoch-runtime startup intent required");
  // No losing worker publishes an error or starts a broker.
  api.durable(
    path.join(audit, "worker.json"),
    { pid: process.pid, birth: api.processBirth() },
    true,
  );
  try {
    const broker = await host().serve(input["cfg"], {
      dir: path.dirname(path.dirname(audit)),
      confirmOwnership: true,
      autoReconcile: false,
      stateOptions: approval["stateOptions"],
      epochRuntimeUpgradeNonce: intent["nonce"],
    });
    api.durable(
      path.join(audit, "worker-ready.json"),
      {
        buildHash: broker.buildHash,
        owner: api.readJson(path.join(broker.dir, "broker.lock")),
      },
      true,
    );
  } catch (error) {
    const info =
      error && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    api.durable(
      path.join(audit, "worker-error.json"),
      {
        code: info["code"] || "EPOCH_UPGRADE_START_FAILED",
        message: info["message"],
      },
      true,
    );
    throw error;
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

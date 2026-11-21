import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const api = load("./queue-instance") as {
  durable(file: string, value: unknown, exclusive: boolean): void;
  processBirth(): string;
  priorProcessAlive(value: unknown): boolean | null;
  readJson(file: string): unknown;
};
type BrokerHost = {
  serve(
    cfg: unknown,
    options: Record<string, unknown>,
  ): Promise<{ dir: string; buildHash: string; close(): Promise<void> }>;
};
const host = () => load("./queue-broker") as BrokerHost;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Object-shaped migration startup evidence required");
  return value as Record<string, unknown>;
}
function errorCode(error: unknown): unknown {
  return error && typeof error === "object"
    ? (error as Record<string, unknown>)["code"]
    : undefined;
}
async function main(): Promise<void> {
  const audit = process.argv[2];
  if (!audit) throw new Error("Migration audit directory required");
  const intent = object(api.readJson(path.join(audit, "intent.json")));
  try {
    api.durable(
      path.join(audit, "worker.json"),
      { pid: process.pid, birth: api.processBirth() },
      true,
    );
  } catch (error) {
    if (
      errorCode(error) === "EEXIST" &&
      api.priorProcessAlive(api.readJson(path.join(audit, "worker.json"))) ===
        true
    )
      return;
    throw error;
  }
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024)
      throw new Error("Migration configuration exceeds 1 MiB");
  }
  const parsed = object(JSON.parse(input) as unknown),
    cfg = object(parsed["cfg"]),
    nonce = parsed["nonce"];
  if (nonce !== intent["nonce"]) throw new Error("Migration nonce changed");
  const broker = await host().serve(
    { ...cfg, routing: "queue", queue: {} },
    {
      confirmOwnership: true,
      autoReconcile: false,
      atomicMigrationNonce: nonce,
    },
  );
  api.durable(
    path.join(audit, "worker-ready.json"),
    {
      buildHash: broker.buildHash,
      owner: api.readJson(path.join(broker.dir, "broker.lock")),
    },
    true,
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => broker.close().catch(() => {}));
}
if (require.main === module)
  main().catch((error) => {
    try {
      const audit = process.argv[2];
      if (audit)
        api.durable(
          path.join(audit, "worker-error.json"),
          { code: errorCode(error) || "MIGRATION_START_FAILED" },
          true,
        );
    } catch {
      /* Remains unknown. */
    }
    process.stderr.write(
      "Migration worker failed: " +
        String(errorCode(error) || "MIGRATION_START_FAILED") +
        "\n",
    );
    process.exitCode = 1;
  });

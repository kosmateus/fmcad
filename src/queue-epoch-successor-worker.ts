import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const api = load("./queue-instance") as {
  processBirth(): string;
  readJson(file: string): unknown;
};
const files = load("./queue-atomic-migration-files") as {
  exclusive(file: string, value: unknown): void;
};
type BrokerHost = {
  serve(
    cfg: unknown,
    options: Record<string, unknown>,
  ): Promise<{ buildHash: string; close(): Promise<void> }>;
};
const host = () => load("./queue-broker") as BrokerHost;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Object-shaped successor startup input required");
  return value as Record<string, unknown>;
}
function errorCode(error: unknown): unknown {
  return error && typeof error === "object"
    ? (error as Record<string, unknown>)["code"]
    : undefined;
}
async function main(): Promise<void> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new Error("Successor worker configuration bound exceeded");
  }
  const parsed = object(JSON.parse(text) as unknown),
    cfg = parsed["cfg"],
    dir = parsed["dir"],
    audit = parsed["audit"],
    nonce = parsed["nonce"];
  if (typeof dir !== "string" || typeof audit !== "string")
    throw new Error("Successor worker directories required");
  const owner = { pid: process.pid, birth: api.processBirth(), nonce };
  files.exclusive(path.join(audit, "worker-claim.json"), owner);
  try {
    const broker = await host().serve(cfg, {
      dir,
      confirmOwnership: true,
      deadEpochSuccessorNonce: nonce,
      autoReconcile: false,
    });
    const marker = api.readJson(path.join(dir, "broker.lock"));
    files.exclusive(path.join(audit, "worker-ready.json"), {
      nonce,
      owner: marker,
      buildHash: broker.buildHash,
      sdkRequestsSent: 0,
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => {
        broker
          .close()
          .catch((error) =>
            process.stderr.write(
              "Broker remains reserved: " +
                String(errorCode(error) || "CLOSE_REFUSED") +
                "\n",
            ),
          );
      });
  } catch (error) {
    files.exclusive(path.join(audit, "worker-error.json"), {
      nonce,
      code: errorCode(error) || "SUCCESSOR_START_FAILED",
    });
    throw error;
  }
}
main().catch((error) => {
  process.stderr.write(
    String(
      errorCode(error) || (error instanceof Error ? error.message : error),
    ) + "\n",
  );
  process.exitCode = 1;
});

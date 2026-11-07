import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(__dirname, "../../..");
const load = createRequire(path.join(root, "package.json"));
test("production broker refuses test native paths without an explicit physical adapter", async () => {
  const { serve } = load("./src/queue-broker") as {
    serve(config: object, options: object): Promise<unknown>;
  };
  await assert.rejects(
    serve(
      { timeoutMs: 1000 },
      { nativePath: (file: string) => file, confirmOwnership: true },
    ),
    /explicit physical test adapter/,
  );
});
test("probe prepares receipt paths through the injected physical adapter before artifact binding", async () => {
  const { prepareProbe } = load("./src/queue-instance") as {
    prepareProbe(
      client: object,
      options: object,
    ): Promise<() => Promise<unknown>>;
  };
  let captured = "";
  const client = {
    server: { timeoutMs: 1000 },
    async prepareCallTool(args: { object: { script: string } }) {
      captured = args.object.script;
      return Object.assign(
        async () => {
          throw new Error("Preparation must not execute the probe");
        },
        { fence() {} },
      );
    },
  };
  let mapped = 0;
  await prepareProbe(client, {
    receiptPath: "/test/owned.json",
    binding: {
      jobId: "job",
      rpcId: "rpc",
      requestHash: "a".repeat(64),
      buildHash: "b".repeat(64),
    },
    mapPath: (file: string) => {
      mapped++;
      return "NATIVE:" + file;
    },
  });
  assert.ok(mapped >= 1);
  assert.match(captured, /NATIVE:\/test\/owned\.json/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const load = createRequire(__filename);
const { createBrokerTransport } = load(
  "../src/dist/fusion-transport/broker",
) as typeof import("../packages/node-adapters/src/fusion-transport/broker");
const { serve } = load("../src/queue-broker") as {
  serve(
    cfg: Record<string, unknown>,
    options: Omit<
      import("../src/queue-broker-ports").Options,
      "createBackend"
    > & { createBackend(): ReturnType<typeof createBrokerTransport> },
  ): Promise<{ close(): Promise<void> }>;
};
const { request } = load("../src/queue-connection") as {
  request<T>(dir: string, message: Record<string, unknown>): Promise<T>;
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
// This test isolates post-response retention, not Python analysis or execution.
// The independent generic queued-worker contract suite covers the real checker.
const admissionModule = load("../src/queue-admission") as {
  createProductionQueueAdmission(...args: unknown[]): {
    admission: {
      check(
        payload: unknown,
      ): Promise<{ kind: string; fence(outgoing: unknown): void }>;
    };
    checkPrepared(prepared: unknown): Promise<unknown>;
    fencePrepared(prepared: unknown, buildHash: string): void;
    checkerFingerprint(): unknown;
  };
};

function matchingRpcFiles(
  names: readonly string[],
  read: (name: string) => unknown,
  expected: {
    jobId: string;
    rpcId: string;
    sourceHash: string;
    wireId: string;
  },
): string[] {
  return names.filter((name) => {
    if (!/^rpc-.*\.json$/.test(name)) return false;
    const rpc = object(read(name));
    const binding = object(rpc["binding"]);
    return (
      name === `rpc-${expected.rpcId}.json` &&
      binding["jobId"] === expected.jobId &&
      binding["rpcId"] === expected.rpcId &&
      binding["sourceHash"] === expected.sourceHash &&
      object(rpc["wireRequest"])["id"] === expected.wireId
    );
  });
}

test("RPC artifact selection binds the product despite terminal siblings and file order", () => {
  const expected = {
    jobId: "00000000-0000-4000-8000-000000000000",
    rpcId: "20000000-0000-4000-8000-000000000000",
    sourceHash: "a".repeat(64),
    wireId: "fmcad:20000000-0000-4000-8000-000000000000",
  };
  const preflightName = "rpc-00000000-0000-4000-8000-000000000001.json";
  const siblingName = "rpc-10000000-0000-4000-8000-000000000000.json";
  const productName = `rpc-${expected.rpcId}.json`;
  const resultName = "rpc-result.json";
  const productBinding = {
    jobId: expected.jobId,
    rpcId: expected.rpcId,
    sourceHash: expected.sourceHash,
  };
  const files = new Map<string, unknown>([
    [
      preflightName,
      {
        terminal: true,
        binding: {
          jobId: expected.jobId,
          rpcId: "00000000-0000-4000-8000-000000000001",
        },
        wireRequest: { id: "fmcad:00000000-0000-4000-8000-000000000001" },
      },
    ],
    [
      siblingName,
      {
        terminal: true,
        binding: {
          jobId: expected.jobId,
          rpcId: "10000000-0000-4000-8000-000000000000",
          sourceHash: "b".repeat(64),
        },
        wireRequest: { id: "fmcad:10000000-0000-4000-8000-000000000000" },
      },
    ],
    [
      productName,
      {
        terminal: false,
        binding: productBinding,
        wireRequest: { id: expected.wireId },
      },
    ],
    [
      resultName,
      {
        terminal: true,
        binding: productBinding,
        wireRequest: { id: expected.wireId },
      },
    ],
  ]);
  const read = (name: string) => files.get(name);
  const adversarialOrder = [
    preflightName,
    resultName,
    siblingName,
    productName,
  ];

  assert.equal(
    adversarialOrder.find((name) => /^rpc-.*\.json$/.test(name)),
    preflightName,
    "the old first-match lookup chooses a terminal preflight RPC",
  );
  for (const order of [
    adversarialOrder,
    [...adversarialOrder].reverse(),
    [siblingName, productName, preflightName, resultName],
  ]) {
    assert.deepEqual(matchingRpcFiles(order, read, expected), [productName]);
  }
  assert.deepEqual(
    matchingRpcFiles([preflightName, siblingName, resultName], read, expected),
    [],
    "terminal sibling RPCs and rpc-result.json are not the product RPC",
  );
});

for (const responseMode of [
  "missing-receipt",
  "foreign-jsonrpc",
  "malformed-jsonrpc",
  "http-error",
]) {
  test(`owned RPC retains returned raw before settlement failure: ${responseMode}`, async (t) => {
    if (!process.env["FMCAD_RETAINED_RPC_CHILD"]) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        FMCAD_RETAINED_RPC_CHILD: "1",
      };
      delete env["NODE_TEST_CONTEXT"];
      const child = spawnSync(
        process.execPath,
        [
          "--test",
          "--test-force-exit",
          "--test-name-pattern",
          responseMode,
          __filename,
        ],
        { env, encoding: "utf8", timeout: 20000 },
      );
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.match(child.stdout, /tests 1\b/);
      return;
    }
    const originalAdmission = admissionModule.createProductionQueueAdmission;
    admissionModule.createProductionQueueAdmission = () => ({
      admission: {
        async check() {
          return { kind: "python", fence() {} };
        },
      },
      async checkPrepared() {
        return {};
      },
      fencePrepared() {},
      checkerFingerprint() {
        return "explicit synthetic checker: response-retention test only";
      },
    });
    t.after(() => {
      admissionModule.createProductionQueueAdmission = originalAdmission;
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-rpc-retained-"));
    const dir = path.join(root, "queue");
    fs.mkdirSync(dir);
    const instance = {
      pid: 991,
      birth: "synthetic:991",
      version: "fixture",
      activeCommand: "SelectCommand",
      documents: [],
    };
    const cfg = {
      backend: "mcp",
      routing: "queue",
      url: "http://synthetic.invalid",
      timeoutMs: 30000,
    };
    const physical = createBrokerTransport(cfg, {
      version: "synthetic",
      requestTimeout: () => 30000,
      bridgeSource: () => {
        throw new Error("No add-in bridge");
      },
    });
    let productCalls = 0;
    let productWireId: string | undefined;
    let originalRaw = "";
    const sourceCode =
      "def run(context: str) -> None:\n    print('synthetic owned write result')\n";
    const sourceHash = createHash("sha256").update(sourceCode).digest("hex");
    physical._post = async (payload) => {
      if (payload["method"] === "initialize")
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload["id"],
            result: { protocolVersion: "2025-03-26" },
          }),
        };
      if (payload["method"] === "notifications/initialized")
        return { status: 202, raw: "" };
      const args = object(object(payload["params"])["arguments"]);
      const code =
        typeof args["code"] === "string"
          ? args["code"]
          : object(args["object"])["script"];
      assert.ok(typeof code === "string");
      if (code.includes("FMCAD_QUEUE_INSTANCE")) {
        const filename = /_qr_path = ("(?:\\.|[^"\\])*")/.exec(code);
        const binding =
          /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/.exec(
            code,
          );
        if (filename && binding) {
          const target = JSON.parse(filename[1]!);
          assert.ok(target.startsWith(root + path.sep));
          fs.writeFileSync(
            target,
            JSON.stringify({
              ...JSON.parse(JSON.parse(binding[1]!)),
              terminal: true,
              outcome: "succeeded",
              instance,
            }),
          );
        }
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload["id"],
            result: {
              content: [
                {
                  type: "text",
                  text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
                },
              ],
            },
          }),
        };
      }
      productCalls++;
      const wireId = payload["id"];
      assert.ok(typeof wireId === "string");
      productWireId = wireId;
      // A physical-port response, not a Fusion execution or model assertion. No
      // remote receipt is emitted, exactly the settlement boundary under test.
      originalRaw =
        responseMode === "malformed-jsonrpc"
          ? "original malformed JSON"
          : responseMode === "http-error"
            ? "original HTTP failure body"
            : JSON.stringify({
                jsonrpc: "2.0",
                id:
                  responseMode === "foreign-jsonrpc"
                    ? "foreign-wire-id"
                    : payload["id"],
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        success: false,
                        message: "synthetic original native error",
                      }),
                    },
                  ],
                },
              });
      return {
        status: responseMode === "http-error" ? 503 : 200,
        raw: originalRaw,
      };
    };
    const broker = await serve(cfg, {
      dir,
      confirmOwnership: true,
      pollMs: 5,
      createBackend: () => physical,
      nativePath: (value: string) => value,
    });
    t.after(async () => {
      await assert.rejects(broker.close(), { code: "RECONCILIATION_REQUIRED" });
      fs.rmSync(root, { recursive: true, force: true });
    });
    const auth = {
      clientId: "owned-synthetic-client",
      clientToken: "synthetic-private-test-token",
    };
    await request(dir, { action: "register", ...auth });
    const job = await request<{ id: string }>(dir, {
      action: "submit",
      auth,
      request: {
        kind: "rpc",
        requestId: randomUUID(),
        cwd: root,
        timeoutMs: 30000,
        payload: {
          jsonrpc: "2.0",
          id: "synthetic-caller",
          method: "tools/call",
          params: {
            name: "fusion_mcp_execute",
            arguments: {
              featureType: "script",
              object: {
                script: sourceCode,
                readOnly: false,
              },
            },
          },
        },
      },
    });
    const deadline = Date.now() + 30000;
    let result: { job: { state: string } };
    do {
      result = await request(dir, { action: "result", auth, jobId: job.id });
      if (result.job.state === "needs_reconciliation") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(result.job.state, "needs_reconciliation");
    assert.equal(productCalls, 1, "No SDK request or response may be replayed");
    const directory = path.join(dir, "jobs", job.id);
    assert.ok(
      typeof productWireId === "string" && productWireId.startsWith("fmcad:"),
      "the product RPC must have a unique broker wire ID",
    );
    const wireId = productWireId;
    const rpcId = wireId.slice("fmcad:".length);
    const expectedBinding = { jobId: job.id, rpcId, sourceHash, wireId };
    const rpcNames = matchingRpcFiles(
      fs.readdirSync(directory),
      (name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")),
      expectedBinding,
    );
    assert.equal(rpcNames.length, 1, "select exactly the original product RPC");
    const rpcName = rpcNames[0]!;
    const rpc = JSON.parse(
      fs.readFileSync(path.join(directory, rpcName), "utf8"),
    );
    assert.equal(rpc.binding.jobId, job.id);
    assert.equal(rpc.binding.rpcId, rpcId);
    assert.equal(rpc.binding.sourceHash, sourceHash);
    assert.equal(rpc.wireRequest.id, wireId);
    assert.equal(
      rpc.terminal,
      false,
      "Retained HTTP response is not terminal SDK authority",
    );
    assert.equal(fs.existsSync(rpc.receipt), false);
    const receivedPath = path.join(
      directory,
      `received-response-${rpc.binding.rpcId}.json`,
    );
    assert.ok(
      fs.existsSync(receivedPath),
      "Original returned response must survive failed receipt settlement",
    );
    const received = JSON.parse(fs.readFileSync(receivedPath, "utf8"));
    assert.deepEqual(received.binding, rpc.binding);
    assert.equal(received.wireId, wireId);
    assert.equal(received.version, 1);
    assert.equal(received.kind, "owned-rpc-received-response-v1");
    assert.equal(
      received.response.status,
      responseMode === "http-error" ? 503 : 200,
    );
    assert.equal(received.response.raw, originalRaw);
  });
}

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import type * as P from "../src/queue-broker-ports";

const root =
  process.env["FMCAD_TEST_RUNTIME"] || path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "src/queue-broker.js"));
const fixtureLoad = createRequire(path.join(root, "tests/fixture-loader.cjs"));
const releasedProof = fixtureLoad("./fixtures/physical-turn-fixture.cjs") as (
  binding: P.PhysicalTurnBinding,
) => P.PhysicalTurnQuiescence;
const { runStartupProbe } = fixtureLoad(
  "./fixtures/startup-observation-runner.cjs",
) as {
  runStartupProbe(script: string): {
    failed: boolean;
    text: string;
    stderr: string;
    report: { events: string[] };
  };
};
const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function fixture(
  t: TestContext,
  capture?: P.Options["captureStartupObservation"],
) {
  const home = fs.mkdtempSync("/tmp/opencode/startup-observation-broker-");
  const previous = Object.fromEntries(
    ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  const cwd = process.cwd();
  process.env["XDG_STATE_HOME"] = home;
  process.env["XDG_DATA_HOME"] = path.join(home, "data");
  process.env["XDG_CONFIG_HOME"] = path.join(home, "config");
  process.chdir(home);
  const { resolveFmcadConfiguration } = load("./dist/core") as {
    resolveFmcadConfiguration(value: unknown): P.Config;
  };
  const cfg = resolveFmcadConfiguration({
    // Port 1 is never contacted: the physical boundary below is wholly synthetic.
    adapter: {
      backend: "addin",
      url: "http://127.0.0.1:1/mcp",
      timeoutMs: 60000,
    },
    environment: {},
    file: {},
    platformDefaults: {},
    acceptedService: null,
  });
  const { queueDirectory, queueSocket } = load(
    "./queue-connection",
  ) as typeof import("../src/entrypoints/queue-connection");
  const dir = queueDirectory(),
    socket = queueSocket();
  const { createBrokerTransport } = load("./dist/fusion-transport/broker") as {
    createBrokerTransport(config: unknown, dependencies: unknown): P.Client;
  };
  const { addinBridgeSource } = load(
    "./addin-bridge",
  ) as typeof import("../src/composition/library-addin-bridge");
  const physical = createBrokerTransport(cfg, {
    version: "fixture",
    requestTimeout: (server: { timeoutMs: number }) => server.timeoutMs,
    bridgeSource: addinBridgeSource,
  });
  let getters: string[] = [],
    posts = 0,
    source = "a".repeat(40);
  const released = new Set<string>();
  physical._post = async (payload) => {
    if (payload.method === "initialize")
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-06-18" },
        }),
      };
    if (payload.method === "notifications/initialized")
      return { status: 202, raw: "" };
    if (["tools/list", "ping"].includes(payload.method))
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: payload.method === "tools/list" ? { tools: [] } : {},
        }),
      };
    posts++;
    const script =
      payload.params?.arguments?.code ??
      payload.params?.arguments?.object?.script;
    assert.equal(typeof script, "string");
    const output = runStartupProbe(script!);
    getters = output.report.events;
    return {
      status: 200,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: !output.failed,
                stdout: output.text,
                stderr: output.stderr,
              }),
            },
          ],
        },
      }),
    };
  };
  const { serve } = load(
    "./queue-broker",
  ) as typeof import("../src/composition/queue-broker");
  let broker: Awaited<ReturnType<typeof serve>> | undefined;
  t.after(async () => {
    source = "a".repeat(40);
    try {
      await broker?.close();
    } finally {
      process.chdir(cwd);
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
  const options: P.Options = {
    dir,
    confirmOwnership: true,
    pollMs: 5,
    startPaused: true,
    createBackend: () => physical,
    nativePath: (file) => file,
    ...(capture ? { captureStartupObservation: capture } : {}),
    bindPhysicalTurn(request) {
      return {
        version: 1,
        generation: { instance: "owned", epoch: "owned" },
        grantDigest: sha("owned-explicit-fake-grant-not-authority"),
        physicalRuntime: {
          pid: 991,
          birth: "fakeboot:1",
          version: "fake-startup-sdk-1",
          source,
          build: sha("owned-native-build"),
        },
        turnId: request.physicalRequestId,
        target: JSON.stringify(request.documentSelector ?? null),
      };
    },
    async withPhysicalTurn(binding, send) {
      try {
        return await send();
      } finally {
        released.add(binding.turnId);
      }
    },
    async physicalTurnQuiescence(binding) {
      return released.has(binding.turnId)
        ? releasedProof(binding)
        : { state: "unknown", binding };
    },
  };
  return {
    dir,
    socket,
    options,
    counts: () => ({ posts, getters }),
    changeNativeSource() {
      source = "b".repeat(40);
    },
    async start() {
      try {
        broker = await serve(cfg, options);
        return broker;
      } catch (error) {
        t.diagnostic(
          JSON.stringify((error as { pythonCheck?: unknown }).pythonCheck) ??
            String(error),
        );
        throw error;
      }
    },
  };
}

test("actual compiled broker exports original fixed startup receipt/physical/source data, not authority", async (t) => {
  let captured: P.StartupObservation | undefined;
  const operatorModule = process.env["FMCAD_STARTUP_OPERATOR_CAPTURE"];
  const evidenceDirectory = path.join(
    fs.mkdtempSync("/tmp/opencode/startup-operator-interop-"),
    "capture",
  );
  const sink = operatorModule
    ? (
        fixtureLoad(operatorModule) as {
          createStartupCapture(
            directory: string,
          ): (data: P.StartupObservation) => void;
        }
      ).createStartupCapture(evidenceDirectory)
    : undefined;
  const f = await fixture(t, (value) => {
    sink?.(value);
    captured = value;
  });
  await f.start();
  assert.ok(captured);
  assert.deepEqual(Object.keys(captured).sort(), [
    "binding",
    "broker",
    "identity",
    "native",
    "originalPhysicalRead",
    "originalReceipt",
    "startupAudit",
  ]);
  assert.equal(captured.identity.pid, captured.native.pid);
  assert.equal(captured.identity.birth, captured.native.birth);
  assert.equal(captured.startupAudit.scripts.items.length, 2);
  assert.equal(Object.hasOwn(captured.identity, "startupAudit"), false);
  const bytes = fs.readFileSync(captured.originalReceipt.path);
  assert.equal(sha(bytes), captured.originalReceipt.sha256);
  assert.deepEqual(Uint8Array.from(bytes), captured.originalReceipt.bytes);
  if (sink) {
    const descriptor = JSON.parse(
      fs.readFileSync(path.join(evidenceDirectory, "capture.json"), "utf8"),
    );
    assert.equal(descriptor.authority, "NONE");
    for (const key of ["originalReceipt", "originalPhysicalRead"] as const) {
      assert.equal(descriptor[key].path, captured[key].path);
      assert.equal(descriptor[key].sha256, captured[key].sha256);
      assert.deepEqual(
        fs.readFileSync(descriptor[key].copiedBytes),
        Buffer.from(captured[key].bytes),
      );
    }
    t.diagnostic(`Private operator interop evidence: ${evidenceDirectory}`);
  }
  const original = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(
    original.probeObservation.identity.startupAudit,
    captured.startupAudit,
  );
  for (const [key, value] of Object.entries(captured.binding))
    assert.deepEqual(original[key], value);
  const physical = JSON.parse(
    fs.readFileSync(captured.originalPhysicalRead.path, "utf8"),
  );
  assert.equal(physical.request.kind, "system-read");
  assert.deepEqual(physical.physicalTurn.physicalRuntime, captured.native);
  assert.equal(physical.receiptPath, captured.originalReceipt.path);
  const persisted = JSON.parse(
    fs.readFileSync(path.join(f.dir, "instance.json"), "utf8"),
  );
  assert.equal(persisted.instance.startupAudit, undefined);
  assert.equal(f.counts().posts, 1);
});

test("broker without private capture keeps cheap readiness and exports no SDK collection", async (t) => {
  const f = await fixture(t);
  await f.start();
  assert.deepEqual(f.counts(), { posts: 1, getters: [] });
});

for (const mode of [
  "throw",
  "async",
  "native-change",
  "receipt-change",
  "byte-copy-change",
  "data-return",
]) {
  test(`startup data callback ${mode} closes its actual owned listener/owner and grants nothing`, async (t) => {
    let captures = 0;
    const f = await fixture(t, (captured) => {
      captures++;
      if (mode === "throw") throw Error("owned capture failed");
      if (mode === "async")
        return Promise.reject(
          Error("owned asynchronous capture"),
        ) as unknown as void;
      if (mode === "native-change") f.changeNativeSource();
      if (mode === "receipt-change")
        fs.appendFileSync(captured.originalReceipt.path, "\n ");
      if (mode === "byte-copy-change") captured.originalReceipt.bytes[0] = 0;
      if (mode === "data-return") return { grant: true } as unknown as void;
    });
    await assert.rejects(f.start());
    assert.equal(
      captures,
      1,
      "Failure must occur at/after the real capture, not an unrelated startup error",
    );
    assert.equal(
      fs.existsSync(f.socket),
      false,
      "Rejected serve must not leave an unowned listener",
    );
    assert.equal(fs.existsSync(path.join(f.dir, "broker.lock")), false);
  });
}

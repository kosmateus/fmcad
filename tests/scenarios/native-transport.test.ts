import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ScenarioBackend } from "./contracts";
import { record, text } from "./contracts";
import { ScenarioSession, runScenarios } from "./runner";
import { nativeBackendAdapterScenarios } from "./native-backend-adapter-cases";
import { nativeMcpStdioScenarios } from "./native-mcp-stdio-cases";
import {
  nativeRpcRecoveryScenarios,
  prepareNativeRpcRecoveryBroker,
} from "./native-rpc-recovery-cases";
import {
  diagnosticAddinClient,
  disposeDiagnosticClient,
  type DiagnosticQueue,
} from "./native-transport-support";
import type { Job, Result } from "../live-recovery-ports";
import type { ObjectValue } from "../../packages/node-adapters/src/fusion-transport/contracts";

const root = path.resolve(__dirname, "../../..");
const backend: ScenarioBackend = {
  identity: "native-transport-port-proof",
  mode: "simulator",
  qualification: "component",
  protocol: "addin",
  capabilities: new Set(["documents"]),
  fusionPath: (value) => value,
  async execute() {
    throw new Error(
      "No simulator SDK operation belongs to this transport port proof",
    );
  },
};
test("all native diagnostic factories are pure and reject unsupported ten-owner runs before SDK or child work", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-transport-plans-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const factory of [
    nativeBackendAdapterScenarios,
    nativeMcpStdioScenarios,
    nativeRpcRecoveryScenarios,
  ]) {
    const scenarios = factory();
    assert.equal(scenarios.length, 10);
    const reports = [];
    for (const scenario of scenarios)
      reports.push(...(await runScenarios(backend, [scenario], directory, 10)));
    for (const report of reports) {
      assert.equal(report.status, "unsupported");
      assert.equal(report.cleanup, "not-created");
      assert.equal(report.document, undefined);
      assert.equal(report.fixture, undefined);
      assert.deepEqual(report.requests, []);
    }
  }
});

test("native adapter timeout keeps retained positive integer bound before dispatch", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 2147482648])
    assert.throws(
      () => nativeBackendAdapterScenarios(1, value),
      /positive integer at most 2147482647/u,
    );
  assert.equal(nativeBackendAdapterScenarios(1, 2147482647).length, 1);
});

for (const fault of [
  "none",
  "foreign-owner",
  "foreign-request",
  "missing-settlement",
  "lost-reply",
] as const) {
  test(`actual private addin adapter journals each original request before queue admission: ${fault}`, async (t) => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "native-adapter-receipt-"),
    );
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const owner = {
      runId: "diagnostic-run",
      scenarioId: "adapter",
      clientId: "diagnostic-owner",
    };
    const session = new ScenarioSession(
      backend,
      owner,
      path.join(parent, "adapter"),
    );
    session.report.lifecycle = "read-only";
    session.report.scope = "exclusive-instance";
    session.persist();
    const admitted = new Map<string, { job: Job; payload: ObjectValue }>();
    const methods: string[] = [];
    const queue: DiagnosticQueue = {
      dir: parent,
      auth: { clientId: owner.clientId },
      async register() {
        return undefined;
      },
      async call() {
        throw new Error("No observer RPC requested by this port proof");
      },
      async findRequest() {
        throw new Error(
          "No recovery replay or lookup requested by this port proof",
        );
      },
      async submit(input) {
        const stored = record(
          JSON.parse(
            fs.readFileSync(
              path.join(session.directory, "report.json"),
              "utf8",
            ),
          ) as unknown,
        );
        const requests = stored["requests"];
        assert.ok(Array.isArray(requests));
        const intent = record(requests.at(-1));
        assert.equal(intent["requestId"], input["requestId"]);
        assert.equal(record(stored["owner"])["clientId"], owner.clientId);
        assert.equal(record(intent["intent"])["readOnly"], true);
        assert.deepEqual(record(intent["intent"])["payload"], input["payload"]);
        const payload = record(input["payload"]);
        methods.push(text(payload["method"]));
        const job: Job = {
          id: "job-" + admitted.size,
          requestId: text(input["requestId"]),
          clientId: owner.clientId,
          state: "succeeded",
        };
        admitted.set(job.id, { job, payload });
        return job;
      },
      async wait(id): Promise<Result> {
        const item = admitted.get(id);
        assert.ok(item);
        const scripted = item.payload["method"] === "tools/call";
        if (scripted && fault === "lost-reply")
          throw new Error("lost original reply");
        const job = {
          ...item.job,
          ...(scripted && fault === "foreign-owner"
            ? { clientId: "foreign" }
            : {}),
          ...(scripted && fault === "foreign-request"
            ? { requestId: "foreign" }
            : {}),
        };
        const response =
          item.payload["method"] === "initialize"
            ? { protocolVersion: "2025-06-18" }
            : {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      success: true,
                      stdout: "ADAPTER_PROBE_1\n",
                      stderr: "",
                    }),
                  },
                ],
              };
        const value = {
          job,
          stdout: "",
          execution: {
            sdkSettled: !(scripted && fault === "missing-settlement"),
            mayHaveMutated: true,
          },
          rpc: {
            status:
              item.payload["method"] === "notifications/initialized"
                ? 202
                : 200,
            sessionId: "stable-session",
            raw: JSON.stringify({
              jsonrpc: "2.0",
              id: item.payload["id"],
              result: response,
            }),
          },
        };
        return value;
      },
      dispose() {},
    };
    const client = diagnosticAddinClient(
      session,
      {
        root,
        config: {
          backend: "addin",
          url: "http://never.invalid",
          timeoutMs: 1000,
        },
        queue,
        buildHash: "test",
      },
      1000,
    );
    t.after(() => disposeDiagnosticClient(root, client));
    const call = () =>
      client.callTool({
        featureType: "script",
        object: {
          readOnly: true,
          script: 'def run(_context: str):\n print("ADAPTER_PROBE_1")',
        },
      });
    if (fault === "none") {
      const value = await call();
      assert.equal(value.failed, false);
      assert.equal(value.text, "ADAPTER_PROBE_1\n");
      assert.equal(value.readOnlyRequested, true);
      assert.equal(value.readOnlyEnforced, false);
      assert.equal(
        session.report.requests.at(-1)?.result?.mayHaveMutated,
        true,
        "Readonly intent must not manufacture no-mutation proof",
      );
    } else {
      await assert.rejects(
        call(),
        /Foreign original|Unsettled|lost original reply/u,
      );
      const before = admitted.size;
      await assert.rejects(call(), /Unsettled/u);
      assert.equal(
        admitted.size,
        before,
        "Uncertain original reply must never be submitted again",
      );
      await session.cleanup();
      assert.equal(session.report.cleanup, "deferred");
    }
    assert.deepEqual(methods, [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.equal(session.report.requests.length, 3);
  });
}

test("native RPC preparation refuses an existing user broker before constructing a physical adapter", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-existing-broker-"),
  );
  const previous = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = directory;
  t.after(() => {
    if (previous === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const queue = path.join(directory, "fmcad", "queue");
  fs.mkdirSync(queue, { recursive: true });
  const filename = path.join(queue, "broker.lock"),
    sentinel = "owned-by-existing-user-broker";
  fs.writeFileSync(filename, sentinel);
  await assert.rejects(
    prepareNativeRpcRecoveryBroker(root, {
      backend: "addin",
      url: "http://never.invalid",
      timeoutMs: 1000,
    }),
    /Drain\/stop the idle broker/u,
  );
  assert.equal(fs.readFileSync(filename, "utf8"), sentinel);
});

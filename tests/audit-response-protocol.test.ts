import os from "node:os";
import { randomUUID } from "node:crypto";
import type {
  AuditScope,
  AuditRpc,
} from "../packages/node-adapters/src/execution/recovery-audit";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const repository = process.cwd();
const load = createRequire(
  path.join(repository, "tests", "audit-response-protocol.test.js"),
);
test.beforeEach((t) =>
  (t as test.TestContext).after(
    (load("./fixtures/fake-wsl-platform.cjs") as () => () => void)(),
  ),
);
const installation = repository;
const { createBrokerTransport } = load(
  "../src/dist/fusion-transport/broker",
) as typeof import("../packages/node-adapters/src/fusion-transport/broker");
const identity = {
  resolvedIdentity: {
    name: "Fixture historical document",
    creationId: "fixture-old-id",
    fileId: null,
  },
};
function summary() {
  return {
    version: 1,
    purpose: "atomic-recovery-audit-v1",
    profile: "atomic-recovery-counts-v1",
    requestIdentity: identity,
    nativeOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
    modulePresent: false,
    ui: { activeCommand: "SelectCommand", idle: true },
    commandDefinition: { status: "absent" },
    document: { status: "absent", matches: 0 },
    snapshot: null,
    fingerprint: null,
  };
}
for (const mode of [
  "frozen-843",
  "fixed",
  "wrong-wire-id",
  "lost-response",
  "bad-facts",
  "guarded-mutation",
  "unbound-mutation-rejected",
]) {
  test(
    "add-in/McpClient response contract with historical source comparison: " +
      mode,
    async (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "audit-id-protocol-"),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const scope = new AsyncLocalStorage<AuditScope>();
      const client = createBrokerTransport(
        { backend: "addin", url: "http://never-send.invalid", timeoutMs: 3000 },
        {
          version: "fixture",
          requestTimeout: (server) => server.timeoutMs!,
          bridgeSource: () => assert.fail("No generic bridge allowed"),
        },
      ) as import("../packages/node-adapters/src/fusion-transport/addin").BrokerAddinClient;
      client._post = (payload, session) => {
        assert.ok(
          scope.getStore(),
          "Every request stays inside the fake physical port",
        );
        return scope
          .getStore()!
          .post(payload as AuditRpc, session) as unknown as Promise<
          Awaited<ReturnType<typeof client._post>>
        >;
      };
      const create =
        mode === "frozen-843"
          ? (
              load("./fixtures/historical-module.cjs") as (
                revision: string,
                file: string,
              ) => typeof import("../src/queue-atomic-recovery-audit")
            )(
              "843ce0dc98d512f88c3c42124ad4f6909b69cc91",
              "src/queue-atomic-recovery-audit.js",
            ).createRecoveryAudit
          : (
              load(
                "../src/queue-atomic-recovery-audit",
              ) as typeof import("../src/queue-atomic-recovery-audit")
            ).createRecoveryAudit;
      let endedResolve!: () => void,
        tools = 0;
      const ended = new Promise<void>((resolve) => {
        endedResolve = resolve;
      });
      const mutating = mode.includes("mutation"),
        kind = mutating
          ? "isolated-scratch-qualification"
          : "atomic-recovery-audit";
      const binding = mutating
        ? {
            purpose: "isolated-scratch-epoch-v1",
            epochId: randomUUID(),
            forbiddenIds: ["fixture-old-id"],
            sdkProofPath: path.join(directory, kind, "sdk-qualified.json"),
            currentInstance: { pid: 1, birth: "fixture" },
          }
        : {
            purpose: "atomic-recovery-audit-v1",
            currentInstance: { pid: 1, birth: "fixture" },
          };
      const expectedFacts = (): Record<string, unknown> =>
        mutating
          ? {
              version: 1,
              purpose: binding.purpose,
              epochId: binding.epochId,
              bindingHash: (
                load(
                  "../src/dist/core/application/cad/json",
                ) as typeof import("../packages/core/src/application/cad/json")
              ).hash(binding),
              document: {
                name: "FMCAD_ISOLATED_" + binding.epochId,
                creationId: "new-fixture-id",
                fileId: null,
              },
              independent: true,
              empty: true,
              unsaved: true,
              activeCommand: "SelectCommand",
              beforeIdsHash: "a".repeat(64),
              historicalOutcome: "unknown",
              originalModelValidation: "not_performed",
              originalRollbackVerification: "not_performed",
            }
          : summary();
      const controller = create({
        kind,
        installation,
        buildHash: "qualified-fixture",
        jobDirectory: () => directory,
        ...(mutating
          ? {
              prepareReader: (
                load(
                  "../src/queue-scratch-qualification",
                ) as typeof import("../src/queue-scratch-qualification")
              ).prepareScratchQualification,
              parseSummary: (
                load(
                  "../src/queue-scratch-qualification",
                ) as typeof import("../src/queue-scratch-qualification")
              ).parseScratchQualification,
            }
          : {}),
        assertOwner() {},
        inspect: async () => ({
          identity,
          instance: { pid: 1, birth: "fixture" },
          binding,
        }),
        fence() {},
        begin() {},
        end: endedResolve,
        admit: (send) => send(),
        check: async () => ({ report: { status: "passed" }, fence() {} }), // Protocol unit test only; not a production checker proof.
        async post(payload) {
          if (payload.method === "initialize")
            return {
              status: 200,
              sessionId: "fixture-session",
              raw: JSON.stringify({
                jsonrpc: "2.0",
                id: payload.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  serverInfo: { name: "fixture", version: "1" },
                },
              }),
            };
          if (payload.method === "notifications/initialized")
            return { status: 202, raw: "" };
          tools++;
          assert.equal(typeof payload.id, "string");
          assert.match(payload.id as string, /^fmcad:/);
          if (mode === "lost-response")
            throw Object.assign(new Error("fixture lost response"), {
              code: "EPROTO",
            });
          const facts = expectedFacts();
          if (mode === "bad-facts") facts["nativeOutcome"] = "aborted";
          const reply = {
            jsonrpc: "2.0",
            id: mode === "wrong-wire-id" ? "foreign" : payload.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    stdout: "FMCAD_RESULT " + JSON.stringify(facts),
                    stderr: "",
                  }),
                },
              ],
              isError: false,
            },
          };
          return { status: 200, raw: JSON.stringify(reply) };
        },
        match(response, payload) {
          const reply = client._parse(response["raw"] as string) as Record<
            string,
            unknown
          >;
          if (reply["id"] !== payload.id || reply["jsonrpc"] !== "2.0")
            throw Object.assign(new Error("wrong wire"), {
              code: "UNKNOWN_RPC",
            });
          return reply;
        },
        remoteReceipt: () => ({ outcome: "succeeded" }),
        sendScript: (value, script) =>
          scope.run(value, async () => {
            const output =
              mode === "guarded-mutation"
                ? await client.executeUiGuardedScript(script, value.origin)
                : await client.callTool(
                    {
                      featureType: "script",
                      object: { script, readOnly: !mutating },
                    },
                    "fusion_mcp_execute",
                    value.origin,
                  );
            if (mode === "guarded-mutation")
              assert.equal(
                output["readOnlyRequested"],
                false,
                "Never misclassify mutation as read-only",
              );
            return output;
          }),
      });
      const message = {
        jobId: "target",
        observationJobId: "observer",
        requestId: "same-read",
      };
      await controller.handle(message, "owner");
      await ended;
      const result = (await controller.handle(message, "owner")) as {
        status: string;
        summary?: unknown;
        endpointVerified?: boolean;
        code?: string;
      };
      const expectedTools = mode === "unbound-mutation-rejected" ? 0 : 1;
      assert.equal(tools, expectedTools);
      if (mode === "fixed" || mode === "guarded-mutation") {
        assert.equal(result.status, "complete", JSON.stringify(result));
        assert.deepEqual(result.summary, expectedFacts());
        const record = JSON.parse(
          fs.readFileSync(path.join(directory, kind, "response.json"), "utf8"),
        ) as { callerId: number; wireId: string; reply: { id: string } };
        assert.equal(record.callerId, 2);
        assert.match(record.wireId, /^fmcad:/);
        assert.equal(record.reply.id, record.wireId);
      } else {
        assert.equal(result.status, "failed");
        assert.equal(result.endpointVerified, false);
        assert.equal(result.summary, undefined);
        assert.equal(
          result.code,
          mode === "unbound-mutation-rejected"
            ? "AUDIT_REQUEST_INVALID"
            : mode === "wrong-wire-id"
              ? "UNKNOWN_RPC"
              : mode === "bad-facts"
                ? "AUDIT_OUTPUT_INVALID"
                : "EPROTO",
        );
      }
      await controller.handle(message, "owner");
      assert.equal(tools, expectedTools, "No SDK replay on receipt reads");
    },
  );
}

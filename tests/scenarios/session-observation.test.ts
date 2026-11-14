import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ScenarioSession, resumeCleanup, type ScenarioReport } from "./runner";
import type { ScenarioBackend, ScriptRequest } from "./contracts";
import { marker } from "./programs";

function restored(t: TestContext, output: string) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-observe-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const runId = randomUUID(),
    scenarioId = "owned";
  const directory = path.join(parent, runId, scenarioId);
  fs.mkdirSync(directory, { recursive: true });
  const owner = {
    runId,
    scenarioId,
    clientId: `scenario:${runId}:${scenarioId}`,
  };
  const requests: ScriptRequest[] = [];
  const backend: ScenarioBackend = {
    identity: "bounded-runner-unit",
    mode: "simulator",
    qualification: "component",
    protocol: "mcp",
    capabilities: new Set(["documents"]),
    fusionPath: (file) => file,
    async execute(request) {
      requests.push(request);
      return {
        requestId: request.requestId,
        state: "succeeded",
        sdkSettled: true,
        mayHaveMutated: true,
        stdout: output,
      };
    },
    async lookup() {
      throw new Error("Unexpected lookup after explicit domain hold");
    },
  };
  const report: ScenarioReport = {
    owner,
    directory,
    mode: backend.mode,
    qualification: backend.qualification,
    protocol: backend.protocol,
    backendIdentity: backend.identity,
    status: "running",
    cleanup: "pending",
    requests: [],
    document: { creationId: "owned-id", name: "owned-name" },
  };
  return {
    session: new ScenarioSession(
      backend,
      owner,
      directory,
      undefined,
      undefined,
      report,
    ),
    backend,
    requests,
    directory,
  };
}

test("owned observation preserves the original active document and checks returned identity", async (t) => {
  const f = restored(
    t,
    marker + JSON.stringify({ creationId: "owned-id", active: "foreign-id" }),
  );
  assert.equal(
    (await f.session.observe("observe-active", "read-only source"))["active"],
    "foreign-id",
  );
  assert.equal(f.requests.length, 1);
  assert.equal(
    f.requests[0]?.target,
    undefined,
    "No CLI target may activate the fixture before the observation",
  );
  assert.equal(f.requests[0]?.owner.clientId, f.session.report.owner.clientId);
  assert.equal(
    f.requests[0]?.requestId,
    f.session.report.requests[0]?.requestId,
  );
});

for (const output of [
  "",
  marker + "{",
  marker + JSON.stringify({ creationId: "foreign" }),
]) {
  test(
    "missing, malformed or foreign observation holds cleanup and never submits another request: " +
      JSON.stringify(output),
    async (t) => {
      const f = restored(t, output);
      await assert.rejects(
        f.session.observe("observe-state", "read-only source"),
      );
      await assert.rejects(
        f.session.execute("next", "must not execute"),
        /Unsettled/u,
      );
      await f.session.cleanup();
      assert.equal(f.session.report.cleanup, "deferred");
      assert.equal(f.requests.length, 1);
    },
  );
}

test("explicit native domain uncertainty stays deferred despite a completed outer SDK request", async (t) => {
  const f = restored(t, marker + JSON.stringify({ creationId: "owned-id" }));
  await f.session.observe("observe-native-outcome", "read-only source");
  assert.throws(
    () => f.session.deferCleanup("Native feature settlement is unknown"),
    /Native feature/u,
  );
  await f.session.cleanup();
  assert.equal(f.session.report.cleanup, "deferred");
  await assert.rejects(
    resumeCleanup(f.backend, path.join(f.directory, "report.json")),
    /Case-specific mutation outcome/u,
  );
  assert.equal(f.requests.length, 1);
});

test("registered transport persists its original intent before dispatch and preserves raw evidence", async (t) => {
  const f = restored(t, "");
  const raw = { status: "RESULT_UNAVAILABLE", http: 409 };
  const value = await f.session.registeredRequest(
    "transport-negative",
    { readOnly: true, payloadSha256: "a".repeat(64) },
    async (context) => {
      const durable = JSON.parse(
        fs.readFileSync(path.join(f.directory, "report.json"), "utf8"),
      ) as ScenarioReport;
      assert.equal(durable.requests.at(-1)?.requestId, context.requestId);
      assert.deepEqual(durable.requests.at(-1)?.intent, {
        readOnly: true,
        payloadSha256: "a".repeat(64),
      });
      assert.equal(context.owner.clientId, f.session.report.owner.clientId);
      return {
        execution: {
          requestId: context.requestId,
          state: "failed",
          sdkSettled: true,
          mayHaveMutated: false,
          stdout: "",
          stderr: "original diagnostic",
        },
        value: raw,
      };
    },
  );
  assert.equal(value, raw);
  assert.equal(f.session.report.requests.at(-1)?.result?.state, "failed");
  assert.equal(f.session.uncertain, false);
});

test("lost registered transport blocks every later dispatch and preserves cleanup", async (t) => {
  const f = restored(t, "");
  let sends = 0;
  await assert.rejects(
    f.session.registeredRequest(
      "transport-lost",
      { readOnly: true },
      async () => {
        sends++;
        throw new Error("response lost");
      },
    ),
    /response lost/u,
  );
  await assert.rejects(
    f.session.registeredRequest(
      "transport-next",
      { readOnly: true },
      async () => {
        sends++;
        throw new Error("must not send");
      },
    ),
    /Unsettled/u,
  );
  await f.session.cleanup();
  assert.equal(sends, 1);
  assert.equal(f.session.report.cleanup, "deferred");
});

test("a matching outer request cannot conceal a foreign original broker receipt", async (t) => {
  const f = restored(t, "");
  await assert.rejects(
    f.session.registeredRequest(
      "transport-foreign",
      { readOnly: true },
      async ({ requestId }) => ({
        execution: {
          requestId,
          state: "succeeded",
          sdkSettled: true,
          mayHaveMutated: false,
          stdout: "",
          brokerReceipt: {
            requestId,
            jobId: "foreign-job",
            clientId: "foreign-client",
            state: "succeeded",
            operationResult: {},
          },
        },
        value: "must not be returned",
      }),
    ),
    /mismatched original request/u,
  );
  await f.session.cleanup();
  assert.equal(f.session.report.cleanup, "deferred");
});

test("public CLI inspection retains raw text and its original receipt without a target", async (t) => {
  const f = restored(t, "DOC name=original\nDONE\n");
  const result = await f.session.inspectCli(
    "inspect-document-list",
    "doc-list",
  );
  assert.equal(result.stdout, "DOC name=original\nDONE\n");
  assert.equal(f.requests[0]?.inspectCli, "doc-list");
  assert.equal(f.requests[0]?.target, undefined);
  assert.equal(result.requestId, f.session.report.requests[0]?.requestId);
});

test("readonly peer has its own durable identity and blocks its parent after a lost result", async (t) => {
  const f = restored(t, "");
  const report = { ...f.session.report };
  delete report.document;
  report.lifecycle = "read-only";
  report.scope = "exclusive-instance";
  report.cleanup = "not-created";
  const parent = new ScenarioSession(
    f.backend,
    report.owner,
    f.directory,
    undefined,
    undefined,
    report,
  );
  const peer = parent.createReadonlyPeer("b");
  assert.notEqual(peer.report.owner.clientId, parent.report.owner.clientId);
  const durable = JSON.parse(
    fs.readFileSync(path.join(f.directory, "report.json"), "utf8"),
  ) as ScenarioReport;
  assert.deepEqual(durable.peers, [peer.report.owner]);
  let sends = 0;
  await assert.rejects(
    peer.registeredRequest(
      "transport-peer-lost",
      { readOnly: true },
      async (context) => {
        sends++;
        assert.equal(context.owner.clientId, peer.report.owner.clientId);
        throw new Error("peer response lost");
      },
    ),
    /peer response lost/u,
  );
  assert.equal(parent.uncertain, true);
  await assert.rejects(
    parent.registeredRequest(
      "transport-parent-next",
      { readOnly: true },
      async () => {
        sends++;
        throw new Error("must not send");
      },
    ),
    /Unsettled/u,
  );
  await parent.cleanup();
  assert.equal(peer.report.cleanup, "deferred");
  assert.equal(parent.report.cleanup, "deferred");
  assert.equal(sends, 1);
});

test("canonical CAD command carries an owned unsaved identity without fabricating a file", async (t) => {
  const f = restored(
    t,
    JSON.stringify({
      success: true,
      operation: "entity.inspect",
      result: { kind: "body" },
    }),
  );
  assert.equal(
    (await f.session.cad("cad-inspect", "entity.inspect", { ref: "body" }))[
      "success"
    ],
    true,
  );
  assert.deepEqual(f.requests[0]?.target, {
    creationId: "owned-id",
    name: "owned-name",
  });
  assert.deepEqual(f.requests[0]?.command, {
    operation: "entity.inspect",
    data: { ref: "body" },
  });
});

test("checkpoint child creation without its bound closure proof defers primary cleanup", async (t) => {
  const f = restored(t, marker + JSON.stringify({ creationId: "owned-id" }));
  const input = path.join(f.directory, "owned.f3d");
  fs.writeFileSync(input, "bounded intent test; no native archive claim");
  await assert.rejects(
    f.session.execute("checkpoint-child", (requestId) => {
      const proof = f.session.prepareChildReceipt(
        "checkpoint-child",
        requestId,
        input,
      );
      fs.writeFileSync(
        proof,
        JSON.stringify({
          requestId,
          clientId: f.session.report.owner.clientId,
          parentCreationId: "owned-id",
          path: input,
          creationId: "child-id",
          name: "owned-child",
          saved: false,
          fileId: null,
          status: "created",
        }),
      );
      return "unit test intent only";
    }),
    /closure is unverified/u,
  );
  await f.session.cleanup();
  assert.equal(f.session.report.cleanup, "deferred");
  assert.equal(
    f.requests.length,
    1,
    "The parent cannot be closed while its imported child is unaccounted",
  );
  const intent = JSON.parse(
    fs.readFileSync(
      path.join(f.directory, "children/checkpoint-child.intent.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(intent["requestId"], f.session.report.requests[0]?.requestId);
  assert.deepEqual(intent["owner"], f.session.report.owner);
});

test("a child intent cannot enroll a foreign file or request", async (t) => {
  const f = restored(t, marker + JSON.stringify({ creationId: "owned-id" }));
  assert.throws(
    () =>
      f.session.prepareChildReceipt(
        "checkpoint",
        "foreign",
        path.join(f.directory, "own.f3d"),
      ),
    /does not belong/u,
  );
  await assert.rejects(
    f.session.execute("checkpoint", (requestId) => {
      f.session.prepareChildReceipt(
        "checkpoint",
        requestId,
        path.resolve(f.directory, "../foreign.f3d"),
      );
      return "must not submit";
    }),
    /does not belong/u,
  );
  assert.equal(f.requests.length, 0);
});

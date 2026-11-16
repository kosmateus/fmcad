import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Owner, ScenarioBackend } from "./contracts";
import { ScenarioSession, type ScenarioReport } from "./runner";

test("owned integration CLI settles each child dispatch before the next one", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-native-integration-fence-"),
  );
  const runtime = path.join(directory, "runtime");
  fs.mkdirSync(path.join(runtime, "dist/src"), { recursive: true });
  const runId = randomUUID();
  const owner: Owner = {
    runId,
    scenarioId: "native-integration-fence",
    clientId: "scenario:" + runId + ":native-integration-fence",
  };
  const document = {
    creationId: "fence-document",
    name: "Owned Fence Document v1",
    file: {
      fileId: "fence-file",
      projectId: "fence-project",
      folderId: "fence-folder",
      version: 1,
    },
  };
  const report: ScenarioReport = {
    owner,
    directory,
    mode: "simulator",
    qualification: "broker",
    protocol: "mcp",
    backendIdentity: "owned-integration-fence-test",
    status: "running",
    cleanup: "pending",
    document,
    requests: [],
  };
  fs.writeFileSync(
    path.join(directory, "creation.json"),
    JSON.stringify({
      ...document,
      clientId: owner.clientId,
      requestId: owner.clientId + ":create",
    }),
    { mode: 0o600 },
  );
  const requestOrder: string[] = [];
  const lookupCounts = new Map<string, number>();
  const backend: ScenarioBackend = {
    identity: report.backendIdentity,
    mode: "simulator",
    qualification: "broker",
    protocol: "mcp",
    capabilities: new Set(),
    fusionPath: (value) => value,
    execute: async () => {
      throw new Error("Owned child settlement must never submit a replacement");
    },
    lookup: async (actualOwner, requestId) => {
      assert.deepEqual(actualOwner, owner);
      if (!requestOrder.includes(requestId)) requestOrder.push(requestId);
      const lookups = (lookupCounts.get(requestId) ?? 0) + 1;
      lookupCounts.set(requestId, lookups);
      if (lookups === 1) return null;
      return {
        requestId,
        state: "succeeded",
        sdkSettled: true,
        mayHaveMutated: false,
        stdout: "original terminal receipt",
        brokerReceipt: {
          requestId,
          jobId: "job-" + requestId,
          clientId: owner.clientId,
          state: "succeeded",
          operationResult: null,
        },
      };
    },
  };
  const previousRuntime = process.env["FMCAD_LIVE_RUNTIME_ROOT"];
  const previousTestContext = process.env["NODE_TEST_CONTEXT"];
  t.after(() => {
    if (previousRuntime === undefined)
      delete process.env["FMCAD_LIVE_RUNTIME_ROOT"];
    else process.env["FMCAD_LIVE_RUNTIME_ROOT"] = previousRuntime;
    if (previousTestContext === undefined)
      delete process.env["NODE_TEST_CONTEXT"];
    else process.env["NODE_TEST_CONTEXT"] = previousTestContext;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  process.env["FMCAD_LIVE_RUNTIME_ROOT"] = runtime;
  delete process.env["NODE_TEST_CONTEXT"];
  fs.writeFileSync(
    path.join(runtime, "dist/src/cli.js"),
    `"use strict";
const fs = require("node:fs");
const path = require("node:path");
exports.main = async (_argv, { stderr }) => {
  const filename = process.env.FMCAD_LIVE_COMMAND_INTENT;
  const current = JSON.parse(fs.readFileSync(filename, "utf8"));
  const intents = path.dirname(filename);
  const pending = fs.readdirSync(intents).filter(name => name.endsWith(".json") && path.join(intents, name) !== filename)
    .map(name => JSON.parse(fs.readFileSync(path.join(intents, name), "utf8")))
    .filter(value => value.admissionRequested && (!value.settlement || value.settlement.requestId !== value.requestId || value.settlement.clientId !== value.owner.clientId || !value.settlement.jobId || !["succeeded", "failed"].includes(value.settlement.state) || value.settlement.sdkSettled !== true));
  if (pending.length) {
    stderr.write("Previous admitted command lacks terminal owner settlement\\n");
    return 2;
  }
  stderr.write("FMCAD_QUEUE_REQUEST " + JSON.stringify({ requestId: current.requestId, clientId: current.owner.clientId }) + "\\n");
  const lease = JSON.parse(fs.readFileSync(process.env.FMCAD_LIVE_OWNED_SCOPE, "utf8"));
  process.stdout.write(JSON.stringify({ success: true, result: {
    creationId: lease.document.creationId,
    fileId: lease.document.file.fileId,
    projectId: lease.document.file.projectId,
    folderId: lease.document.file.folderId
  }}) + "\\n");
  return 0;
};
`,
  );
  const session = new ScenarioSession(
    backend,
    owner,
    directory,
    undefined,
    undefined,
    report,
  );
  await session.legacyCli(
    "tests/fixtures/owned-cli/settlement-fence.test.js",
    "owned child CLI dispatches two settled commands",
  );
  assert.equal(requestOrder.length, 2);
  assert.equal(lookupCounts.size, 2);
  assert.ok([...lookupCounts.values()].every((lookups) => lookups === 2));
  assert.equal(session.report.requests.length, 2);
  assert.deepEqual(
    session.report.requests.map((request) => request.result?.state),
    ["succeeded", "succeeded"],
  );
});

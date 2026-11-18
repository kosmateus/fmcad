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
  const runtimeDist = path.join(runtime, "dist");
  fs.mkdirSync(path.join(runtimeDist, "src"), { recursive: true });
  fs.mkdirSync(path.join(runtimeDist, "bin"), { recursive: true });
  const fingerprint = "a".repeat(64);
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
    protocol: "addin",
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
      requestId: owner.clientId + ":0",
    }),
    { mode: 0o600 },
  );
  const requestOrder: string[] = [];
  const lookupCounts = new Map<string, number>();
  const backend: ScenarioBackend = {
    identity: report.backendIdentity,
    mode: "simulator",
    qualification: "broker",
    protocol: "addin",
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
    path.join(runtimeDist, "package.json"),
    JSON.stringify({ name: "fmcad", fmcadRuntimeLayout: 1 }),
  );
  fs.writeFileSync(
    path.join(runtimeDist, "runtime-build.json"),
    JSON.stringify({
      version: 1,
      algorithm: "sha256",
      fingerprint,
      entrypoints: {
        "queue-worker": "worker.js",
        "queue-autostart-worker": "autostart.js",
        "queue-broker": "broker.js",
      },
    }),
  );
  fs.writeFileSync(
    path.join(runtimeDist, "src/queue-instance.js"),
    `exports.buildHash = () => ${JSON.stringify(fingerprint)};\n`,
  );
  fs.writeFileSync(
    path.join(runtimeDist, "src/config.js"),
    `exports.loadConfig = () => ({ cfg: {
  backend: "addin",
  url: "http://127.0.0.1:8765/mcp",
  protocolVersion: "2025-06-18",
  tool: "execute_python",
  timeoutMs: 60000
} });\n`,
  );
  fs.writeFileSync(
    path.join(runtimeDist, "bin/fmcad.js"),
    `"use strict";
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error("Missing " + flag);
  return args[index + 1];
};
if (args[0] !== "queue" || args[1] !== "exec") process.exit(2);
const requestId = value("--request-id");
const clientId = value("--client");
process.stderr.write("FMCAD_QUEUE_REQUEST " + JSON.stringify({ requestId, clientId }) + "\\n");
process.stderr.write("FMCAD_QUEUE_JOB " + JSON.stringify({ requestId, clientId, jobId: "job-" + requestId }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, result: {
  creationId: "fence-document",
  fileId: "fence-file",
  projectId: "fence-project",
  folderId: "fence-folder"
} }) + "\\n");
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

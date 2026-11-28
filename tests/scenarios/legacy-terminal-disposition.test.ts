import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  publishLegacyTerminalDisposition,
  validateLegacyTerminalDisposition,
  type LegacyTerminalBackend,
  type LegacyTerminalPorts,
} from "./legacy-terminal-disposition";

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-terminal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "native-legacy-0");
  fs.mkdirSync(path.join(directory, "legacy/intents"), { recursive: true });
  fs.mkdirSync(path.join(directory, "legacy/queue-receipts"));
  const owner = {
    runId: randomUUID(),
    scenarioId: "native-legacy-0",
    clientId: "",
  };
  owner.clientId = `scenario:${owner.runId}:${owner.scenarioId}`;
  const id = randomUUID(),
    requestId = owner.clientId + ":legacy:" + id,
    jobId = randomUUID();
  const document = { creationId: randomUUID(), name: "Exact owned fixture" };
  const buildHash = "a".repeat(64);
  const backend: LegacyTerminalBackend = {
    mode: "fusion",
    protocol: "addin",
    identity: "fusion:addin:" + buildHash,
  };
  const write = (file: string, value: unknown) =>
    fs.writeFileSync(path.join(directory, file), JSON.stringify(value));
  write("../index.json", {
    runId: owner.runId,
    backendIdentity: backend.identity,
    processIdentity: { pid: 3, birth: "parent" },
  });
  write("report.json", {
    directory,
    owner,
    document,
    mode: "fusion",
    protocol: "addin",
    backendIdentity: backend.identity,
    status: "failed",
    cleanup: "deferred",
    scope: "exclusive-instance",
    error:
      "Original legacy request remains unsettled; cleanup deferred: " +
      requestId,
  });
  write("creation.json", {
    ...document,
    clientId: owner.clientId,
    requestId: owner.clientId + ":0",
  });
  write("legacy/lease.json", {
    version: 1,
    owner,
    document,
    directory,
    source: "tests/scenarios/legacy-owned-driver.ts",
    testCase: "native-legacy-cli",
    protocol: "addin",
    mode: "owned-unsaved-script",
  });
  write("legacy/launch.json", {
    state: "completed",
    code: 1,
    pid: 1,
    birth: "child",
  });
  write("legacy/completion.json", {
    owner,
    document,
    status: "failed",
    safeForCleanup: true,
    reportPath: path.join(directory, "legacy/readback.json"),
  });
  write("legacy/readback.json", { status: "failed" });
  write("legacy/stdout.log", "");
  write("legacy/stderr.log", "Original failure");
  const intent = `legacy/intents/${id}.json`;
  write(intent, {
    version: 1,
    owner,
    requestId,
    argvHash: "b".repeat(64),
    admissionRequested: true,
    completed: true,
    exitCode: 1,
    pid: 2,
    birth: "cli",
    settlementFailure: {
      requestId,
      clientId: owner.clientId,
      reason: "lookup-unavailable",
    },
  });
  write(`legacy/queue-receipts/${id}.json`, {
    version: 1,
    owner,
    requestId,
    jobId,
  });
  const raw = {
    job: {
      id: jobId,
      clientId: owner.clientId,
      requestId,
      kind: "command",
      state: "failed",
      code: "LOCAL_PREPARATION_FAILED",
      executionOutcome: "not_started",
      mayHaveMutated: false,
      finishedAt: 1,
      operationResult: {
        version: 1,
        jobId,
        requestId,
        acceptance: "accepted",
        executionOutcome: "not_started",
        mayHaveMutated: false,
        code: "LOCAL_PREPARATION_FAILED",
        validation: { status: "not_checked" },
      },
    },
    execution: {
      state: "failed",
      code: "LOCAL_PREPARATION_FAILED",
      executionOutcome: "not_started",
      mayHaveMutated: false,
      sdkSettled: true,
    },
    stdout: "",
    stderr: "ERROR unknown option for doc list: --doc\n",
    pythonChecks: [],
  };
  const sourceHashes: LegacyTerminalPorts["sourceBinding"]["sourceHashes"] = {};
  for (const base of ["runner", "legacy-owned-driver", "legacy-handoff"])
    for (const name of [
      `tests/scenarios/${base}.ts`,
      `dist/tests/scenarios/${base}.js`,
    ]) {
      const file = path.join(root, name.replaceAll("/", "__"));
      fs.writeFileSync(file, "independently captured " + name);
      sourceHashes[name] = {
        path: file,
        sha256: createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex"),
      };
    }
  const ports: LegacyTerminalPorts = {
    sourceBinding: { driverSource: "c".repeat(40), buildHash, sourceHashes },
    producerAlive: () => false,
    readOriginal: async (o, r, j) => {
      assert.deepEqual(o, owner);
      assert.equal(r, requestId);
      assert.equal(j, jobId);
      return raw;
    },
  };
  return { directory, backend, ports, raw, intent, write, requestId, jobId };
}
test("accepted pre-execution failure needs a separate disposition, not zero intents or fabricated completion", async (t) => {
  const f = setup(t),
    before = fs.readFileSync(path.join(f.directory, f.intent));
  assert.throws(
    () => validateLegacyTerminalDisposition(f.directory, f.backend),
    { code: "ENOENT" },
  );
  const result = await publishLegacyTerminalDisposition(
    f.directory,
    f.backend,
    f.ports,
  );
  assert.equal(result.jobId, f.jobId);
  assert.equal(result.originalRequest.result.state, "failed");
  assert.equal(result.originalRequest.result.sdkSettled, true);
  assert.equal(result.originalRequest.result.mayHaveMutated, false);
  assert.equal(result.expectedModified, false);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, f.intent)), before);
  await assert.rejects(
    publishLegacyTerminalDisposition(f.directory, f.backend, f.ports),
    { code: "EEXIST" },
  );
  f.write("legacy/readback.json", { status: "tampered" });
  assert.throws(
    () => validateLegacyTerminalDisposition(f.directory, f.backend),
    /Original artifact changed/,
  );
});
for (const change of [
  "unknown",
  "owner",
  "request",
  "job",
  "started",
  "mutated",
  "unsettled",
  "binding",
  "source",
  "producer",
] as const)
  test(`accepted legacy disposition rejects ${change}`, async (t) => {
    const f = setup(t);
    if (change === "unknown") f.raw.job.state = "unknown";
    if (change === "owner") f.raw.job.clientId = "foreign";
    if (change === "request") f.raw.job.requestId = "foreign";
    if (change === "job") f.raw.job.id = randomUUID();
    if (change === "started") f.raw.execution.executionOutcome = "failed";
    if (change === "mutated") f.raw.execution.mayHaveMutated = true;
    if (change === "unsettled") f.raw.execution.sdkSettled = false;
    if (change === "binding")
      Reflect.deleteProperty(f.raw.job.operationResult, "jobId");
    if (change === "source")
      f.ports.sourceBinding.sourceHashes["tests/scenarios/runner.ts"]!.sha256 =
        "f".repeat(64);
    if (change === "producer") f.ports.producerAlive = () => null;
    await assert.rejects(
      publishLegacyTerminalDisposition(f.directory, f.backend, f.ports),
    );
    assert.equal(
      fs.existsSync(path.join(f.directory, "legacy/terminal-disposition.json")),
      false,
    );
  });

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { record } from "./contracts";
import {
  assertFencedDocumentInventory,
  assertReceiptBoundDocumentInventory,
  currentProcessIdentity,
  discoverOwnedUnsavedFixtureProofs,
} from "./fixture-provenance";
import * as programs from "./programs";

function peer(t: TestContext, sequence = 1) {
  const parent = path.join(process.cwd(), ".test-artifacts/scenario-unit");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "peer-create-phase-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = randomUUID(),
    scenarioId = "capture-before-create",
    clientId = `scenario:${runId}:${scenarioId}`,
    directory = path.join(root, runId, scenarioId),
    document = { creationId: randomUUID(), name: "Exact owned scratch" },
    requestId = `${clientId}:${sequence}`,
    identity = {
      ...document,
      requestId,
      clientId,
      activeCreationId: document.creationId,
    },
    backend = {
      identity: "peer-create-phase:v1",
      mode: "fusion" as const,
      qualification: "broker" as const,
      protocol: "addin" as const,
    },
    jobId = randomUUID(),
    create = {
      requestId,
      phase: "create",
      intent: { kind: "script" },
      result: {
        requestId,
        state: "succeeded",
        sdkSettled: true,
        mayHaveMutated: true,
        exitCode: 0,
        stdout: programs.marker + JSON.stringify(identity) + "\n",
        brokerReceipt: {
          requestId,
          clientId,
          jobId,
          state: "succeeded",
          operationResult: {
            version: 1,
            requestId,
            jobId,
            acceptance: "accepted",
            executionOutcome: "succeeded",
            mayHaveMutated: true,
          },
        },
      },
    },
    capture = {
      requestId: clientId + ":0",
      phase: "original-user-view-capture",
      intent: { kind: "script" },
      result: {
        requestId: clientId + ":0",
        state: "succeeded",
        sdkSettled: true,
        mayHaveMutated: true,
        stdout:
          programs.marker + JSON.stringify({ documents: [], active: null }),
      },
    },
    report = {
      owner: { runId, scenarioId, clientId },
      directory,
      ...backend,
      backendIdentity: backend.identity,
      scope: "exclusive-instance",
      status: "running",
      cleanup: "pending",
      document,
      requests: sequence ? [capture, create] : [create],
    };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(root, runId, "index.json"),
    JSON.stringify({
      runId,
      ...backend,
      backendIdentity: backend.identity,
      scenarioIds: [scenarioId],
      processIdentity: currentProcessIdentity(),
      before: { documents: [] },
      status: "running",
    }),
  );
  const writeReport = () =>
    fs.writeFileSync(
      path.join(directory, "report.json"),
      JSON.stringify(report),
    );
  writeReport();
  fs.writeFileSync(
    path.join(directory, "creation.json"),
    JSON.stringify(identity),
    { flag: "wx", mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(directory, `request-${sequence}.py`),
    programs.create(document.name, path.join(directory, "creation.json"), {
      requestId,
      clientId,
    }),
    { flag: "wx", mode: 0o600 },
  );
  return {
    root,
    directory,
    backend,
    document,
    report,
    create,
    capture,
    identity,
    writeReport,
  };
}

for (const sequence of [1, 7])
  test(`peer discovery binds capture:0 followed by exact settled create:${sequence}`, (t) => {
    const fixture = peer(t, sequence);
    assert.deepEqual(
      discoverOwnedUnsavedFixtureProofs(fixture.root, fixture.backend).get(
        fixture.document.creationId,
      ),
      { document: fixture.document, state: "open" },
      "The actual create phase and immutable receipt, not any fixed ordinal, bind the peer",
    );
  });

test("peer creation without a preceding capture remains valid at ordinal zero", (t) => {
  const fixture = peer(t, 0);
  assert.equal(
    discoverOwnedUnsavedFixtureProofs(fixture.root, fixture.backend).get(
      fixture.document.creationId,
    )?.state,
    "open",
  );
});

for (const sequence of [0, 1]) {
  for (const tamper of [
    "wrong-phase",
    "duplicate-create",
    "foreign-request",
    "foreign-client",
    "foreign-job",
    "foreign-original-request",
    "unaccepted-original",
    "unknown",
    "unsettled",
    "failed-exit",
    "missing-creation",
    "changed-immutable-body",
    "changed-result-body",
    "duplicate-body",
    "pretend-create",
  ] as const) {
    test(`peer create:${sequence} rejects ${tamper} without admitting by name`, (t) => {
      const fixture = peer(t, sequence),
        result = fixture.create.result,
        receipt = result.brokerReceipt;
      switch (tamper) {
        case "wrong-phase":
          fixture.create.phase = "observe";
          break;
        case "duplicate-create":
          fixture.report.requests.push(fixture.create);
          break;
        case "foreign-request":
          fixture.create.requestId = "scenario:foreign:0";
          break;
        case "foreign-client":
          receipt.clientId = "scenario:foreign";
          break;
        case "foreign-job":
          receipt.operationResult.jobId = randomUUID();
          break;
        case "foreign-original-request":
          receipt.operationResult.requestId += ":foreign";
          break;
        case "unaccepted-original":
          receipt.operationResult.acceptance = "rejected";
          break;
        case "unknown":
          result.state = "unknown";
          receipt.state = "unknown";
          break;
        case "unsettled":
          result.sdkSettled = false;
          break;
        case "failed-exit":
          Object.assign(result, { exitCode: 1 });
          break;
        case "missing-creation":
          fs.unlinkSync(path.join(fixture.directory, "creation.json"));
          break;
        case "changed-immutable-body":
          fs.writeFileSync(
            path.join(fixture.directory, "creation.json"),
            JSON.stringify({
              ...fixture.identity,
              activeCreationId: "foreign",
            }),
          );
          break;
        case "changed-result-body":
          result.stdout =
            programs.marker +
            JSON.stringify({ ...fixture.identity, unexpected: true });
          break;
        case "duplicate-body":
          result.stdout += "\n" + result.stdout;
          break;
        case "pretend-create":
          result.stdout = fixture.capture.result.stdout;
          break;
      }
      fixture.writeReport();
      assert.equal(
        discoverOwnedUnsavedFixtureProofs(fixture.root, fixture.backend).size,
        0,
      );
    });
  }
}

test("a relabelled capture cannot replace the immutable original create phase", (t) => {
  const fixture = peer(t);
  const body = record(
    JSON.parse(
      fixture.create.result.stdout.slice(programs.marker.length),
    ) as unknown,
  );
  body["requestId"] = fixture.capture.requestId;
  fixture.create.requestId = fixture.capture.requestId;
  fixture.create.result.requestId = fixture.capture.requestId;
  fixture.create.result.brokerReceipt.requestId = fixture.capture.requestId;
  fixture.create.result.brokerReceipt.operationResult.requestId =
    fixture.capture.requestId;
  fixture.create.result.stdout = programs.marker + JSON.stringify(body);
  fixture.report.requests.splice(0, 1);
  fixture.writeReport();
  assert.equal(
    discoverOwnedUnsavedFixtureProofs(fixture.root, fixture.backend).size,
    0,
  );
});

test("phase-bound peers may change between turns but foreign changes within one turn still fail", (t) => {
  const fixture = peer(t),
    proofs = discoverOwnedUnsavedFixtureProofs(fixture.root, fixture.backend),
    pristine = {
      ...fixture.document,
      saved: false,
      fileId: null,
      modified: false,
    },
    modified = { ...pristine, modified: true },
    user = {
      creationId: "user",
      name: "User design",
      saved: false,
      fileId: null,
      modified: false,
    },
    target = { creationId: "observer", name: "Other owner scratch" },
    own = { ...target, saved: false, fileId: null, modified: false };
  assert.equal(proofs.get(fixture.document.creationId)?.state, "open");
  assert.doesNotThrow(() =>
    assertReceiptBoundDocumentInventory(
      [pristine, user],
      [modified, user],
      proofs,
      "foreign baseline changed",
    ),
  );
  assert.throws(
    () =>
      assertReceiptBoundDocumentInventory(
        [pristine, user],
        [modified, { ...user, modified: true }],
        proofs,
        "foreign baseline changed",
      ),
    /foreign baseline changed/u,
  );
  assert.throws(
    () =>
      assertFencedDocumentInventory(
        [pristine, user, own],
        [modified, user, own],
        target,
        [pristine, user],
        proofs,
        "peer changed within observer SDK turn",
      ),
    /peer changed within observer SDK turn/u,
  );
});

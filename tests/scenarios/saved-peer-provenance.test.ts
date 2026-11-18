import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Document,
  Execution,
  SavedFile,
  ScenarioBackend,
} from "./contracts";
import {
  assertReceiptBoundDocumentInventory,
  currentProcessIdentity,
  discoverOwnedUnsavedFixtureProofs,
} from "./fixture-provenance";
import { marker } from "./programs";

function savedPeer(t: TestContext, sameId = false) {
  const parent = path.join(process.cwd(), ".test-artifacts/scenario-unit");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "saved-peer-proof-")),
    runId = randomUUID(),
    scenarioId = "saved-peer-owner",
    clientId = `scenario:${runId}:${scenarioId}`,
    directory = path.join(root, runId, scenarioId),
    original: Document = { creationId: randomUUID(), name: "Owned scratch" },
    file: SavedFile = {
      projectId: "owned-project",
      folderId: "owned-folder",
      fileId: "owned-file",
      version: 1,
    },
    savedDocument = {
      creationId: sameId ? original.creationId : randomUUID(),
      name: "Owned scratch v0",
      file,
    },
    owner = { runId, scenarioId, clientId },
    backend = {
      identity: "saved-peer-proof:v1",
      mode: "fusion",
      qualification: "broker",
      protocol: "addin",
    } satisfies Pick<
      ScenarioBackend,
      "identity" | "mode" | "qualification" | "protocol"
    >,
    identity = {
      ...original,
      activeCreationId: original.creationId,
      clientId,
      requestId: clientId + ":0",
    },
    intent = {
      creationId: original.creationId,
      name: original.name,
      projectId: file.projectId,
      folderId: file.folderId,
      clientId,
      requestId: clientId + ":2",
    },
    accepted = {
      ...intent,
      accepted: true,
      postCreationId: savedDocument.creationId,
      postName: savedDocument.name,
    };
  const request = (
    sequence: number,
    phase: string,
    value: Record<string, unknown>,
  ) => {
    const requestId = clientId + ":" + sequence;
    const result: Execution = {
      requestId,
      state: "succeeded",
      sdkSettled: true,
      mayHaveMutated: true,
      exitCode: 0,
      stdout: marker + JSON.stringify(value) + "\n",
      brokerReceipt: {
        requestId,
        clientId,
        jobId: randomUUID(),
        state: "succeeded",
        operationResult: null,
      },
    };
    return { requestId, phase, intent: { kind: "script" }, result };
  };
  const report = {
    owner,
    directory,
    mode: backend.mode,
    qualification: backend.qualification,
    protocol: backend.protocol,
    backendIdentity: backend.identity,
    scope: "owned-document",
    status: "running",
    cleanup: "pending",
    fixture: { projectId: file.projectId, folderId: file.folderId },
    document: savedDocument,
    savedIdentityTransition: {
      version: 1,
      originalCreationId: original.creationId,
      saveRequestId: intent.requestId,
      creationId: savedDocument.creationId,
      name: savedDocument.name,
    },
    requests: [
      request(0, "create", identity),
      request(1, "export", { creationId: original.creationId, exported: true }),
      request(2, "save", accepted),
      request(3, "save-observe", {
        creationId: savedDocument.creationId,
        saved: true,
        complete: true,
        ...file,
      }),
    ],
  };
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value), {
      mode: 0o600,
    });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(root, runId, "index.json"),
    JSON.stringify({
      runId,
      ...backend,
      backendIdentity: backend.identity,
      processIdentity: currentProcessIdentity(),
      before: { documents: [] },
      scenarioIds: [scenarioId],
      status: "running",
    }),
    { mode: 0o600 },
  );
  write("report.json", report);
  write("creation.json", identity);
  write("save-intent.json", intent);
  write("save-transition.json", accepted);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    directory,
    backend,
    original,
    savedDocument,
    report,
    write,
    request,
  };
}

function inventory(fixture: ReturnType<typeof savedPeer>) {
  return {
    original: {
      ...fixture.original,
      saved: false,
      modified: false,
      fileId: null,
    },
    saved: {
      creationId: fixture.savedDocument.creationId,
      name: fixture.savedDocument.name,
      saved: true,
      modified: false,
      fileId: fixture.savedDocument.file.fileId,
    },
  };
}

test("an exact same-document save transition is recognized as saved, never as an original close", (t) => {
  const fixture = savedPeer(t),
    proofs = discoverOwnedUnsavedFixtureProofs(fixture.root, fixture.backend),
    proof = proofs.get(fixture.original.creationId);
  assert.equal(proof?.state, "saved");
  assert.deepEqual(proof?.document, fixture.original);
  assert.ok(proof && "savedDocument" in proof);
  assert.deepEqual(proof.savedDocument, fixture.savedDocument);
  const user = {
      creationId: "user-document",
      name: "User document",
      saved: false,
      modified: false,
      fileId: null,
    },
    oldRow = {
      ...fixture.original,
      saved: false,
      modified: false,
      fileId: null,
    },
    savedRow = {
      creationId: fixture.savedDocument.creationId,
      name: fixture.savedDocument.name,
      saved: true,
      modified: false,
      fileId: fixture.savedDocument.file.fileId,
    };
  assert.doesNotThrow(() =>
    assertReceiptBoundDocumentInventory(
      [user, oldRow],
      [user, savedRow],
      proofs,
      "Only the exact receipt-bound saved successor replaces the original",
      true,
      new Set([fixture.original.creationId]),
    ),
  );
});

test("a save transition cannot reuse the original creation job", (t) => {
  const fixture = savedPeer(t),
    creation = fixture.report.requests[0],
    save = fixture.report.requests[2];
  assert.ok(creation?.result.brokerReceipt && save?.result.brokerReceipt);
  save.result = {
    ...save.result,
    brokerReceipt: {
      ...save.result.brokerReceipt,
      jobId: creation.result.brokerReceipt.jobId,
    },
  };
  fixture.write("report.json", fixture.report);
  const proofs = discoverOwnedUnsavedFixtureProofs(
    fixture.root,
    fixture.backend,
  );
  assert.notEqual(proofs.get(fixture.original.creationId)?.state, "saved");
});

test("a same-ID save still requires the exact saved successor identity", (t) => {
  const fixture = savedPeer(t, true),
    rows = inventory(fixture),
    proofs = discoverOwnedUnsavedFixtureProofs(fixture.root, fixture.backend);
  assert.equal(proofs.get(fixture.original.creationId)?.state, "saved");
  assert.doesNotThrow(() =>
    assertReceiptBoundDocumentInventory(
      [rows.original],
      [rows.saved],
      proofs,
      "same-ID saved successor",
      true,
      new Set([fixture.original.creationId]),
    ),
  );
});

for (const sameId of [false, true]) {
  test(`only an exact saved close explains successor disappearance (same ID: ${sameId})`, (t) => {
    const fixture = savedPeer(t, sameId),
      rows = inventory(fixture);
    let proofs = discoverOwnedUnsavedFixtureProofs(
      fixture.root,
      fixture.backend,
    );
    assert.throws(() =>
      assertReceiptBoundDocumentInventory(
        [rows.original],
        [],
        proofs,
        "missing saved successor",
        true,
        new Set([
          fixture.original.creationId,
          fixture.savedDocument.creationId,
        ]),
      ),
    );
    fixture.report.requests.push(
      fixture.request(4, "cleanup-close", {
        creationId: fixture.savedDocument.creationId,
        closed: true,
      }),
    );
    fixture.report.cleanup = "complete";
    fixture.report.status = "failed";
    fixture.write("report.json", fixture.report);
    proofs = discoverOwnedUnsavedFixtureProofs(fixture.root, fixture.backend);
    const proof = proofs.get(fixture.original.creationId);
    assert.equal(proof?.state, "saved");
    assert.ok(proof?.state === "saved");
    assert.equal(proof.savedState, "closed");
    assert.doesNotThrow(() =>
      assertReceiptBoundDocumentInventory(
        [rows.original],
        [],
        proofs,
        "exact saved successor close",
        true,
        new Set([
          fixture.original.creationId,
          fixture.savedDocument.creationId,
        ]),
      ),
    );
  });
}

test("an unsettled saved successor has only an explicit visible read-only admission", (t) => {
  const fixture = savedPeer(t),
    rows = inventory(fixture);
  fixture.report.cleanup = "deferred";
  fixture.write("report.json", fixture.report);
  const proofs = discoverOwnedUnsavedFixtureProofs(
      fixture.root,
      fixture.backend,
    ),
    proof = proofs.get(fixture.original.creationId);
  assert.ok(proof?.state === "saved");
  assert.equal(proof.savedState, "unsettled");
  assert.throws(() =>
    assertReceiptBoundDocumentInventory(
      [rows.original],
      [rows.saved],
      proofs,
      "strict saved transfer",
    ),
  );
  assert.doesNotThrow(() =>
    assertReceiptBoundDocumentInventory(
      [rows.saved],
      [rows.saved],
      proofs,
      "unchanged saved baseline",
    ),
  );
  assert.doesNotThrow(() =>
    assertReceiptBoundDocumentInventory(
      [rows.original],
      [rows.saved],
      proofs,
      "read-only saved transfer",
      true,
    ),
  );
  assert.throws(() =>
    assertReceiptBoundDocumentInventory(
      [rows.original],
      [rows.original, rows.saved],
      proofs,
      "two visible identities",
      true,
    ),
  );
});

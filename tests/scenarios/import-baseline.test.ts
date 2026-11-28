import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseDocumentSnapshot } from "../import-result-contracts";
import {
  assertActiveDocumentRestored,
  assertProtectedBaselineDocuments,
} from "../live-import-receipts";
import { parseImportBaseline, readImportBaseline } from "./import-baseline";
import { marker } from "./programs";
import type { OwnedUnsavedFixtureProof } from "./fixture-provenance";

function fixture() {
  const owner = {
    runId: "import-run",
    scenarioId: "native-import-0",
    clientId: "scenario:import-run:native-import-0",
  };
  const protectedRow = {
    creationId: "user-id",
    name: "User",
    saved: false,
    modified: false,
    fileId: null,
  };
  const peer = {
    creationId: "peer-id",
    name: "Owned peer",
    saved: false,
    modified: true,
    fileId: null,
  };
  const requestId = "scenario:import-run:coordinator:before";
  const snapshot = { documents: [protectedRow, peer], active: peer.creationId };
  const coordinator = {
    runId: owner.runId,
    scenarioIds: [owner.scenarioId],
    before: { documents: [protectedRow], active: peer.creationId },
  };
  const intent = { phase: "before", requestId };
  const operationResult = {
    requestId,
    jobId: "before-job",
    acceptance: "accepted",
    executionOutcome: "succeeded",
  };
  const result = {
    requestId,
    state: "succeeded",
    sdkSettled: true,
    stdout: marker + JSON.stringify(snapshot) + "\n",
    brokerReceipt: {
      requestId,
      jobId: "before-job",
      clientId: "scenario:import-run:coordinator",
      state: "succeeded",
      operationResult,
    },
  };
  const proofs = new Map<string, OwnedUnsavedFixtureProof>([
    [
      peer.creationId,
      {
        state: "open",
        document: { creationId: peer.creationId, name: peer.name },
      },
    ],
  ]);
  return {
    owner,
    protectedRow,
    peer,
    snapshot,
    coordinator,
    intent,
    result,
    proofs,
  };
}

test("import separates a receipt-bound active peer from the protected baseline without weakening snapshots", () => {
  const f = fixture();
  assert.throws(
    () =>
      parseDocumentSnapshot(
        {
          documents: f.coordinator.before.documents,
          activeCreationId: f.coordinator.before.active,
        },
        "Original import baseline",
      ),
    /does not identify an open document/u,
  );
  const baseline = parseImportBaseline(
    f.owner,
    f.coordinator,
    f.intent,
    f.result,
    f.proofs,
  );
  assert.deepEqual(baseline.original.documents, f.snapshot.documents);
  assert.equal(baseline.original.activeCreationId, f.peer.creationId);
  assert.deepEqual(baseline.protectedDocuments, [f.protectedRow]);
  const peerChanged = {
    ...baseline.original,
    documents: [f.protectedRow, { ...f.peer, modified: false }],
  };
  assertProtectedBaselineDocuments(
    { documents: baseline.protectedDocuments },
    peerChanged,
    "test",
  );
  assert.throws(
    () =>
      assertProtectedBaselineDocuments(
        { documents: baseline.protectedDocuments },
        {
          ...peerChanged,
          documents: [{ ...f.protectedRow, modified: true }, f.peer],
        },
        "test",
      ),
    /changed or disappeared/u,
  );
  assert.throws(
    () =>
      assertActiveDocumentRestored(
        baseline.original,
        { ...peerChanged, activeCreationId: f.protectedRow.creationId },
        "test",
      ),
    /previously active document was not restored/u,
  );
  assertActiveDocumentRestored(baseline.original, peerChanged, "test");
});

test("import accepts an exact open saved peer without adding it to protected documents", () => {
  const f = fixture();
  const file = {
    projectId: "project",
    folderId: "folder",
    fileId: "saved-file",
    version: 1,
  };
  const saved = { ...f.peer, saved: true, fileId: file.fileId };
  f.result.stdout =
    marker +
    JSON.stringify({ ...f.snapshot, documents: [f.protectedRow, saved] });
  f.proofs.set(f.peer.creationId, {
    state: "saved",
    savedState: "open",
    document: { creationId: f.peer.creationId, name: f.peer.name },
    savedDocument: { creationId: f.peer.creationId, name: f.peer.name, file },
  });
  const baseline = parseImportBaseline(
    f.owner,
    f.coordinator,
    f.intent,
    f.result,
    f.proofs,
  );
  assert.equal(baseline.original.documents[1]!.fileId, file.fileId);
  assert.deepEqual(baseline.protectedDocuments, [f.protectedRow]);
});

test("a peer's later close cannot invalidate its earlier authenticated presence or authorize restoration", () => {
  const f = fixture();
  f.proofs.set(f.peer.creationId, { state: "closed", document: f.peer });
  const baseline = parseImportBaseline(
    f.owner,
    f.coordinator,
    f.intent,
    f.result,
    f.proofs,
  );
  assert.equal(baseline.original.activeCreationId, f.peer.creationId);
  assert.throws(
    () =>
      assertActiveDocumentRestored(
        baseline.original,
        {
          documents: [f.protectedRow],
          activeCreationId: f.protectedRow.creationId,
        },
        "After historical peer closed",
      ),
    /previously active document was not restored/u,
  );
});

test("a later save retains the original unsaved identity without rewriting the historical snapshot", () => {
  const f = fixture();
  f.proofs.set(f.peer.creationId, {
    state: "saved",
    savedState: "closed",
    document: f.peer,
    savedDocument: {
      creationId: "successor",
      name: f.peer.name,
      file: {
        projectId: "project",
        folderId: "folder",
        fileId: "file",
        version: 1,
      },
    },
  });
  const baseline = parseImportBaseline(
    f.owner,
    f.coordinator,
    f.intent,
    f.result,
    f.proofs,
  );
  assert.deepEqual(baseline.original.documents, f.snapshot.documents);
});

const negatives: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  "foreign run": (f) => {
    f.coordinator.runId = "other";
  },
  "foreign owner client": (f) => {
    f.owner.clientId = "other";
  },
  "foreign scenario": (f) => {
    f.coordinator.scenarioIds = ["other"];
  },
  "foreign intent": (f) => {
    f.intent.requestId = "other";
  },
  "wrong phase": (f) => {
    f.intent.phase = "after";
  },
  "foreign result": (f) => {
    f.result.requestId = "other";
  },
  "UNKNOWN result": (f) => {
    f.result.state = "unknown";
  },
  "unsettled result": (f) => {
    f.result.sdkSettled = false;
  },
  "foreign receipt": (f) => {
    f.result.brokerReceipt.requestId = "other";
  },
  "foreign receipt client": (f) => {
    f.result.brokerReceipt.clientId = "other";
  },
  "failed receipt": (f) => {
    f.result.brokerReceipt.state = "failed";
  },
  "foreign operation": (f) => {
    f.result.brokerReceipt.operationResult.requestId = "other";
  },
  "foreign job": (f) => {
    f.result.brokerReceipt.operationResult.jobId = "other";
  },
  "unaccepted operation": (f) => {
    f.result.brokerReceipt.operationResult.acceptance = "rejected";
  },
  "unexecuted operation": (f) => {
    f.result.brokerReceipt.operationResult.executionOutcome = "not_started";
  },
  "duplicate marker": (f) => {
    f.result.stdout += f.result.stdout;
  },
  "changed active": (f) => {
    f.coordinator.before.active = f.protectedRow.creationId;
  },
  "duplicate protected row": (f) => {
    f.coordinator.before.documents.push(f.protectedRow);
  },
  "changed protected row": (f) => {
    f.coordinator.before.documents = [{ ...f.protectedRow, modified: true }];
  },
  "foreign protected row": (f) => {
    f.coordinator.before.documents = [
      { ...f.protectedRow, creationId: "other" },
    ];
  },
  "missing peer proof": (f) => {
    f.proofs.clear();
  },
  "unsettled active peer": (f) => {
    f.proofs.set(f.peer.creationId, { state: "unsettled", document: f.peer });
  },
  "retained active peer": (f) => {
    f.proofs.set(f.peer.creationId, {
      state: "retained",
      document: f.peer,
      terminalReceipt: { requestId: "rejected", jobId: "job" },
    });
  },
  "foreign peer identity": (f) => {
    f.proofs.set(f.peer.creationId, {
      state: "open",
      document: { ...f.peer, name: "Foreign" },
    });
  },
  "invalid full active reference": (f) => {
    f.result.stdout =
      marker + JSON.stringify({ ...f.snapshot, documents: [f.protectedRow] });
  },
};
for (const [name, mutate] of Object.entries(negatives))
  test("import baseline rejects " + name, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      parseImportBaseline(f.owner, f.coordinator, f.intent, f.result, f.proofs),
    );
  });

test("import baseline reads only the matching coordinator sidecars and refuses a symlink", (t) => {
  const f = fixture();
  const parent = path.join(process.cwd(), ".test-artifacts");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "import-baseline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, f.owner.runId),
    directory = path.join(run, f.owner.scenarioId);
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(run, "_coordinator"));
  f.coordinator.before.documents.push(f.peer);
  const coordinator = {
    ...f.coordinator,
    mode: "fusion",
    protocol: "addin",
    qualification: "broker",
    backendIdentity: "fusion:addin:matching-build",
  };
  fs.writeFileSync(path.join(run, "index.json"), JSON.stringify(coordinator));
  fs.writeFileSync(
    path.join(run, "_coordinator/before.intent.json"),
    JSON.stringify(f.intent),
  );
  const resultFile = path.join(run, "_coordinator/before.result.json");
  fs.writeFileSync(resultFile, JSON.stringify(f.result));
  const actual = readImportBaseline(
    directory,
    f.owner,
    coordinator.backendIdentity,
  );
  assert.deepEqual(actual.protectedDocuments, f.snapshot.documents);
  assert.throws(() =>
    readImportBaseline(directory, f.owner, "foreign-runtime"),
  );
  const renamed = resultFile + ".original";
  fs.renameSync(resultFile, renamed);
  fs.symlinkSync(renamed, resultFile);
  assert.throws(() =>
    readImportBaseline(directory, f.owner, coordinator.backendIdentity),
  );
});

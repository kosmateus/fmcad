import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import path from "node:path";
import {
  assertActiveDocumentRestored,
  assertProtectedBaselineDocuments,
  asRecord,
  assertWorkerMatchesCli,
  type LiveDocumentSnapshot,
  type JsonRecord,
  parsePublicQueueJob,
} from "./live-import-receipts.js";

type QueueDomainOptions = {
  now: () => number;
  newId: () => string;
  hash: (value: string) => string;
};
type QueueDomainPort = {
  submit(input: {
    requestId: string;
    clientId: string;
    kind: "rpc";
    payload: JsonRecord;
    timeoutMs: number;
  }): { id: string };
  next(): unknown;
  finish(id: string, result: JsonRecord): unknown;
  status(id: string): unknown;
};
type QueueDomainModule = {
  QueueDomain: new (options: QueueDomainOptions) => QueueDomainPort;
};
type PublicQueueJob = {
  id: string;
  requestId: string;
  clientId: string;
  state: string;
  code?: string;
  executionOutcome?: string;
  operationResult: JsonRecord;
};

const projectRoot = path.resolve(__dirname, "..", "..");
const runtimeRequire = createRequire(__filename);

test("public worker and CLI job DTOs use operationResult and top-level executionOutcome", () => {
  const queuePath = path.join(projectRoot, "src/dist/core/domain/queue.js");
  const cliSource = fs.readFileSync(
    path.join(projectRoot, "src/entrypoints/queue-cli.ts"),
    "utf8",
  );
  assert.match(
    cliSource,
    /"FMCAD_QUEUE_RESULT "\s*\+\s*JSON\.stringify\(value\.job\)/,
    "The CLI marker serializes the public queue-job DTO, not a receipt wrapper",
  );
  const queueModule = runtimeRequire(queuePath) as QueueDomainModule;
  const queue = new queueModule.QueueDomain({
    now: () => 1000,
    newId: () => "negative-job",
    hash: (value) => value,
  });
  const accepted = queue.submit({
    requestId: "negative-request",
    clientId: "live-data-import",
    kind: "rpc",
    payload: { operation: "param.import" },
    timeoutMs: 60_000,
  });
  queue.next();
  queue.finish(accepted.id, {
    state: "failed",
    code: "LOCAL_EXECUTION_FAILED",
    executionOutcome: "failed",
    userScriptSubmitted: true,
    mayHaveMutated: false,
  });

  const workerJob = queue.status(accepted.id);
  const cliMarker = `FMCAD_QUEUE_RESULT ${JSON.stringify(workerJob)}`;
  const markerPayload = cliMarker.slice("FMCAD_QUEUE_RESULT ".length);
  const cliJob: unknown = JSON.parse(markerPayload);
  const publicJob = parsePublicQueueJob(workerJob, "worker job");

  assert.equal(publicJob.state, "failed");
  assert.equal(publicJob.code, "LOCAL_EXECUTION_FAILED");
  assert.equal(publicJob.executionOutcome, "failed");
  assert.equal(publicJob.operationResult.executionOutcome, "failed");
  assert.equal(publicJob.operationResult.code, "LOCAL_EXECUTION_FAILED");
  assert.equal(
    Object.hasOwn(asRecord(workerJob, "worker job"), "outcome"),
    false,
    "A queue job is not the wrapped Fmcad ExecutionReceipt DTO",
  );
  assertWorkerMatchesCli(workerJob, cliJob, "expected failure");
  assert.throws(
    () =>
      assertWorkerMatchesCli(
        workerJob,
        {
          ...publicJob,
          operationResult: undefined,
          outcome: { executionOutcome: "failed" },
        },
        "missing operation result",
      ),
    /operationResult/,
  );
});

test("cleanup protects original document identities and flags, allows sibling fixtures, and restores active identity", () => {
  const baseline: LiveDocumentSnapshot = {
    documents: [
      {
        creationId: "saved-user-document",
        name: "User design",
        saved: true,
        modified: false,
        fileId: "cloud-file-id",
      },
      {
        creationId: "unsaved-user-document",
        name: "Untitled",
        saved: false,
        modified: true,
        fileId: null,
      },
    ],
    activeCreationId: "unsaved-user-document",
  };
  const afterCleanup: LiveDocumentSnapshot = {
    documents: [
      ...baseline.documents,
      {
        creationId: "parallel-test-document",
        name: "Parallel fixture",
        saved: false,
        modified: true,
        fileId: null,
      },
    ],
    activeCreationId: baseline.activeCreationId,
  };

  assertProtectedBaselineDocuments(
    baseline,
    afterCleanup,
    "Concurrent fixture cleanup",
  );
  assertActiveDocumentRestored(
    baseline,
    afterCleanup,
    "Concurrent fixture cleanup",
  );
  assert.throws(
    () =>
      assertProtectedBaselineDocuments(
        baseline,
        {
          ...afterCleanup,
          documents: afterCleanup.documents.map((document) =>
            document.creationId === "saved-user-document"
              ? { ...document, fileId: "unexpected-cloud-file" }
              : document,
          ),
        },
        "Changed baseline",
      ),
    /pre-existing document saved-user-document changed or disappeared/,
  );
  for (const changedFlags of [{ saved: false }, { modified: true }]) {
    assert.throws(
      () =>
        assertProtectedBaselineDocuments(
          baseline,
          {
            ...afterCleanup,
            documents: afterCleanup.documents.map((document) =>
              document.creationId === "saved-user-document"
                ? { ...document, ...changedFlags }
                : document,
            ),
          },
          "Changed document flags",
        ),
      /pre-existing document saved-user-document changed or disappeared/,
    );
  }
  assert.throws(
    () =>
      assertProtectedBaselineDocuments(
        baseline,
        {
          ...afterCleanup,
          documents: afterCleanup.documents.filter(
            (document) => document.creationId !== "unsaved-user-document",
          ),
        },
        "Missing baseline",
      ),
    /pre-existing document unsaved-user-document changed or disappeared/,
  );
  assert.throws(
    () =>
      assertActiveDocumentRestored(
        baseline,
        { ...afterCleanup, activeCreationId: "parallel-test-document" },
        "Changed active document",
      ),
    /previously active document was not restored/,
  );
});

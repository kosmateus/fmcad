import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  assertActiveDocumentRestored,
  assertProtectedBaselineDocuments,
  asRecord,
  asArray,
  assertWorkerMatchesCli,
  type LiveDocumentSnapshot,
  type JsonRecord,
  parsePublicQueueJob,
  parseWorkerResultReadback,
  prepareNativeInvocation,
  readNativeInvocation,
  observeNativeInvocation,
  recoverNativeInvocation,
  type NativeInvocationBinding,
} from "./live-import-receipts.js";

test("fixed native invocation intent survives lost replies and recovery only reads the original owner request", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-fixed-intent-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binding: NativeInvocationBinding = {
    requestId: "exact-request",
    clientId: "exact-client",
    document: { name: "Exact unsaved", creationId: "exact-creation" },
    runtimeRoot: directory,
    buildHash: "build",
    fixtureId: "fixed-import",
    manifestSha256: "a".repeat(64),
    scriptSha256: "b".repeat(64),
    command: [
      "installed-cli",
      "run",
      "fixed.py",
      "--request-id",
      "exact-request",
      "--doc",
      "Exact unsaved",
      "--doc-id",
      "exact-creation",
    ],
  };
  const filename = prepareNativeInvocation(directory, binding);
  assert.equal(readNativeInvocation(filename).state, "prepared");
  assert.deepEqual(readNativeInvocation(filename).binding, binding);
  assert.throws(() => prepareNativeInvocation(directory, binding), /EEXIST/);
  const retry = {
    ...binding,
    requestId: "retry-under-another-request",
    command: binding.command.map((word) =>
      word === binding.requestId ? "retry-under-another-request" : word,
    ),
  };
  assert.throws(
    () => prepareNativeInvocation(directory, retry),
    /EEXIST/,
    "New request IDs cannot replay the same one-shot fixed fixture",
  );
  assert.throws(
    () =>
      prepareNativeInvocation(directory, {
        ...binding,
        requestId: "foreign-request",
      }),
    /Foreign fixed invocation/,
  );
  const terminal = {
    id: "job",
    requestId: binding.requestId,
    clientId: binding.clientId,
    state: "succeeded",
    executionOutcome: "succeeded",
    operationResult: { executionOutcome: "succeeded" },
  };
  let lookups = 0;
  const lookup = async (original: NativeInvocationBinding) => {
    lookups++;
    assert.deepEqual(original, binding);
    return terminal;
  };
  await assert.rejects(
    recoverNativeInvocation(filename, lookup, () => true),
    /may still submit/,
  );
  await assert.rejects(
    recoverNativeInvocation(filename, lookup, () => null),
    /may still submit/,
  );
  assert.equal(lookups, 0, "Live or unverifiable drivers cannot race recovery");
  await assert.rejects(
    recoverNativeInvocation(
      filename,
      async () => ({ ...terminal, state: "unknown" }),
      () => false,
    ),
    /unsettled/,
  );
  await assert.rejects(
    recoverNativeInvocation(
      filename,
      async () => ({ ...terminal, clientId: "foreign" }),
      () => false,
    ),
  );
  assert.equal(
    readNativeInvocation(filename).state,
    "prepared",
    "Unknown/foreign receipts must not settle intent",
  );
  assert.throws(() =>
    observeNativeInvocation(
      filename,
      { jobId: "job", requestId: "foreign" },
      terminal,
    ),
  );
  assert.throws(() =>
    observeNativeInvocation(
      filename,
      { jobId: "foreign", requestId: binding.requestId },
      terminal,
    ),
  );
  observeNativeInvocation(
    filename,
    { jobId: "job", requestId: binding.requestId },
    terminal,
  );
  assert.equal(
    readNativeInvocation(filename).state,
    "terminal-observed",
    "CLI observation alone is not independent worker recovery",
  );
  await assert.rejects(
    recoverNativeInvocation(
      filename,
      async () => ({ ...terminal, id: "foreign-job" }),
      () => false,
    ),
  );
  assert.deepEqual(
    await recoverNativeInvocation(filename, lookup, () => false),
    terminal,
  );
  assert.equal(lookups, 1);
  assert.equal(readNativeInvocation(filename).state, "settled");
  assert.throws(
    () => prepareNativeInvocation(directory, retry),
    /EEXIST/,
    "Recovery does not grant another mutation on the same pristine-fixture claim",
  );
});

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

test("retained import receipt parsers reject malformed identifiers, operation outcomes and output descriptors", () => {
  const job = {
    id: "owned-job",
    requestId: "owned-request",
    clientId: "owned-client",
    state: "failed",
    code: "EXPECTED_PREFLIGHT_FAILURE",
    executionOutcome: "failed",
    operationResult: {
      code: "EXPECTED_PREFLIGHT_FAILURE",
      executionOutcome: "failed",
    },
  };
  const complete = {
    job,
    outputs: {
      stdout: {
        name: "stdout",
        artifact: { path: "owned-output", sha256: "a".repeat(64) },
      },
      stderr: {},
    },
    stdout: "real output bytes represented by this DTO fixture",
    stderr: "expected diagnostic",
  };
  assert.deepEqual(parseWorkerResultReadback(complete, "complete"), complete);
  assert.deepEqual(
    parsePublicQueueJob(
      {
        ...job,
        code: undefined,
        executionOutcome: undefined,
        operationResult: {},
      },
      "optional fields",
    ),
    {
      id: job.id,
      requestId: job.requestId,
      clientId: job.clientId,
      state: job.state,
      operationResult: {},
    },
  );
  for (const value of [null, [], "text", 1])
    assert.throws(() => asRecord(value, "object shape"), /must be an object/u);
  const array = [{ owned: true }];
  assert.equal(asArray(array, "array shape"), array);
  for (const value of [null, {}, "text", 1])
    assert.throws(() => asArray(value, "array shape"), /must be an array/u);
  for (const key of [
    "id",
    "requestId",
    "clientId",
    "state",
    "code",
    "executionOutcome",
  ])
    assert.throws(
      () => parsePublicQueueJob({ ...job, [key]: 1 }, "job field"),
      /must be a string/u,
    );
  for (const operationResult of [
    null,
    [],
    "text",
    { code: 1 },
    { executionOutcome: false },
  ])
    assert.throws(() =>
      parsePublicQueueJob({ ...job, operationResult }, "result shape"),
    );
  const malformed = [
    { ...complete, job: null },
    { ...complete, outputs: [] },
    { ...complete, outputs: { stdout: "unbound descriptor" } },
    { ...complete, outputs: { stdout: { artifact: null } } },
    { ...complete, outputs: { stdout: { name: 1 } } },
    { ...complete, stdout: {} },
    { ...complete, stderr: [] },
  ];
  for (const value of malformed)
    assert.throws(() =>
      parseWorkerResultReadback(value, "malformed worker result"),
    );
  assert.deepEqual(parseWorkerResultReadback({ job }, "no optional output"), {
    job,
  });
  assertWorkerMatchesCli(job, structuredClone(job), "same terminal projection");
  for (const key of [
    "id",
    "requestId",
    "clientId",
    "state",
    "code",
    "executionOutcome",
  ])
    assert.throws(() =>
      assertWorkerMatchesCli(
        job,
        { ...job, [key]: "foreign" },
        "foreign terminal projection",
      ),
    );
  assert.throws(() =>
    assertWorkerMatchesCli(
      job,
      { ...job, operationResult: { ...job.operationResult, extra: true } },
      "changed operation result",
    ),
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

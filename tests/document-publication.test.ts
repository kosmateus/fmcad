import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  NativeSaveResult,
  SaveResult,
} from "../packages/core/src/application/documents/save";
import type { Descriptor } from "./modeling-unit-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/document-publication.test.ts"),
);
const publication = load(
  "../src/document-publication",
) as typeof import("../src/composition/document-publication");
const { hash } = load("../src/batch") as { hash(value: unknown): string };
const { writeOperationRecord } = load(
  "../src/batch-atomic",
) as typeof import("../packages/node-adapters/src/persistence/operation-journal");
const { catalog, validateCad, buildCadScript } = load(
  "../src/cad",
) as {
  catalog: Record<string, Descriptor>;
  validateCad(operation: string, data: unknown): Descriptor;
  buildCadScript(operation: string, data: unknown, context: unknown): string;
  executeCad(
    client: unknown,
    operation: string,
    data: unknown,
    context: unknown,
  ): Promise<unknown>;
};
const { detail } = load("../src/help") as {
  detail(...words: string[]): string;
};
const { parseCadInput } = load("../src/cad-input") as {
  parseCadInput(
    words: string[],
    inputs: unknown,
  ): {
    docId: string;
    docFileId: string;
    projectId: string;
    data: Record<string, unknown>;
  };
};
const documentManual = load("../src/manual/document.json") as Record<
  string,
  { examples: { data: Record<string, unknown> }[] }
>;
type Execute = Parameters<typeof publication.execute>[4];
const target = {
  name: "SavedScratch",
  creationId: "creation-1",
  fileId: "file-1",
  projectId: "project-1",
  version: 3,
};
const context = {
  doc: target.name,
  docId: target.creationId,
  docFileId: target.fileId,
  projectId: target.projectId,
};

async function fixture(
  t: import("node:test").TestContext,
  {
    snapshots = [],
    saveResult = { status: "accepted", accepted: true },
    saveError,
  }: {
    snapshots?: (Record<string, unknown> | Error)[];
    saveResult?: NativeSaveResult;
    saveError?: Error;
  } = {},
) {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-document-save-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const calls: { operation: string; data: Record<string, unknown> }[] = [];
  let now = 0;
  let statusIndex = 0;
  const deps = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const execute: Execute = async (_client, operation, data, actualContext) => {
    assert.deepEqual(actualContext, context);
    calls.push({ operation, data });
    if (operation === "document.status") {
      const row = snapshots[Math.min(statusIndex++, snapshots.length - 1)];
      if (row instanceof Error) throw row;
      return { success: true, operation, document: target.name, result: row };
    }
    if (operation === "document.save_native") {
      if (saveError) throw saveError;
      return {
        success: true,
        operation,
        document: target.name,
        result: saveResult,
      };
    }
    assert.fail("unexpected internal operation " + operation);
  };
  const data = {
    requestId: "request-1",
    operationId: "operation-1",
    projectId: target.projectId,
    fileId: target.fileId,
    creationId: target.creationId,
    expectedVersion: target.version,
    reportPath,
    confirm: true,
    timeBudgetMs: 50,
  };
  return {
    reportPath,
    calls,
    execute,
    deps,
    data,
    setNow(value: number) {
      now = value;
    },
  };
}

const snapshot = (patch: Record<string, unknown> = {}) => ({
  name: target.name,
  creationId: target.creationId,
  saved: true,
  modified: true,
  fileId: target.fileId,
  fileName: target.name,
  version: target.version,
  versionId: "version-3",
  isComplete: true,
  isReadOnly: false,
  folderId: "folder-1",
  projectId: target.projectId,
  ...patch,
});

test("save_once performs one identity-pinned save and completes only after same-lineage cloud publication", async (t) => {
  const f = await fixture(t, {
    snapshots: [
      snapshot(),
      snapshot({ version: 4, versionId: "version-4", modified: false }),
    ],
  });
  const result = await publication.execute(
    null,
    "document.save.once",
    f.data,
    context,
    f.execute,
    f.deps,
  );
  assert.equal(result.status, "complete");
  assert.equal(result.accepted, true);
  assert.equal(result.resultingVersion, 4);
  assert.equal(result.cloudComplete, true);
  assert.deepEqual(
    f.calls.map((call) => call.operation),
    ["document.status", "document.save_native", "document.status"],
  );
  assert.equal(f.calls[1]!.data["fileId"], target.fileId);
  assert.equal(f.calls[1]!.data["version"], target.version);
  assert.equal(f.calls[1]!.data["projectId"], target.projectId);
  assert.equal(f.calls[1]!.data["creationId"], target.creationId);
  assert.equal(catalog["document.save_native"]!.internalOnly, true);
  assert.equal(catalog["document.save.once"]!.nodeOnly, true);
  assert.equal(catalog["document.save.observe"]!.nodeOnly, true);
});

test("clean document returns explicit no-op without native save or version increment", async (t) => {
  const f = await fixture(t, {
    snapshots: [
      snapshot({ modified: false, isComplete: false, isReadOnly: true }),
    ],
  });
  const result = await publication.execute(
    null,
    "document.save.once",
    f.data,
    context,
    f.execute,
    f.deps,
  );
  assert.equal(result.status, "noop");
  assert.equal(result.changed, false);
  assert.equal(result.resultingVersion, target.version);
  assert.equal(result.cloudComplete, false);
  assert.deepEqual(
    f.calls.map((call) => call.operation),
    ["document.status"],
  );
});

test("pending publication can be observed later using the original receipt without resubmitting", async (t) => {
  const f = await fixture(t, {
    snapshots: [
      snapshot(),
      snapshot({ modified: true }),
      snapshot({
        version: 4,
        versionId: "version-4",
        modified: false,
        isComplete: true,
      }),
    ],
  });
  f.deps.sleep = async () => {
    f.setNow(50);
  };
  const pending = await publication.execute(
    null,
    "document.save.once",
    f.data,
    context,
    f.execute,
    f.deps,
  );
  assert.equal(pending.status, "pending");
  assert.equal(
    f.calls.filter((call) => call.operation === "document.save_native").length,
    1,
  );
  const observeData = Object.fromEntries(
    Object.entries(f.data).filter(([key]) => key !== "confirm"),
  );
  const observed = await publication.execute(
    null,
    "document.save.observe",
    observeData,
    context,
    f.execute,
    { ...f.deps, now: () => 0 },
  );
  assert.equal(observed.status, "complete");
  assert.equal(observed.operation, "document.save.observe");
  assert.equal(
    f.calls.filter((call) => call.operation === "document.save_native").length,
    1,
  );
  assert.equal(
    f.calls.filter((call) => call.operation === "document.status").length,
    3,
  );
});

test("native acceptance remains distinct when the bounded budget expires before status observation", async (t) => {
  const f = await fixture(t, { snapshots: [snapshot()] });
  f.data.timeBudgetMs = 2;
  const ticks = [0, 2];
  f.deps.now = () => ticks.shift() ?? 2;
  const result = await publication.execute(
    null,
    "document.save.once",
    f.data,
    context,
    f.execute,
    f.deps,
  );
  assert.equal(result.status, "accepted");
  assert.equal(result.accepted, true);
  assert.equal(result.cloudComplete, null);
  assert.deepEqual(
    f.calls.map((call) => call.operation),
    ["document.status", "document.save_native"],
  );
  const repeated = await publication.execute(
    null,
    "document.save.once",
    f.data,
    context,
    f.execute,
    f.deps,
  );
  assert.equal(repeated.replayedReceipt, true);
  assert.equal(
    f.calls.filter((call) => call.operation === "document.save_native").length,
    1,
  );
});

test("ambiguous save RPC stays unknown, repeated submit replays receipt only, observer can reconcile original request", async (t) => {
  const f = await fixture(t, {
    snapshots: [snapshot(), snapshot({ version: 4, modified: false })],
    saveError: new Error("transport lost after submit"),
  });
  const uncertain = await publication.execute(
    null,
    "document.save.once",
    f.data,
    context,
    f.execute,
    f.deps,
  );
  assert.equal(uncertain.status, "unknown");
  assert.equal(
    f.calls.filter((call) => call.operation === "document.save_native").length,
    1,
  );
  const repeated = await publication.execute(
    null,
    "document.save.once",
    f.data,
    context,
    f.execute,
    f.deps,
  );
  assert.equal(repeated.replayedReceipt, true);
  assert.equal(
    f.calls.filter((call) => call.operation === "document.save_native").length,
    1,
  );
  const observeData = Object.fromEntries(
    Object.entries(f.data).filter(([key]) => key !== "confirm"),
  );
  const observed = await publication.execute(
    null,
    "document.save.observe",
    observeData,
    context,
    f.execute,
    f.deps,
  );
  assert.equal(observed.status, "complete");
  assert.equal(
    f.calls.filter((call) => call.operation === "document.save_native").length,
    1,
  );
});

test("version/identity drift, failed acceptance and post-save status getter errors never replay", async (t) => {
  const mismatch = await fixture(t, { snapshots: [snapshot({ version: 4 })] });
  const refused = await publication.execute(
    null,
    "document.save.once",
    mismatch.data,
    context,
    mismatch.execute,
    mismatch.deps,
  );
  assert.equal(refused.status, "blocked");
  assert.equal(
    mismatch.calls.some((call) => call.operation === "document.save_native"),
    false,
  );

  for (const change of [
    { name: "Other" },
    { creationId: "other-creation" },
    { fileId: "other-file" },
    { projectId: "other-project" },
    { isComplete: false },
    { isReadOnly: true },
  ]) {
    const f = await fixture(t, { snapshots: [snapshot(change)] });
    const result = await publication.execute(
      null,
      "document.save.once",
      f.data,
      context,
      f.execute,
      f.deps,
    );
    assert.equal(result.status, "blocked", JSON.stringify(change));
    assert.equal(
      f.calls.some((call) => call.operation === "document.save_native"),
      false,
      JSON.stringify(change),
    );
  }

  const failure = await fixture(t, {
    snapshots: [snapshot()],
    saveResult: {
      status: "failed",
      accepted: false,
      reason: "saveNotAccepted",
    },
  });
  const failed = await publication.execute(
    null,
    "document.save.once",
    failure.data,
    context,
    failure.execute,
    failure.deps,
  );
  assert.equal(failed.status, "failed");
  assert.equal(
    failure.calls.filter((call) => call.operation === "document.status").length,
    1,
    "a known failed acceptance performs only preflight status, no completion polling",
  );
  assert.equal(
    failure.calls.filter((call) => call.operation === "document.save_native")
      .length,
    1,
  );

  const getter = await fixture(t, {
    snapshots: [
      snapshot(),
      new Error("post-save DataFile getter failed"),
      snapshot({ version: 4, modified: false }),
    ],
  });
  const unknown = await publication.execute(
    null,
    "document.save.once",
    getter.data,
    context,
    getter.execute,
    getter.deps,
  );
  assert.equal(unknown.status, "unknown");
  const getterObserveData = Object.fromEntries(
    Object.entries(getter.data).filter(([key]) => key !== "confirm"),
  );
  const reconciled = await publication.execute(
    null,
    "document.save.observe",
    getterObserveData,
    context,
    getter.execute,
    getter.deps,
  );
  assert.equal(reconciled.status, "complete");
  assert.equal(
    getter.calls.filter((call) => call.operation === "document.save_native")
      .length,
    1,
  );
});

test("save_once schema rejects missing pins and non-true authorization; detailed help covers both methods", () => {
  assert.throws(
    () =>
      validateCad("document.save.once", {
        requestId: "r",
        operationId: "o",
        confirm: true,
      }),
    /Missing CAD inputs/,
  );
  assert.throws(
    () =>
      publication.validate("document.save.once", {
        requestId: "r",
        operationId: "o",
        projectId: "p",
        fileId: "f",
        creationId: "c",
        expectedVersion: 1,
        reportPath: "/tmp/x",
        confirm: "true",
      }),
    /confirm/,
  );
  assert.match(detail("document", "save", "once"), /at most once/);
  const onceHelp = detail("document", "save", "once");
  const observeHelp = detail("document", "save", "observe");
  assert.match(onceHelp, /status:accepted/);
  assert.match(onceHelp, /status:complete/);
  assert.match(observeHelp, /Never calls Document\.save/i);
  assert.match(observeHelp, /missing receipt.*unknown/i);
  const inputData = {
    requestId: "request-1",
    operationId: "operation-1",
    projectId: target.projectId,
    fileId: target.fileId,
    creationId: target.creationId,
    expectedVersion: target.version,
    reportPath: "/tmp/save-receipts",
    confirm: true,
  };
  const parsed = parseCadInput(
    [
      "--doc",
      target.name,
      "--doc-id",
      target.creationId,
      "--doc-file-id",
      target.fileId,
      "--project-id",
      target.projectId,
      "--data",
      JSON.stringify(inputData),
    ],
    catalog["document.save.once"]!.inputs,
  );
  assert.equal(parsed.docId, target.creationId);
  assert.equal(parsed.docFileId, target.fileId);
  assert.equal(parsed.projectId, target.projectId);
  assert.equal(
    validateCad("document.save.once", parsed.data),
    catalog["document.save.once"],
  );
  const internalData = {
    requestId: "request-1",
    operationId: "operation-1",
    projectId: target.projectId,
    fileId: target.fileId,
    creationId: target.creationId,
    version: target.version,
    description: "save once",
  };
  assert.match(
    buildCadScript("document.save_native", internalData, context),
    /if False:\n        ctx\.activate_target\(\)/,
    "the native save primitive must not activate or switch documents",
  );
});

test("observe refuses a corrupt receipt and reports an interrupted submit lock as unknown without saving", async (t) => {
  const missing = await fixture(t);
  const missingData = Object.fromEntries(
    Object.entries(missing.data).filter(([key]) => key !== "confirm"),
  );
  const missingReceipt = await publication.execute(
    null,
    "document.save.observe",
    missingData,
    context,
    missing.execute,
    missing.deps,
  );
  assert.equal(
    missingReceipt.status,
    "unknown",
    "absence cannot prove the original request never submitted",
  );
  assert.deepEqual(missing.calls, []);

  const corrupt = await fixture(t);
  const directory = path.join(
    corrupt.reportPath,
    "document-save",
    hash(["request-1", "operation-1"]),
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "00000000.json"),
    JSON.stringify({
      sequence: 0,
      binding: { operation: "different-request" },
      operation: "document.save.once",
      result: { status: "pending" },
    }),
  );
  const observeData = Object.fromEntries(
    Object.entries(corrupt.data).filter(([key]) => key !== "confirm"),
  );
  const badReceipt = await publication.execute(
    null,
    "document.save.observe",
    observeData,
    context,
    corrupt.execute,
    corrupt.deps,
  );
  assert.equal(badReceipt.status, "blocked");
  assert.deepEqual(corrupt.calls, []);

  const interrupted = await fixture(t);
  const interruptedDirectory = path.join(
    interrupted.reportPath,
    "document-save",
    hash(["request-1", "operation-1"]),
  );
  await fs.mkdir(interruptedDirectory, { recursive: true });
  await fs.writeFile(path.join(interruptedDirectory, "submit.lock"), "");
  const interruptedData = Object.fromEntries(
    Object.entries(interrupted.data).filter(([key]) => key !== "confirm"),
  );
  const unknown = await publication.execute(
    null,
    "document.save.observe",
    interruptedData,
    context,
    interrupted.execute,
    interrupted.deps,
  );
  assert.equal(unknown.status, "unknown");
  assert.deepEqual(interrupted.calls, []);
});

test("public manual save examples execute through save.once/save.observe coordinators", async (t) => {
  const saveExamples = documentManual["document.save.once"]!.examples;
  const observeExample =
    documentManual["document.save.observe"]!.examples[0]!.data;
  const bindManual = (
    example: Record<string, unknown>,
    reportPath: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    ...example,
    projectId: target.projectId,
    fileId: target.fileId,
    creationId: target.creationId,
    reportPath,
    ...overrides,
  });

  const changed = await fixture(t, {
    snapshots: [snapshot(), snapshot({ version: 4, modified: false })],
  });
  const changedResult = await publication.execute(
    null,
    "document.save.once",
    bindManual(saveExamples[0]!.data, changed.reportPath),
    context,
    changed.execute,
    changed.deps,
  );
  assert.equal(changedResult.status, "complete");

  const clean = await fixture(t, {
    snapshots: [snapshot({ modified: false })],
  });
  const cleanResult = await publication.execute(
    null,
    "document.save.once",
    bindManual(saveExamples[1]!.data, clean.reportPath),
    context,
    clean.execute,
    clean.deps,
  );
  assert.equal(cleanResult.status, "noop");
  assert.equal(
    clean.calls.some((call) => call.operation === "document.save_native"),
    false,
  );

  const stale = await fixture(t, { snapshots: [snapshot()] });
  const staleResult = await publication.execute(
    null,
    "document.save.once",
    bindManual(saveExamples[2]!.data, stale.reportPath),
    context,
    stale.execute,
    stale.deps,
  );
  assert.equal(staleResult.status, "blocked");
  assert.equal(
    stale.calls.some((call) => call.operation === "document.save_native"),
    false,
  );

  const pending = await fixture(t, {
    snapshots: [
      snapshot(),
      snapshot({ modified: true }),
      snapshot({ version: 4, modified: false }),
    ],
  });
  pending.deps.sleep = async () => {
    pending.setNow(50);
  };
  const originalData = bindManual(saveExamples[0]!.data, pending.reportPath, {
    timeBudgetMs: 50,
  });
  const submission = await publication.execute(
    null,
    "document.save.once",
    originalData,
    context,
    pending.execute,
    pending.deps,
  );
  assert.equal(submission.status, "pending");
  pending.setNow(0);
  const observationData = bindManual(observeExample, pending.reportPath, {
    timeBudgetMs: 10000,
  });
  const observation = await publication.execute(
    null,
    "document.save.observe",
    observationData,
    context,
    pending.execute,
    pending.deps,
  );
  assert.equal(observation.status, "complete");
  assert.equal(
    pending.calls.filter((call) => call.operation === "document.save_native")
      .length,
    1,
  );
});

test("observer follows an after-save display-name change using the original file-bound receipt", async (t) => {
  const reportPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-document-save-rename-"),
  );
  t.after(() => fs.rm(reportPath, { recursive: true, force: true }));
  const requestId = "rename-request",
    operationId = "rename-operation";
  const oldTarget = {
    name: target.name,
    creationId: target.creationId,
    fileId: target.fileId,
    projectId: target.projectId,
    version: target.version,
  };
  const legacyBinding = {
    operation: "document.save.once",
    requestId,
    operationId,
    requestHash: hash({ requestId, operationId, target: oldTarget }),
    target: oldTarget,
  };
  const directory = path.join(
    reportPath,
    "document-save",
    hash([requestId, operationId]),
  );
  await writeOperationRecord(directory, legacyBinding, 0, {
    operation: "document.save.once",
    state: "submit_uncertain",
    result: { status: "submit_uncertain", accepted: null, changed: true },
  });
  await writeOperationRecord(directory, legacyBinding, 1, {
    operation: "document.save.once",
    state: "accepted",
    result: { status: "accepted", accepted: true, changed: true },
  });
  const currentContext = { ...context, doc: "SavedScratch v2" };
  const calls: string[] = [];
  const execute: Execute = async (_client, operation, _data, actualContext) => {
    assert.deepEqual(actualContext, currentContext);
    calls.push(operation);
    assert.equal(operation, "document.status");
    return {
      success: true,
      operation,
      document: currentContext.doc,
      result: snapshot({
        name: currentContext.doc,
        version: 4,
        versionId: "version-4",
        modified: false,
      }),
    };
  };
  const data = {
    requestId,
    operationId,
    projectId: target.projectId,
    fileId: target.fileId,
    creationId: target.creationId,
    expectedVersion: target.version,
    reportPath,
    timeBudgetMs: 10000,
  };
  const result = await publication.execute(
    null,
    "document.save.observe",
    data,
    currentContext,
    execute,
    { now: () => 0 },
  );
  assert.equal(result.status, "complete");
  assert.equal(result.accepted, true);
  assert.equal(
    result.requestHash,
    legacyBinding.requestHash,
    "the observer returns the immutable hash from the original request receipt",
  );
  assert.equal(
    (result.target as SaveResult["target"] & { name: string }).name,
    target.name,
  );
  assert.equal(result.resultingVersion, 4);
  assert.deepEqual(calls, ["document.status"]);
  const records = await load("../src/batch-atomic").readOperationJournal(
    directory,
    legacyBinding,
  );
  assert.equal(records.at(-1).result.status, "complete");
  assert.equal(
    records.at(-1).binding.target.name,
    target.name,
    "legacy original receipt identity remains immutable despite the current display name",
  );
});

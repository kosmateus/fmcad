import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { AtomicClient } from "../src/composition/batch-atomic.js";
import type { BatchCatalog, CadData } from "@fmcad/core";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
type Api = typeof import("../src/composition/batch-atomic.js");
const current = load("./src/batch-atomic.js") as Api;
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
const original = historical(
  "a26222ff617b0e9597b2a91b50474bdca8d0a0ce",
  "src/batch-atomic.js",
) as Pick<Api, "runAtomicBatch">;
const beforeExtraction = historical(
  "e92a0ee0133c8dccd93fe9157044668cbfcbd33c",
  "src/batch-atomic.js",
) as Api;
const { validateBatch } = load("./src/batch.js") as {
  validateBatch: typeof import("../packages/core/src/application/cad/batch-plan.js").validateBatch;
};
const { catalog } = load("./src/cad.js") as { catalog: BatchCatalog };
const literal = load("./tests/fixtures/python-literal.cjs") as (
  source: string,
) => unknown;
function requestData(source: string): unknown {
  // The baseline used a JSON string wrapper. Decode only its data, never Python.
  const prefix = "__import__('json').loads(";
  if (!source.startsWith(prefix)) return literal(source);
  assert.ok(source.endsWith(")"));
  const encoded: unknown = JSON.parse(source.slice(prefix.length, -1));
  assert.equal(typeof encoded, "string");
  assert.ok(typeof encoded === "string");
  return JSON.parse(encoded) as unknown;
}
const phases = [
  "atomic_resolve",
  "atomic_start",
  "atomic_status",
  "atomic_finalize",
] as const;
type Phase = (typeof phases)[number];
const context = {
  doc: "Owned model",
  docId: "creation-A",
  docFileId: "file-A",
};
const responses: Record<Phase, CadData> = {
  atomic_resolve: {
    status: "resolved",
    resolvedIdentity: {
      name: context.doc,
      creationId: context.docId,
      fileId: context.docFileId,
    },
    candidates: [],
    unavailableEvidence: [],
  },
  atomic_start: {
    status: "submitted",
    accepted: true,
    completed: false,
    destroyed: false,
  },
  atomic_status: { status: "completed", completed: true, destroyed: true },
  atomic_finalize: {
    status: "completed",
    completed: true,
    destroyed: true,
    terminationReason: 1,
    outcome: "committed",
    results: { only: { success: true, result: { count: 1 } } },
    created: [],
    rollbackVerified: false,
    rollback: { measured: false, matched: null, dimensions: [] },
    cleanupCompleted: true,
    definitionDeleted: true,
    errorStep: null,
  },
};

async function execute(
  t: TestContext,
  api: Pick<Api, "runAtomicBatch">,
  fault?: { phase: Phase; text: string },
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-adapter-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls: Phase[] = [];
  const client: AtomicClient = {
    capabilities: { backend: "addin", atomicBatch: true },
    server: { timeoutMs: 180000 },
    async callTool(request) {
      const line = request.object.script
        .split("\n")
        .find((item) => item.startsWith("_ATOMIC_REQUEST = "));
      assert.ok(line);
      const args = requestData(line.slice("_ATOMIC_REQUEST = ".length));
      assert.ok(args && typeof args === "object" && "operation" in args);
      const phase = phases.find((item) => item === args.operation);
      assert.ok(phase);
      calls.push(phase);
      assert.equal(
        request.object.readOnly === true,
        phase === "atomic_resolve" || phase === "atomic_status",
      );
      if (fault?.phase === phase) return { text: fault.text };
      return {
        text: "FMCAD_RESULT " + JSON.stringify(responses[phase]),
        failed: false,
      };
    },
  };
  const data = {
    runId: "atomic-A",
    reportPath: directory,
    operations: [
      { id: "only", operation: "entity.list", data: { kind: "body" } },
    ],
  };
  const validation = validateBatch(data, catalog, () => false);
  assert.equal(validation.success, true);
  const result = await api.runAtomicBatch(
    client,
    data,
    context,
    () => assert.fail("no alternate route"),
    catalog,
    validation,
  );
  assert.equal(client.server?.timeoutMs, 180000);
  const files = (await fs.readdir(directory))
    .filter((name) => /^\d{8}\.json$/.test(name))
    .sort();
  assert.ok(files.length);
  const last = files.at(-1);
  assert.ok(last);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(directory, last), "utf8")),
    result,
  );
  return { result, calls };
}

test("atomic preparation retains the complete artifact and request", () => {
  for (const operation of phases) {
    const args = {
      operation,
      runId: "atomic-A",
      doc: context.doc,
      docId: context.docId,
      docFileId: context.docFileId,
      steps: [{ id: "only", operation: "entity.list", data: { kind: "body" } }],
    };
    assert.deepEqual(
      current.prepareAtomicScript(args),
      beforeExtraction.prepareAtomicScript(args),
    );
    assert.equal(
      current.buildAtomicScript(args),
      beforeExtraction.buildAtomicScript(args),
    );
  }
});

test("ordinary atomic completion retains the historical physical call sequence", async (t) => {
  for (const api of [original, beforeExtraction, current]) {
    const { result, calls } = await execute(t, api);
    assert.deepEqual(calls, phases);
    assert.equal(result["outcome"], "committed");
    assert.equal(result["status"], "success");
    assert.equal(result["success"], true);
  }
});

for (const phase of phases) {
  test(`ambiguous ${phase} results reproduce the inherited defect and stop further SDK calls`, async (t) => {
    const text =
      "FMCAD_RESULT " +
      JSON.stringify(responses[phase]) +
      '\nFMCAD_RESULT {"status":"failed","outcome":"aborted"}';
    const before = await execute(t, original, { phase, text });
    assert.equal(before.result["outcome"], "committed");
    assert.deepEqual(before.calls, phases);
    const after = await execute(t, current, { phase, text });
    assert.deepEqual(after.calls, phases.slice(0, phases.indexOf(phase) + 1));
    assert.equal(
      after.calls.filter((item) => item === "atomic_start").length,
      phase === "atomic_resolve" ? 0 : 1,
    );
    assert.equal(after.result["success"], false);
    assert.equal(
      after.result["outcome"],
      phase === "atomic_resolve" ? "rejected" : "unknown",
    );
    assert.equal(
      after.result["status"],
      phase === "atomic_resolve" ? "failed" : "unknown",
    );
  });
}

for (const text of [
  "progress without a result",
  "FMCAD_RESULT {",
  "FMCAD_RESULT null",
  "FMCAD_RESULT []",
  "FMCAD_RESULT true",
]) {
  test(`unusable submit evidence remains unknown without replay: ${text}`, async (t) => {
    const { result, calls } = await execute(t, current, {
      phase: "atomic_start",
      text,
    });
    assert.deepEqual(calls, ["atomic_resolve", "atomic_start"]);
    assert.equal(result["outcome"], "unknown");
    assert.equal(result["success"], false);
  });
}

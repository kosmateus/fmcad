import type { BatchClient } from "../src/composition/batch.js";
import type { AtomicClient } from "../src/composition/batch-atomic.js";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type { CadData } from "@fmcad/core";
import {
  object,
  array,
  field,
  string,
  present,
} from "./modeling-unit-test-support.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDirectory = path.join(process.cwd(), "tests");
const load = createRequire(path.join(fixtureDirectory, "batch-atomic.test.ts"));
const {
  validateBatch,
  runBatchEntry,
  runBatch,
  hash,
  resolveReferences,
  readBatchSummary,
} = load("../src/batch") as typeof import("../src/composition/batch.js");
const {
  runAtomicBatch,
  buildAtomicScript,
  isTransactional,
  injectTestFault,
  readAtomicReceipt,
  reconcileAtomicBatch,
  finalizeAtomicBatch,
  setObserveReadOnlyCatalog,
} = load(
  "../src/batch-atomic",
) as typeof import("../src/composition/batch-atomic.js");
const { catalog } = load(
  "../src/cad",
) as typeof import("../src/composition/cad-execution.js");
const { findCommand } = load(
  "../src/commands",
) as typeof import("../src/composition/library-commands.js");
const { parseCadInput } = load(
  "../src/cad-input",
) as typeof import("../src/composition/library-cad-input.js");

const context = {
  doc: "Model",
  component: null,
  projectId: null,
  preview: false,
};
const operations = [
  {
    id: "first",
    operation: "entity.list",
    data: { kind: "body" },
    onExisting: "reuse",
  },
  {
    id: "second",
    operation: "entity.inspect",
    data: { ref: { $ref: "first.result.entity" } },
    onExisting: "reuse",
  },
];

async function directory(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fmcad-atomic-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function withPerformanceTicks<T>(
  ticks: readonly number[],
  action: () => Promise<T>,
): Promise<T> {
  const originalNow = performance.now;
  let index = 0;
  performance.now = () => present(ticks[Math.min(index++, ticks.length - 1)]);
  try {
    return await action();
  } finally {
    performance.now = originalNow;
  }
}

function extractAtomicRequest(script: string) {
  const marker = "_ATOMIC_REQUEST = ";
  const start = script.indexOf(marker);
  assert.ok(start >= 0, "missing _ATOMIC_REQUEST");
  const lineEnd = script.indexOf("\n", start + marker.length);
  const line = script.slice(start + marker.length, lineEnd);
  return object(
    (load("./fixtures/python-literal.cjs") as (line: string) => unknown)(line),
  );
}

// A fake addin client that answers the atomic lifecycle with scripted state.
interface AtomicCall {
  operation: unknown;
  readOnly: boolean;
  args: CadData;
}
function addinClient(respond: (args: CadData, calls: AtomicCall[]) => unknown) {
  const calls: AtomicCall[] = [];
  const client: BatchClient = {
    capabilities: { backend: "addin", atomicBatch: true },
    server: { url: "http://127.0.0.1:8765/mcp" },
    async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
      assert.equal(request.featureType, "script");
      const args = extractAtomicRequest(request.object.script);
      calls.push({
        operation: field(args, "operation"),
        readOnly: request.object.readOnly === true,
        args,
      });
      if (field(args, "operation") === "atomic_resolve") {
        const expected = object(field(args, "documentIdentity", "expected"));
        return {
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              status: "resolved",
              resolvedIdentity: {
                name: expected["name"],
                creationId: expected["creationId"] ?? "creation",
                fileId: expected["fileId"] ?? null,
              },
              candidates: [
                {
                  name: expected["name"],
                  creationId: expected["creationId"] ?? "creation",
                  fileId: expected["fileId"] ?? null,
                },
              ],
              unavailableEvidence: [],
            }),
          failed: false,
        };
      }
      return {
        text: "FMCAD_RESULT " + JSON.stringify(respond(args, calls)),
        failed: false,
      };
    },
  };
  return { client, calls };
}

const committed = (results: Record<string, unknown>) => ({
  status: "completed",
  completed: true,
  destroyed: true,
  terminationReason: 1,
  outcome: "committed",
  results,
  created: [],
  rollbackVerified: false,
  rollback: { measured: false, matched: null, dimensions: [] },
  cleanupCompleted: true,
  definitionDeleted: true,
  errorStep: null,
});

test("atomic field defaults to true, honors explicit false, and rejects non-booleans", () => {
  const base = {
    runId: "a",
    operations: [{ id: "s", operation: "entity.list", data: {} }],
  };
  assert.equal(validateBatch(base, catalog).atomic.effective, true);
  assert.equal(
    validateBatch({ ...base, atomic: true }, catalog).atomic.effective,
    true,
  );
  assert.equal(
    validateBatch({ ...base, atomic: false }, catalog).atomic.effective,
    false,
  );
  for (const bad of ["false", "true", 0, 1, [], {}, null]) {
    const result = validateBatch({ ...base, atomic: bad }, catalog);
    assert.equal(field(result, "success"), false, JSON.stringify(bad));
    assert.match(
      array(field(result, "errors")).join(" "),
      /atomic must be a boolean/,
    );
  }
});

test("validate and preview report effective mode and atomic capability without a backend", async () => {
  for (const mode of ["validate", "preview"]) {
    const result = await runBatchEntry(
      null,
      { runId: "a", mode, operations },
      context,
      () => assert.fail(),
      catalog,
    );
    assert.equal(field(result, "success"), true);
    assert.equal(field(result, "mutated"), false);
    assert.equal(field(result, "atomic", "effective"), true);
    assert.equal(field(result, "atomicCapability", "addin"), true);
    assert.equal(field(result, "atomicCapability", "mcp"), false);
  }
});

test("mcp backend is rejected before any mutation with a specific reason", async (t) => {
  const dir = await directory(t);
  const client: BatchClient = {
    capabilities: { backend: "mcp" },
    callTool: async () => assert.fail("no mutation"),
  };
  const result = await runBatchEntry(
    client,
    { runId: "a", reportPath: dir, operations },
    context,
    () => assert.fail(),
    catalog,
  );
  assert.equal(field(result, "outcome"), "rejected");
  assert.equal(field(result, "status"), "failed");
  assert.match(
    array(field(result, "errors")).join(" "),
    /unsupported on the mcp backend/,
  );
  await assert.rejects(fs.access(path.join(dir, "run.lock")), {
    code: "ENOENT",
  });
});

test("external-effect and local steps are rejected inside an atomic batch", async (t) => {
  assert.equal(isTransactional("export.step", catalog), false);
  assert.equal(isTransactional("document.save_as", catalog), false);
  assert.equal(isTransactional("checkpoint.open", catalog), false);
  assert.equal(isTransactional("import.file", catalog), false);
  assert.equal(isTransactional("entity.list", catalog), true);
  for (const [operation, reason] of [
    ["export.step", /external-effect/],
    ["mass.system", /local\/node-only/],
  ] as const) {
    const dir = await directory(t);
    const { client } = addinClient(() => assert.fail("no execution"));
    const data = {
      runId: "a",
      reportPath: dir,
      operations: [{ id: "bad", operation, data: {} }],
    };
    const result = await runAtomicBatch(
      client,
      data,
      context,
      () => assert.fail(),
      catalog,
      validateBatch(data, catalog),
    );
    assert.equal(field(result, "outcome"), "rejected", operation);
    assert.match(array(field(result, "errors")).join(" "), reason, operation);
    await assert.rejects(fs.access(path.join(dir, "run.lock")), {
      code: "ENOENT",
    });
  }
});

test("batchAllowed:false external-effect ops surface outcome:rejected in the atomic run path", async (t) => {
  for (const [operation, data] of [
    [
      "document.save_as",
      { name: "Never", project: "x", folder: "", confirm: true },
    ],
    ["document.clear", { fileId: "f", confirm: true }],
  ] as const) {
    const dir = await directory(t);
    const client: BatchClient = {
      capabilities: { backend: "addin", atomicBatch: true },
      callTool: async () => assert.fail("no mutation"),
    };
    const batch = {
      runId: "a",
      reportPath: dir,
      operations: [{ id: "ext", operation, data }],
    };
    const result = await runBatchEntry(
      client,
      batch,
      context,
      () => assert.fail(),
      catalog,
    );
    assert.equal(field(result, "outcome"), "rejected", operation);
    assert.equal(field(result, "status"), "failed", operation);
    assert.equal(field(result, "mutated"), false, operation);
    assert.ok(
      array(field(result, "errors")).some((e) =>
        /invoked separately/.test(string(e)),
      ),
      operation,
    );
    await assert.rejects(fs.access(path.join(dir, "run.lock")), {
      code: "ENOENT",
    });
  }
});

test("batchAllowed:false ops keep the legacy validation shape (no outcome) for atomic:false", async () => {
  const batch = {
    runId: "a",
    atomic: false,
    operations: [
      {
        id: "ext",
        operation: "document.save_as",
        data: { name: "Never", project: "x", folder: "", confirm: true },
      },
    ],
  };
  const result = await runBatchEntry(
    null,
    batch,
    context,
    () => assert.fail(),
    catalog,
  );
  assert.equal(field(result, "success"), false);
  assert.equal(field(result, "outcome"), undefined);
  assert.ok(
    array(field(result, "errors")).some((e) =>
      /invoked separately/.test(string(e)),
    ),
  );
});

test("committed atomic batch sends one payload, preserves $ref, and reports committed", async (t) => {
  const dir = await directory(t);
  let startArgs: CadData | undefined;
  const results = {
    first: {
      success: true,
      operation: "entity.list",
      document: "Model",
      result: { entity: { token: "T1" } },
      created: [],
    },
    second: {
      success: true,
      operation: "entity.inspect",
      document: "Model",
      result: {},
      created: [],
    },
  };
  const { client } = addinClient((args) => {
    if (field(args, "operation") === "atomic_start") {
      startArgs = args;
      return {
        status: "submitted",
        accepted: true,
        completed: false,
        destroyed: false,
      };
    }
    if (field(args, "operation") === "atomic_status")
      return { status: "completed", completed: true, destroyed: true };
    if (field(args, "operation") === "atomic_finalize")
      return committed(results);
    assert.fail("unexpected operation " + field(args, "operation"));
  });
  const data = { runId: "atomic", reportPath: dir, operations };
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => assert.fail(),
    catalog,
    validateBatch(data, catalog),
  );
  // One execution payload preserves the $ref to an earlier step, unresolved.
  assert.equal(field(startArgs, "steps", "length"), 2);
  assert.deepEqual(field(startArgs, "steps", 1, "data", "ref"), {
    $ref: "first.result.entity",
  });
  assert.equal(field(startArgs, "doc"), "Model");
  assert.equal(field(report, "atomic", "effective"), true);
  assert.equal(field(report, "outcome"), "committed");
  assert.equal(field(report, "version"), 2);
  assert.equal(field(report, "success"), true);
  assert.equal(field(report, "status"), "success");
  assert.equal(field(report, "terminationReason"), 1);
  assert.equal(field(report, "rollbackVerified"), false);
  assert.equal(field(report, "rollback", "measured"), false);
  assert.equal(field(report, "request", "atomic"), true);
  assert.deepEqual(
    array(field(report, "steps")).map((s) => field(s, "status")),
    ["success", "success"],
  );
  // The report is only finalized after destroy/finalization.
  const journal = (await fs.readdir(dir))
    .filter((name) => /^\d{8}\.json$/.test(name))
    .sort();
  assert.deepEqual(journal, [
    "00000000.json",
    "00000001.json",
    "00000002.json",
  ]);
  const first = JSON.parse(
    await fs.readFile(path.join(dir, present(journal[0])), "utf8"),
  );
  assert.equal(
    field(first, "journal", "event"),
    "identity_resolution_uncertain",
  );
  assert.equal(field(first, "commandId"), field(startArgs, "commandId"));
  assert.equal(field(first, "requestHash"), field(report, "requestHash"));
  assert.equal(field(first, "sessionNonce"), field(startArgs, "sessionNonce"));
  const beforeSubmit = JSON.parse(
    await fs.readFile(path.join(dir, present(journal[1])), "utf8"),
  );
  assert.equal(field(beforeSubmit, "journal", "event"), "submit_uncertain");
  assert.deepEqual(field(beforeSubmit, "documentIdentity", "resolved"), {
    name: "Model",
    creationId: "creation",
    fileId: null,
  });
  const saved = JSON.parse(
    await fs.readFile(path.join(dir, present(journal.at(-1))), "utf8"),
  );
  assert.deepEqual(saved, report);
  assert.equal((await readBatchSummary({ reportPath: dir })).status, "success");
});

test("aborted atomic batch reports aborted, errorStep and never durably applied steps", async (t) => {
  const dir = await directory(t);
  const { client } = addinClient((args) => {
    if (field(args, "operation") === "atomic_start")
      return {
        status: "submitted",
        accepted: true,
        completed: false,
        destroyed: false,
      };
    if (field(args, "operation") === "atomic_status")
      return { status: "terminated", completed: false, destroyed: true };
    if (field(args, "operation") === "atomic_finalize")
      return {
        status: "terminated",
        completed: false,
        destroyed: true,
        terminationReason: 3,
        outcome: "aborted",
        error: "RuntimeError: step failure",
        errorStep: "second",
        rollbackVerified: true,
        rollback: { measured: true, matched: true, dimensions: [] },
        cleanupCompleted: true,
        definitionDeleted: true,
      };
    assert.fail("unexpected operation");
  });
  const data = { runId: "abort", reportPath: dir, operations };
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => assert.fail(),
    catalog,
    validateBatch(data, catalog),
  );
  assert.equal(field(report, "outcome"), "aborted");
  assert.equal(field(report, "success"), false);
  assert.equal(field(report, "status"), "failed");
  assert.equal(field(report, "terminationReason"), 3);
  assert.equal(field(report, "rollbackVerified"), true);
  assert.equal(field(report, "rollback", "measured"), true);
  assert.equal(field(report, "errorStep"), "second");
  assert.deepEqual(
    array(field(report, "steps")).map((s) => field(s, "status")),
    ["success", "failed"],
  );
  assert.equal(field(report, "steps", 0, "mutationStatus"), "rolled_back");
});

test("an aborted snapshot mismatch never labels prior mutations rolled_back", async (t) => {
  const dir = await directory(t);
  const { client } = addinClient((args) => {
    if (field(args, "operation") === "atomic_start") return { accepted: true };
    if (field(args, "operation") === "atomic_status")
      return { destroyed: true };
    return {
      outcome: "aborted",
      errorStep: "second",
      rollbackVerified: false,
      rollback: { measured: true, matched: false, dimensions: [] },
      cleanupCompleted: true,
    };
  });
  const data = { runId: "rollback-unverified", reportPath: dir, operations };
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => assert.fail(),
    catalog,
    validateBatch(data, catalog),
  );
  assert.equal(field(report, "outcome"), "aborted");
  assert.equal(field(report, "steps", 0, "mutationStatus"), "unknown");
  assert.notEqual(field(report, "steps", 0, "mutationStatus"), "rolled_back");
});

test("committed report publication failure stays committed and retains a no-replay lock", async (t) => {
  const dir = await directory(t);
  const { client, calls } = addinClient((args) => {
    if (field(args, "operation") === "atomic_start") return { accepted: true };
    if (field(args, "operation") === "atomic_status")
      return { destroyed: true };
    fsSync.chmodSync(dir, 0o500);
    return committed({
      first: { success: true, result: {}, created: [] },
      second: { success: true, result: {}, created: [] },
    });
  });
  const data = { runId: "publication-failed", reportPath: dir, operations };
  const validation = validateBatch(data, catalog);
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => assert.fail(),
    catalog,
    validation,
  );
  fsSync.chmodSync(dir, 0o700);
  assert.equal(field(report, "outcome"), "committed");
  assert.equal(field(report, "status"), "success");
  assert.equal(field(report, "success"), true);
  assert.equal(field(report, "publication", "status"), "failed");
  assert.ok((await fs.stat(path.join(dir, "run.lock"))).isFile());
  const callCount = calls.length;
  await assert.rejects(
    runAtomicBatch(
      client,
      data,
      context,
      () => assert.fail(),
      catalog,
      validation,
    ),
    /Run is locked/,
  );
  assert.equal(
    calls.length,
    callCount,
    "a committed run with failed publication is never replayed",
  );
});

test("a timeout after send stays unknown with no automatic replay", async (t) => {
  const dir = await directory(t);
  let rpcCount = 0;
  const client: BatchClient = {
    capabilities: { backend: "addin", atomicBatch: true },
    server: { url: "http://127.0.0.1:8765/mcp" },
    async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
      const args = extractAtomicRequest(request.object.script);
      rpcCount++;
      if (field(args, "operation") === "atomic_resolve")
        return {
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              status: "resolved",
              resolvedIdentity: {
                name: "Model",
                creationId: "creation",
                fileId: null,
              },
            }),
          failed: false,
        };
      throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    },
  };
  const data = { runId: "timeout", reportPath: dir, operations };
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => assert.fail(),
    catalog,
    validateBatch(data, catalog),
  );
  assert.equal(field(report, "outcome"), "unknown");
  assert.equal(field(report, "status"), "unknown");
  assert.equal(field(report, "success"), false);
  assert.equal(
    rpcCount,
    2,
    "one read-only resolution then one mutating submit; no retry",
  );
  // A second run under the same identity is refused, never auto-replayed.
  await assert.rejects(
    runAtomicBatch(
      client,
      data,
      context,
      () => assert.fail(),
      catalog,
      validateBatch(data, catalog),
    ),
    /already exists/,
  );
});

test("deadline before identity/submit records not-submitted and sends no RPC", async (t) => {
  const dir = await directory(t);
  const calls: unknown[] = [];
  const client: BatchClient = {
    capabilities: { backend: "addin", atomicBatch: true },
    server: { timeoutMs: 1000 },
    async callTool() {
      calls.push("unexpected");
      assert.fail("expired work must not be sent");
    },
  };
  const data = {
    runId: "expired",
    reportPath: dir,
    timeBudgetMs: 1,
    operations,
  };
  const report = await withPerformanceTicks([0, 2], () =>
    runAtomicBatch(
      client,
      data,
      context,
      () => {},
      catalog,
      validateBatch(data, catalog),
    ),
  );
  assert.equal(field(report, "outcome"), "rejected");
  assert.equal(field(report, "mutated"), false);
  assert.deepEqual(calls, []);
  const receipt = await readAtomicReceipt(dir);
  assert.equal(field(receipt, "report", "journal", "event"), "not_submitted");
  assert.equal(
    calls.length,
    0,
    "the expired preflight budget is rejected locally before any RPC",
  );
});

test("resolver reserve exhaustion is not-submitted, distinct from an identity lookup failure", async (t) => {
  const dir = await directory(t);
  const calls: unknown[] = [];
  const client: BatchClient = {
    capabilities: { backend: "addin", atomicBatch: true },
    server: { timeoutMs: 1000 },
    async callTool() {
      calls.push("unexpected");
      assert.fail("reserve exhaustion must not send the resolver RPC");
    },
  };
  const data = {
    runId: "resolver-reserve-expired",
    reportPath: dir,
    timeBudgetMs: 6000,
    operations,
  };
  const report = await withPerformanceTicks([0, 0, 0, 2000], () =>
    runAtomicBatch(
      client,
      data,
      context,
      () => {},
      catalog,
      validateBatch(data, catalog),
    ),
  );
  assert.equal(field(report, "outcome"), "rejected");
  assert.equal(field(report, "mutated"), false);
  assert.deepEqual(calls, []);
  assert.equal(
    field((await readAtomicReceipt(dir)).report, "journal", "event"),
    "not_submitted",
  );
});

test("resolved identity-unavailable response is journaled separately from deadline exhaustion", async (t) => {
  const dir = await directory(t);
  const calls: unknown[] = [];
  const client: BatchClient = {
    capabilities: { backend: "addin", atomicBatch: true },
    server: { timeoutMs: 10000 },
    async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
      const args = extractAtomicRequest(request.object.script);
      calls.push(field(args, "operation"));
      assert.equal(field(args, "operation"), "atomic_resolve");
      return {
        failed: false,
        text:
          "FMCAD_RESULT " +
          JSON.stringify({
            status: "unavailable",
            candidates: [],
            unavailableEvidence: ["unique document identity unavailable"],
          }),
      };
    },
  };
  const data = {
    runId: "identity-unavailable",
    reportPath: dir,
    timeBudgetMs: 30000,
    operations,
  };
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => {},
    catalog,
    validateBatch(data, catalog),
  );
  assert.equal(field(report, "outcome"), "rejected");
  assert.equal(field(report, "mutated"), false);
  assert.deepEqual(calls, ["atomic_resolve"]);
  assert.equal(
    field((await readAtomicReceipt(dir)).report, "journal", "event"),
    "identity_unavailable",
  );
});

test("unresolved document identity blocks submit and recovery never retries the resolver", async (t) => {
  const dir = await directory(t);
  const calls: unknown[] = [];
  const client: BatchClient = {
    capabilities: { backend: "addin", atomicBatch: true },
    server: { timeoutMs: 500 },
    async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
      const args = extractAtomicRequest(request.object.script);
      calls.push(field(args, "operation"));
      throw new Error("identity resolution response lost");
    },
  };
  const data = { runId: "unresolved", reportPath: dir, operations };
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => {},
    catalog,
    validateBatch(data, catalog),
  );
  assert.equal(field(report, "outcome"), "rejected");
  assert.deepEqual(calls, ["atomic_resolve"]);
  const noFurtherRpc = {
    callTool: async () =>
      assert.fail("unresolved identity must not initiate another RPC"),
  };
  const reconcile = await reconcileAtomicBatch(noFurtherRpc, dir);
  assert.equal(field(reconcile, "status"), "not_submitted");
  const finalize = await finalizeAtomicBatch(noFurtherRpc, dir);
  assert.equal(field(finalize, "status"), "blocked");
});

test("poll failure is durably unknown and never triggers finalize or replay", async (t) => {
  const dir = await directory(t);
  const calls: unknown[] = [];
  const client: BatchClient = {
    capabilities: { backend: "addin", atomicBatch: true },
    server: { timeoutMs: 500 },
    async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
      const args = extractAtomicRequest(request.object.script);
      calls.push(field(args, "operation"));
      if (field(args, "operation") === "atomic_resolve")
        return {
          failed: false,
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              status: "resolved",
              resolvedIdentity: {
                name: "Model",
                creationId: "creation",
                fileId: null,
              },
            }),
        };
      if (field(args, "operation") === "atomic_start")
        return { failed: false, text: "FMCAD_RESULT {}" };
      throw Object.assign(new Error("status transport failed"), {
        code: "ETIMEDOUT",
      });
    },
  };
  const data = { runId: "poll-error", reportPath: dir, operations };
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => {},
    catalog,
    validateBatch(data, catalog),
  );
  assert.equal(field(report, "outcome"), "unknown");
  assert.deepEqual(calls, ["atomic_resolve", "atomic_start", "atomic_status"]);
  const receipt = await readAtomicReceipt(dir);
  assert.equal(field(receipt, "report", "journal", "event"), "status_unknown");
  assert.equal(field(receipt, "report", "outcome"), "unknown");
});

test("finalize transport failure remains unknown and requires later reconciliation", async (t) => {
  const dir = await directory(t);
  const calls: unknown[] = [];
  const client: BatchClient = {
    capabilities: { backend: "addin", atomicBatch: true },
    server: { timeoutMs: 500 },
    async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
      const args = extractAtomicRequest(request.object.script);
      calls.push(field(args, "operation"));
      if (field(args, "operation") === "atomic_resolve")
        return {
          failed: false,
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              status: "resolved",
              resolvedIdentity: {
                name: "Model",
                creationId: "creation",
                fileId: null,
              },
            }),
        };
      if (field(args, "operation") === "atomic_start")
        return { failed: false, text: "FMCAD_RESULT {}" };
      if (field(args, "operation") === "atomic_status")
        return {
          failed: false,
          text: "FMCAD_RESULT " + JSON.stringify({ destroyed: true }),
        };
      throw Object.assign(new Error("finalize transport failed"), {
        code: "ETIMEDOUT",
      });
    },
  };
  const data = { runId: "finalize-error", reportPath: dir, operations };
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => {},
    catalog,
    validateBatch(data, catalog),
  );
  assert.equal(field(report, "outcome"), "unknown");
  assert.deepEqual(calls, [
    "atomic_resolve",
    "atomic_start",
    "atomic_status",
    "atomic_finalize",
  ]);
  assert.equal(
    field((await readAtomicReceipt(dir)).report, "journal", "event"),
    "finalize_unknown",
  );
});

test("a stale run.lock blocks a new run with no automatic replay", async (t) => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, "run.lock"), "");
  const client: BatchClient = {
    capabilities: { backend: "addin", atomicBatch: true },
    callTool: async () => assert.fail("no mutation"),
  };
  const data = { runId: "locked", reportPath: dir, operations };
  await assert.rejects(
    runAtomicBatch(
      client,
      data,
      context,
      () => assert.fail(),
      catalog,
      validateBatch(data, catalog),
    ),
    /Run is locked/,
  );
});

async function ownedAtomicReceipt(t: TestContext, outcome = "committed") {
  const dir = await directory(t);
  const results = {
    first: {
      success: true,
      operation: "entity.list",
      document: "Model",
      result: {},
      created: [],
    },
    second: {
      success: true,
      operation: "entity.inspect",
      document: "Model",
      result: {},
      created: [],
    },
  };
  const { client } = addinClient((args) => {
    if (field(args, "operation") === "atomic_start")
      return { status: "submitted", accepted: true };
    if (field(args, "operation") === "atomic_status")
      return { status: "completed", destroyed: true, idle: true };
    if (field(args, "operation") === "atomic_finalize")
      return {
        ...committed(results),
        outcome,
        ...(outcome === "aborted"
          ? { completed: false, errorStep: "second", error: "expected failure" }
          : {}),
      };
    assert.fail("unexpected operation " + field(args, "operation"));
  });
  const data = { runId: "reconcile", reportPath: dir, operations };
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => {},
    catalog,
    validateBatch(data, catalog),
  );
  return { dir, report };
}

function holderIdentity(report: unknown) {
  return {
    commandId: field(report, "commandId"),
    runId: field(report, "runId"),
    sessionNonce: field(report, "sessionNonce"),
    requestHash: field(report, "requestHash"),
    backend: field(report, "atomic", "backend"),
    documentIdentity: field(report, "documentIdentity"),
    resolvedIdentity: field(report, "documentIdentity", "resolved"),
  };
}

test("reconcile is read-only, distinguishes native outcome from receipt, and never steals a live writer lock", async (t) => {
  const { dir, report } = await ownedAtomicReceipt(t);
  const before = await Promise.all(
    (await fs.readdir(dir))
      .filter((name) => /^\d{8}\.json$/.test(name))
      .map(
        async (name) =>
          [name, await fs.readFile(path.join(dir, name), "utf8")] as const,
      ),
  );
  const calls: unknown[] = [];
  const client: BatchClient = {
    async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
      const args = extractAtomicRequest(request.object.script);
      calls.push({
        operation: field(args, "operation"),
        readOnly: request.object.readOnly === true,
      });
      return {
        failed: false,
        text:
          "FMCAD_RESULT " +
          JSON.stringify({
            status: "completed",
            destroyed: true,
            outcome: "committed",
            identity: holderIdentity(report),
          }),
      };
    },
  };
  setObserveReadOnlyCatalog(catalog);
  const result = await reconcileAtomicBatch(client, dir);
  assert.equal(field(result, "outcome"), "committed");
  assert.equal(field(result, "nativeOutcome"), "committed");
  assert.deepEqual(calls, [{ operation: "atomic_status", readOnly: true }]);
  assert.equal((await fs.readdir(dir)).includes("run.lock"), false);
  assert.deepEqual(
    await Promise.all(
      before.map(async ([name]) => [
        name,
        await fs.readFile(path.join(dir, name), "utf8"),
      ]),
    ),
    before,
  );
});

test("reconcile mismatched holder identity and absent holder never infer native success", async (t) => {
  const { dir, report } = await ownedAtomicReceipt(t);
  const client: BatchClient = {
    async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
      const args = extractAtomicRequest(request.object.script);
      if (field(args, "operation") === "atomic_resolve")
        assert.fail("reconcile must not resolve or activate a document");
      return {
        failed: false,
        text:
          "FMCAD_RESULT " +
          JSON.stringify({
            status: "completed",
            destroyed: true,
            outcome: "committed",
            identity: {
              ...holderIdentity(report),
              sessionNonce: "0".repeat(32),
            },
          }),
      };
    },
  };
  const mismatch = await reconcileAtomicBatch(client, dir);
  assert.equal(field(mismatch, "status"), "identity_mismatch");
  assert.equal(field(mismatch, "outcome"), "unknown");
  const missing = await reconcileAtomicBatch(
    {
      async callTool() {
        return {
          failed: false,
          text:
            "FMCAD_RESULT " +
            JSON.stringify({ status: "unavailable", outcome: "unknown" }),
        };
      },
    },
    dir,
  );
  assert.equal(field(missing, "status"), "unavailable");
  assert.equal(
    field(missing, "outcome"),
    "committed",
    "the immutable local terminal receipt remains known",
  );
  assert.equal(field(missing, "nativeOutcome"), null);
});

test("reconcile reports live-buffer ambiguity and unavailable evidence without selecting a candidate", async (t) => {
  const { dir, report } = await ownedAtomicReceipt(t, "unknown");
  const candidates = [
    { name: "Model", creationId: "buffer-a", fileId: "file" },
    { name: "Model", creationId: "buffer-b", fileId: "file" },
  ];
  const result = await reconcileAtomicBatch(
    {
      async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
        const args = extractAtomicRequest(request.object.script);
        assert.equal(field(args, "operation"), "atomic_status");
        return {
          failed: false,
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              status: "ambiguous",
              ambiguous: true,
              destroyed: true,
              identity: holderIdentity(report),
              candidates,
              unavailableEvidence: ["unique open buffer"],
            }),
        };
      },
    },
    dir,
  );
  assert.equal(field(result, "status"), "ambiguous");
  assert.equal(field(result, "outcome"), "unknown");
  assert.deepEqual(field(result, "candidates"), candidates);
  assert.deepEqual(field(result, "unavailableEvidence"), [
    "unique open buffer",
  ]);
});

test("contradictory durable and native terminal outcomes stay unknown and block finalize cleanup", async (t) => {
  const { dir, report } = await ownedAtomicReceipt(t, "committed");
  const calls: unknown[] = [];
  const client: BatchClient = {
    async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
      const args = extractAtomicRequest(request.object.script);
      calls.push(field(args, "operation"));
      return {
        failed: false,
        text:
          "FMCAD_RESULT " +
          JSON.stringify({
            status: "terminated",
            destroyed: true,
            idle: true,
            outcome: "aborted",
            identity: holderIdentity(report),
            cleanupCompleted: false,
          }),
      };
    },
  };
  const reconciled = await reconcileAtomicBatch(client, dir);
  assert.equal(field(reconciled, "outcome"), "unknown");
  assert.equal(field(reconciled, "status"), "receipt_mismatch");
  assert.equal(field(reconciled, "nativeOutcome"), "aborted");
  calls.length = 0;
  const finalized = await finalizeAtomicBatch(client, dir);
  assert.equal(field(finalized, "outcome"), "unknown");
  assert.equal(field(finalized, "status"), "receipt_mismatch");
  assert.deepEqual(
    calls,
    ["atomic_status"],
    "conflict blocks cleanup before atomic_finalize",
  );
});

test("reconcile rejects unbounded and mutating observe requests before RPC", async (t) => {
  const { dir } = await ownedAtomicReceipt(t);
  setObserveReadOnlyCatalog(catalog);
  const client: BatchClient = {
    callTool: async () =>
      assert.fail("invalid observe data must fail before RPC"),
  };
  await assert.rejects(
    reconcileAtomicBatch(
      client,
      dir,
      Array.from({ length: 101 }, () => ({})),
    ),
    /at most 100/,
  );
  await assert.rejects(
    reconcileAtomicBatch(client, dir, [
      { operation: "component.create", data: { name: "x" } },
    ]),
    /read-only/,
  );
});

test("reconcile optional observe uses only catalog read handlers and stays read-only", async (t) => {
  const { dir, report } = await ownedAtomicReceipt(t, "unknown");
  const calls: unknown[] = [];
  setObserveReadOnlyCatalog(catalog);
  const result = await reconcileAtomicBatch(
    {
      async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
        const args = extractAtomicRequest(request.object.script);
        calls.push({
          operation: field(args, "operation"),
          readOnly: request.object.readOnly,
        });
        return {
          failed: false,
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              status:
                field(args, "operation") === "atomic_observe"
                  ? "observed"
                  : "executing",
              destroyed: false,
              identity: holderIdentity(report),
              results: [{ count: 0 }],
            }),
        };
      },
    },
    dir,
    [{ operation: "entity.stats", data: { kind: "body" } }],
  );
  assert.equal(field(result, "outcome"), "unknown");
  assert.deepEqual(field(result, "observed"), [{ count: 0 }]);
  assert.deepEqual(calls, [
    { operation: "atomic_status", readOnly: true },
    { operation: "atomic_observe", readOnly: true },
  ]);
});

test("finalize requires destroy, idle, and exact identity before cleanup and durably acknowledges native result", async (t) => {
  const { dir, report } = await ownedAtomicReceipt(t, "unknown");
  const requests: unknown[] = [];
  let acknowledged = false;
  const client: BatchClient = {
    async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
      const args = extractAtomicRequest(request.object.script);
      requests.push(field(args, "operation"));
      if (field(args, "operation") === "atomic_status")
        return {
          failed: false,
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              status: "completed",
              destroyed: true,
              idle: true,
              cleanupCompleted: acknowledged,
              outcome: acknowledged ? "committed" : undefined,
              identity: holderIdentity(report),
            }),
        };
      acknowledged = true;
      return {
        failed: false,
        text:
          "FMCAD_RESULT " +
          JSON.stringify({
            cleanupCompleted: true,
            outcome: "committed",
            results: { first: { success: true }, second: { success: true } },
            identity: holderIdentity(report),
          }),
      };
    },
  };
  const ack = await finalizeAtomicBatch(client, dir);
  assert.equal(field(ack, "status"), "finalized");
  assert.equal(field(ack, "outcome"), "committed");
  assert.deepEqual(requests, ["atomic_status", "atomic_finalize"]);
  const receipt = await readAtomicReceipt(dir);
  assert.equal(field(receipt, "report", "journal", "event"), "finalize_ack");
  assert.equal(field(receipt, "report", "outcome"), "committed");
  assert.equal((await fs.readdir(dir)).includes("run.lock"), false);
  requests.length = 0;
  const again = await finalizeAtomicBatch(client, dir);
  assert.equal(field(again, "status"), "already_finalized");
  assert.deepEqual(
    requests,
    [],
    "a durable finalize acknowledgment makes repeat finalize RPC-free",
  );
});

test("finalize never calls native cleanup for active, non-destroyed, or mismatched instances", async (t) => {
  for (const observation of [
    { destroyed: false, idle: true },
    { destroyed: true, idle: false },
    { destroyed: true, idle: true, identity: { sessionNonce: "wrong" } },
  ]) {
    const { dir, report } = await ownedAtomicReceipt(t, "unknown");
    const calls: unknown[] = [];
    const client: BatchClient = {
      async callTool(request: Parameters<AtomicClient["callTool"]>[0]) {
        const args = extractAtomicRequest(request.object.script);
        calls.push(field(args, "operation"));
        return {
          failed: false,
          text:
            "FMCAD_RESULT " +
            JSON.stringify({
              status: "submitted",
              ...observation,
              identity: observation.identity ?? holderIdentity(report),
            }),
        };
      },
    };
    const result = await finalizeAtomicBatch(client, dir);
    assert.notEqual(field(result, "status"), "finalized");
    assert.deepEqual(calls, ["atomic_status"]);
  }
});

test("finalize retries while the command context is busy, then finalizes with the true outcome", async (t) => {
  const dir = await directory(t);
  let finalizeCalls = 0;
  const { client } = addinClient((args) => {
    if (field(args, "operation") === "atomic_start")
      return {
        status: "submitted",
        accepted: true,
        completed: false,
        destroyed: false,
      };
    if (field(args, "operation") === "atomic_status")
      return { status: "terminated", completed: false, destroyed: true };
    if (field(args, "operation") === "atomic_finalize") {
      finalizeCalls += 1;
      if (finalizeCalls === 1) {
        return {
          status: "cleanup_pending",
          completed: false,
          destroyed: true,
          terminationReason: 4,
          outcome: "aborted",
          cleanupCompleted: false,
          definitionDeleted: false,
        };
      }
      return {
        status: "terminated",
        completed: false,
        destroyed: true,
        terminationReason: 4,
        outcome: "aborted",
        rollbackVerified: true,
        rollback: { measured: true, matched: true, dimensions: [] },
        cleanupCompleted: true,
        definitionDeleted: true,
      };
    }
    assert.fail("unexpected operation " + field(args, "operation"));
  });
  const data = { runId: "preempt", reportPath: dir, operations };
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => assert.fail(),
    catalog,
    validateBatch(data, catalog),
  );
  assert.equal(finalizeCalls, 2);
  assert.equal(field(report, "outcome"), "aborted");
  assert.equal(field(report, "terminationReason"), 4);
  assert.equal(field(report, "rollbackVerified"), true);
});

test("effective atomic mode is part of the replay identity", () => {
  const base = { runId: "a", operations };
  const atomicHash = hash({ request: { ...base, atomic: true }, context });
  const nonAtomicHash = hash({ request: { ...base, atomic: false }, context });
  assert.notEqual(atomicHash, nonAtomicHash);
});

test("a collection/array produced by one step resolves through $ref into a later refs:[...] input", () => {
  const results = {
    find: {
      success: true,
      operation: "entity.find",
      result: {
        refs: [
          { token: "A", kind: "body" },
          { token: "B", kind: "body" },
        ],
      },
    },
  };
  assert.deepEqual(
    resolveReferences({ refs: { $ref: "find.result.refs" } }, results),
    {
      refs: [
        { token: "A", kind: "body" },
        { token: "B", kind: "body" },
      ],
    },
  );
});

test("the owned native indexed-reference fixture passes batch preflight", async () => {
  const fixture = object(
    JSON.parse(
      await fs.readFile(
        path.join(
          fixtureDirectory,
          "fixtures/recipe-reduction/iw7.1/indexed-reference-scope.json",
        ),
        "utf8",
      ),
    ),
  );
  const validation = validateBatch(
    { runId: "indexed-reference-fixture", ...fixture },
    catalog,
  );
  assert.equal(validation.success, true, validation.errors.join("; "));
});

test("batch recovery CLI commands parse report-path and observe shortcut without document identity requirements", () => {
  for (const command of ["reconcile", "finalize"]) {
    const entry = findCommand(["batch", command]);
    assert.ok(entry, `missing fmcad batch ${command}`);
    assert.equal(entry.requiresDoc, false);
    const input = parseCadInput(
      [
        "--report-path",
        "/tmp/atomic-report",
        ...(command === "reconcile" ? ["--data", "observe"] : []),
      ],
      present(catalog[`batch.${command}`]).inputs,
      {
        ...present(catalog[`batch.${command}`]),
        observeShortcut: command === "reconcile",
      },
    );
    assert.equal(input.data["reportPath"], "/tmp/atomic-report");
    if (command === "reconcile") assert.deepEqual(input.data["operations"], []);
  }
});

test("timeout recovery generic commit and abort fixtures pass the real batch validator", async () => {
  for (const name of ["atomic-commit.json", "atomic-abort.json"]) {
    const fixture = JSON.parse(
      await fs.readFile(
        path.join(
          fixtureDirectory,
          "fixtures/recipe-reduction/timeout-reconcile",
          name,
        ),
        "utf8",
      ),
    );
    const validation = validateBatch(fixture, catalog);
    assert.equal(
      validation.success,
      true,
      `${name}: ${validation.errors.join("; ")}`,
    );
  }
});

test("atomic recipe metadata is rejected in preflight before report or RPC", async (t) => {
  const dir = await directory(t);
  const { client, calls } = addinClient(() =>
    assert.fail("recipe metadata must be rejected before RPC"),
  );
  const data = {
    runId: "recipe-preflight",
    reportPath: dir,
    recipe: { id: "unsupported", bindings: [] },
    operations,
  };
  const validation = {
    success: true,
    errors: [],
    limitations: [],
    atomic: { requested: true, effective: true },
    operations,
    plan: {
      steps: operations.length,
      backendCalls: operations.length,
      mutations: 0,
      timeBudgetMs: 1000,
    },
    exports: {},
  };
  const report = await runAtomicBatch(
    client,
    data,
    context,
    () => assert.fail(),
    catalog,
    validation,
  );
  assert.equal(field(report, "outcome"), "rejected");
  assert.match(array(field(report, "errors")).join(" "), /definition\.recipe/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("non-atomic run marks the report with no transactional protection", async (t) => {
  const dir = await directory(t);
  const data = {
    runId: "non-atomic",
    atomic: false,
    reportPath: dir,
    operations,
  };
  const output = { success: true, result: { entity: { token: "T1" } } };
  const report = await runBatch(
    null,
    data,
    context,
    async () => output,
    catalog,
  );
  assert.equal(field(report, "atomic", "effective"), false);
  assert.equal(field(report, "success"), true);
});

test("buildAtomicScript bundles the reusable CadContext handlers and an atomic entry point", () => {
  const script = buildAtomicScript({
    operation: "atomic_status",
    commandId: "fmcad_atomic_" + "a".repeat(32),
    runId: "r",
  });
  assert.match(script, /def run\(_context: str\)/);
  assert.match(script, /FMCAD_RESULT /);
  assert.match(script, /class CadContext/);
  assert.match(script, /CAD_HANDLERS\.update/);
});

test("test-only fault injection is gated, positioned, and absent from the catalog", (t) => {
  const steps = [
    { id: "one", operation: "entity.list", data: {} },
    {
      id: "two",
      operation: "entity.inspect",
      data: { ref: { $ref: "one.result.entity" } },
    },
  ];
  const previousFault = process.env["FMCAD_TEST_ATOMIC_FAULT"];
  // Unset (the production default) leaves steps unchanged.
  delete process.env["FMCAD_TEST_ATOMIC_FAULT"];
  t.after(() => {
    if (previousFault === undefined)
      delete process.env["FMCAD_TEST_ATOMIC_FAULT"];
    else process.env["FMCAD_TEST_ATOMIC_FAULT"] = previousFault;
  });
  assert.deepEqual(injectTestFault(steps), steps);
  // Each phase injects a synthetic failing step after the last real step.
  for (const phase of [
    "after_mutation",
    "before_ref_publish",
    "final_validation",
  ]) {
    process.env["FMCAD_TEST_ATOMIC_FAULT"] = phase;
    const injected = injectTestFault(steps);
    assert.equal(injected.length, 3, phase);
    assert.equal(present(injected[2]).id, "__test_fault", phase);
    assert.equal(present(injected[2]).operation, "__test.fault", phase);
    assert.deepEqual(present(injected[2]).data, { phase }, phase);
    assert.deepEqual(injected.slice(0, 2), steps, phase);
  }
  // An explicit after-index injects the fault at that position.
  process.env["FMCAD_TEST_ATOMIC_FAULT"] = "after_mutation:0";
  assert.deepEqual(
    injectTestFault(steps).map((s) => s.id),
    ["one", "__test_fault", "two"],
  );
  // The fault operation name is not a catalog operation, so validation can never produce it.
  assert.equal(catalog["__test.fault"], undefined);
  // Malformed gate values fail loud instead of silently misbehaving.
  for (const bad of ["nonsense", "after_mutation:99", "after_mutation:-2"]) {
    process.env["FMCAD_TEST_ATOMIC_FAULT"] = bad;
    assert.throws(() => injectTestFault(steps), /FMCAD_TEST_ATOMIC_FAULT/, bad);
  }
});

test("atomic fault gate is carried only with the internally injected synthetic step", async (t) => {
  const dir = await directory(t);
  const { client } = addinClient((args) => {
    if (field(args, "operation") === "atomic_start") {
      assert.equal(field(args, "testFault"), true);
      assert.equal(
        array(field(args, "steps")).filter(
          (step) => field(step, "operation") === "__test.fault",
        ).length,
        1,
      );
      return { status: "submitted", accepted: true };
    }
    if (field(args, "operation") === "atomic_status")
      return { status: "completed", destroyed: true, idle: true };
    if (field(args, "operation") === "atomic_finalize")
      return committed({ first: { success: true }, second: { success: true } });
    assert.fail("unexpected operation " + field(args, "operation"));
  });
  const previousFault = process.env["FMCAD_TEST_ATOMIC_FAULT"];
  process.env["FMCAD_TEST_ATOMIC_FAULT"] = "final_validation";
  t.after(() => {
    if (previousFault === undefined)
      delete process.env["FMCAD_TEST_ATOMIC_FAULT"];
    else process.env["FMCAD_TEST_ATOMIC_FAULT"] = previousFault;
  });
  const data = { runId: "fault-gate", reportPath: dir, operations };
  await runAtomicBatch(
    client,
    data,
    context,
    () => assert.fail(),
    catalog,
    validateBatch(data, catalog),
  );
});

test("the atomic bundle keeps the test fault outside the production handler registry", () => {
  const script = buildAtomicScript({
    operation: "atomic_status",
    commandId: "fmcad_atomic_" + "a".repeat(32),
    runId: "r",
  });
  assert.match(script, /def _atomic_test_fault/);
  assert.match(script, /if step\['operation'\] == '__test\.fault'/);
  assert.match(script, /args\.get\('testFault'\) is not True/);
  assert.doesNotMatch(script, /CAD_HANDLERS\s*\[['"]__test\.fault/);
});

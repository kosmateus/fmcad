import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { BatchCatalog, CadData } from "@fmcad/core";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
type Batch = typeof import("../src/composition/batch.js");
const current = load("./src/batch.js") as Batch;
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
const previous = historical(
  "979944d53961b9b80a5e8213c43706409d194669",
  "src/batch.js",
) as Batch;
const catalog: BatchCatalog = {
  "test.create": {
    required: ["name"],
    inputs: { name: "", source: "" },
    readOnly: false,
  },
};
const context = {
  doc: "Owned model",
  docId: "creation-A",
  docFileId: "file-A",
};
const request = (reportPath: string): CadData => ({
  runId: "batch-A",
  atomic: false,
  reportPath,
  operations: [
    {
      id: "first",
      operation: "test.create",
      data: { name: "first" },
      onExisting: "reuse",
    },
    {
      id: "second",
      operation: "test.create",
      data: { name: "second", source: { $ref: "first.result.feature" } },
      onExisting: "reuse",
    },
  ],
});

async function fixture(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batch-services-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function bytes(directory: string) {
  return Promise.all(
    (await fs.readdir(directory))
      .sort()
      .map(async (name) => [
        name,
        await fs.readFile(path.join(directory, name), "utf8"),
      ]),
  );
}

for (const outcome of ["success", "failed", "unknown"] as const) {
  test(`batch extraction preserves ${outcome} calls, stage binding, reports and replay`, async (t) => {
    t.mock.method(performance, "now", () => 100);
    t.mock.method(
      Date.prototype,
      "toISOString",
      () => "2026-01-02T03:04:05.000Z",
    );
    const directory = await fixture(t);
    const observations = [];
    for (const api of [previous, current]) {
      const calls: unknown[] = [],
        stages: unknown[] = [];
      const data = request(directory);
      const result = await api.runBatch(
        null,
        data,
        context,
        async (_client, operation, payload, target) => {
          calls.push({ operation, payload, target });
          if (calls.length === 2 && outcome === "unknown")
            throw new Error("reply lost");
          if (calls.length === 2 && outcome === "failed")
            return { success: false, result: { message: "explicit failure" } };
          return {
            success: true,
            operation,
            result: {
              feature: { token: payload["name"] },
              count: calls.length,
              metadata: "not a summary fact",
            },
            created: [],
          };
        },
        catalog,
        {
          async beforeRun(input) {
            stages.push(input);
          },
        },
      );
      assert.equal(result["status"], outcome);
      assert.equal(calls.length, 2);
      assert.equal(stages.length, 1);
      const stored = await bytes(directory);
      const summary = await api.readBatchSummary({ reportPath: directory });
      assert.equal(summary.historical, true);
      assert.equal(summary.modelValidated, false);
      assert.deepEqual(await bytes(directory), stored);
      const replay = api.runBatch(
        null,
        data,
        context,
        async () => assert.fail("must not replay an existing batch"),
        catalog,
      );
      if (outcome === "success")
        assert.deepEqual(await replay, { ...result, replayed: true });
      else
        await assert.rejects(
          replay,
          /operator inspection required, no automatic retry/,
        );
      assert.deepEqual(await bytes(directory), stored);
      observations.push({
        result,
        calls,
        stages,
        stored,
        summary,
        text: api.formatBatchSummary(result),
      });
      await fs.rm(directory, { recursive: true });
      await fs.mkdir(directory);
    }
    assert.deepEqual(observations[1], observations[0]);
  });
}

test("offline definition inspection and preview retain outputs without an executor", async () => {
  const data = request("ignored");
  assert.deepEqual(
    current.definitionInspect(data, catalog),
    previous.definitionInspect(data, catalog),
  );
  for (const mode of ["validate", "preview"]) {
    const input = { ...data, mode };
    const before = await previous.runBatchEntry(
      null,
      input,
      context,
      undefined,
      catalog,
    );
    const after = await current.runBatchEntry(
      null,
      input,
      context,
      undefined,
      catalog,
    );
    assert.deepEqual(after, before);
    assert.ok(before && typeof before === "object" && !Array.isArray(before));
    assert.ok(after && typeof after === "object" && !Array.isArray(after));
    assert.equal(
      current.formatBatchSummary(after as CadData),
      previous.formatBatchSummary(before as CadData),
    );
  }
});

test("read-only batches do not acquire a mutation stage", async (t) => {
  for (const api of [previous, current]) {
    const directory = await fixture(t);
    const readCatalog: BatchCatalog = {
      "test.create": { ...catalog["test.create"]!, readOnly: true },
    };
    let stageCalls = 0;
    await api.runBatch(
      null,
      request(directory),
      context,
      async () => ({ success: true, result: { feature: { token: "read" } } }),
      readCatalog,
      {
        async beforeRun() {
          stageCalls++;
        },
      },
    );
    assert.equal(stageCalls, 0);
  }
});

test("corrupt reports retain rejection and sanitized diagnostics", async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, "00000000.json");
  for (const contents of ["{", "opaque-private-fragment", "{}", "null", "[]"]) {
    await fs.writeFile(file, contents);
    const errors: string[] = [];
    for (const api of [previous, current]) {
      await assert.rejects(
        api.readBatchSummary({ reportPath: directory }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /opaque-private/);
          errors.push(error.message);
          return true;
        },
      );
      assert.equal(await fs.readFile(file, "utf8"), contents);
    }
    assert.equal(errors[1], errors[0]);
  }
});

for (const variant of [
  "rejected",
  "foreign-operation",
  "created",
  "extra-proof",
  "thrown",
] as const) {
  test(`primitive input rejection settles only authoritative no-mutation evidence: ${variant}`, async (t) => {
    const directory = await fixture(t);
    let calls = 0;
    const operation = "shape.box";
    const output = {
      success: false,
      operation,
      created: variant === "created" ? [{ token: "partial" }] : [],
      result: {
        status: "failed",
        rejection: {
          kind: "cad-input-rejection",
          version: 1,
          operation: variant === "foreign-operation" ? "shape.cone" : operation,
          mutationStatus: "not_started",
          ...(variant === "extra-proof" ? { callerClaim: true } : {}),
        },
        error: {
          code: "INVALID_INPUT",
          message: "Invalid or incompatible expression: literal",
        },
      },
    };
    const data = request(directory);
    data["operations"] = ["first", "second"].map((id) => ({
      id,
      operation,
      data: { name: id },
      onExisting: "reuse",
    }));
    const report = await current.runBatch(
      null,
      data,
      context,
      async () => {
        calls++;
        if (variant === "thrown")
          throw new Error("Invalid or incompatible expression: literal");
        return output;
      },
      { [operation]: catalog["test.create"]! },
    );
    const steps = report["steps"] as {
      status: string;
      mutationStatus: string;
      error?: { message: string; code?: string };
    }[];
    assert.equal(calls, 1);
    assert.equal(report["success"], false);
    assert.equal(report["status"], variant === "thrown" ? "unknown" : "failed");
    assert.equal(steps[1]!.status, "skipped");
    assert.equal(
      steps[0]!.mutationStatus,
      variant === "rejected" ? "not_started" : "unknown",
    );
    if (variant === "rejected")
      assert.deepEqual(steps[0]!.error, output.result.error);
    else assert.notEqual(steps[0]!.error?.code, "INVALID_INPUT");
    await assert.rejects(
      current.runBatch(
        null,
        data,
        context,
        async () => {
          assert.fail("a failed or unknown batch must never replay");
        },
        { [operation]: catalog["test.create"]! },
      ),
    );
  });
}

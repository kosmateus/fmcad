import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  BatchCatalog,
  CadContext,
  CadData,
  BatchReport,
} from "@fmcad/core";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const composition = load(
  "./src/batch.js",
) as typeof import("../src/composition/batch.js");
const { batchServices } = load(
  "./src/dist/composition/batch.js",
) as typeof import("../src/composition/batch.js");
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
  runtimePath?: string,
) => unknown;
const baseline = historical(
  "a26222ff617b0e9597b2a91b50474bdca8d0a0ce",
  "src/batch.js",
) as typeof composition;
const before = historical(
  "e57d3874f049c23016084d69e013b345fdf9e30a",
  "packages/core/src/application/cad/batch.ts",
  "src/dist/core/application/cad/batch.js",
) as typeof import("../packages/core/src/application/cad/batch.js");
const catalog: BatchCatalog = {
  "test.create": { required: ["name"], inputs: { name: "" }, readOnly: false },
};
const context: CadContext = {
  doc: "Owned model",
  docId: "creation-A",
  docFileId: "file-A",
  preview: false,
};
const legacy: CadContext = { ...context, component: null, projectId: null };
const request = (reportPath: string): CadData => ({
  runId: "batch-A",
  atomic: false,
  reportPath,
  operations: [
    {
      id: "create",
      operation: "test.create",
      data: { name: "part" },
      onExisting: "reuse",
    },
  ],
});
const output = { success: true, result: { token: "original" } };
const forbidden = async () =>
  assert.fail("Receipt replay must not submit an SDK call");
const stages = {
  async beforeRun() {
    assert.fail("Receipt replay must not acquire a mutation stage");
  },
};
async function directory(t: TestContext) {
  const value = await fs.mkdtemp(
    path.join(os.tmpdir(), "batch-compatibility-"),
  );
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}
async function snapshots(directory: string) {
  return Promise.all(
    (await fs.readdir(directory))
      .sort()
      .map(async (name) => [
        name,
        await fs.readFile(path.join(directory, name), "utf8"),
      ]),
  );
}
async function seed(t: TestContext, target = legacy) {
  const dir = await directory(t),
    data = request(dir);
  const report = (await baseline.runBatch(
    null,
    data,
    target,
    async () => output,
    catalog,
  )) as BatchReport;
  assert.equal(report.status, "success");
  return { dir, data, report };
}

for (const selector of ["component", "projectId", "both"] as const) {
  test(`historical ${selector} null selectors replay as absent selectors without changing the receipt`, async (t) => {
    const old = {
      ...context,
      ...(selector !== "projectId" ? { component: null } : {}),
      ...(selector !== "component" ? { projectId: null } : {}),
    };
    const { dir, data, report } = await seed(t, old);
    const bytes = await snapshots(dir);
    assert.deepEqual(
      await baseline.runBatch(null, data, old, forbidden, catalog),
      { ...report, replayed: true },
    );
    await assert.rejects(
      baseline.runBatch(null, data, context, forbidden, catalog),
      /hash differs/,
    );
    await assert.rejects(
      before.runBatch(
        data,
        context,
        batchServices(null, forbidden, catalog, stages),
      ),
      /hash differs/,
    );
    const replay = await composition.runBatch(
      null,
      data,
      context,
      forbidden,
      catalog,
      stages,
    );
    assert.deepEqual(replay, { ...report, replayed: true });
    assert.deepEqual(await snapshots(dir), bytes);
  });
}

test("an explicit legacy client can also read an omitted-selector report without rewriting it", async (t) => {
  const dir = await directory(t),
    data = request(dir);
  const report = await composition.runBatch(
    null,
    data,
    context,
    async () => output,
    catalog,
  );
  const bytes = await snapshots(dir);
  assert.deepEqual(
    await composition.runBatch(null, data, legacy, forbidden, catalog, stages),
    { ...report, replayed: true },
  );
  assert.deepEqual(await snapshots(dir), bytes);
});

for (const changed of [
  { doc: "Other model" },
  { docId: "creation-B" },
  { docFileId: "file-B" },
  { component: "root" },
  { component: "part" },
  { projectId: "project-B" },
  { json: true },
  { summary: true },
  { extra: "different" },
] satisfies CadData[]) {
  test(`selector compatibility refuses a different context: ${JSON.stringify(changed)}`, async (t) => {
    const { dir, data } = await seed(t);
    const bytes = await snapshots(dir);
    await assert.rejects(
      composition.runBatch(
        null,
        data,
        { ...context, ...changed },
        forbidden,
        catalog,
        stages,
      ),
      /hash differs/,
    );
    assert.deepEqual(await snapshots(dir), bytes);
  });
}

for (const pin of ["docId", "docFileId"] as const) {
  for (const value of [null, "", undefined]) {
    test(`selector compatibility requires a nonempty ${pin}: ${String(value)}`, async (t) => {
      const old: CadContext = { ...legacy },
        target: CadContext = { ...context };
      if (value === undefined) {
        delete old[pin];
        delete target[pin];
      } else {
        old[pin] = value;
        target[pin] = value;
      }
      const { dir, data } = await seed(t, old),
        bytes = await snapshots(dir);
      await assert.rejects(
        composition.runBatch(null, data, target, forbidden, catalog, stages),
        /hash differs/,
      );
      assert.deepEqual(await snapshots(dir), bytes);
    });
  }
}

test("selector compatibility rejects a changed request before any call or stage", async (t) => {
  const { dir, data } = await seed(t),
    bytes = await snapshots(dir);
  for (const changed of [
    { ...data, runId: "batch-B" },
    {
      ...data,
      operations: [
        {
          id: "create",
          operation: "test.create",
          data: { name: "other" },
          onExisting: "reuse",
        },
      ],
    },
  ]) {
    await assert.rejects(
      composition.runBatch(null, changed, context, forbidden, catalog, stages),
      /hash differs/,
    );
    assert.deepEqual(await snapshots(dir), bytes);
  }
});

for (const change of [
  "hash",
  "stored-context",
  "success-flag",
  "failed",
  "unknown",
  "running",
] as const) {
  test(`selector compatibility refuses ${change} evidence and preserves its bytes`, async (t) => {
    const { dir, data, report } = await seed(t);
    const terminal = path.join(
      dir,
      String(report.sequence).padStart(8, "0") + ".json",
    );
    if (change === "hash") report.requestHash = "0".repeat(64);
    else if (change === "stored-context") report.context.docFileId = "file-B";
    else if (change === "success-flag") report.success = false;
    else {
      report.status = change;
      report.success = false;
      report.steps[0]!.status = change;
    }
    await fs.writeFile(terminal, JSON.stringify(report));
    const bytes = await snapshots(dir);
    await assert.rejects(
      composition.runBatch(null, data, context, forbidden, catalog, stages),
      /hash differs|operator inspection/,
    );
    assert.deepEqual(await snapshots(dir), bytes);
  });
}

for (const mutation of [
  "success",
  "operation",
  "runId",
  "step-operation",
  "unexpected-failure",
  "blocked-negative",
] as const) {
  test(`contradictory ${mutation} evidence was accepted by old policies and now blocks exact replay`, async (t) => {
    const { dir, data, report } = await seed(t);
    if (mutation === "success") report.success = false;
    else if (mutation === "operation") report.operation = "unrelated";
    else if (mutation === "runId") report.runId = "batch-B";
    else if (mutation === "step-operation")
      report.steps[0]!.operation = "unrelated";
    else {
      report.steps[0]!.expectFail = true;
      report.steps[0]!.output = {
        success: false,
        status: mutation === "blocked-negative" ? "blocked" : "fail",
      };
    }
    await fs.writeFile(
      path.join(dir, String(report.sequence).padStart(8, "0") + ".json"),
      JSON.stringify(report),
    );
    const bytes = await snapshots(dir);
    assert.deepEqual(
      await baseline.runBatch(null, data, legacy, forbidden, catalog),
      { ...report, replayed: true },
    );
    assert.deepEqual(
      await before.runBatch(
        data,
        legacy,
        batchServices(null, forbidden, catalog, stages),
      ),
      { ...report, replayed: true },
    );
    await assert.rejects(
      composition.runBatch(null, data, legacy, forbidden, catalog, stages),
      /operator inspection/,
    );
    await assert.rejects(
      composition.runBatch(null, data, context, forbidden, catalog, stages),
      /operator inspection/,
    );
    assert.deepEqual(await snapshots(dir), bytes);
  });
}

test("a declared negative check replays only its well-formed fail result", async (t) => {
  const readCatalog: BatchCatalog = {
    "test.create": { ...catalog["test.create"]!, readOnly: true },
  };
  const dir = await directory(t),
    data = request(dir);
  data["operations"] = [
    {
      id: "create",
      operation: "test.create",
      data: { name: "part" },
      onExisting: "reuse",
      expectFail: true,
    },
  ];
  const report = (await baseline.runBatch(
    null,
    data,
    legacy,
    async () => ({ success: false, status: "fail" }),
    readCatalog,
  )) as BatchReport;
  assert.equal(report.status, "success", JSON.stringify(report));
  const bytes = await snapshots(dir);
  assert.deepEqual(
    await composition.runBatch(
      null,
      data,
      context,
      forbidden,
      readCatalog,
      stages,
    ),
    { ...report, replayed: true },
  );
  assert.deepEqual(await snapshots(dir), bytes);
  report.steps[0]!.output = { success: false, status: "blocked" };
  await fs.writeFile(
    path.join(dir, String(report.sequence).padStart(8, "0") + ".json"),
    JSON.stringify(report),
  );
  const blocked = await snapshots(dir);
  assert.deepEqual(
    await before.runBatch(
      data,
      legacy,
      batchServices(null, forbidden, readCatalog, stages),
    ),
    { ...report, replayed: true },
  );
  await assert.rejects(
    composition.runBatch(null, data, context, forbidden, readCatalog, stages),
    /operator inspection/,
  );
  assert.deepEqual(await snapshots(dir), blocked);
});

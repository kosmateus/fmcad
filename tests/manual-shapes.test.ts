import { createRequire } from "node:module";
import { record } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(testRoot + "/tests/manual-shapes.test.js");
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const { validateCad } = runtimeRequire(
  "../src/cad",
) as typeof import("../src/composition/cad-execution");
const { validateBatch, resolveReferences } = runtimeRequire(
  "../src/batch",
) as typeof import("../src/composition/batch");
const catalog = runtimeRequire("../src/catalog/shapes.json") as Record<
  string,
  import("@fmcad/core").OperationDeclaration
>;
const manual = runtimeRequire("../src/manual/shapes.json") as Record<
  string,
  import("../src/composition/library-help-manual").CommandManual
>;

test("all 13 shape manuals cover catalog and examples pass existing outer validators", () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  assert.equal(Object.keys(manual).length, 13);
  for (const [operation, entry] of Object.entries(manual)) {
    assert.ok(
      entry.sections.some((s) => s.title.startsWith("Return Contract")),
      operation,
    );
    assert.deepEqual(entry.audit.gaps, []);
    assert.ok(
      entry.audit.sources.length &&
        entry.audit.verified.length &&
        entry.audit.tests.length,
    );
    for (const example of present(entry.examples)) {
      assert.ok(example.requires && example.output && example.label);
      validateCad(operation, record(example.data));
      const result = validateBatch(
        {
          runId: "manual",
          operations: [{ id: "s", operation, data: record(example.data) }],
        },
        catalog,
      );
      assert.equal(result.success, true, JSON.stringify(result.errors));
    }
  }
});

test("recipe output wiring distinguishes final pattern and seed; dotted keys are not traversable", () => {
  const seed = { token: "test-only-seed", kind: "feature" };
  const result = { b: { result: { seed: { feature: seed } } } };
  assert.deepEqual(
    resolveReferences(
      { entities: [{ $ref: "b.result.seed.feature" }] },
      result,
    ),
    { entities: [seed] },
  );
  assert.throws(
    () =>
      resolveReferences(
        { $ref: "r.result.refs.route0.fit0" },
        { r: { result: { refs: { "route0.fit0": seed } } } },
      ),
    /Unresolved reference/,
  );
});

test("shape manual examples, conditional returns and documented defects reproduce offline", () => {
  const result = spawnSync("python3", ["-B", "tests/manual_shapes_test.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

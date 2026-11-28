import { createRequire } from "node:module";
import type { Descriptor, ModelingApi } from "./modeling-unit-test-support";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const load = createRequire(
  path.join(process.cwd(), "tests/shape-library.test.ts"),
);
test.after(load("./fixtures/fake-wsl-platform.cjs")());
const { catalog, validateCad } = load("../src/cad") as ModelingApi;
const { validateBatch } = load("../src/batch") as {
  validateBatch(
    data: unknown,
    catalog: unknown,
  ): { success: boolean; errors: unknown };
};

const shapeLibrary = load("../src/catalog/shapes-library.json") as Record<
  string,
  Descriptor
>;
const gear = load("../src/catalog/gear.json") as Record<string, Descriptor>;
const shapeManual = load("../src/manual/shapes-library.json");
const gearManual = load("../src/manual/gear.json");

test("GM10/GM11 descriptors are registered in the shared catalog and covered by manuals", () => {
  for (const operation of [
    ...Object.keys(shapeLibrary),
    ...Object.keys(gear),
  ]) {
    assert.ok(catalog[operation], `catalog missing ${operation}`);
  }
  assert.deepEqual(
    Object.keys(shapeManual).sort(),
    Object.keys(shapeLibrary).sort(),
  );
  assert.deepEqual(Object.keys(gearManual).sort(), Object.keys(gear).sort());
  assert.equal(shapeLibrary["shape.slot"], undefined);
  assert.equal(Object.keys(shapeLibrary).length, 5);
  assert.equal(Object.keys(gear).length, 2);
});

test("every GM10/GM11 example validates and registers exactly one non-Node Python handler", () => {
  for (const [operation, entry] of Object.entries({
    ...shapeLibrary,
    ...gear,
  })) {
    assert.equal(entry.readOnly, false || operation === "gear.pair-check");
    validateCad(operation, entry.example);
    const result = validateBatch(
      {
        runId: "gm10-11",
        operations: [{ id: "s", operation, data: entry.example }],
      },
      catalog,
    );
    assert.equal(result.success, true, JSON.stringify(result.errors));
  }
  assert.equal(catalog["gear.pair-check"]!.readOnly, true);
  assert.equal(catalog["gear.pair-check"]!.envelope, true);
});

test("GM10/GM11 Python recipes reproduce offline", () => {
  for (const file of ["tests/shapes_gm10_test.py", "tests/gear_test.py"]) {
    const result = spawnSync("python3", ["-B", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

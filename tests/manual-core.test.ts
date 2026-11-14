import { createRequire } from "node:module";
import { record } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(testRoot + "/tests/manual-core.test.js");
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
const manual = runtimeRequire("../src/manual/core.json") as Record<
  string,
  import("../src/composition/library-help-manual").CommandManual
>;
const catalog = runtimeRequire("../src/catalog/core.json") as Record<
  string,
  import("@fmcad/core").OperationDeclaration
>;
const { validateCad } = runtimeRequire(
  "../src/cad",
) as typeof import("../src/composition/cad-execution");
const { resolveReferences } = runtimeRequire(
  "../src/batch",
) as typeof import("../src/composition/batch");

test("core manual covers every operation and examples pass existing outer validator", () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  for (const [operation, entry] of Object.entries(manual)) {
    for (const section of entry.sections)
      assert.ok(section.title && section.text, operation);
    assert.ok(present(entry.examples).length, operation);
    for (const example of present(entry.examples)) {
      assert.ok(example.label && example.requires && example.output, operation);
      validateCad(operation, record(example.data));
      assert.doesNotMatch(
        JSON.stringify(record(example.data)),
        /TOKEN_FROM|token-placeholder|\"token\":/,
      );
    }
    for (const key of ["sources", "verified", "tests", "gaps", "bugs"] as const)
      assert.ok(Array.isArray(entry.audit[key]), operation);
  }
});

test("core documented result paths resolve through real batch reference helper", () => {
  const ref = { kind: "body", name: "BodyA", token: "offline-fixture-only" };
  const results = {
    bodies: { result: { entities: [ref] } },
    mount: { result: { ref } },
    selected: { result: { selections: [{ entity: ref }] } },
  };
  for (const reference of [
    "bodies.result.entities.0",
    "mount.result.ref",
    "selected.result.selections.0.entity",
  ]) {
    assert.deepEqual(resolveReferences({ ref: { $ref: reference } }, results), {
      ref,
    });
  }
  assert.throws(
    () =>
      resolveReferences(
        { ref: { $ref: "bodies.result.entities.0.ref" } },
        results,
      ),
    /Unresolved/,
  );
});

test("all core manual examples execute actual handlers using offline fixtures, not Fusion", () => {
  const out = spawnSync(
    "python3",
    ["-B", path.join(testRoot + "/tests", "manual_core_test.py")],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stdout + out.stderr);
});

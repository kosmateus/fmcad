import { createRequire } from "node:module";
import { at, record, list, text } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(
  testRoot + "/tests/manual-measure.test.js",
);
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
const manual = runtimeRequire("../src/manual/measure.json") as Record<
  string,
  import("../src/composition/library-help-manual").CommandManual
>;
const catalog = runtimeRequire("../src/catalog/measure.json") as Record<
  string,
  import("@fmcad/core").OperationDeclaration
>;
const { validateCad } = runtimeRequire(
  "../src/cad",
) as typeof import("../src/composition/cad-execution");
const { resolveReferences } = runtimeRequire(
  "../src/batch",
) as typeof import("../src/composition/batch");
const { failedOutcome } = runtimeRequire(
  "../src/outcome",
) as typeof import("@fmcad/core");

test("measure manual covers every operation and all examples pass existing outer validator", () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  for (const [operation, entry] of Object.entries(manual)) {
    assert.ok(
      entry.sections.some((section) =>
        section.title.endsWith("Return Contract"),
      ),
      operation,
    );
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
      for (const raw of list(
        record(example.data)["checks"] ||
          (operation === "check" ? [record(example.data)] : []),
      )) {
        const check = record(raw);
        validateCad("check", check);
        validateCad(
          text(at(check, "measurement", "operation")),
          record(at(check, "measurement", "data")),
        );
      }
    }
    for (const key of ["sources", "verified", "tests", "gaps", "bugs"] as const)
      assert.ok(Array.isArray(entry.audit[key]), operation);
    assert.equal(entry.audit.gaps.length, 0, operation);
  }
});

test("measure snapshot and selected-geometry wiring uses actual result nesting", () => {
  const snapshot = {
    schema: "fmcad.measure.snapshot.v1",
    document: { name: "Offline" },
  };
  const face = { kind: "face", token: "offline-fixture-only" };
  const results = { baseline: { result: snapshot }, face: { result: face } };
  assert.deepEqual(
    resolveReferences({ before: { $ref: "baseline.result" } }, results),
    { before: snapshot },
  );
  assert.deepEqual(
    resolveReferences(
      {
        measurement: {
          operation: "measure.diameter",
          data: { ref: { $ref: "face.result" } },
        },
      },
      results,
    ),
    { measurement: { operation: "measure.diameter", data: { ref: face } } },
  );
});

test("failed report and sampled motion evidence make legacy success envelopes fail", () => {
  for (const [operation, result] of [
    [
      "report",
      { checkOutcome: "fail", status: { acceptance: "notEvaluated" } },
    ],
    ["assembly.motion_check", { sampledPassed: false }],
  ]) {
    assert.equal(failedOutcome({ success: true, operation, result }), true);
  }
});

test("all measure manual examples execute actual handlers using offline fixtures, not Fusion", () => {
  const out = spawnSync(
    "python3",
    ["-B", path.join(testRoot + "/tests", "manual_measure_test.py")],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stdout + out.stderr);
});

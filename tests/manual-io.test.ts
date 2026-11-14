import { createRequire } from "node:module";
import { record, text } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(testRoot + "/tests/manual-io.test.js");
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
const { validateCad } = runtimeRequire(
  "../src/cad",
) as typeof import("../src/composition/cad-execution");
const { validateBatch } = runtimeRequire(
  "../src/batch",
) as typeof import("../src/composition/batch");
const catalog = runtimeRequire("../src/catalog/io.json") as Record<
  string,
  import("@fmcad/core").OperationDeclaration
>;
const manual = runtimeRequire("../src/manual/io.json") as Record<
  string,
  import("../src/composition/library-help-manual").CommandManual
>;
const { parseCadInput } = runtimeRequire(
  "../src/cad-input",
) as typeof import("../src/composition/library-cad-input");
const { detail } = runtimeRequire(
  "../src/help",
) as typeof import("../src/composition/library-help");

test("mesh tolerance accepts direct CLI and JSON payloads and appears in help", () => {
  const data = {
    path: "C:/cad-output/part.stl",
    units: "mm",
    surfaceDeviation: "0.005 mm",
  };
  const direct = parseCadInput(
    ["--path", data.path, "--units", "mm", "--surface-deviation", "0.005 mm"],
    present(catalog["export.mesh"]).inputs,
  );
  assert.deepEqual(direct.data, data);
  assert.deepEqual(
    parseCadInput(
      ["--data", JSON.stringify(data)],
      present(catalog["export.mesh"]).inputs,
    ).data,
    data,
  );
  assert.doesNotThrow(() => validateCad("export.mesh", data));
  assert.throws(() => validateCad("export.step", data), /Unknown CAD inputs/);
  assert.throws(
    () =>
      parseCadInput(
        ["--surface-deviation", "0.005 mm"],
        present(catalog["export.parts"]).inputs,
      ),
    /Unknown CAD option/,
  );
  assert.match(detail("export", "mesh"), /--surface-deviation/);
  assert.match(detail("export", "mesh"), /surfaceDeviationCm/);
});

test("io manual covers every exact operation with audited contracts", () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  assert.equal(Object.keys(manual).length, 28);
  for (const [operation, entry] of Object.entries(manual)) {
    assert.ok(
      entry.sections.some((section) => section.title === "Return Contract"),
      operation,
    );
    for (const section of entry.sections) {
      assert.equal(typeof section.title, "string");
      assert.equal(typeof section.text, "string");
      assert.ok(section.text.length > 0);
    }
    assert.ok(
      entry.audit.sources.some((source) =>
        source.startsWith("assets/cad/io.py:"),
      ),
    );
    for (const key of [
      "sources",
      "verified",
      "tests",
      "gaps",
      "bugs",
    ] as const) {
      assert.ok(Array.isArray(entry.audit[key]));
    }
    assert.deepEqual(entry.audit.gaps, []);
    assert.ok(present(entry.examples).length > 0);
  }
});

test("all io examples pass existing outer validators and ordered reference syntax", () => {
  // Handler fixtures in manual_io_test.py resolve and execute these nested inputs.
  for (const [operation, entry] of Object.entries(manual)) {
    for (const example of present(entry.examples)) {
      assert.equal(typeof example.label, "string");
      assert.ok(example.requires.length > 0);
      assert.ok(example.output.length > 0);
      assert.doesNotThrow(
        () => validateCad(operation, record(example.data)),
        operation,
      );
      const refs = new Set<string>();
      function visit(value: unknown) {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        const ref = record(value)["$ref"];
        if (ref) refs.add(text(text(ref).split(".")[0]));
        Object.values(value).forEach(visit);
      }
      visit(record(example.data));
      const operations = [...refs].map((id) => ({
        id,
        operation: "camera.save",
        data: {},
      }));
      operations.push({ id: "example", operation, data: record(example.data) });
      const result = validateBatch({ runId: "manual-io", operations }, catalog);
      assert.equal(
        result.success,
        true,
        `${operation}: ${result.errors.join(", ")}`,
      );
    }
  }
});

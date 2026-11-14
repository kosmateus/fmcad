import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  ModelingApi,
  Descriptor,
  AuditedManual,
} from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/explode.test.ts"));
import fs from "node:fs";
const { validateCad, buildCadScript } = load("../src/cad") as ModelingApi;

const catalog = load("../src/catalog/explode.json") as Record<
  string,
  Descriptor
>;
const manual = load("../src/manual/explode.json") as Record<
  string,
  AuditedManual
>;

test("GM36 explode catalog and manual cover the same operations with audited contracts", () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  for (const [operation, entry] of Object.entries(catalog)) {
    assert.equal(typeof entry.summary, "string", operation);
    assert.ok(Array.isArray(entry.required), operation);
    assert.ok(entry.example && typeof entry.example === "object", operation);
    assert.equal(typeof entry.readOnly, "boolean", operation);
    assert.equal(entry.envelope, true, operation);
    assert.ok(Array.isArray(entry.limitations), operation);
    const m = manual[operation];
    assert.ok(m, `Unfinished command: ${operation}`);
    assert.ok(
      m.sections.some((s) => /Return Contract/i.test(s.title)),
      operation,
    );
    assert.ok(m.audit.sources.length, operation);
    assert.ok(m.audit.verified.length, operation);
    assert.ok(m.audit.tests.length, operation);
    assert.deepEqual(m.audit.gaps, [], operation);
    assert.ok(m.examples.length, operation);
    for (const example of m.examples) {
      assert.equal(typeof example.label, "string");
      assert.ok(example.requires.length > 0, operation);
      assert.ok(example.output.length > 0, operation);
      assert.doesNotThrow(
        () => validateCad(operation, example.data),
        `${operation}: ${example.label}`,
      );
    }
  }
});

test("GM36 explode handlers bundle into the CAD script", () => {
  const script = buildCadScript(
    "explode.plan",
    catalog["explode.plan"]!.example,
    { doc: "GM36" },
  );
  assert.ok(script.includes("def explode_plan"));
  assert.ok(script.includes("def explode_render"));
  assert.ok(script.includes("'explode.plan': explode_plan"));
  assert.ok(script.includes("'explode.render': explode_render"));
});

test("GM36 explode test evidence files exist", () => {
  const seen = new Set();
  for (const entry of Object.values(manual)) {
    for (const evidence of entry.audit.tests) {
      const file = evidence.split(/[: ]/)[0];
      assert.ok(file);
      seen.add(file);
      assert.ok(fs.existsSync(file), `missing test evidence ${file}`);
    }
  }
});

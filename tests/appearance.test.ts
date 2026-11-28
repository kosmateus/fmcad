import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  ModelingApi,
  Descriptor,
  AuditedManual,
} from "./modeling-unit-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/appearance.test.ts"),
);
import fs from "node:fs";
const { validateCad } = load("../src/cad") as ModelingApi;

const GROUPS: [
  string,
  Record<string, Descriptor>,
  Record<string, AuditedManual>,
][] = [
  [
    "appearance",
    load("../src/catalog/appearance.json"),
    load("../src/manual/appearance.json"),
  ],
  [
    "texture",
    load("../src/catalog/texture.json"),
    load("../src/manual/texture.json"),
  ],
  [
    "attributes",
    load("../src/catalog/attributes.json"),
    load("../src/manual/attributes.json"),
  ],
];

test("GM29 catalog and manual cover the same operations with audited contracts", () => {
  for (const [name, catalog, manual] of GROUPS) {
    assert.deepEqual(
      Object.keys(manual).sort(),
      Object.keys(catalog).sort(),
      name,
    );
    for (const [operation, entry] of Object.entries(catalog)) {
      assert.equal(typeof entry.summary, "string", operation);
      assert.ok(Array.isArray(entry.required), operation);
      assert.ok(entry.example && typeof entry.example === "object", operation);
      assert.equal(typeof entry.readOnly, "boolean", operation);
      assert.ok(Array.isArray(entry.limitations), operation);
      const m = manual[operation];
      assert.ok(m, `Unfinished command: ${operation}`);
      assert.ok(
        m.sections.some((s) => /Return Contract/i.test(s.title)),
        operation,
      );
      for (const section of m.sections) {
        assert.equal(typeof section.title, "string");
        assert.equal(typeof section.text, "string");
        assert.ok(section.text.length > 0);
      }
      assert.ok(m.audit.sources.length, operation);
      assert.ok(m.audit.verified.length, operation);
      assert.ok(m.audit.tests.length, operation);
      assert.ok(Array.isArray(m.audit.gaps), operation);
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
  }
});

test("GM29 test evidence files exist", () => {
  const seen = new Set();
  for (const [, , manual] of GROUPS) {
    for (const entry of Object.values(manual)) {
      for (const evidence of entry.audit.tests) {
        const file = evidence.split(/[: ]/)[0];
        assert.ok(file);
        seen.add(file);
        assert.ok(fs.existsSync(file), `missing test evidence ${file}`);
      }
    }
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { Descriptor } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/measure.test.ts"));
const { spawnSync } = load(
  "node:child_process",
) as typeof import("node:child_process");
import fs from "node:fs";

const catalog = load("../src/catalog/measure.json") as Record<
  string,
  Descriptor
>;

test("measurement catalog documents every input and read-only boundary", () => {
  assert.equal(Object.keys(catalog).length, 28);
  for (const [key, entry] of Object.entries(catalog).filter(
    ([, entry]) => !entry.internalOnly,
  )) {
    assert.ok(entry.summary, key);
    assert.ok(Array.isArray(entry.required), key);
    assert.ok(entry.limitations.length, key);
    assert.equal(entry.readOnly, key !== "parameter.test", key);
    for (const input of entry.required) {
      assert.ok(
        Object.hasOwn(entry.example, input),
        `${key}: missing example input ${input}`,
      );
      assert.ok(entry.inputs[input], `${key}: undocumented input ${input}`);
    }
    for (const input of Object.keys(entry.example))
      assert.ok(entry.inputs[input], `${key}: ${input}`);
  }
});

test("measurement Python compiles in actual core/model bundle order without writing pyc", () => {
  const base = path.join(process.cwd(), "assets/cad");
  const source = ["core.py", "measure.py", "model.py"]
    .map((name) => fs.readFileSync(path.join(base, name), "utf8"))
    .join("\n");
  const result = spawnSync(
    "python3",
    ["-B", "-c", 'import sys; compile(sys.stdin.read(), "cad-bundle", "exec")'],
    { input: source, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("measurement offline mathematical and failure-restoration stubs pass (not kernel verification)", () => {
  const result = spawnSync(
    "python3",
    ["-B", path.join(process.cwd(), "tests/measure_test.py")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

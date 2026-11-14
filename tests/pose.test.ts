import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/pose.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const readOnly: Record<string, boolean> = { "pose.list": true };
const operations = [
  "pose.save",
  "pose.apply",
  "pose.list",
  "pose.delete",
  "pose.evaluate",
];

test("GM18 pose operations are catalog reachable with schemaVersion 1 and frame component", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, readOnly[operation] === true, operation);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM18 rejects unknown top-level inputs before SDK dispatch", async () => {
  let dispatches = 0;
  const client = {
    callTool: async () => {
      dispatches++;
      throw new Error("invalid input reached SDK dispatch");
    },
  };
  for (const operation of operations) {
    const data = { ...catalog[operation]!.example, bogus: 1 };
    assert.throws(() => validateCad(operation, data), /Unknown CAD inputs/);
    await assert.rejects(
      () =>
        executeCad(client, operation, data, {
          doc: "negative-input",
          docId: "owned-creation",
          docFileId: "owned-file",
        }),
      /Unknown CAD inputs/,
    );
  }
  assert.equal(dispatches, 0);
});

test("GM18 native handoff bundles the pose module", () => {
  const script = buildCadScript("pose.save", catalog["pose.save"]!.example, {
    doc: "GM18",
  });
  assert.ok(script.includes("_POSE_SCHEMA"));
  assert.ok(script.includes("'pose.save': pose_save"));
});

test("GM18 Python recipes reproduce offline", () => {
  const { spawnSync } = load(
    "node:child_process",
  ) as typeof import("node:child_process");
  const result = spawnSync("python3", ["-B", "tests/pose_test.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

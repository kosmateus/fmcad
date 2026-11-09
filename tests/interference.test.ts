import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/interference.test.ts"),
);
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = ["clearance.grid", "motion.envelope"];

test("GM19 interference operations are catalog reachable with schemaVersion 1 and frame component", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, operation !== "clearance.grid");
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM19 rejects unknown top-level inputs before SDK dispatch", async () => {
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

test("GM19 native handoff bundles the interference module", () => {
  const script = buildCadScript(
    "clearance.grid",
    catalog["clearance.grid"]!.example,
    { doc: "GM19" },
  );
  assert.ok(script.includes("def _grid_pairs"));
  assert.ok(script.includes("'clearance.grid': clearance_grid"));
  assert.ok(script.includes("'motion.envelope': motion_envelope"));
});

test("GM19 Python recipes reproduce offline", () => {
  const { spawnSync } = load(
    "node:child_process",
  ) as typeof import("node:child_process");
  const result = spawnSync("python3", ["-B", "tests/interference_test.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/seal.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = [
  "shape.o_ring",
  "seal.gland",
  "seal.profile",
  "seal.evaluate",
  "dock.sequence-check",
];

test("GM15 seal operations are catalog reachable with schemaVersion 1 and frame component", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, operation !== "shape.o_ring");
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM15 rejects invalid seal payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["shape.o_ring", { ...catalog["shape.o_ring"]!.example, cs: 5 }],
    ["seal.gland", { ...catalog["seal.gland"]!.example, oRing: "10 mm" }],
    ["seal.profile", { ...catalog["seal.profile"]!.example, layout: "washer" }],
    [
      "seal.evaluate",
      { ...catalog["seal.evaluate"]!.example, gland: "1.6 mm" },
    ],
    [
      "dock.sequence-check",
      { schemaVersion: 1, frame: "component", connect: [] },
    ],
  ];
  let dispatches = 0;
  const client = {
    callTool: async () => {
      dispatches++;
      throw new Error("invalid input reached SDK dispatch");
    },
  };
  for (const [operation, data] of cases) {
    assert.throws(
      () => validateCad(operation, data),
      `${operation}: ${JSON.stringify(data)}`,
    );
    await assert.rejects(() =>
      executeCad(client, operation, data, {
        doc: "negative-input",
        docId: "owned-creation",
        docFileId: "owned-file",
      }),
    );
  }
  assert.equal(dispatches, 0, "all rejected inputs leave the SDK untouched");
});

test("GM15 native handoff bundles the seal module", () => {
  const script = buildCadScript(
    "dock.sequence-check",
    catalog["dock.sequence-check"]!.example,
    { doc: "GM15" },
  );
  assert.ok(script.includes("def _dock_sequence"));
  assert.ok(script.includes("'dock.sequence-check': _dock_sequence"));
});

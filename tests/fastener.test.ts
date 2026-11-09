import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/fastener.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = [
  "mount.create",
  "mount.check",
  "fastener.stack",
  "fastener.check",
  "fastener.schedule",
  "bearing.stack-check",
  "shaft.interface",
  "retention.bayonet",
  "snap.define",
  "snap.evaluate",
  "shape.hose_barb",
];

test("GM16 fastener operations are catalog reachable with schemaVersion 1 and frame component", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM16 rejects invalid fastener payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "mount.create",
      { ...catalog["mount.create"]!.example, scheme: "bolt-circle" },
    ],
    ["mount.check", { ...catalog["mount.check"]!.example, holes: [] }],
    [
      "fastener.stack",
      { ...catalog["fastener.stack"]!.example, screw: { length: "16 mm" } },
    ],
    ["fastener.check", { ...catalog["fastener.check"]!.example, stack: [] }],
    [
      "fastener.schedule",
      { ...catalog["fastener.schedule"]!.example, fasteners: [] },
    ],
    [
      "shaft.interface",
      {
        ...catalog["shaft.interface"]!.example,
        shaft: { type: "hex", d: "6 mm" },
      },
    ],
    [
      "snap.evaluate",
      {
        ...catalog["snap.evaluate"]!.example,
        material: { name: "ABS", modulus: 2.1 },
      },
    ],
    ["shape.hose_barb", { ...catalog["shape.hose_barb"]!.example, barbs: [] }],
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

test("GM16 native handoff bundles the fastener module", () => {
  const script = buildCadScript(
    "snap.evaluate",
    catalog["snap.evaluate"]!.example,
    { doc: "GM16" },
  );
  assert.ok(script.includes("def _snap_evaluate"));
  assert.ok(script.includes("'snap.evaluate': _snap_evaluate"));
});

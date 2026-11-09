import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/manufacturing.test.ts"),
);
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = [
  "measure.draft",
  "measure.wall-map",
  "undercut.check",
  "manufacturing.zone",
  "manufacturing.check",
];

test("GM31 manufacturing operations are catalog reachable with envelope and readOnly", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM31 rejects malformed payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "measure.draft",
      { ...catalog["measure.draft"]!.example, unsupportedReviewFlag: true },
    ],
    [
      "measure.draft",
      { pullDirections: catalog["measure.draft"]!.example["pullDirections"] },
    ],
    ["measure.wall-map", { ...catalog["measure.wall-map"]!.example, bogus: 1 }],
    ["undercut.check", { ...catalog["undercut.check"]!.example, bogus: 1 }],
    [
      "manufacturing.zone",
      { ...catalog["manufacturing.zone"]!.example, bogus: 1 },
    ],
    [
      "manufacturing.check",
      { ...catalog["manufacturing.check"]!.example, bogus: 1 },
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
  assert.equal(dispatches, 0);
});

test("GM31 native handoff bundles the dfm module", () => {
  const script = buildCadScript(
    "measure.draft",
    catalog["measure.draft"]!.example,
    { doc: "GM31" },
  );
  assert.ok(script.includes("def _measure_draft"));
  assert.ok(script.includes("'measure.draft': _measure_draft"));
  assert.ok(script.includes("'undercut.check': _undercut_check"));
  assert.ok(script.includes("'manufacturing.check': _manufacturing_check"));
});

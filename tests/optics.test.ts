import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/optics.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = [
  "optics.frustum",
  "optics.coverage",
  "optics.occlusion",
  "sensor.alignment-check",
];

test("GM28 optics/sensor operations are catalog reachable with envelope and readOnly", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM28 rejects malformed payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "optics.frustum",
      { ...catalog["optics.frustum"]!.example, unsupportedReviewFlag: true },
    ],
    ["optics.frustum", { pupil: catalog["optics.frustum"]!.example["pupil"] }],
    ["optics.coverage", { ...catalog["optics.coverage"]!.example, bogus: 1 }],
    ["optics.occlusion", { ...catalog["optics.occlusion"]!.example, bogus: 1 }],
    [
      "sensor.alignment-check",
      { ...catalog["sensor.alignment-check"]!.example, bogus: 1 },
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

test("GM28 native handoff bundles the optics module", () => {
  const script = buildCadScript(
    "optics.frustum",
    catalog["optics.frustum"]!.example,
    { doc: "GM28" },
  );
  assert.ok(script.includes("def optics_frustum"));
  assert.ok(script.includes("'optics.frustum': optics_frustum"));
  assert.ok(script.includes("'optics.coverage': optics_coverage"));
  assert.ok(script.includes("'optics.occlusion': optics_occlusion"));
  assert.ok(
    script.includes("'sensor.alignment-check': sensor_alignment_check"),
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/cam.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = ["cam.profile", "cam.evaluate", "cam.cycle-check"];

test("GM14 cam operations are catalog reachable with schemaVersion 1 and frame component", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM14 rejects invalid cam payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["cam.profile", { ...catalog["cam.profile"]!.example, rise: "halfCosine" }],
    ["cam.profile", { ...catalog["cam.profile"]!.example, schemaVersion: 2 }],
    [
      "cam.evaluate",
      { ...catalog["cam.evaluate"]!.example, minimumCurvatureRadius: 5 },
    ],
    [
      "cam.evaluate",
      { ...catalog["cam.evaluate"]!.example, maximumPressureAngle: 12 },
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

test("GM14 native handoff bundles the cam module", () => {
  const script = buildCadScript(
    "cam.profile",
    catalog["cam.profile"]!.example,
    { doc: "GM14" },
  );
  assert.ok(script.includes("def _cam_compute"));
  assert.ok(script.includes("'cam.profile': cam_profile"));
});

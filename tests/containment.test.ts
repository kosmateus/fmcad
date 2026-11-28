import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/containment.test.ts"),
);
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = ["measure.contains", "measure.corridor", "measure.region"];

test("GM20 containment operations are catalog reachable with envelope and readOnly", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM20 rejects malformed payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "measure.contains",
      { ...catalog["measure.contains"]!.example, unsupportedReviewFlag: true },
    ],
    [
      "measure.contains",
      { points: catalog["measure.contains"]!.example["points"] },
    ],
    ["measure.corridor", { ...catalog["measure.corridor"]!.example, bogus: 1 }],
    ["measure.region", { ...catalog["measure.region"]!.example, bogus: 1 }],
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

test("GM20 native handoff bundles the containment module", () => {
  const script = buildCadScript(
    "measure.contains",
    catalog["measure.contains"]!.example,
    { doc: "GM20" },
  );
  assert.ok(script.includes("def _region_signed_distance"));
  assert.ok(script.includes("'measure.contains': _measure_contains"));
  assert.ok(script.includes("target.pointContainment(pt)"));
  assert.ok(script.includes("PointInsidePointContainment"));
  assert.ok(!script.includes("manager.pointContainment("));
  assert.ok(!script.includes("PointContainment.InsidePointContainment"));
  assert.ok(script.includes("def _native_face_distance"));
});

test("GM20 canonical containment inventory packages the Fusion adapter implementation", () => {
  const { cadBundleManifest, cadBundleUnits } = load(
    "../packages/node-adapters/dist/python/bundle",
  ) as typeof import("../packages/node-adapters/src/python/bundle");
  const manifest = cadBundleManifest.find((unit) => unit.id === "containment");
  assert.ok(manifest);
  assert.equal(
    manifest.path,
    "runtime/python/fmcad/adapters/fusion/containment.py",
  );
  const unit = cadBundleUnits(process.cwd()).find(
    (candidate) => candidate.id === "containment",
  );
  assert.ok(unit);
  assert.equal(unit.filename, manifest.path);
  assert.ok(unit.source.includes("target.pointContainment(pt)"));
  assert.ok(!unit.source.includes("manager.pointContainment("));
});

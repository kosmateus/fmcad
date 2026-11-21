import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/route3d.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = [
  "route.create3d",
  "route.inspect",
  "route.cut-list",
  "route.motion-states",
];

test("GM25 route operations are catalog reachable with envelope and readOnly", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM25 rejects malformed route payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "route.create3d",
      { ...catalog["route.create3d"]!.example, unsupportedReviewFlag: true },
    ],
    ["route.inspect", { bogus: 1 }],
    ["route.cut-list", { ...catalog["route.cut-list"]!.example, bogus: 1 }],
    ["route.motion-states", { bogus: 1 }],
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

test("GM25 native handoff bundles the route3d module", () => {
  const script = buildCadScript(
    "route.create3d",
    catalog["route.create3d"]!.example,
    { doc: "GM25" },
  );
  assert.ok(script.includes("def _sample_centerline"));
  assert.ok(script.includes("'route.create3d': route_create3d"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/thread.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = [
  "thread.catalog",
  "thread.custom-profile",
  "thread.pair-check",
];

test("GM13 thread operations are catalog reachable with schemaVersion 1 and frame component", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM13 model.thread recipe extension validates and keeps tabular mode", () => {
  assert.ok(validateCad("model.thread", catalog["model.thread"]!.example));
  assert.ok(
    validateCad("model.thread", {
      faces: ["f"],
      internal: false,
      profile: {
        majorDiameter: "10 mm",
        pitch: "1.5 mm",
        starts: 2,
        hand: "right",
      },
    }),
  );
});

test("GM13 rejects invalid thread payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "thread.custom-profile",
      {
        ...catalog["thread.custom-profile"]!.example,
        minorDiameter: "8 mm",
        pitchDiameter: "9 mm",
      },
    ],
    [
      "thread.custom-profile",
      { ...catalog["thread.custom-profile"]!.example, schemaVersion: 2 },
    ],
    [
      "thread.pair-check",
      { ...catalog["thread.pair-check"]!.example, internal: null },
    ],
    [
      "thread.catalog",
      { ...catalog["thread.catalog"]!.example, system: "unified" },
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

test("GM13 native handoff bundles the thread module and preserves native ThreadInfo", () => {
  const script = buildCadScript(
    "thread.custom-profile",
    catalog["thread.custom-profile"]!.example,
    { doc: "GM13" },
  );
  assert.ok(script.includes("def _thread_profile"));
  assert.ok(script.includes("'model.thread'] = thread_feature"));
});

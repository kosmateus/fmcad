import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/fpc-pcb.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = [
  "fpc.fold",
  "fpc.flatten",
  "pcb.mechanical-exchange",
  "pcb.check",
  "port.define",
  "connector.mate-check",
  "pack.cross-section",
  "keepout.check",
];

test("GM26 fpc/pcb/connector operations are catalog reachable with envelope and readOnly", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM26 rejects malformed payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "fpc.fold",
      { ...catalog["fpc.fold"]!.example, unsupportedReviewFlag: true },
    ],
    [
      "pcb.mechanical-exchange",
      { ...catalog["pcb.mechanical-exchange"]!.example, bogus: 1 },
    ],
    [
      "connector.mate-check",
      { ...catalog["connector.mate-check"]!.example, bogus: 1 },
    ],
    [
      "pack.cross-section",
      { ...catalog["pack.cross-section"]!.example, bogus: 1 },
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

test("GM26 native handoff bundles the fpc_pcb module", () => {
  const script = buildCadScript("fpc.fold", catalog["fpc.fold"]!.example, {
    doc: "GM26",
  });
  assert.ok(script.includes("def _fold_walk"));
  assert.ok(script.includes("'fpc.fold': fpc_fold"));
});

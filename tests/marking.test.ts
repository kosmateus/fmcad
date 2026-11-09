import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/marking.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = ["marking.create", "marking.check"];

test("GM34 marking operations are catalog reachable with envelope and readOnly", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM34 rejects malformed payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "marking.create",
      { ...catalog["marking.create"]!.example, unsupportedReviewFlag: true },
    ],
    ["marking.create", {}],
    ["marking.check", { ...catalog["marking.check"]!.example, bogus: 1 }],
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

test("GM34 native handoff bundles the marking module", () => {
  const script = buildCadScript(
    "marking.create",
    catalog["marking.create"]!.example,
    { doc: "GM34" },
  );
  assert.ok(script.includes("def _marking_create"));
  assert.ok(script.includes("'marking.create': _marking_create"));
  assert.ok(script.includes("'marking.check': _marking_check"));
});

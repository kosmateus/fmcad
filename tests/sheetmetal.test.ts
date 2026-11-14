import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/sheetmetal.test.ts"),
);
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = ["sheet.bends", "sheet.form", "sheet.flat"];

test("GM32 sheet-metal operations are catalog reachable with envelope and readOnly", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM32 rejects malformed payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "sheet.bends",
      { ...catalog["sheet.bends"]!.example, unsupportedReviewFlag: true },
    ],
    ["sheet.bends", { segments: catalog["sheet.bends"]!.example["segments"] }],
    ["sheet.form", { ...catalog["sheet.form"]!.example, bogus: 1 }],
    ["sheet.flat", { ...catalog["sheet.flat"]!.example, bogus: 1 }],
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

test("GM32 native handoff bundles the sheetmetal module", () => {
  const script = buildCadScript("sheet.form", catalog["sheet.form"]!.example, {
    doc: "GM32",
  });
  assert.ok(script.includes("def _sheet_form"));
  assert.ok(script.includes("'sheet.form': _sheet_form"));
  assert.ok(script.includes("'sheet.flat': _sheet_flat"));
});

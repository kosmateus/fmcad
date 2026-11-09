import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/checking.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = [
  "check.set",
  "evidence.package",
  "evidence.check",
  "deliver",
];

test("GM37 check/evidence operations are catalog reachable with envelope and readOnly", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM37 rejects malformed payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "check.set",
      { ...catalog["check.set"]!.example, unsupportedReviewFlag: true },
    ],
    ["check.set", {}],
    ["evidence.package", { ...catalog["evidence.package"]!.example, bogus: 1 }],
    ["evidence.check", { ...catalog["evidence.check"]!.example, bogus: 1 }],
    ["deliver", { ...catalog["deliver"]!.example, bogus: 1 }],
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

test("GM37 native handoff bundles the checking module without re-registering check/report", () => {
  const script = buildCadScript("check.set", catalog["check.set"]!.example, {
    doc: "GM37",
  });
  assert.ok(script.includes("def _check_set"));
  assert.ok(script.includes("'check.set': _check_set"));
  assert.ok(script.includes("'deliver': _deliver"));
  assert.ok(script.includes("'evidence.check': _evidence_check"));
});

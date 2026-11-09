import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/sequence.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = [
  "assembly.sequence",
  "service.path-check",
  "tool.access",
  "fixture.access",
];

test("GM27 sequence/service/tool/fixture operations are catalog reachable with envelope and readOnly", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM27 rejects malformed payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "assembly.sequence",
      { ...catalog["assembly.sequence"]!.example, unsupportedReviewFlag: true },
    ],
    ["assembly.sequence", {}],
    [
      "service.path-check",
      { ...catalog["service.path-check"]!.example, bogus: 1 },
    ],
    ["tool.access", { ...catalog["tool.access"]!.example, bogus: 1 }],
    ["fixture.access", { ...catalog["fixture.access"]!.example, bogus: 1 }],
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

test("GM27 native handoff bundles the sequence module", () => {
  const script = buildCadScript(
    "assembly.sequence",
    catalog["assembly.sequence"]!.example,
    { doc: "GM27" },
  );
  assert.ok(script.includes("def assembly_sequence"));
  assert.ok(script.includes("'assembly.sequence': assembly_sequence"));
  assert.ok(script.includes("'service.path-check': service_path_check"));
  assert.ok(script.includes("'tool.access': tool_access"));
  assert.ok(script.includes("'fixture.access': fixture_access"));
});

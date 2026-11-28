import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/sequence.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;
const { prepareCadScript } = load("../src/cad") as Pick<
  typeof import("../src/composition/cad-execution"),
  "prepareCadScript"
>;
const { createPythonChecker } = load(
  "../src/python",
) as typeof import("../packages/node-adapters/src/python/checker");

const operations = [
  "assembly.sequence",
  "service.path-check",
  "tool.access",
  "fixture.access",
] as const;
type Gm27Operation = (typeof operations)[number];
const handlers: Record<Gm27Operation, string> = {
  "assembly.sequence": "assembly_sequence",
  "service.path-check": "service_path_check",
  "tool.access": "tool_access",
  "fixture.access": "fixture_access",
};
const runtime = path.resolve("dist/runtime/python");
const checker = createPythonChecker({
  typingRoot: path.join(runtime, "typing"),
  definitionsRoot: path.join(runtime, "typing"),
  pythonPlatform: "Windows",
});

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

function assertSelectedHandler(script: string, selected: Gm27Operation) {
  const handler = handlers[selected];
  assert.ok(
    script.includes(`def ${handler}(`),
    `${selected} handler definition`,
  );
  assert.ok(
    script.includes(`'${selected}': ${handler}`),
    `${selected} handler registration`,
  );
  assert.deepEqual(
    operations.filter((operation) =>
      script.includes(`'${operation}': ${handlers[operation]}`),
    ),
    [selected],
    `${selected} should not restore sibling GM27 registrations`,
  );
  for (const operation of operations) {
    if (operation === selected) continue;
    assert.ok(
      !script.includes(`def ${handlers[operation]}(`),
      `${selected} handoff retained ${operation} handler`,
    );
  }
}

async function buildAndCheck(operation: Gm27Operation) {
  const data = catalog[operation]!.example;
  const context = { doc: "GM27" };
  const script = buildCadScript(operation, data, context);
  const artifact = prepareCadScript(operation, data, context);
  assert.equal(artifact.script, script);
  assertSelectedHandler(script, operation);

  const report = await checker.check({
    artifact,
    context: { kind: "cad-v1" },
  });
  assert.equal(
    report.status,
    "passed",
    `${operation}: ${JSON.stringify(report.diagnostics)}`,
  );
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.provenance.artifactHash, artifact.artifactHash);
  assert.equal(report.provenance.wireHash, artifact.sha256);
  return artifact;
}

test("GM27 assembly.sequence handoff selects its handler and dependencies", async () => {
  const artifact = await buildAndCheck("assembly.sequence");
  const ids = new Set(artifact.units.map((unit) => unit.id));
  for (const dependency of [
    "sequence-domain",
    "sequence-application",
    "sequence-fusion",
  ])
    assert.ok(ids.has(dependency), `assembly.sequence omitted ${dependency}`);

  const application = artifact.units.find(
    (unit) => unit.id === "sequence-application",
  );
  assert.ok(application);
  assert.match(application.source, /^def _sequence_plan\(/m);
});

for (const operation of operations.slice(1))
  test(`GM27 ${operation} handoff selects its handler and passes the real checker`, async () => {
    await buildAndCheck(operation);
  });

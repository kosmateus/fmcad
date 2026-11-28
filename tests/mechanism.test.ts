import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/mechanism.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;

const operations = [
  "mechanism.couple",
  "mechanism.inspect",
  "mechanism.stop-check",
];

test("GM17 mechanism operations are catalog reachable with schemaVersion 1 and frame component", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, true);
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM17 rejects unknown top-level inputs before SDK dispatch", async () => {
  let dispatches = 0;
  const client = {
    callTool: async () => {
      dispatches++;
      throw new Error("invalid input reached SDK dispatch");
    },
  };
  for (const operation of operations) {
    const data = { ...catalog[operation]!.example, bogus: 1 };
    assert.throws(() => validateCad(operation, data), /Unknown CAD inputs/);
    await assert.rejects(
      () =>
        executeCad(client, operation, data, {
          doc: "negative-input",
          docId: "owned-creation",
          docFileId: "owned-file",
        }),
      /Unknown CAD inputs/,
    );
  }
  assert.equal(dispatches, 0);
});

test("GM17 native handoff bundles the mechanism module", () => {
  const script = buildCadScript(
    "mechanism.couple",
    catalog["mechanism.couple"]!.example,
    { doc: "GM17" },
  );
  assert.ok(script.includes("def _mechanism_coupling"));
  assert.ok(script.includes("'mechanism.couple': mechanism_couple"));
});

test("native MotionLink creation has a pinned mutating typed contract", () => {
  const { contracts, mcpTools, mcpInvocation, validateInvocation } = load(
    "../src/catalog",
  ) as typeof import("../src/composition/library-catalog-registry");
  const operation = "mechanism.motion-link.create";
  const data = {
    schemaVersion: 1,
    frame: "component",
    confirm: true,
    jointOne: { kind: "joint", name: "Driver" },
    jointTwo: { kind: "joint", name: "Follower" },
    valueOne: "1 rad",
    valueTwo: "2 rad",
    isReversed: false,
  };
  const tool = mcpTools.find(
    (item) => item._meta.fmcad.operation === operation,
  );
  assert.ok(tool);
  assert.equal(tool.name, "fmcad_cad_mechanism_motion_link_create");
  assert.equal(contracts[operation]!.readOnlyRequested, false);
  assert.equal(contracts[operation]!.declaration.documentPin, true);
  assert.equal(contracts[operation]!.declaration["batchAllowed"], false);
  const invocation = {
    version: 1,
    kind: "cad",
    operation,
    doc: "Scratch",
    docId: "drive-scratch",
    data,
  };
  assert.deepEqual(validateInvocation(invocation), invocation);
  assert.deepEqual(
    mcpInvocation(tool.name, { doc: "Scratch", docId: "drive-scratch", data })
      .invocation.data,
    data,
  );
  for (const invalid of [
    { ...data, confirm: false },
    { ...data, isReversed: "false" },
    { ...data, unknown: true },
  ])
    assert.throws(() => validateInvocation({ ...invocation, data: invalid }));
  assert.throws(() => validateInvocation({ ...invocation, docId: undefined }));
});

test("GM17 Python recipes reproduce offline", () => {
  const { spawnSync } = load(
    "node:child_process",
  ) as typeof import("node:child_process");
  const result = spawnSync("python3", ["-B", "tests/mechanism_test.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

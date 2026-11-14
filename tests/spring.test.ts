import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(path.join(process.cwd(), "tests/spring.test.ts"));
const { validateCad, executeCad, buildCadScript, catalog } = load(
  "../src/cad",
) as ModelingApi;
const { contracts, localInvocation } = load("../src/catalog") as {
  contracts: (typeof import("../src/composition/library-catalog-registry"))["contracts"];
  localInvocation(input: {
    operation: string;
    data: Record<string, unknown>;
    preview: boolean;
  }): boolean;
};

const operations = [
  "curve.helix",
  "shape.spring",
  "spring.evaluate",
  "spring.configure",
];

test("GM12 spring operations are catalog reachable with schemaVersion 1 and frame component", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.envelope, true);
    assert.equal(entry.readOnly, operation.startsWith("spring."));
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM12 recipe and engineering operations require Fusion Python, not a local/offline result", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    const contract = contracts[operation];
    assert.ok(entry, operation);
    assert.ok(contract, operation);
    assert.equal(contract.service.kind, "python", operation);
    assert.equal(contract.requirements.sdk, "required", operation);
    assert.equal(contract.requirements.document, true, operation);
    assert.equal(
      localInvocation({ operation, data: entry.example, preview: false }),
      false,
      operation,
    );
  }
});

test("GM12 shape.helix generation example validates", () => {
  assert.ok(validateCad("shape.helix", catalog["shape.helix"]!.example));
});

test("GM12 rejects contradictory helix and spring payloads before SDK dispatch", async () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "curve.helix",
      { ...catalog["curve.helix"]!.example, pitch: "5 mm", height: "46 mm" },
    ],
    ["curve.helix", { ...catalog["curve.helix"]!.example, schemaVersion: 2 }],
    ["curve.helix", { schemaVersion: 1, frame: "component", radius: "4 mm" }],
    [
      "spring.evaluate",
      {
        ...catalog["spring.evaluate"]!.example,
        compressedLength: "17 mm",
        deflection: "18 mm",
      },
    ],
    [
      "spring.evaluate",
      { ...catalog["spring.evaluate"]!.example, activeCoils: "six" },
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

test("GM12 blocked native helix lifts the envelope and fails", async () => {
  const client = {
    callTool: async () => ({
      text:
        "FMCAD_RESULT " +
        JSON.stringify({
          success: true,
          operation: "curve.helix",
          result: {
            schemaVersion: 1,
            status: "blocked",
            warnings: ["native path unavailable"],
          },
        }),
    }),
  };
  const out = await executeCad(
    client,
    "curve.helix",
    catalog["curve.helix"]!.example,
    { doc: "GM12" },
  );
  assert.equal(out.success, false);
  assert.equal(out.status, "blocked");
});

test("GM12 native handoff bundles the spring module", () => {
  const script = buildCadScript(
    "spring.evaluate",
    catalog["spring.evaluate"]!.example,
    { doc: "GM12" },
  );
  assert.ok(script.includes("def _helix_parameters"));
  assert.ok(script.includes("'spring.evaluate': spring_evaluate"));
});

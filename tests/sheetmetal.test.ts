import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  CadContext,
  CadData,
} from "../packages/core/src/application/cad/contracts";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact";
import type { ModelingApi } from "./modeling-unit-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/sheetmetal.test.ts"),
);
interface SheetmetalApi extends ModelingApi {
  prepareCadScript(
    operation: string,
    data: CadData,
    context: CadContext,
  ): PreparedPythonArtifact;
}
const { validateCad, executeCad, prepareCadScript, catalog } = load(
  "../src/cad",
) as SheetmetalApi;
const { createPythonChecker } = load(
  "../dist/src/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { verifyPythonArtifact } = load(
  "../dist/src/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");

const operations = ["sheet.bends", "sheet.form", "sheet.flat"] as const;
type SheetmetalOperation = (typeof operations)[number];
const expectedHandlers: Record<
  SheetmetalOperation,
  readonly (readonly [string, string])[]
> = {
  "sheet.bends": [["sheet.bends", "_sheet_bends"]],
  "sheet.form": [
    ["sheet.bends", "_sheet_bends"],
    ["sheet.form", "_sheet_form"],
  ],
  "sheet.flat": [
    ["sheet.bends", "_sheet_bends"],
    ["sheet.flat", "_sheet_flat"],
  ],
};

function selectedSheetHandlers(source: string): [string, string][] {
  const registry = source.match(/CAD_HANDLERS\.update\(\{([\s\S]*?)\}\)/);
  assert.ok(registry, "sheetmetal source has a handler registry");
  return [
    ...registry[1]!.matchAll(
      /['"](sheet\.(?:bends|form|flat))['"]\s*:\s*(_sheet_(?:bends|form|flat))/g,
    ),
  ]
    .map((match): [string, string] => [match[1]!, match[2]!])
    .sort(([left], [right]) => left!.localeCompare(right!));
}

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

test("GM32 native handoffs retain each sheet-metal handler and dependency", async () => {
  const typingRoot = path.resolve("dist/runtime/python/typing");
  const checker = createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonPlatform: "Windows",
  });

  for (const operation of operations) {
    const artifact = prepareCadScript(operation, catalog[operation]!.example, {
      doc: "GM32",
    });
    verifyPythonArtifact(artifact);
    assert.equal(
      (artifact.request as { operation?: unknown }).operation,
      operation,
    );

    const sheetmetal = artifact.units.find(
      (unit) => unit.id === "sheetmetal-fusion",
    );
    assert.ok(sheetmetal, `${operation} selects the sheetmetal adapter`);
    const selected = selectedSheetHandlers(sheetmetal.source);
    assert.deepEqual(selected, expectedHandlers[operation], operation);
    for (const [, handler] of selected)
      assert.match(sheetmetal.source, new RegExp(`^def ${handler}\\(`, "m"));

    if (operation !== "sheet.bends") {
      const domain = artifact.units.find(
        (unit) => unit.id === "sheetmetal-domain",
      );
      assert.ok(domain, `${operation} selects the sheetmetal domain`);
      assert.match(domain.source, /^def _flat_walk\(/m);
      assert.match(domain.source, /^def _formed_walk\(/m);
      assert.ok(sheetmetal.source.includes("ctx.call('sheet.bends'"));
      assert.match(sheetmetal.source, /_flat_walk\(/);
      assert.match(sheetmetal.source, /_formed_walk\(/);
    }

    const report = await checker.check({
      artifact,
      context: { kind: "cad-v1" },
    });
    assert.equal(
      report.status,
      "passed",
      `${operation}: ${JSON.stringify(report.diagnostics.slice(0, 5))}`,
    );
    assert.equal(report.provenance.artifactHash, artifact.artifactHash);
    assert.equal(report.provenance.wireHash, artifact.sha256);
  }
});

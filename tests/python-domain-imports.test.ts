import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import type { SourceInput } from "../packages/node-adapters/src/python/artifact";

const root = path.resolve(process.cwd());
const load = createRequire(path.join(root, "package.json"));
const { cadBundleManifest, cadBundleUnits } = load(
  "./packages/node-adapters/dist/python/bundle",
) as typeof import("../packages/node-adapters/src/python/bundle");
const { preparePythonArtifact, verifyPythonArtifact } = load(
  "./packages/node-adapters/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { mapPythonPosition } = load(
  "./packages/core/dist/domain/python-artifact",
) as typeof import("../packages/core/src/domain/python-artifact");

test("public flattened bundle lowers canonical imports with source and line provenance", () => {
  const fixture = cadBundleManifest.find(
    (unit) => unit.path === "runtime/python/fmcad/domain/animation2.py",
  );
  assert.ok(fixture);
  const units = cadBundleUnits(root);
  const values = units.find((unit) => unit.id === "values");
  const lowered = units.find((unit) => unit.id === fixture.id);
  assert.ok(values);
  assert.ok(lowered);
  assert.ok(units.indexOf(values) < units.indexOf(lowered));

  const original = readFileSync(path.join(root, fixture.path), "utf8");
  const originalHash = createHash("sha256")
    .update(original, "utf8")
    .digest("hex");
  const originalLines = original.split(/\r?\n/);
  const loweredLines = lowered.source.split(/\r?\n/);
  const importLines = originalLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith("from fmcad.domain.values import "));

  assert.ok(importLines.length > 1);
  for (const { line, index } of importLines) {
    assert.equal(
      loweredLines[index],
      line.includes(" as ") ? "_cad_cast = cast" : "pass",
    );
  }
  assert.ok(
    lowered.source.endsWith(
      `# fmcad-domain-imports-v1; original-sha256=${originalHash}\n`,
    ),
  );
  assert.ok(!lowered.source.includes("from fmcad.domain.values import"));

  const dataImport = units.find(
    (unit) => unit.id === "docio-data_import-rules",
  );
  assert.ok(dataImport);
  assert.ok(
    dataImport.source.includes(
      "_di_cad_fields = __fmcad_domain_values__cad_fields",
    ),
  );

  const artifact = preparePythonArtifact([
    values,
    lowered,
    { id: "wrapper", filename: "<wrapper>", source: "pass\n", role: "wrapper" },
  ]);
  verifyPythonArtifact(artifact);
  assert.equal(
    artifact.units.find((unit) => unit.id === lowered.id)?.sha256,
    createHash("sha256").update(lowered.source, "utf8").digest("hex"),
  );
  const domainMap = artifact.sourceMap.find(
    (entry) => entry.unitId === lowered.id,
  );
  assert.ok(domainMap);
  const originalImportLine = importLines[0]!.index + 1;
  assert.deepEqual(
    mapPythonPosition(
      artifact,
      "<fmcad-artifact>",
      domainMap.generatedStartLine +
        originalImportLine -
        domainMap.sourceStartLine,
    ),
    {
      filename: fixture.path,
      line: originalImportLine,
      unitId: fixture.id,
    },
  );
});

test("lowered domain alias executes equivalently in the flattened namespace", () => {
  const fixture = cadBundleManifest.find(
    (unit) => unit.path === "runtime/python/fmcad/domain/animation2.py",
  );
  assert.ok(fixture);
  const units = cadBundleUnits(root);
  const selected = [
    units.find((unit) => unit.id === "values"),
    units.find((unit) => unit.id === fixture.id),
  ];
  assert.ok(selected[0]);
  assert.ok(selected[1]);
  const flattened: SourceInput[] = [selected[0], selected[1]];
  const runner = [
    "import json, sys",
    "units = json.load(sys.stdin)",
    "namespace = {'__name__': 'fmcad.domain.animation2'}",
    "for unit in units:",
    "    exec(compile(unit['source'], unit['filename'], 'exec'), namespace)",
    "print(json.dumps(namespace['_anim2_direction']([0, 3, 4])))",
  ].join("\n");
  const result = spawnSync("python3", ["-I", "-S", "-B", "-c", runner], {
    cwd: root,
    input: JSON.stringify(flattened),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [0, 0.6, 0.8]);
});

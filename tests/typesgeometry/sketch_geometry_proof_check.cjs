// One bounded strict pass for the proof family using the canonical full-source
// map and official helper projection. This is not an admission or native pass.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const {
  cadBundleManifest,
  cadBundleUnits,
} = require("../../packages/node-adapters/dist/python/bundle");
const {
  preparePythonArtifact,
} = require("../../packages/node-adapters/dist/python/artifact");
const {
  sketchGeometryProofBundleManifest,
} = require("../../packages/node-adapters/dist/python/sketch-geometry-proof-manifest");
const {
  runCheckerProcess,
} = require("../../packages/node-adapters/dist/python/checker-process");

const root = path.resolve(__dirname, "../..");
const typingRoot = process.env.FMCAD_TYPING_ROOT;
if (!typingRoot) throw new Error("Set FMCAD_TYPING_ROOT to the approved SDK typing snapshot root");
const checkerProject = path.join(root, "runtime/python/typing/checker-project.py");
const contextStub = path.join(root, "runtime/python/typing/fmcad_context.pyi");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const pointer = JSON.parse(fs.readFileSync(path.join(typingRoot, "current.json"), "utf8"));
assert.equal(pointer.snapshot, "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179");
const snapshot = path.join(typingRoot, "snapshots", pointer.snapshot);
const sdkManifestBytes = fs.readFileSync(path.join(snapshot, "manifest.json"));
assert.equal(hash(sdkManifestBytes), pointer.snapshot);
const sdkManifest = JSON.parse(sdkManifestBytes.toString("utf8"));
for (const [relative, expected] of Object.entries(sdkManifest.files ?? {})) {
  assert.equal(hash(fs.readFileSync(path.join(snapshot, relative))), expected, relative);
}

const proofIds = sketchGeometryProofBundleManifest.map((unit) => unit.id);
const manifest = cadBundleManifest;
assert.ok(sketchGeometryProofBundleManifest.every((unit) =>
  manifest.some((item) => item.id === unit.id),
), "canonical manifest must compose the typed proof family");
const units = cadBundleUnits(root, "full", manifest);
assert.equal(units.length, 152, "canonical proof bundle must add exactly two units to the 150-unit base");
const artifact = preparePythonArtifact(units);
assert.equal(artifact.sourceMap.length, 152, "canonical source map must cover every bundle unit");
const temporaryRoot = fs.mkdtempSync(path.join("/tmp/opencode", "fmcad-sketch-proof-strict-"));

function runHelper(input, cwd) {
  const result = spawnSync("python3", ["-I", "-S", checkerProject], {
    cwd,
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

async function main() {
  try {
    const inventoryRoot = path.join(temporaryRoot, "inventory");
    const analysisRoot = path.join(temporaryRoot, "analysis");
    const stubs = path.join(analysisRoot, "stubs");
    fs.mkdirSync(inventoryRoot);
    fs.mkdirSync(stubs, { recursive: true });
    fs.cpSync(path.join(snapshot, "adsk"), path.join(stubs, "adsk"), { recursive: true });
    fs.copyFileSync(contextStub, path.join(stubs, "fmcad_context.pyi"));
    fs.writeFileSync(
      path.join(stubs, "fmcad_injected.pyi"),
      "import adsk.core\nfrom fmcad_context import Facade\nFMCAD: Facade\n",
    );

    const inventory = runHelper({
      units: [{
        id: "wire",
        filename: "<fmcad-artifact>",
        source: artifact.script,
        context: { kind: "cad-v1", deferredFacade: true },
      }],
    }, inventoryRoot);
    assert.equal(inventory.units.length, 1);
    const insert = inventory.units[0].insert;
    const sourcePath = path.join(temporaryRoot, "wire.py");
    fs.writeFileSync(sourcePath, artifact.script);
    const metadata = artifact.units.map(({ id, filename, role, sha256 }) => ({
      id, filename, role, sha256,
    }));
    const plan = runHelper({
      analysisSourcePath: "wire.py",
      analysisSourceHash: artifact.sha256,
      sourceMap: artifact.sourceMap,
      sourceUnits: metadata,
      projectionUnitIds: proofIds,
    }, temporaryRoot).analysisPlan;
    assert.ok(plan && Array.isArray(plan.groups));
    assert.deepEqual(plan.unitHashes.map((unit) => unit.id), units.map((unit) => unit.id));
    const groups = plan.groups.filter((group) => proofIds.some((id) => group.includes(id)));
    assert.ok(groups.length > 0, "the canonical helper did not schedule proof modules");
    for (const id of proofIds)
      assert.ok(groups.some((group) => group.includes(id)), `proof unit omitted from analysis: ${id}`);

    const roles = Object.fromEntries(units.map((unit) => [unit.id, unit.role]));
    const proofDiagnostics = [];
    const otherDiagnostics = [];
    for (const [groupIndex, selectedUnitIds] of groups.entries()) {
      const groupRoot = path.join(inventoryRoot, `group-${groupIndex}`);
      fs.mkdirSync(groupRoot);
      fs.writeFileSync(path.join(groupRoot, "wire.py"), artifact.script);
      const projectedName = `projected-${groupIndex}.py`;
      runHelper({
        projectionSourcePath: "wire.py",
        projectionOutputPath: projectedName,
        sourceMap: artifact.sourceMap,
        sourceRoles: roles,
        selectedUnitIds,
      }, groupRoot);
      const lines = fs.readFileSync(path.join(groupRoot, projectedName), "utf8").split("\n");
      const prelude = [
        "from typing import TYPE_CHECKING",
        "if TYPE_CHECKING:",
        "    from fmcad_injected import FMCAD",
      ];
      lines.splice(insert, 0, ...prelude);
      const filename = `group-${groupIndex}.py`;
      fs.writeFileSync(path.join(analysisRoot, filename), lines.join("\n"));
      const configPath = path.join(analysisRoot, `pyrightconfig-${groupIndex}.json`);
      fs.writeFileSync(configPath, JSON.stringify({
        include: [filename],
        exclude: ["stubs"],
        stubPath: "stubs",
        extraPaths: [],
        pythonVersion: "3.11",
        pythonPlatform: "Linux",
        typeCheckingMode: "strict",
        useLibraryCodeForTypes: false,
        reportMissingImports: "error",
        reportMissingModuleSource: "error",
        reportMissingTypeStubs: "error",
        reportAny: "error",
        reportExplicitAny: "error",
        enableTypeIgnoreComments: false,
        reportUnusedImport: "none",
        reportUnusedVariable: "none",
        reportUnusedFunction: "none",
      }));
      const engine = require.resolve("basedpyright/index.js");
      const report = await runCheckerProcess(
        process.execPath,
        ["--max-old-space-size=512", engine, "--outputjson", "--pythonpath",
          path.join(analysisRoot, "no-host-python"), "--project", configPath],
        analysisRoot,
        { timeoutMs: 30000, outputBytes: 2 * 1024 * 1024, memoryBytes: 768 * 1024 * 1024 },
      );
      assert.equal(report.problem, null, report.stderr || report.stdout);
      assert.ok(report.code === 0 || report.code === 1, report.stderr);
      const diagnostics = JSON.parse(report.stdout).generalDiagnostics;
      for (const diagnostic of diagnostics) {
        const lineWithPrelude = diagnostic.range.start.line + 1;
        const line = lineWithPrelude > insert ? lineWithPrelude - prelude.length : lineWithPrelude;
        const source = artifact.sourceMap.find((entry) =>
          entry.generatedStartLine <= line && line <= entry.generatedEndLine,
        );
        assert.ok(source, `strict diagnostic escaped the complete prepared source map: ${diagnostic.message}`);
        const unit = units.find((item) => item.id === source.unitId);
        assert.ok(unit, `source map references missing source unit ${source.unitId}`);
        const record = {
          unitId: unit.id,
          filename: unit.filename,
          line: line - source.generatedStartLine + source.sourceStartLine,
          rule: diagnostic.rule,
          message: diagnostic.message,
        };
        if (proofIds.includes(unit.id)) proofDiagnostics.push(record);
        else otherDiagnostics.push(record);
      }
    }
    console.log(JSON.stringify({
      checker: "basedpyright 1.40.2",
      sdkSnapshot: pointer.snapshot,
      artifactHash: artifact.artifactHash,
      wireHash: artifact.sha256,
      preparedUnits: units.length,
      sourceMapEntries: artifact.sourceMap.length,
      analyzedGroups: groups.length,
      proofUnits: proofIds,
      proofDiagnostics: proofDiagnostics.length,
      dependencyDiagnostics: otherDiagnostics.length,
      diagnostics: proofDiagnostics,
    }, null, 2));
    assert.deepEqual(proofDiagnostics, [], "proof modules must have zero strict diagnostics");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

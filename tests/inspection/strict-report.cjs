"use strict";
// Direct strict replay of the exact prepared inspect.pack artifact. This is
// diagnostic/type evidence only; it never admits or dispatches the script.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const load = require("node:module").createRequire(__filename);
const { prepare, repositoryRoot } = require("./prepared-artifact.cjs");
const { stageCheckerDefinitions } = load(
  "../../packages/node-adapters/dist/python/checker-definitions",
);
const { mapPythonPosition } = load(
  "../../packages/core/dist/domain/python-artifact",
);
const { cadBundleUnits } = load(
  "../../packages/node-adapters/dist/python/bundle",
);
const typingRoot = path.join(root, "dist/runtime/python/typing");
const evidenceRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : fs.mkdtempSync(path.join("/tmp/opencode", "fmcad-inspection-strict-"));
const sourceRoot = process.argv[3]
  ? path.resolve(process.argv[3])
  : repositoryRoot;
const replay = path.join(evidenceRoot, "replay");
fs.mkdirSync(replay, { recursive: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");

function verifiedSnapshot() {
  const current = JSON.parse(
    fs.readFileSync(path.join(typingRoot, "current.json"), "utf8"),
  );
  const directory = path.join(typingRoot, "snapshots", current.snapshot);
  const manifestBytes = fs.readFileSync(path.join(directory, "manifest.json"));
  if (hash(manifestBytes) !== current.snapshot)
    throw new Error("Definitions manifest hash mismatch");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  for (const [name, expected] of Object.entries(manifest.files))
    if (hash(fs.readFileSync(path.join(directory, name))) !== expected)
      throw new Error(`Definitions hash mismatch: ${name}`);
  return { current, directory };
}

async function main() {
const { current, directory: snapshot } = verifiedSnapshot();
const reads = Array.from({ length: 20 }, (_, index) => ({
  id: `read-${index}`,
  operation: "entity.list",
  data: { kind: "body" },
}));
const context = {
  doc: "InspectionScratch",
  docId: "creation-123",
  docFileId: "file-123",
};
  const { artifact } = prepare(
    "inspect.pack",
    { reads, maxBytes: 65536 },
    context,
    sourceRoot,
  );
  const expectedUnits = cadBundleUnits(sourceRoot, "full");
  const actualRuntime = artifact.units.filter(
    (unit) => unit.role === "runtime",
  );
  const actualIds = actualRuntime.map((unit) => unit.id);
  if (
    actualRuntime.length !== expectedUnits.length ||
    actualRuntime.some(
      (unit, index) =>
        unit.id !== expectedUnits[index].id ||
        unit.filename !== expectedUnits[index].filename ||
        unit.source !== expectedUnits[index].source,
    )
  )
    throw new Error(
      "Prepared artifact runtime inventory differs from the complete bundle manifest",
    );
  if (
    artifact.units.filter((unit) => unit.role === "wrapper").length !== 1 ||
    artifact.units.at(-1)?.role !== "wrapper"
  )
    throw new Error(
      "Prepared inspect.pack artifact is missing its wrapper source unit",
    );
  if (
    artifact.sourceMap.length !== artifact.units.length ||
    artifact.sourceMap.some(
      (entry, index) => entry.unitId !== artifact.units[index].id,
    )
  )
    throw new Error("Prepared inspect.pack source map is incomplete or reordered");
  for (const id of ["inspection-domain", "inspection"])
    if (actualIds.filter((value) => value === id).length !== 1)
      throw new Error(`Inspection source unit missing/duplicated: ${id}`);
  fs.writeFileSync(path.join(evidenceRoot, "inspect-pack.py"), artifact.script);
  fs.writeFileSync(
    path.join(evidenceRoot, "inspect-pack.artifact.json"),
    JSON.stringify(artifact, null, 2),
  );

  await stageCheckerDefinitions(typingRoot, path.join(replay, "stubs"));
  fs.copyFileSync(
    path.join(typingRoot, "fmcad_context.pyi"),
    path.join(replay, "stubs/fmcad_context.pyi"),
  );
  fs.writeFileSync(
    path.join(replay, "stubs/fmcad_injected.pyi"),
    "import adsk.core\nfrom fmcad_context import Facade\nFMCAD: Facade\n",
  );
  const inventory = spawnSync(
    "python3",
    ["-I", "-S", path.join(typingRoot, "checker-project.py")],
    {
      input: JSON.stringify({
        units: [
          {
            id: "wire",
            filename: "<fmcad-artifact>",
            source: artifact.script,
            context: { kind: "bundle" },
          },
        ],
      }),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (inventory.status !== 0)
    throw new Error(
      inventory.stderr || `AST inventory exited ${inventory.status}`,
    );
  const ast = JSON.parse(inventory.stdout);
  const locations = [];
  for (const [index, unit] of ast.units.entries()) {
    const prelude = [];
    if (unit.context.app || unit.context.ui || unit.context.deferredFacade)
      prelude.push("from typing import TYPE_CHECKING", "if TYPE_CHECKING:");
    if (unit.context.app) prelude.push("    from fmcad_injected import app");
    if (unit.context.ui) prelude.push("    from fmcad_injected import ui");
    if (unit.context.deferredFacade)
      prelude.push("    from fmcad_injected import FMCAD");
    const lines = unit.source.split("\n");
    lines.splice(unit.insert, 0, ...prelude);
    const filename = `unit-${index}.py`;
    fs.writeFileSync(path.join(replay, filename), lines.join("\n"));
    locations.push({ filename, unit, preludeLines: prelude.length });
  }
  const config = {
    include: locations.map((item) => item.filename),
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
  };
  fs.writeFileSync(
    path.join(replay, "pyrightconfig.json"),
    JSON.stringify(config),
  );
  const engine = load.resolve("basedpyright/index.js");
  const checked = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=512",
      engine,
      "--outputjson",
      "--pythonpath",
      path.join(replay, "no-host-python"),
      "--project",
      path.join(replay, "pyrightconfig.json"),
    ],
    {
      cwd: replay,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (![0, 1].includes(checked.status))
    throw new Error(checked.stderr || `basedpyright exited ${checked.status}`);
  const raw = JSON.parse(checked.stdout);
  const byUnit = Object.create(null);
  for (const unit of artifact.units) byUnit[unit.id] = [];
  for (const diagnostic of raw.generalDiagnostics) {
    const location = locations.find(
      (item) => path.basename(diagnostic.file) === item.filename,
    );
    if (!location)
      throw new Error(
        `Diagnostic outside prepared source units: ${diagnostic.file}`,
      );
    const generatedLine = diagnostic.range.start.line + 1;
    const line =
      generatedLine > location.unit.insert
        ? generatedLine - location.preludeLines
        : generatedLine;
    const mapped = mapPythonPosition(artifact, "<fmcad-artifact>", line);
    if (!mapped) throw new Error(`Cannot map strict diagnostic line ${line}`);
    byUnit[mapped.unitId].push({
      line: mapped.line,
      rule: diagnostic.rule ?? "syntax",
      message: diagnostic.message,
    });
  }
  const strictSources = Object.fromEntries(
    Object.entries(byUnit).filter(([id]) =>
      ["inspection-domain", "inspection"].includes(id),
    ),
  );
  const ownErrorCount = Object.values(strictSources).reduce(
    (total, diagnostics) => total + diagnostics.length,
    0,
  );
  const otherDiagnostics = Object.fromEntries(
    Object.entries(byUnit).filter(
      ([id, diagnostics]) =>
        !["inspection-domain", "inspection"].includes(id) &&
        diagnostics.length > 0,
    ),
  );
  const report = {
    measuredAt: new Date().toISOString(),
    sourceRoot:
      sourceRoot === repositoryRoot
        ? "current-checkout"
        : "explicit-source-root",
    sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).stdout.trim(),
    checker: raw.version,
    checkerContext: { kind: "bundle" },
    config,
    definitionsSnapshot: current.snapshot,
    preparedArtifactHash: artifact.artifactHash,
    wireHash: artifact.sha256,
    preparedWireBytes: artifact.bytes.length,
    runtimeInventoryCount: actualRuntime.length,
    preparedSourceUnits: artifact.units.length,
    sourceMapEntries: artifact.sourceMap.length,
    checkerInputUnits: raw.summary.filesAnalyzed,
    astInventoryOutputBytes: Buffer.byteLength(inventory.stdout),
    runtimeSourceIds: actualIds,
    inspectionStrictDiagnostics: strictSources,
    otherStrictDiagnostics: otherDiagnostics,
    inspectionStrictErrorCount: ownErrorCount,
    inspectionSourceUnitsStrict: ownErrorCount === 0,
    totalStrictErrors: raw.summary.errorCount,
    totalStrictWarnings: raw.summary.warningCount,
    totalStrictInformation: raw.summary.informationCount,
    fullRuntimeInventoryRetained: actualRuntime.length === expectedUnits.length,
    officialCheckerAdmission: "not-run-by-diagnostic-replay",
  };
  const outputPath = path.join(evidenceRoot, "report.json");
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(replay, "raw-diagnostics.json"), checked.stdout);
  console.log(
    JSON.stringify(
      {
        outputPath,
        preparedWireBytes: report.preparedWireBytes,
        runtimeInventoryCount: report.runtimeInventoryCount,
        preparedSourceUnits: report.preparedSourceUnits,
        checkerInputUnits: report.checkerInputUnits,
        inspectionStrictErrorCount: ownErrorCount,
        totalStrictErrors: report.totalStrictErrors,
        definitionsSnapshot: current.snapshot,
      },
      null,
      2,
    ),
  );
  if (ownErrorCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

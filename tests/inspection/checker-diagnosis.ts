/** Reproduce inspection checker failures without changing checker/admission. */
import type { PreparedPythonArtifact } from "../../packages/core/src/domain/python-artifact";
import type { PythonCheckContext } from "../../packages/core/src/domain/python-checker";
import type { PythonChecker } from "../../packages/core/src/domain/python-checker";
const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
const path = process.getBuiltinModule(
  "node:path",
) as typeof import("node:path");
const modules = process.getBuiltinModule(
  "node:module",
) as typeof import("node:module");
const child = process.getBuiltinModule(
  "node:child_process",
) as typeof import("node:child_process");
const crypto = process.getBuiltinModule(
  "node:crypto",
) as typeof import("node:crypto");
const load = modules.createRequire(__filename);
const python = load(
  "../../dist/src/python",
) as typeof import("../../packages/node-adapters/src/python/artifact") &
  typeof import("../../packages/node-adapters/src/python/checker");
const { prepareCadScript } = load("../../dist/src/cad") as {
  prepareCadScript(
    operation: string,
    data: unknown,
    context: unknown,
  ): PreparedPythonArtifact;
};
const { stageCheckerDefinitions } = load(
  "../../packages/node-adapters/dist/python/checker-definitions",
) as typeof import("../../packages/node-adapters/src/python/checker-definitions");
const { mapPythonPosition } = load(
  "../../packages/core/dist/domain/python-artifact",
) as typeof import("../../packages/core/src/domain/python-artifact");

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "../..");
  const evidence = process.argv[2];
  if (!evidence)
    throw new Error("Provide an evidence directory under /tmp/opencode");
  fs.mkdirSync(evidence, { recursive: true });
  const typingRoot = path.join(root, "dist/runtime/python/typing");
  const checker = python.createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    temporaryRoot: "/tmp/opencode",
  });
  const context = {
    doc: "InspectionScratch",
    docId: "creation-123",
    docFileId: "file-123",
  };
  const reads = Array.from({ length: 20 }, (_, i) => ({
    id: `read-${i}`,
    operation: "entity.list",
    data: { kind: "body" },
  }));
  const sources = {
    positive:
      "import adsk.core\np = adsk.core.Point3D.create(0, 0, 0)\nif p is not None:\n    print(p.x)\n",
    negative:
      'import adsk.core\np = adsk.core.Point3D.create("bad", 0, 0)\nprint(p.x)\n',
  };
  const artifacts: Record<string, PreparedPythonArtifact> = {
    ...Object.fromEntries(
      Object.entries(sources).map(([name, source]) => [
        name,
        python.preparePythonArtifact([
          { id: "user", filename: `${name}.py`, role: "user", source },
        ]),
      ]),
    ),
    individual: prepareCadScript("entity.list", { kind: "body" }, context),
    lightStatus: prepareCadScript("document.status", {}, context),
    pack: prepareCadScript("inspect.pack", { reads }, context),
  };
  // Historical individual-read control only, never an inspection candidate:
  // reconstruct the pre-inspection runtime by removing precisely our two new
  // units while retaining every pre-existing runtime unit and the read wrapper.
  const individual = artifacts["individual"]!;
  artifacts["preInspectionIndividual"] = python.preparePythonArtifact(
    individual.units.filter(
      (unit) => !["inspection", "inspection-domain"].includes(unit.id),
    ),
    { request: individual.request, context: individual.context },
  );
  const reports: Record<string, unknown> = {};
  for (const [name, artifact] of Object.entries(artifacts)) {
    python.verifyPythonArtifact(artifact);
    fs.writeFileSync(path.join(evidence, `${name}.py`), artifact.script);
    fs.writeFileSync(
      path.join(evidence, `${name}.artifact.json`),
      JSON.stringify(artifact),
    );
    const checkContext: PythonCheckContext = {
      kind: name === "positive" || name === "negative" ? "run" : "bundle",
    };
    const start = performance.now();
    const report = await checker.check({ artifact, context: checkContext });
    reports[name] = {
      elapsedMs: performance.now() - start,
      context: checkContext,
      bytes: artifact.bytes.length,
      units: artifact.units.map((unit) => ({
        id: unit.id,
        filename: unit.filename,
        sha256: unit.sha256,
      })),
      ...report,
    };
  }
  if (
    (reports["positive"] as { status: string }).status !== "passed" ||
    (reports["negative"] as { status: string }).status !== "failed"
  )
    throw new Error(
      "Real SDK checker controls did not satisfy the installed-fixture contract",
    );
  // Diagnostic-only replay of the same AST inventory, config and engine with a
  // larger capture file. It is NOT an admission report or a policy override.
  const artifact = artifacts["pack"]!;
  const replay = path.join(evidence, "replay");
  fs.mkdirSync(replay, { recursive: true });
  await stageCheckerDefinitions(typingRoot, path.join(replay, "stubs"));
  fs.copyFileSync(
    path.join(typingRoot, "fmcad_context.pyi"),
    path.join(replay, "stubs/fmcad_context.pyi"),
  );
  const inventory = child.spawnSync(
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
  if (inventory.status !== 0) throw new Error(inventory.stderr);
  const projected = JSON.parse(inventory.stdout) as {
    units: { source: string; gaps: number[] }[];
  };
  projected.units.forEach((unit, index) =>
    fs.writeFileSync(path.join(replay, `unit-${index}.py`), unit.source),
  );
  const config = {
    include: projected.units.map((_, index) => `unit-${index}.py`),
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
  const configText = JSON.stringify(config);
  const configHash = crypto
    .createHash("sha256")
    .update(configText)
    .digest("hex");
  if (
    configHash !==
    (reports["pack"] as { provenance: { configHash: string } }).provenance
      .configHash
  )
    throw new Error(
      "Diagnostic replay configuration differs from actual checker configuration",
    );
  fs.writeFileSync(path.join(replay, "pyrightconfig.json"), configText);
  const raw = child.spawnSync(
    process.execPath,
    [
      "--max-old-space-size=512",
      load.resolve("basedpyright/index.js"),
      "--outputjson",
      "--pythonpath",
      path.join(replay, "no-host-python"),
      "--project",
      path.join(replay, "pyrightconfig.json"),
    ],
    {
      cwd: replay,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: replay,
        TMPDIR: replay,
        LANG: "C.UTF-8",
      },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60000,
    },
  );
  fs.writeFileSync(path.join(replay, "raw-diagnostics.json"), raw.stdout);
  const diagnostics = JSON.parse(raw.stdout) as {
    version: string;
    summary: unknown;
    generalDiagnostics: {
      file: string;
      range: { start: { line: number; character: number } };
      rule?: string;
      message: string;
    }[];
  };
  const counts: Record<string, number> = {};
  const samples: unknown[] = [];
  const inspectionDiagnostics: Record<string, unknown[]> = {
    "runtime/python/fmcad/domain/inspection.py": [],
    "runtime/python/fmcad/adapters/fusion/inspection.py": [],
  };
  for (const diagnostic of diagnostics.generalDiagnostics) {
    const location =
      path.basename(diagnostic.file) === "unit-0.py"
        ? mapPythonPosition(
            artifact,
            "<fmcad-artifact>",
            diagnostic.range.start.line + 1,
          )
        : null;
    const key = location?.unitId ?? "dependency";
    counts[key] = (counts[key] ?? 0) + 1;
    if (location && Object.hasOwn(inspectionDiagnostics, location.filename)) {
      inspectionDiagnostics[location.filename]!.push({
        filename: location.filename,
        unitId: location.unitId,
        line: location.line,
        rule: diagnostic.rule ?? "syntax",
        message: diagnostic.message,
      });
    }
    if ((counts[key] ?? 0) <= 2) samples.push({ ...diagnostic, location });
  }
  let platformComparison: unknown = null;
  const comparisonRoot = process.argv[3];
  if (comparisonRoot) {
    const comparison = load(
      path.join(path.resolve(comparisonRoot), "src/python"),
    ) as {
      createPythonChecker(options: {
        typingRoot: string;
        definitionsRoot: string;
        temporaryRoot: string;
        pythonPlatform: "Windows";
      }): PythonChecker;
    };
    const windows = comparison.createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      temporaryRoot: "/tmp/opencode",
      pythonPlatform: "Windows",
    });
    const compared: Record<string, unknown> = {};
    for (const name of ["positive", "pack", "preInspectionIndividual"])
      compared[name] = await windows.check({
        artifact: artifacts[name]!,
        context: { kind: name === "positive" ? "run" : "bundle" },
      });
    platformComparison = {
      pythonPlatform: "Windows",
      comparisonRoot: path.resolve(comparisonRoot),
      sourceCommit: child
        .execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: comparisonRoot,
          encoding: "utf8",
        })
        .trim(),
      reports: compared,
    };
  }
  const report = {
    measuredAt: new Date().toISOString(),
    sourceCommit: child
      .execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      })
      .trim(),
    node: process.version,
    definitionsSnapshot: JSON.parse(
      fs.readFileSync(path.join(typingRoot, "current.json"), "utf8"),
    ) as unknown,
    guardedSdkControlPassed:
      (reports["positive"] as { status: string }).status === "passed",
    packDelivered: false,
    platformComparison,
    reports,
    diagnosticReplay: {
      admissionEvidence: false,
      config,
      configHash,
      configMatchesChecker:
        configHash ===
        (reports["pack"] as { provenance: { configHash: string } }).provenance
          .configHash,
      engineVersion: diagnostics.version,
      exitCode: raw.status,
      outputBytes: Buffer.byteLength(raw.stdout),
      stderr: raw.stderr,
      summary: diagnostics.summary,
      totalDiagnostics: diagnostics.generalDiagnostics.length,
      counts,
      samples,
      inspectionDiagnostics,
      unresolvedDynamicUnits: projected.units.map((unit) => unit.gaps),
    },
  };
  fs.writeFileSync(
    path.join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      evidence,
      positive: (reports["positive"] as { status: string }).status,
      individual: (reports["individual"] as { status: string }).status,
      pack: (reports["pack"] as { status: string }).status,
      diagnosticBytes: Buffer.byteLength(raw.stdout),
      diagnostics: diagnostics.generalDiagnostics.length,
    }),
  );
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

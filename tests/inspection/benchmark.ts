/** Actual shared preparation/checker costs; fake transport counts, never live RPC. */
import type { PreparedPythonArtifact } from "../../packages/core/src/domain/python-artifact";
import type { PythonCheckReport } from "../../packages/core/src/domain/python-checker";

const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
const path = process.getBuiltinModule(
  "node:path",
) as typeof import("node:path");
const { spawnSync } = process.getBuiltinModule(
  "node:child_process",
) as typeof import("node:child_process");
const modules = process.getBuiltinModule(
  "node:module",
) as typeof import("node:module");
const load = modules.createRequire(__filename);
const child = process.getBuiltinModule(
  "node:child_process",
) as typeof import("node:child_process");
const { prepare } = load("./prepared-artifact.cjs") as {
  prepare(
    operation: string,
    data: unknown,
    context: unknown,
    sourceRoot?: string,
  ): { artifact: PreparedPythonArtifact };
};
const { prepareAtomicScript } = load("../../src/batch-atomic") as {
  prepareAtomicScript(request: unknown): PreparedPythonArtifact;
};
const { verifyPythonArtifact, preparePythonArtifact, prepareCadBundle } = load(
  "../../src/python",
) as typeof import("../../packages/node-adapters/src/python/artifact") &
  typeof import("../../packages/node-adapters/src/python/bundle");
async function main(): Promise<void> {
  const root = path.resolve(__dirname, "../..");
  const sourceRoot = process.argv[3] ? path.resolve(process.argv[3]) : root;
  const checkerRoot = process.env["FMCAD_INSPECTION_CHECKER_ROOT"]
    ? path.resolve(process.env["FMCAD_INSPECTION_CHECKER_ROOT"])
    : root;
  const typingRoot = path.join(checkerRoot, "runtime/python/typing");
  const { createPythonChecker } = load(
    path.join(checkerRoot, "src/python"),
  ) as typeof import("../../packages/node-adapters/src/python/checker");
  const context = {
    doc: "InspectionScratch",
    docId: "creation-123",
    docFileId: "file-123",
  };
  const kinds = [
    "body",
    "sketch",
    "feature",
    "face",
    "edge",
    "vertex",
    "plane",
    "axis",
    "point",
    "parameter",
  ];
  const reads = Array.from({ length: 20 }, (_, i) => ({
    id: `read-${i}`,
    operation: "entity.list",
    data: { kind: kinds[i % 10]! },
  }));
  const atomicRequest = {
    operation: "atomic_start",
    runId: "inspection-offline",
    nonce: "offline-nonce",
    doc: context.doc,
    identity: { creationId: context.docId, fileId: context.docFileId },
    steps: reads,
  };
  const builders = {
    individual: () =>
      reads.map(
        (read) =>
          prepare(read.operation, read.data, context, sourceRoot).artifact,
      ),
    batch: () => {
      const template = prepareAtomicScript(atomicRequest);
      const wrapper = template.units.find((unit) => unit.role === "wrapper");
      if (!wrapper) throw new Error("Atomic benchmark wrapper is missing");
      return [
        prepareCadBundle(sourceRoot, wrapper.source, {
          request: atomicRequest,
        }),
      ];
    },
    pack: () => [
      prepare("inspect.pack", { reads, maxBytes: 65536 }, context, sourceRoot)
        .artifact,
    ],
  };
  const definitionsRoot =
    process.env["FMCAD_INSPECTION_DEFINITIONS_ROOT"] ?? typingRoot;
  if (!fs.existsSync(path.join(definitionsRoot, "current.json")))
    throw new Error(
      "Verified SDK definitions required: run the full authorized build or set FMCAD_INSPECTION_DEFINITIONS_ROOT to an existing verified producer snapshot",
    );
  const checker = createPythonChecker({
    typingRoot,
    definitionsRoot,
    temporaryRoot: "/tmp/opencode",
    limits: { timeoutMs: 30000 },
  });
  const checkerControl = await checker.check({
    artifact: preparePythonArtifact([
      {
        id: "positive",
        filename: "guarded-sdk.py",
        role: "user",
        source:
          "import adsk.core\np = adsk.core.Point3D.create(0, 0, 0)\nif p is not None:\n    print(p.x)\n",
      },
    ]),
    context: { kind: "run" },
  });
  if (checkerControl.status !== "passed")
    throw new Error(
      "Positive checker control failed: " + JSON.stringify(checkerControl),
    );
  const artifacts: Record<string, PreparedPythonArtifact[]> = {};
  const preparationTimes: Record<
    string,
    { prepareAndVerifyMs: number; warmPrepareAndVerifyMs: number }
  > = {};
  const metrics: Record<string, unknown> = {};
  for (const [name, build] of Object.entries(builders)) {
    const start = performance.now();
    const prepared = build();
    prepared.forEach(verifyPythonArtifact);
    const prepareMs = performance.now() - start;
    artifacts[name] = prepared;
    const warm = performance.now();
    build().forEach(verifyPythonArtifact);
    const warmPrepareMs = performance.now() - warm;
    preparationTimes[name] = {
      prepareAndVerifyMs: prepareMs,
      warmPrepareAndVerifyMs: warmPrepareMs,
    };
  }
  const runtimeSources = (artifact: PreparedPythonArtifact): string =>
    JSON.stringify(
      artifact.units
        .filter((unit) => unit.role === "runtime")
        .map((unit) => [unit.id, unit.sha256]),
    );
  const runtimeInventories = new Set(
    Object.values(artifacts).flat().map(runtimeSources),
  );
  if (runtimeInventories.size !== 1)
    throw new Error(
      "Runtime sources changed during preparation; rerun on stable sources",
    );
  for (const [name, prepared] of Object.entries(artifacts)) {
    const reports: PythonCheckReport[] = [];
    const checkStart = performance.now();
    for (const artifact of prepared)
      reports.push(
        await checker.check({ artifact, context: { kind: "bundle" } }),
      );
    metrics[name] = {
      preparedArtifacts: prepared.length,
      scriptBytes: prepared.reduce(
        (n, artifact) => n + artifact.bytes.length,
        0,
      ),
      ...preparationTimes[name],
      checkerMs: performance.now() - checkStart,
      checkerInvocations: reports.length,
      checkerStatuses: reports.map((report) => report.status),
      checkerReasons: [...new Set(reports.flatMap((report) => report.reasons))],
      checkerProvenance: reports.map((report) => report.provenance),
      nativeAdmissionEligible: reports.every(
        (report) => report.status === "passed",
      ),
    };
  }
  const fake = spawnSync(
    "python3",
    ["-B", path.join(root, "tests/inspection/compare.py")],
    {
      input: JSON.stringify(
        Object.fromEntries(
          Object.entries(artifacts).map(([name, units]) => [
            name,
            units.map((unit) => unit.script),
          ]),
        ),
      ),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (fake.status !== 0) throw new Error(fake.stderr);
  const report = {
    source: "offline-fake-only",
    node: process.version,
    measuredAt: new Date().toISOString(),
    sourceRoot:
      sourceRoot === root ? "current-checkout" : "explicit-source-root",
    sourceRootBranch: spawnSync("git", ["branch", "--show-current"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).stdout.trim(),
    sourceRootCommit: spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).stdout.trim(),
    checkerRoot:
      checkerRoot === root
        ? "current-checkout"
        : "official-checker-distribution",
    checkerCommit: child
      .execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: checkerRoot === root ? root : path.dirname(checkerRoot),
        encoding: "utf8",
      })
      .trim(),
    reads: 20,
    nativeRpcCount: null,
    nativeValidation: "not-performed",
    nativeLifecycle: "not-simulated",
    checkerControl,
    packDelivered: false,
    runtimeSources: artifacts["pack"]![0]!.units.filter(
      (unit) => unit.role === "runtime",
    ).map((unit) => ({
      id: unit.id,
      filename: unit.filename,
      sha256: unit.sha256,
    })),
    scope:
      "Real generated wrappers, source/identity hashes and real checker calls. Fake SDK dispatch comparison is NOT broker admission; nonpassing checker reports prohibit native dispatch. Batch measures one atomic_start payload, excluding resolve/poll/finalize RPCs.",
    preparation: metrics,
    fake: JSON.parse(fake.stdout) as unknown,
  };
  const output = process.argv[2];
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  else console.log(JSON.stringify(report, null, 2));
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

"use strict";
// Exercise the shipped checker on the complete CAD-prepared pack. This is a
// checker-only admission report; it never calls a Fusion client or SDK port.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const load = createRequire(__filename);
const { prepare } = require("./prepared-artifact.cjs");

async function main() {
  const sourceRoot = process.argv[3] ? path.resolve(process.argv[3]) : root;
  const checkerRoot = process.env["FMCAD_INSPECTION_CHECKER_ROOT"]
    ? path.resolve(process.env["FMCAD_INSPECTION_CHECKER_ROOT"])
    : root;
  const typingRoot = path.join(checkerRoot, "runtime/python/typing");
  const pointer = JSON.parse(
    fs.readFileSync(path.join(typingRoot, "current.json"), "utf8"),
  );
  const { createPythonChecker } = load(path.join(checkerRoot, "src/python"));
  const context = {
    doc: "InspectionScratch",
    docId: "creation-123",
    docFileId: "file-123",
  };
  const reads = Array.from({ length: 20 }, (_, index) => ({
    id: `read-${index}`,
    operation: "entity.list",
    data: { kind: "body" },
  }));
  const requests = {
    entityList: prepare("entity.list", { kind: "body" }, context, sourceRoot)
      .artifact,
    inspectPack: prepare(
      "inspect.pack",
      { reads, maxBytes: 65536 },
      context,
      sourceRoot,
    ).artifact,
  };
  const checker = createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    temporaryRoot: "/tmp/opencode",
  });
  const checkerContext = { kind: "bundle" };
  const reports = {};
  for (const [name, artifact] of Object.entries(requests)) {
    reports[name] = {
      wireBytes: artifact.bytes.length,
      wireHash: artifact.sha256,
      artifactHash: artifact.artifactHash,
      units: artifact.units.map(({ id, filename, sha256, role }) => ({
        id,
        filename,
        sha256,
        role,
      })),
      report: await checker.check({ artifact, context: checkerContext }),
    };
  }
  const report = {
    measuredAt: new Date().toISOString(),
    sourceRoot:
      sourceRoot === root ? "current-checkout" : "explicit-source-root",
    sourceRootBranch: require("node:child_process")
      .execFileSync("git", ["branch", "--show-current"], {
        cwd: sourceRoot,
        encoding: "utf8",
      })
      .trim(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim(),
    checkerRoot:
      checkerRoot === root
        ? "current-checkout"
        : "official-checker-distribution",
    checkerCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: checkerRoot === root ? root : path.dirname(checkerRoot),
      encoding: "utf8",
    }).trim(),
    checkerContext,
    definitionsSnapshot: pointer.snapshot,
    requests: reports,
    outcome: Object.values(reports).every(
      (item) => item.report.status === "passed",
    )
      ? "passed"
      : "incomplete",
    sdkDispatched: false,
  };
  const output = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join("/tmp/opencode", "inspection-official-check.json");
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        output,
        outcome: report.outcome,
        definitionsSnapshot: pointer.snapshot,
        requests: Object.fromEntries(
          Object.entries(reports).map(([name, item]) => [
            name,
            {
              status: item.report.status,
              wireBytes: item.wireBytes,
              wireHash: item.wireHash,
              reasons: item.report.reasons.slice(-4),
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
  if (report.outcome !== "passed") process.exitCode = 1;
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

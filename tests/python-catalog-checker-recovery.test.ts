import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { record } from "./integration/offline-cli";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { prepareReceiptScript } = load("./src/queue-instance") as Pick<
  ReturnType<
    typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
  >,
  "prepareReceiptScript"
>;
interface EvidencePass {
  fileCount: number;
  hasValues: boolean;
  hasLateRuntime: boolean;
  userRoot: boolean;
  workerRoot: boolean;
  changedCanonicalPrefix: boolean;
  projectedStubs: number;
}
function evidencePass(value: unknown): EvidencePass {
  assert.ok(value !== null && typeof value === "object");
  const row = value as Record<string, unknown>;
  assert.equal(typeof row["fileCount"], "number");
  assert.equal(typeof row["projectedStubs"], "number");
  for (const key of [
    "hasValues",
    "hasLateRuntime",
    "userRoot",
    "workerRoot",
    "changedCanonicalPrefix",
  ])
    assert.equal(typeof row[key], "boolean");
  return value as EvidencePass;
}
const { cadBundleUnits } = load(
  "./packages/node-adapters/dist/python/bundle",
) as typeof import("../packages/node-adapters/src/python/bundle");
const { preparePythonArtifact } = load(
  "./packages/node-adapters/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { pythonUnitContexts } = load(
  "./packages/node-adapters/dist/python/context-binding",
) as typeof import("../packages/node-adapters/src/python/context-binding");
const { createPythonChecker } = load(
  "./packages/node-adapters/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");

const runtime = path.join(root, "dist/runtime/python");
const typingRoot = path.join(runtime, "typing");

async function fakeChecker(t: TestContext) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-catalog-recovery-"),
  );
  const evidence = path.join(root, "checker-passes.jsonl");
  const engine = path.join(root, "recording-engine.cjs");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    engine,
    `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const project = process.argv[process.argv.indexOf("--project") + 1];
const config = JSON.parse(fs.readFileSync(project, "utf8"));
const files = config.include.map(name => path.resolve(path.dirname(project), name));
const diagnostics = [];
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const marker of ["CATALOG_USER_ROOT: int = \\\"wrong\\\"", "CATALOG_WORKER_ROOT: int = \\\"wrong\\\""]) {
    const offset = source.indexOf(marker);
    if (offset < 0) continue;
    const line = source.slice(0, offset).split("\\n").length - 1;
    diagnostics.push({file, severity: "error", message: marker,
      rule: "reportAssignmentType", range: {start: {line, character: 0}, end: {line, character: 1}}});
  }
}
fs.appendFileSync(${JSON.stringify(evidence)}, JSON.stringify({
  fileCount: files.length,
  hasValues: files.some(file => fs.readFileSync(file, "utf8").includes("JSON-only values and validation")),
  hasLateRuntime: files.some(file => fs.readFileSync(file, "utf8").includes("measured_fasteners_check_operation")),
  userRoot: diagnostics.some(item => item.message.startsWith("CATALOG_USER_ROOT")),
  workerRoot: diagnostics.some(item => item.message.startsWith("CATALOG_WORKER_ROOT")),
  changedCanonicalPrefix: files.some(file => fs.readFileSync(file, "utf8").includes("JSON-only valuez and validation")),
  projectedStubs: files.reduce((count, file) => count + (fs.readFileSync(file, "utf8").match(/^\\s*raise NotImplementedError\\s*$/gm) || []).length, 0),
}) + "\\n");
console.log(JSON.stringify({version: "1.40.2", generalDiagnostics: diagnostics,
  summary: {filesAnalyzed: files.length, errorCount: diagnostics.length}}));
process.exitCode = diagnostics.length ? 1 : 0;
`,
  );
  const checker = createPythonChecker({
    typingRoot,
    temporaryRoot: root,
    engineEntrypoint: engine,
    checkerResources: () => "a".repeat(64),
    limits: { timeoutMs: 30_000, outputBytes: 2 * 1024 * 1024 },
  });
  return { evidence, checker };
}

function sourceParts() {
  const units = cadBundleUnits(path.join(root, "dist"), "full");
  const requestRoot =
    '\n\n_CATALOG_REQUEST: dict[str, str] = {"operation": "entity.list"}\n\n';
  const workerRoot = `def run(_context: str):
    CATALOG_USER_ROOT: int = "wrong"
    CATALOG_WORKER_ROOT: int = "wrong"
    return None
`;
  const wrapper = requestRoot + workerRoot;
  const original = preparePythonArtifact([
    ...units,
    {
      id: "wrapper",
      filename: "<fmcad-wrapper>",
      source: wrapper,
      role: "wrapper",
    },
  ]);
  return { units, wrapper, original };
}

async function readEvidence(file: string) {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => evidencePass(JSON.parse(line) as unknown));
}

test("receipt-wrapped canonical catalog source retains runtime, roots, maps and wire identity", async (t) => {
  const { evidence, checker } = await fakeChecker(t);
  const { units, original } = sourceParts();
  const prepared = prepareReceiptScript(
    original.script,
    true,
    "/offline/catalog-recovery.json",
    { jobId: "catalog-recovery" },
    { mapPath: (value) => value },
  );
  assert.equal(prepared.units.length, 2);
  assert.equal(record(prepared.context)["origin"], undefined);
  const contexts = pythonUnitContexts(prepared);
  assert.deepEqual(contexts["embedded:0"], { kind: "raw", entrypoint: "run" });

  const report = await checker.check({
    artifact: prepared,
    context: { kind: "raw", entrypoint: "run" },
    unitContexts: contexts,
  });
  const passes = await readEvidence(evidence);

  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.equal(report.provenance.artifactHash, prepared.artifactHash);
  assert.equal(report.provenance.wireHash, prepared.sha256);
  assert.ok(passes.length > 0);
  assert.ok(passes.every((pass) => pass.fileCount === 2));
  assert.ok(passes.every((pass) => pass.hasValues && pass.hasLateRuntime));
  assert.ok(passes.every((pass) => pass.userRoot && pass.workerRoot));
  assert.ok(
    report.diagnostics.some(
      (item) =>
        item.unitId === "wrapper" &&
        item.filename === "<fmcad-wrapper>" &&
        item.message.startsWith("CATALOG_USER_ROOT"),
    ),
    JSON.stringify(report.diagnostics),
  );
  assert.ok(
    report.diagnostics.some(
      (item) =>
        item.unitId === "wrapper" &&
        item.filename === "<fmcad-wrapper>" &&
        item.message.startsWith("CATALOG_WORKER_ROOT"),
    ),
    JSON.stringify(report.diagnostics),
  );
  assert.equal(units.length, 152);
});

test("a changed canonical byte is preserved in analysis and cannot be reported as a passing artifact", async (t) => {
  const { evidence, checker } = await fakeChecker(t);
  const { original } = sourceParts();
  const changedSource = original.script.replace(
    "JSON-only values and validation",
    "JSON-only valuez and validation",
  );
  assert.notEqual(changedSource, original.script);
  const prepared = prepareReceiptScript(
    changedSource,
    true,
    "/offline/catalog-tamper.json",
    { jobId: "catalog-tamper" },
    { mapPath: (value) => value },
  );
  const report = await checker.check({
    artifact: prepared,
    context: { kind: "raw", entrypoint: "run" },
    unitContexts: pythonUnitContexts(prepared),
  });
  const passes = await readEvidence(evidence);

  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.equal(report.provenance.artifactHash, prepared.artifactHash);
  assert.equal(report.provenance.wireHash, prepared.sha256);
  assert.ok(passes.length > 0);
  assert.ok(passes.some((pass) => pass.changedCanonicalPrefix));
  assert.ok(report.diagnostics.length > 0);
});

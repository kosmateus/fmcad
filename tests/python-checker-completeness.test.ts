import { present, retainedOrigin } from "./python-test-contracts";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type { PreparedPythonArtifact } from "@fmcad/core";
import type { SourceInput } from "../packages/node-adapters/src/python/artifact";
import { record, at, list, text } from "./integration/offline-cli";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
const repository = path.resolve(__dirname, "../..");
const load = createRequire(
  path.join(repository, "tests", "python-checker-completeness.test.js"),
);
const { createPythonChecker } = load(
  "../packages/node-adapters/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { preparePythonArtifact } = load(
  "../packages/node-adapters/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { pythonArtifactManifest, pythonUnitContexts, retainPythonOrigin } = load(
  "../packages/node-adapters/dist/python/context-binding",
) as typeof import("../packages/node-adapters/src/python/context-binding");
const { createPythonRpcAdmission } = load(
  "../packages/node-adapters/dist/python/admission",
) as typeof import("../packages/node-adapters/src/python/admission");
const checkerProcess = load(
  "../packages/node-adapters/dist/python/checker-process",
) as typeof import("../packages/node-adapters/src/python/checker-process");

const typingRoot = path.resolve("runtime/python/typing");
const fixtureRoot = path.resolve("tests/fixtures/python-checker-completeness");
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

async function temporary(t: TestContext, prefix = "fmcad-check-completeness-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function artifact(units: readonly SourceInput[], context: unknown = null) {
  return preparePythonArtifact(units, { context });
}

async function fakeChecker(t: TestContext, mode = "pass") {
  const root = await temporary(t);
  const evidencePath = path.join(root, "engine-evidence.jsonl");
  const enginePath = path.join(root, "recording-checker.cjs");
  const template = await fs.readFile(
    path.join(fixtureRoot, "recording-checker.cjs"),
    "utf8",
  );
  await fs.writeFile(
    enginePath,
    template
      .replace("__MODE__", JSON.stringify(mode))
      .replace("__EVIDENCE_PATH__", JSON.stringify(evidencePath)),
  );
  return {
    root,
    evidencePath,
    checker: createPythonChecker({
      typingRoot,
      temporaryRoot: root,
      engineEntrypoint: enginePath,
      limits: { timeoutMs: 5_000, outputBytes: 2 * 1024 * 1024 },
      checkerResources: () => "a".repeat(64),
    }),
  };
}

async function readEvidence(file: string) {
  if (!(await fs.stat(file).catch(() => null))) return [];
  const text = await fs.readFile(file, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function syntheticDefinitions(t: TestContext) {
  const root = await temporary(t, "fmcad-check-completeness-definitions-");
  const files = Object.fromEntries(
    ["__init__", "cam", "drawing", "electron", "fusion", "sim", "volume"].map(
      (name) => [`adsk/${name}.py`, ""],
    ),
  );
  files["adsk/core.py"] = await fs.readFile(
    path.resolve("tests/fixtures/python-checker/adsk/core.py"),
    "utf8",
  );
  for (const name of ["LICENSE.upstream", "README.upstream.md", "NOTICES.md"])
    files[name] = "synthetic completeness fixture; not Autodesk definitions";
  const manifest = JSON.stringify({
    schema: 1,
    repository: "AutodeskFusion360/FusionAPIReference",
    generator: "fmcad-annotated-copy-v1",
    overlay: "point3d-nullable-v1",
    authorization:
      "user-authorized-2026-10-24; Autodesk rights unverified; not legal clearance",
    commit: "a".repeat(40),
    files: Object.fromEntries(
      Object.entries(files).map(([name, source]) => [name, hash(source)]),
    ),
  });
  const snapshot = hash(manifest);
  const directory = path.join(root, "snapshots", snapshot);
  await fs.mkdir(path.join(directory, "adsk"), { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, source]) =>
      fs.writeFile(path.join(directory, name), source),
    ),
  );
  await fs.writeFile(path.join(directory, "manifest.json"), manifest);
  await fs.writeFile(
    path.join(root, "current.json"),
    JSON.stringify({ snapshot }),
  );
  return root;
}

function groupedArtifact(markers = true) {
  // Two independent AST bodies just exceed the checker's fixed 75k body-node
  // bin budget together, but each fits alone. This exercises real projection
  // and aggregation without running the 154-unit production helper.
  const listFor = (marker: string) => {
    const values = Array(40_020).fill("0");
    if (markers) values[0] = JSON.stringify(marker);
    return values.join(",");
  };
  return artifact([
    {
      id: "alpha-runtime",
      filename: "alpha-runtime.py",
      role: "runtime",
      source: `def alpha() -> list[int]:\n    return [${listFor("__TYPE_ERROR_ALPHA__")}]\n`,
    },
    {
      id: "beta-runtime",
      filename: "beta-runtime.py",
      role: "runtime",
      source: `def beta() -> list[int]:\n    return [${listFor("__TYPE_ERROR_BETA__")}]\n`,
    },
  ]);
}

function rebind(artifactValue: PreparedPythonArtifact, context: unknown) {
  const mapped = new Set(artifactValue.sourceMap.map((entry) => entry.unitId));
  return preparePythonArtifact(
    artifactValue.units.map((unit) => ({
      ...unit,
      embedded: !mapped.has(unit.id),
    })),
    { context, request: artifactValue.request },
  );
}

function receiptWithOriginalUnits(
  original: PreparedPythonArtifact,
  label: string,
) {
  const { prepareReceiptScript } = load("../src/queue-instance") as ReturnType<
    typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
  >;
  const receipt = prepareReceiptScript(
    original.script,
    true,
    `/offline/${label}.json`,
    { jobId: label },
    { mapPath: (value) => value },
  );
  const mapped = new Set(receipt.sourceMap.map((entry) => entry.unitId));
  const withSourceNamespaces = preparePythonArtifact(
    [
      ...receipt.units.map((unit) => ({
        ...unit,
        embedded: !mapped.has(unit.id),
      })),
      ...original.units
        .filter((unit) =>
          original.sourceMap.some((entry) => entry.unitId === unit.id),
        )
        .map((unit) => ({
          ...unit,
          id: `preserved-${unit.id}`,
          embedded: true,
        })),
    ],
    { context: receipt.context, request: receipt.request },
  );
  return retainPythonOrigin(
    withSourceNamespaces,
    pythonArtifactManifest(original),
  );
}

test("real basedpyright finds errors in every mapped unit while resolving shared globals", async () => {
  const units: SourceInput[] = [];
  for (const filename of [
    "namespace-first.py",
    "namespace-middle.py",
    "namespace-last.py",
  ]) {
    units.push({
      id: filename,
      filename,
      role: "runtime",
      source: await fs.readFile(path.join(fixtureRoot, filename), "utf8"),
    });
  }
  const prepared = artifact(units);
  const report = await createPythonChecker({ typingRoot }).check({
    artifact: prepared,
    context: { kind: "raw" },
  });

  assert.equal(report.status, "failed", JSON.stringify(report));
  for (const filename of [
    "namespace-first.py",
    "namespace-middle.py",
    "namespace-last.py",
  ]) {
    assert.ok(
      report.diagnostics.some(
        (diagnostic) =>
          diagnostic.filename === filename &&
          diagnostic.unitId === filename &&
          diagnostic.rule === "reportAssignmentType",
      ),
      `the real checker did not report the intended type error in ${filename}: ${JSON.stringify(report.diagnostics)}`,
    );
  }
  assert.ok(
    !report.diagnostics.some((diagnostic) =>
      ["reportUndefinedVariable", "reportUnboundVariable"].includes(
        diagnostic.rule,
      ),
    ),
    `source units lost their shared namespace/order: ${JSON.stringify(report.diagnostics)}`,
  );
  assert.equal(report.provenance.wireHash, prepared.sha256);
  assert.equal(report.provenance.artifactHash, prepared.artifactHash);
});

test("real basedpyright maps a deferred-facade error through the receipt to its original source unit", async (t) => {
  const definitionsRoot = await syntheticDefinitions(t);
  const original = artifact(
    [
      {
        id: "user-script",
        filename: "assets/cad/user_stage.py",
        role: "user",
        source:
          'def run(context: str) -> None:\n    FMCAD.length("1 mm")\n    FMCAD.length(17)\n',
      },
    ],
    {
      unitContexts: {
        "user-script": {
          kind: "cad-v1",
          deferredFacade: true,
          entrypoint: "run-if-present",
        },
      },
    },
  );
  const prepared = receiptWithOriginalUnits(original, "deferred-facade");
  const contexts = pythonUnitContexts(prepared);
  const user = prepared.units.find(
    (unit) => unit.filename === "assets/cad/user_stage.py",
  );
  const wrapper = prepared.units.find(
    (unit) => unit.filename === "<fmcad-queue>",
  );
  assert.ok(user && wrapper);
  assert.deepEqual(contexts[user.id], {
    kind: "cad-v1",
    deferredFacade: true,
    entrypoint: "run-if-present",
  });
  assert.deepEqual(contexts[wrapper.id], { kind: "raw", entrypoint: "run" });

  const report = await createPythonChecker({
    typingRoot,
    definitionsRoot,
  }).check({
    artifact: prepared,
    context: { kind: "raw" },
    unitContexts: contexts,
  });
  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.ok(
    report.diagnostics.some(
      (diagnostic) =>
        diagnostic.rule === "reportArgumentType" &&
        diagnostic.filename === "assets/cad/user_stage.py" &&
        diagnostic.unitId === "user-script" &&
        diagnostic.line === 3,
    ),
    `deferred-FMCAD prologue or retained source map was not respected: ${JSON.stringify(report.diagnostics)}`,
  );
  assert.equal(report.provenance.artifactHash, prepared.artifactHash);
  assert.equal(report.provenance.wireHash, prepared.sha256);
});

test("real basedpyright verifies retained origin bytes inside a transformed Addin wire", async () => {
  const original = artifact([
    {
      id: "runtime-helper",
      filename: "runtime-helper.py",
      role: "runtime",
      source: "def helper(value: int) -> int:\n    return value + 1\n",
    },
    {
      id: "user-script",
      filename: "user-script.py",
      role: "user",
      source: "def run(context: str) -> None:\n    print(helper(1))\n",
    },
  ]);
  const transformed = artifact([
    {
      id: "addin-wire",
      filename: "<addin-wire>",
      role: "wrapper",
      source: "_guard = True\n" + original.script + '\nrun("")\n',
    },
  ]);
  const prepared = retainPythonOrigin(
    transformed,
    pythonArtifactManifest(original),
  );
  const contexts = pythonUnitContexts(prepared);
  const report = await createPythonChecker({ typingRoot }).check({
    artifact: prepared,
    context: { kind: "raw" },
    unitContexts: contexts,
  });

  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(report.provenance.wireHash, prepared.sha256);
  assert.equal(report.provenance.artifactHash, prepared.artifactHash);
  assert.match(text(report.provenance.analysisHash), /^[a-f0-9]{64}$/);

  const tamperedContext = structuredClone(prepared.context);
  record(list(at(tamperedContext, "origin", "segments"))[0])["startLine"] = 1;
  const mapped = new Set(prepared.sourceMap.map((entry) => entry.unitId));
  const tampered = preparePythonArtifact(
    prepared.units.map((unit) => ({
      ...unit,
      embedded: !mapped.has(unit.id),
    })),
    { context: tamperedContext, request: prepared.request },
  );
  const rejected = await createPythonChecker({ typingRoot }).check({
    artifact: tampered,
    context: { kind: "raw" },
  });
  assert.equal(rejected.status, "tool_error", JSON.stringify(rejected));
  assert.match(
    rejected.reasons.join(" "),
    /origin source span does not match/i,
  );
});

test("prepared canonical cad-v1 receipt retains all 154 helper units, maps, bytes and both contexts without a full checker run", (t) => {
  const directory = (load("node:fs") as typeof import("node:fs")).mkdtempSync(
    path.join(os.tmpdir(), "helper-completeness-canonical-"),
  );
  t.after(() =>
    (load("node:fs") as typeof import("node:fs")).rmSync(directory, {
      recursive: true,
      force: true,
    }),
  );
  const scriptFile = path.join(directory, "canonical-stage.py");
  (load("node:fs") as typeof import("node:fs")).writeFileSync(
    scriptFile,
    'ARGS = []\nDOC_NAME = ""\ndef run(context: str) -> None:\n    stage = FMCAD.stage()\n    journal = FMCAD.journalInspect()\n    plan = FMCAD.resumePlan()\n    print(stage, journal, plan)\n',
  );

  const { prepareRunScript } = load(
    "../src/run",
  ) as typeof import("../src/composition/run");
  const { prepareReceiptScript } = load("../src/queue-instance") as ReturnType<
    typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
  >;
  const original = prepareRunScript(
    scriptFile,
    [],
    false,
    "Fixture",
    { docId: "helper-completeness-canonical" },
    "cad-v1",
    [],
  );
  const receipt = prepareReceiptScript(
    original.script,
    true,
    "/offline/helper-completeness.json",
    { jobId: "helper-completeness" },
    { mapPath: (value) => value },
  );
  const final = retainPythonOrigin(receipt, pythonArtifactManifest(original));
  const origin = retainedOrigin(final);

  assert.equal(original.units.length, 154);
  assert.equal(origin.units.length, 154);
  assert.ok(Buffer.byteLength(original.script) > 2_000_000);
  assert.equal(origin.artifactHash, original.artifactHash);
  assert.equal(origin.sha256, original.sha256);
  assert.deepEqual(
    origin.units,
    original.units.map(({ id, filename, role, sha256 }) => ({
      id,
      filename,
      role,
      sha256,
    })),
  );

  const unitsById = new Map(original.units.map((unit) => [unit.id, unit]));
  const lines = original.script.split("\n");
  const mappedIds = new Set();
  for (const entry of origin.sourceMap) {
    assert.ok(
      !mappedIds.has(entry.unitId),
      `duplicate source map unit ${entry.unitId}`,
    );
    mappedIds.add(entry.unitId);
    const unit = unitsById.get(entry.unitId);
    assert.ok(unit, `source map refers to missing unit ${entry.unitId}`);
    const mappedSource = lines
      .slice(entry.generatedStartLine - 1, entry.generatedEndLine)
      .join("\n");
    assert.equal(
      hash(mappedSource),
      unit.sha256,
      `source-map bytes changed for ${unit.filename}`,
    );
  }
  assert.equal(origin.sourceMap.length, 153);
  assert.equal(mappedIds.size, 153);
  const unmappedOrigins = origin.units.filter(
    (unit) => !mappedIds.has(unit.id),
  );
  assert.deepEqual(
    unmappedOrigins.map(({ id, filename, role }) => ({ id, filename, role })),
    [{ id: "user-script", filename: scriptFile, role: "user" }],
    "every runtime/wrapper origin must be mapped; only the standalone user root is unmapped",
  );
  assert.equal(
    origin.units.filter((unit) => unit.role === "runtime").length,
    152,
  );
  assert.ok(
    origin.units
      .filter((unit) => unit.role === "runtime")
      .every((unit) => mappedIds.has(unit.id)),
    "every runtime unit must have a source-map entry",
  );

  const contexts = pythonUnitContexts(final);
  const helper = final.units.find((unit) => unit.filename === scriptFile);
  const receiptWrapper = final.units.find(
    (unit) => unit.filename === "<fmcad-queue>",
  );
  assert.ok(helper && receiptWrapper);
  const originalHelper = unitsById.get("user-script");
  assert.ok(originalHelper);
  assert.equal(helper.id, "embedded:1");
  assert.equal(helper.role, "user");
  assert.equal(helper.source, originalHelper.source);
  assert.equal(helper.sha256, originalHelper.sha256);
  assert.deepEqual(contexts[helper.id], {
    kind: "cad-v1",
    deferredFacade: true,
    entrypoint: "run-if-present",
  });
  assert.deepEqual(contexts[receiptWrapper.id], {
    kind: "raw",
    entrypoint: "run",
  });
  assert.equal(final.sha256, hash(Buffer.from(final.script, "utf8")));
  assert.equal(final.bytes.length, Buffer.byteLength(final.script));
});

test("aggregate checks both active bodies and maps a late-group error; projected stubs are not counted as coverage", async (t) => {
  const { checker, evidencePath } = await fakeChecker(t);
  const prepared = groupedArtifact();
  const report = await checker.check({
    artifact: prepared,
    context: { kind: "raw" },
  });
  assert.notEqual(report.status, "tool_error", JSON.stringify(report));
  const passes = await readEvidence(evidencePath);

  assert.equal(
    passes.length,
    2,
    "the fixture must exercise two independent checker groups",
  );
  assert.ok(passes.every((pass) => pass.files.length > 0));
  assert.equal(
    passes.filter((pass) => pass.alphaActive).length,
    1,
    JSON.stringify(passes),
  );
  assert.equal(
    passes.filter((pass) => pass.betaActive).length,
    1,
    JSON.stringify(passes),
  );
  assert.ok(passes.every((pass) => pass.projectedBodies === 1));
  assert.ok(passes.some((pass) => pass.alphaProjected));
  assert.ok(passes.some((pass) => pass.betaProjected));
  assert.equal(report.status, "failed", JSON.stringify(report));
  assert.ok(
    report.diagnostics.some(
      (diagnostic) =>
        diagnostic.unitId === "alpha-runtime" &&
        diagnostic.filename === "alpha-runtime.py" &&
        diagnostic.rule === "reportReturnType",
    ),
    `first group type error was lost or mis-mapped: ${JSON.stringify(report.diagnostics)}`,
  );
  assert.ok(
    report.diagnostics.some(
      (diagnostic) =>
        diagnostic.unitId === "beta-runtime" &&
        diagnostic.filename === "beta-runtime.py" &&
        diagnostic.rule === "reportReturnType",
    ),
    `late group type error was lost or mis-mapped: ${JSON.stringify(report.diagnostics)}`,
  );
  assert.equal(report.provenance.wireHash, prepared.sha256);
  assert.equal(report.provenance.artifactHash, prepared.artifactHash);
  assert.equal(report.provenance.cache, "disabled");
});

test("retained origin body inventory is planned once and reverified for every group", async (t) => {
  // This recording-engine test covers plan/process orchestration only; it is
  // not a checker PASS or public admission proof.
  const { checker, evidencePath } = await fakeChecker(t);
  const original = groupedArtifact(false);
  const { prepareReceiptScript } = load("../src/queue-instance") as ReturnType<
    typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
  >;
  const receipt = prepareReceiptScript(
    original.script,
    true,
    "/offline/reuse-aggregate-plan.json",
    { jobId: "reuse-aggregate-plan" },
    { mapPath: (value) => value },
  );
  const prepared = retainPythonOrigin(
    receipt,
    pythonArtifactManifest(original),
  );
  const runCheckerProcess = checkerProcess.runCheckerProcess;
  let sourcePlanRuns = 0,
    inventoryRuns = 0,
    projectionRuns = 0;
  checkerProcess.runCheckerProcess = async (...args) => {
    try {
      const input = JSON.parse(args[4] || "{}");
      if (input.analysisSourcePath) sourcePlanRuns++;
      if (input.units) inventoryRuns++;
      if (input.projectionGroups) {
        projectionRuns++;
        assert.equal(
          input.projectionGroups.length,
          2,
          "The complete group set is projected together",
        );
      }
    } catch {
      // Non-JSON checker input belongs to the other fixed checker phases.
    }
    return runCheckerProcess(...args);
  };
  try {
    const contexts = pythonUnitContexts(prepared);
    const report = await checker.check({
      artifact: prepared,
      context: { kind: "raw" },
      unitContexts: contexts,
    });
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(
      sourcePlanRuns,
      1,
      "the parent derives the original full-body plan once",
    );
    assert.equal(
      inventoryRuns,
      1,
      "Exact source namespaces are inventoried once per check invocation",
    );
    assert.equal(
      projectionRuns,
      1,
      "Immutable AST/policy work is shared without reusing analysis results",
    );
    assert.equal(
      (await readEvidence(evidencePath)).length,
      2,
      "both bounded groups still run",
    );
  } finally {
    checkerProcess.runCheckerProcess = runCheckerProcess;
  }
});

test("shared preparation remains hash-bound through later groups and is removed on every outcome", async (t) => {
  for (const mode of [
    "pass",
    "inventory",
    "projection",
    "metadata",
    "missing-group",
  ] as const) {
    const { checker, root, evidencePath } = await fakeChecker(t);
    const run = checkerProcess.runCheckerProcess;
    let sharedDirectory: string | undefined;
    let inventories = 0,
      projections = 0,
      engines = 0;
    checkerProcess.runCheckerProcess = async (...args) => {
      const input = JSON.parse(args[4] || "{}");
      if (input.units) inventories++;
      if (input.projectionGroups) {
        projections++;
        sharedDirectory = args[2];
      }
      const result = await run(...args);
      if (input.projectionGroups && mode === "missing-group") {
        const output = JSON.parse(result.stdout);
        output.projections.pop();
        return { ...result, stdout: JSON.stringify(output) };
      }
      if (args[0] === process.execPath && ++engines === 1 && mode !== "pass") {
        assert.ok(sharedDirectory);
        const tamperFiles: Partial<Record<typeof mode, string>> = {
          inventory: "source-0.txt",
          projection: "projection-1.txt",
          metadata: "projection-1.json",
        };
        const file = tamperFiles[mode];
        if (file)
          await fs.appendFile(
            path.join(sharedDirectory, file),
            "\n# changed between groups",
          );
      }
      return result;
    };
    let report;
    try {
      report = await checker.check({
        artifact: groupedArtifact(false),
        context: { kind: "raw" },
      });
    } finally {
      checkerProcess.runCheckerProcess = run;
    }
    assert.equal(inventories, 1, mode);
    assert.equal(projections, 1, mode);
    const passes = await readEvidence(evidencePath);
    if (mode === "pass") {
      assert.equal(report.status, "passed", JSON.stringify(report));
      assert.equal(
        passes.length,
        2,
        "Both full-body groups still execute the checker",
      );
    } else {
      assert.equal(report.status, "tool_error", JSON.stringify(report));
      assert.match(
        report.reasons.join("\n"),
        /Shared AST inventory bytes changed|Prepared projection .*changed|complete group inventory/,
        mode,
      );
      assert.equal(
        passes.length,
        mode === "missing-group" ? 0 : 1,
        "Corrupt later preparation never reaches a checker pass",
      );
    }
    assert.equal(
      (await fs.readdir(root)).filter((name) => name.startsWith("fmcad-check-"))
        .length,
      0,
      "Parent inventory and all child analysis directories are cleaned after " +
        mode,
    );
  }
});

test("aggregate failure reasons identify the same original unit as mapped diagnostics", async (t) => {
  const { checker } = await fakeChecker(t, "incomplete-beta");
  const original = groupedArtifact();
  const { prepareReceiptScript } = load("../src/queue-instance") as ReturnType<
    typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
  >;
  const receipt = prepareReceiptScript(
    original.script,
    true,
    "/offline/aggregate-origin.json",
    { jobId: "aggregate-origin" },
    { mapPath: (value) => value },
  );
  const prepared = retainPythonOrigin(
    receipt,
    pythonArtifactManifest(original),
  );
  const report = await checker.check({
    artifact: prepared,
    context: { kind: "raw" },
    unitContexts: pythonUnitContexts(prepared),
  });

  assert.equal(report.status, "incomplete", JSON.stringify(report));
  const beta = report.diagnostics.find(
    (diagnostic) => diagnostic.unitId === "beta-runtime",
  );
  assert.ok(beta, JSON.stringify(report));
  assert.ok(
    report.reasons.some((reason) =>
      reason.includes(`${beta.filename}: reportAny`),
    ),
    `aggregate reason lost the mapped source identity: ${JSON.stringify({ beta, reasons: report.reasons })}`,
  );
});

test("aggregate fails closed for OOM, timeout, incomplete, partial and missing later-group reports", async (t) => {
  const cases = [
    ["oom-second", "tool_error", /exit|memory limit/i],
    ["timeout-second", "tool_error", /timeout/i],
    ["incomplete-second", "incomplete", /reportAny/i],
    ["partial-second", "tool_error", /every declared unit/i],
    ["missing-second", "tool_error", /JSON|Unexpected/i],
  ] as const;
  for (const [mode, expectedStatus, reason] of cases) {
    const { checker, evidencePath } = await fakeChecker(t, mode);
    const report = await checker.check({
      artifact: groupedArtifact(false),
      context: { kind: "raw" },
    });
    const passes = await readEvidence(evidencePath);
    assert.equal(passes.length, 2, `${mode} did not reach a second group`);
    assert.equal(
      report.status,
      expectedStatus,
      `${mode}: ${JSON.stringify(report)}`,
    );
    assert.match(
      report.reasons.join(" "),
      reason,
      `${mode}: ${JSON.stringify(report)}`,
    );
  }
});

test("origin omissions, duplicate maps, changed hashes and final-byte tampering cannot be certified", async (t) => {
  const { checker, evidencePath } = await fakeChecker(t);
  const base = artifact([
    {
      id: "origin-runtime",
      filename: "origin-runtime.py",
      role: "runtime",
      source: "VALUE: int = 1\n",
    },
  ]);

  const changedBytes = {
    ...base,
    script: "VALUE: int = 2\n",
  };
  assert.equal(
    (await checker.check({ artifact: changedBytes, context: { kind: "raw" } }))
      .status,
    "tool_error",
  );

  const forgedMap = {
    ...base,
    sourceMap: [{ ...present(base.sourceMap[0]), unitId: "undeclared-unit" }],
  };
  forgedMap.artifactHash = hash(
    JSON.stringify({
      version: forgedMap.version,
      units: forgedMap.units,
      context: forgedMap.context,
      request: forgedMap.request,
      sourceMap: forgedMap.sourceMap,
      sha256: forgedMap.sha256,
    }),
  );
  assert.equal(
    (await checker.check({ artifact: forgedMap, context: { kind: "raw" } }))
      .status,
    "tool_error",
  );

  const { preparePythonArtifact: prepare } = load(
    "../packages/node-adapters/dist/python/artifact",
  ) as typeof import("../packages/node-adapters/src/python/artifact");
  const { pythonArtifactManifest: manifest, retainPythonOrigin: retain } = load(
    "../packages/node-adapters/dist/python/context-binding",
  ) as typeof import("../packages/node-adapters/src/python/context-binding");
  const original = prepare(
    [
      {
        id: "mapped-source",
        filename: "mapped-source.py",
        role: "runtime",
        source: "ORIGIN_VALUE: int = 1\n",
      },
      {
        id: "embedded-source",
        filename: "embedded-source.py",
        role: "runtime",
        source: "EMBEDDED_VALUE: int = 2\n",
        embedded: true,
      },
    ],
    {
      context: {
        unitContexts: {
          "mapped-source": {
            kind: "cad-v1",
            deferredFacade: true,
            entrypoint: "run-if-present",
          },
        },
      },
    },
  );
  const wrapped = prepare([
    {
      id: "receipt-wrapper",
      filename: "receipt-wrapper.py",
      role: "wrapper",
      source: `# receipt\n${original.script}`,
    },
  ]);
  const retained = retain(wrapped, manifest(original));
  const origin = retainedOrigin(retained);

  const cases = [
    [
      "missing mapped unit",
      {
        ...origin,
        units: origin.units.filter((unit) => unit.id !== "mapped-source"),
      },
    ],
    [
      "duplicate source-map entry",
      { ...origin, sourceMap: [...origin.sourceMap, origin.sourceMap[0]] },
    ],
    ["changed original source hash", { ...origin, sha256: "0".repeat(64) }],
    [
      "missing source-map entry",
      { ...origin, sourceMap: origin.sourceMap.slice(1) },
    ],
  ];
  for (const [label, nextOrigin] of cases) {
    const context = { ...record(retained.context), origin: nextOrigin };
    const malformed = rebind(retained, context);
    const report = await checker.check({
      artifact: malformed,
      context: { kind: "raw" },
      unitContexts: {},
    });
    assert.notEqual(
      report.status,
      "passed",
      `${label} was accepted: ${JSON.stringify(report)}`,
    );
  }
  assert.deepEqual(await readEvidence(evidencePath), []);
});

test("declared embedded runtime bytes cannot disappear from a passing aggregate", async (t) => {
  const { checker } = await fakeChecker(t);
  const prepared = artifact([
    {
      id: "mapped-runtime",
      filename: "mapped-runtime.py",
      role: "runtime",
      source: "MAPPED: int = 1\n",
    },
    {
      id: "embedded-runtime",
      filename: "embedded-runtime.py",
      role: "runtime",
      source: "EMBEDDED: int = 2\n",
      embedded: true,
    },
  ]);
  const report = await checker.check({
    artifact: prepared,
    context: { kind: "raw" },
  });

  assert.notEqual(
    report.status,
    "passed",
    `runtime unit absent from the checked source map was treated as covered: ${JSON.stringify(report)}`,
  );
});

test("analysis provenance binds exact source, namespace context and resource fingerprint", async (t) => {
  const { checker, evidencePath } = await fakeChecker(t);
  const source = artifact([
    {
      id: "bound-source",
      filename: "bound-source.py",
      role: "runtime",
      source: "def run(context: str) -> None:\n    pass\n",
    },
  ]);
  const request = (
    prepared: PreparedPythonArtifact,
    context: import("@fmcad/core").PythonCheckContext,
  ) => ({ artifact: prepared, context });
  const first = await checker.check(request(source, { kind: "raw" }));
  const changedSource = artifact([
    {
      id: "bound-source",
      filename: "bound-source.py",
      role: "runtime",
      source:
        "def run(context: str) -> None:\n    pass\n# changed source bytes\n",
    },
  ]);
  const second = await checker.check(request(changedSource, { kind: "raw" }));
  const third = await checker.check(
    request(source, { kind: "raw", entrypoint: "run" }),
  );
  const otherResource = createPythonChecker({
    typingRoot,
    temporaryRoot: path.dirname(evidencePath),
    engineEntrypoint: path.join(
      path.dirname(evidencePath),
      "recording-checker.cjs",
    ),
    checkerResources: () => "b".repeat(64),
  });
  const fourth = await otherResource.check(request(source, { kind: "raw" }));

  for (const report of [first, second, third, fourth])
    assert.equal(report.status, "passed", JSON.stringify(report));
  assert.notEqual(first.provenance.wireHash, second.provenance.wireHash);
  assert.notEqual(
    first.provenance.artifactHash,
    second.provenance.artifactHash,
  );
  assert.notEqual(first.provenance.contextHash, third.provenance.contextHash);
  assert.notEqual(
    first.provenance.analysisHash,
    second.provenance.analysisHash,
  );
  assert.notEqual(first.provenance.analysisHash, third.provenance.analysisHash);
  assert.notEqual(first.provenance.checkerHash, fourth.provenance.checkerHash);
  assert.notEqual(
    first.provenance.analysisHash,
    fourth.provenance.analysisHash,
  );

  const embeddedA = artifact([
    {
      id: "wire-unit",
      filename: "wire-unit.py",
      role: "runtime",
      source: "VALUE: int = 1\n",
    },
    {
      id: "unmapped-unit",
      filename: "unmapped.py",
      role: "user",
      source: "HIDDEN: int = 1\n",
      embedded: true,
    },
  ]);
  const embeddedB = artifact([
    {
      id: "wire-unit",
      filename: "wire-unit.py",
      role: "runtime",
      source: "VALUE: int = 1\n",
    },
    {
      id: "unmapped-unit",
      filename: "unmapped.py",
      role: "user",
      source: "HIDDEN: int = 2\n",
      embedded: true,
    },
  ]);
  const fifth = await checker.check(request(embeddedA, { kind: "raw" }));
  const sixth = await checker.check(request(embeddedB, { kind: "raw" }));
  assert.equal(fifth.status, "passed", JSON.stringify(fifth));
  assert.equal(sixth.status, "passed", JSON.stringify(sixth));
  assert.equal(fifth.provenance.wireHash, sixth.provenance.wireHash);
  assert.notEqual(fifth.provenance.artifactHash, sixth.provenance.artifactHash);
  assert.notEqual(fifth.provenance.analysisHash, sixth.provenance.analysisHash);
  for (const report of [first, second, third, fourth]) {
    for (const key of [
      "artifactHash",
      "wireHash",
      "contextHash",
      "checkerHash",
      "typingHash",
      "configHash",
      "analysisHash",
    ])
      assert.match(text(record(report.provenance)[key]), /^[a-f0-9]{64}$/);
  }
});

test("resource fingerprint change during real checking invalidates the admission certificate", async () => {
  const { preparePythonArtifact: prepare } = load(
    "../packages/node-adapters/dist/python/artifact",
  ) as typeof import("../packages/node-adapters/src/python/artifact");
  const runtime = path.resolve("dist/runtime/python");
  let resources = "a".repeat(64);
  const checker = createPythonChecker({
    typingRoot: path.join(runtime, "typing"),
    checkerResources: () => resources,
  });
  const admission = createPythonRpcAdmission({
    runtime,
    resources: () => resources,
    checker: {
      async check(request, options) {
        const report = await checker.check(request, options);
        resources = "b".repeat(64);
        return report;
      },
    },
  });
  const prepared = prepare([
    {
      id: "wire",
      filename: "wire.py",
      role: "user",
      source: "value: int = 1\n",
    },
  ]);
  const rpc = {
    method: "tools/call",
    params: {
      name: "execute_python",
      arguments: { code: prepared.script },
    },
  };
  await assert.rejects(
    admission.check(rpc, prepared),
    (error) =>
      record(error)["code"] === "PYTHON_ADMISSION_CHANGED" &&
      /changed after analysis/.test(text(record(error)["message"])),
  );
});

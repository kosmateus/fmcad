import type { TestContext } from "node:test";
import type { SourceInput } from "../packages/node-adapters/src/python/artifact";
import type { PythonCheckerOptions } from "../packages/node-adapters/src/python/checker";
import type {
  PythonCheckContext,
  PythonCheckRequest,
} from "../packages/core/src/domain/python-checker";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
const load = createRequire(path.resolve("package.json"));
const { createPythonChecker } = load(
  "./packages/node-adapters/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { preparePythonArtifact } = load(
  "./packages/node-adapters/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { pythonUnitContexts } = load(
  "./packages/node-adapters/dist/python/context-binding",
) as typeof import("../packages/node-adapters/src/python/context-binding");
const { runCheckerProcess } = load(
  "./packages/node-adapters/dist/python/checker-process",
) as typeof import("../packages/node-adapters/src/python/checker-process");
const typingRoot = path.resolve("runtime/python/typing");
const fixtureRoot = path.resolve("tests/fixtures/python-checker");
const hash = (data: string) => createHash("sha256").update(data).digest("hex");
async function temporary(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fmcad-check-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
// Synthetic SDK, not a claim of complete Autodesk definitions. Matches the
// immutable producer's file contract and exercises the real checker resolver.
async function definitions(t: TestContext) {
  const root = await temporary(t);
  const files = Object.fromEntries(
    ["__init__", "cam", "drawing", "electron", "fusion", "sim", "volume"].map(
      (n) => [`adsk/${n}.py`, ""],
    ),
  );
  files["adsk/core.py"] = await fs.readFile(
    path.join(fixtureRoot, "adsk/core.py"),
    "utf8",
  );
  for (const name of ["LICENSE.upstream", "README.upstream.md", "NOTICES.md"])
    files[name] = "synthetic test resource";
  const manifest = JSON.stringify({
    schema: 1,
    repository: "AutodeskFusion360/FusionAPIReference",
    generator: "fmcad-annotated-copy-v1",
    overlay: "point3d-nullable-v1",
    authorization:
      "user-authorized-2026-10-24; Autodesk rights unverified; not legal clearance",
    commit: "a".repeat(40),
    files: Object.fromEntries(
      Object.entries(files).map(([n, s]) => [n, hash(s)]),
    ),
  });
  const snapshot = hash(manifest);
  const directory = path.join(root, "snapshots", snapshot);
  await fs.mkdir(path.join(directory, "adsk"), { recursive: true });
  await Promise.all(
    Object.entries(files).map(([n, s]) =>
      fs.writeFile(path.join(directory, n), s),
    ),
  );
  await fs.writeFile(path.join(directory, "manifest.json"), manifest);
  await fs.writeFile(
    path.join(root, "current.json"),
    JSON.stringify({ snapshot }),
  );
  return { root, directory };
}
function artifact(source: string, more: SourceInput[] = []) {
  return preparePythonArtifact([
    { id: "user", filename: "drawing.py", source, role: "user" },
    ...more,
  ]);
}
async function check(
  source: string,
  options: Partial<PythonCheckerOptions> = {},
  context: PythonCheckContext = { kind: "raw" },
  extra: Partial<PythonCheckRequest> = {},
) {
  return createPythonChecker({ typingRoot, ...options }).check({
    artifact: artifact(source),
    context,
    ...extra,
  });
}

test("real engine detects argument, nullable access and nonexistent member with original positions", async (t) => {
  const { root } = await definitions(t);
  const source = await fs.readFile(path.join(fixtureRoot, "errors.py"), "utf8");
  const result = await check(source, { definitionsRoot: root });
  assert.equal(result.status, "failed", JSON.stringify(result));
  for (const [rule, line] of [
    ["reportArgumentType", 3],
    ["reportOptionalMemberAccess", 4],
    ["reportAttributeAccessIssue", 6],
  ])
    assert.ok(
      result.diagnostics.some(
        (d) =>
          d.rule === rule &&
          d.filename === "drawing.py" &&
          d.unitId === "user" &&
          d.line === line,
      ),
      JSON.stringify(result),
    );
  assert.ok(!result.diagnostics.some((d) => d.rule === "reportMissingImports"));
  assert.match(text(result.provenance.definitionsHash), /^[a-f0-9]{64}$/);
});

test("passed requires full local analysis; unknown imports, Any, missing producers and dynamic eval cannot pass", async (t) => {
  assert.equal((await check("value: int = 1")).status, "passed");
  for (const source of [
    "import missing_fmcad_fixture\nmissing_fmcad_fixture.build()",
    "from typing import Any\nx: Any = 1",
    "s: str = input()\nexec(s)",
    'e = exec\ne("x: int = 1")',
    'from typing import no_type_check\n@no_type_check\ndef ignored() -> None:\n    x: int = "bad"',
    'from typing import no_type_check as bypass\n@bypass\ndef ignored() -> None:\n    x: int = "bad"',
  ]) {
    const result = await check(source);
    assert.equal(result.status, "incomplete", JSON.stringify(result));
  }
  assert.equal(
    (await check("x: int = 1", {}, { kind: "run" })).status,
    "incomplete",
  );
  assert.equal(
    (
      await check("x: int = 1", {
        definitionsRoot: path.join(await temporary(t), "absent"),
      })
    ).status,
    "incomplete",
  );
  const { root, directory } = await definitions(t);
  await fs.appendFile(path.join(directory, "adsk/core.py"), "# tampered");
  assert.equal(
    (await check("x: int = 1", { definitionsRoot: root })).status,
    "incomplete",
  );
});

test("literal exec/compile (including nested and uncalled) and all declared units are analyzed", async () => {
  const source = `exec(compile(${JSON.stringify('x: int = "bad"')}, 'nested.py', 'exec'))\nexec(${JSON.stringify("z: str = 123")})`;
  const result = await check(source);
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.ok(
    result.diagnostics.some(
      (d) =>
        d.filename === "nested.py" &&
        d.line === 1 &&
        d.rule === "reportAssignmentType",
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (d) =>
        d.filename.includes(":literal:2") && d.rule === "reportAssignmentType",
    ),
  );
  const declared = artifact("x: int = 1", [
    {
      id: "unused",
      filename: "unused.py",
      source: "a: str = 1",
      role: "user",
      embedded: true,
    },
  ]);
  const report = await createPythonChecker({ typingRoot }).check({
    artifact: declared,
    context: { kind: "raw" },
  });
  assert.ok(
    report.diagnostics.some(
      (d) => d.unitId === "unused" && d.rule === "reportAssignmentType",
    ),
  );
});

test("exact declared exec payload is checked separately while the final wrapper stays mapped", async () => {
  const embedded = 'value: int = "bad"\n';
  const wrapper = [
    "def run(context: str) -> None:",
    "    namespace: dict[str, object] = {}",
    `    exec(compile(${JSON.stringify(embedded)}, 'checked.py', 'exec'), namespace, namespace); _FMCAD_WRAPPER_ERROR: int = "bad"`,
  ].join("\n");
  const artifact = preparePythonArtifact(
    [
      {
        id: "embedded",
        filename: "checked.py",
        source: embedded,
        role: "user",
        embedded: true,
      },
      {
        id: "wrapper",
        filename: "wrapper.py",
        source: wrapper,
        role: "wrapper",
      },
    ],
    { context: { entrypoints: ["wrapper.py"] } },
  );
  const result = await createPythonChecker({ typingRoot }).check({
    artifact,
    context: { kind: "raw", entrypoint: "run" },
    unitContexts: pythonUnitContexts(artifact),
  });
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.ok(
    result.diagnostics.some(
      (d) => d.filename === "checked.py" && d.rule === "reportAssignmentType",
    ),
    JSON.stringify(result.diagnostics),
  );
  const wrapperError = result.diagnostics.find(
    (d) => d.filename === "wrapper.py" && d.rule === "reportAssignmentType",
  );
  assert(wrapperError, JSON.stringify(result.diagnostics));
  assert.equal(wrapperError.line, 3);
  assert.equal(
    wrapperError.column,
    present(wrapper.split("\n")[2]).lastIndexOf('"bad"') + 1,
  );
  assert.equal(result.provenance.wireHash, artifact.sha256);
  assert.equal(result.provenance.artifactHash, artifact.artifactHash);
});

test("explicit namespace contexts, deferred FMCAD and future/docstring source mapping", async (t) => {
  const { root } = await definitions(t);
  const options = { definitionsRoot: root };
  const source =
    '"""module"""\nfrom __future__ import annotations\nui.messageBox(123)';
  const result = await check(source, options, { kind: "bundle", ui: true });
  assert.ok(
    result.diagnostics.some(
      (d) => d.rule === "reportArgumentType" && d.line === 3,
    ),
  );
  const application = await check(
    'app.userInterface.messageBox("ok")',
    options,
    { kind: "bundle", app: true },
  );
  assert.equal(application.status, "passed", JSON.stringify(application));
  assert.equal(
    (await check('ui.messageBox("x")', options, { kind: "run" })).status,
    "failed",
  );
  assert.equal(
    (
      await check("FMCAD.emit({})", options, {
        kind: "cad-v1",
        deferredFacade: true,
      })
    ).status,
    "failed",
  );
  const deferred = await check(
    'def run(context: object) -> None:\n    FMCAD.length("1 mm")',
    options,
    { kind: "cad-v1", deferredFacade: true },
  );
  assert.equal(deferred.status, "passed", JSON.stringify(deferred));
  const stageRead = await check(
    "def run(context: object) -> None:\n    FMCAD.stage()\n    FMCAD.journalInspect()\n    FMCAD.resumePlan()",
    options,
    { kind: "cad-v1", deferredFacade: true },
  );
  assert.equal(stageRead.status, "passed", JSON.stringify(stageRead));
  const earlyCall = await check(
    "def use() -> None:\n    FMCAD.emit({})\nuse()",
    options,
    { kind: "cad-v1", deferredFacade: true },
  );
  assert.notEqual(earlyCall.status, "passed");
  const wrapper = artifact(
    'exec(compile("ui.messageBox(123)", "child.py", "exec"))',
  );
  const embedded = await createPythonChecker({ typingRoot, ...options }).check({
    artifact: wrapper,
    context: { kind: "bundle", ui: true },
  });
  assert.ok(
    embedded.diagnostics.some(
      (d) => d.filename === "child.py" && d.rule === "reportUndefinedVariable",
    ),
  );
});

test("checker directives cannot hide submitted errors and code/import bodies are never run", async (t) => {
  const root = await temporary(t);
  const marker = path.join(root, "executed");
  const source = `# pyright: reportAssignmentType=false\nx: int = "bad" # type: ignore\nopen(${JSON.stringify(marker)}, "w").write("executed")`;
  const result = await check(source);
  assert.equal(result.status, "failed");
  assert.ok(
    result.diagnostics.some(
      (d) => d.rule === "reportAssignmentType" && d.line === 2,
    ),
  );
  await assert.rejects(fs.access(marker));
  const host = path.join(root, "host");
  await fs.mkdir(host);
  await fs.writeFile(
    path.join(host, "pyrightconfig.json"),
    '{"typeCheckingMode":"off","exclude":["**"]}',
  );
  const previous = process.cwd(),
    oldPythonPath = process.env["PYTHONPATH"],
    oldNodeOptions = process.env["NODE_OPTIONS"];
  try {
    process.chdir(host);
    process.env["PYTHONPATH"] = host;
    process.env["NODE_OPTIONS"] = "--require=bad-module";
    assert.equal((await check('x: int = "bad"')).status, "failed");
    await fs.writeFile(path.join(host, "local_only.py"), "value: int = 1");
    assert.equal(
      (await check("import local_only\nprint(local_only.value)")).status,
      "incomplete",
    );
  } finally {
    process.chdir(previous);
    if (oldPythonPath === undefined) delete process.env["PYTHONPATH"];
    else process.env["PYTHONPATH"] = oldPythonPath;
    if (oldNodeOptions === undefined) delete process.env["NODE_OPTIONS"];
    else process.env["NODE_OPTIONS"] = oldNodeOptions;
  }
});

test("bounded process: timeout, memory/output, wrong JSON/exit and missing tools fail closed", async (t) => {
  const root = await temporary(t);
  const engine = path.join(root, "engine.cjs");
  const cases: [string, NonNullable<PythonCheckerOptions["limits"]>, RegExp][] =
    [
      ['console.log("not json")', {}, /JSON|Unexpected/],
      ["process.exit(7)", {}, /exit: 7/],
      ["setTimeout(()=>{},10000)", { timeoutMs: 200 }, /timeout/],
      [
        'console.log("x".repeat(3000000))',
        { outputBytes: 100000 },
        /output limit/,
      ],
      ["setTimeout(()=>{},10000)", { memoryBytes: 1 }, /memory limit/],
      [
        'console.log(JSON.stringify({version:"1.40.2",summary:{filesAnalyzed:1,errorCount:0},generalDiagnostics:Array(2001).fill({})}))',
        {},
        /Diagnostic limit/,
      ],
      [
        'console.log(JSON.stringify({version:"1.40.2",summary:{filesAnalyzed:0,errorCount:0},generalDiagnostics:[]}))',
        {},
        /every declared unit/,
      ],
      [
        'console.log(JSON.stringify({version:"1.40.2",summary:{filesAnalyzed:1,errorCount:1},generalDiagnostics:[]}))',
        {},
        /summary/,
      ],
    ];
  for (const [source, limits, pattern] of cases) {
    await fs.writeFile(engine, source);
    const report = await check("x: int = 1", {
      engineEntrypoint: engine,
      limits,
    });
    assert.equal(report.status, "tool_error", JSON.stringify(report));
    assert.match(report.reasons.join(" "), pattern);
  }
  assert.equal(
    (
      await check("x: int = 1", {
        pythonExecutable: path.join(root, "missing"),
      })
    ).status,
    "tool_error",
  );
  const realTimeout = await check("x: int = 1", { limits: { timeoutMs: 150 } });
  assert.equal(realTimeout.status, "tool_error", JSON.stringify(realTimeout));
  assert.match(realTimeout.reasons.join(" "), /timeout/);
  const input = artifact("x: int = 1");
  const changed = { ...input, script: 'x: int = "bad"' };
  assert.equal(
    (
      await createPythonChecker({ typingRoot }).check({
        artifact: changed,
        context: { kind: "raw" },
      })
    ).status,
    "tool_error",
  );
  const result = await runCheckerProcess(
    process.execPath,
    ["-e", "setTimeout(()=>{},10000)"],
    root,
    { timeoutMs: 50, outputBytes: 1024, memoryBytes: 768 * 1024 * 1024 },
  );
  assert.equal(result.problem, "timeout");
});

test("cancelled checker subprocess is killed and reported as aborted", async (t) => {
  const root = await temporary(t);
  const controller = new AbortController();
  const pending = runCheckerProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    root,
    { timeoutMs: 10000, outputBytes: 1024, memoryBytes: 768 * 1024 * 1024 },
    "",
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  const result = await pending;
  assert.equal(result.problem, "aborted");
  assert.equal(result.code, null);
  assert.equal(Buffer.byteLength(result.stdout + result.stderr), 0);
});

test("provenance binds source, contexts, stubs/config/engine/Python; no report cache", async (t) => {
  const { root } = await definitions(t);
  const a = await check("x: int = 1", { definitionsRoot: root });
  const b = await check("x: int = 1", { definitionsRoot: root });
  assert.equal(a.provenance.analysisHash, b.provenance.analysisHash);
  assert.equal(a.provenance.cache, "disabled");
  for (const key of [
    "checkerHash",
    "typingHash",
    "configHash",
    "definitionsHash",
    "contextHash",
    "analysisHash",
  ] as const)
    assert.match(text(a.provenance[key]), /^[a-f0-9]{64}$/);
  const c = await check("x: int = 2", { definitionsRoot: root });
  const d = await check("x: int = 1", {
    definitionsRoot: root,
    pythonVersion: "3.12",
  });
  assert.notEqual(a.provenance.analysisHash, c.provenance.analysisHash);
  assert.notEqual(a.provenance.analysisHash, d.provenance.analysisHash);
  assert.ok(
    !(await fs.readdir(root)).some((name) => name.startsWith("fmcad-check-")),
  );
});

function present<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import type { PythonSelectionFacts } from "../packages/core/src/application/cad/source-selection";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { selectPythonSources } = load(
  "./packages/core/dist/application/cad/source-selection",
) as typeof import("../packages/core/src/application/cad/source-selection");
const { selectRunBundle } = load(
  "./packages/node-adapters/dist/python/source-selection",
) as typeof import("../packages/node-adapters/src/python/source-selection");
const { cadBundleUnits } = load(
  "./packages/node-adapters/dist/python/bundle",
) as typeof import("../packages/node-adapters/src/python/bundle");
const { preparePythonArtifact, verifyPythonArtifact } = load(
  "./packages/node-adapters/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");

test("literal facade dispatch automatically closes transitive operation and source dependencies", () => {
  const units = selectRunBundle(
    root,
    "def run(context):\n    FMCAD.call('shape.box', {})\n",
  );
  const ids = units.map((unit) => unit.id);
  for (const id of [
    "core",
    "identity",
    "helpers",
    "geometry-shapes-application",
    "geometry-model-application",
    "geometry-sketch-application",
  ])
    assert.ok(ids.includes(id), id);
  for (const id of ["cam", "optics", "sheetmetal"])
    assert.ok(!ids.includes(id), id);
  assert.ok(units.length < cadBundleUnits(root).length);
  const facade = units.find((unit) => unit.id === "helpers")!.source;
  assert.match(facade, /def call\(/);
  assert.match(facade, /def resolve\(/);
  assert.match(facade, /def terminal\(/);
  assert.doesNotMatch(facade, /def parameter_test\(/);
  const artifact = preparePythonArtifact(units);
  verifyPythonArtifact(artifact);
  assert.throws(
    () =>
      verifyPythonArtifact({ ...artifact, script: artifact.script + "\npass" }),
    /bytes changed/,
  );
});

test("automatic registration analysis retains predecessor captures and ordered overrides", () => {
  for (const [operation, paths] of [
    ["shape.helix", ["geometry_shapes.py", "spring.py"]],
    ["model.thread", ["geometry_model.py", "thread.py"]],
  ] as const) {
    const units = selectRunBundle(
      root,
      `def run(context):\n    FMCAD.call('${operation}', {})\n`,
    );
    const predecessor = units.findIndex((unit) =>
      unit.filename.endsWith(paths[0]),
    );
    const successor = units.findIndex(
      (unit) =>
        unit.filename.endsWith(paths[1]) &&
        unit.filename.includes("adapters/fusion"),
    );
    assert.ok(predecessor >= 0, operation);
    assert.ok(successor > predecessor, operation);
  }
});

test("unresolved dispatch, facade escapes and reflection retain the exact complete runtime", () => {
  const full = cadBundleUnits(root);
  for (const source of [
    "def run(context):\n    FMCAD.call(context, {})",
    "def run(context):\n    dispatch = FMCAD.call\n    dispatch('shape.box', {})",
    "def run(context):\n    getattr(FMCAD, context)({})",
    "def run(context):\n    fn = eval\n    fn(context)",
    "import inspect\ndef run(context):\n    FMCAD.emit(None)",
    "def run(context):\n    FMCAD.emit((1).__class__.__base__)",
  ]) {
    assert.deepEqual(selectRunBundle(root, source), full, source);
  }
});

test("literal alternatives and loop dispatch are analysed without running submitted code", () => {
  const source =
    "raise RuntimeError('must not execute offline')\ndef run(context):\n    for operation in ('shape.box', 'component.create'):\n        FMCAD.call(operation, {})\n";
  const units = selectRunBundle(root, source);
  assert.ok(units.some((unit) => unit.id === "assembly-fusion"));
  assert.ok(units.some((unit) => unit.id === "geometry-shapes-application"));
  assert.ok(!units.some((unit) => unit.id === "cam"));
});

test("selected facade preserves emission sentinel, validation and terminal output", () => {
  const selected = selectRunBundle(
    root,
    "def run(context):\n    FMCAD.emit(None)\n",
  );
  const full = cadBundleUnits(root);
  const execute = (source: string) => {
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        `
import sys, types
namespace = {'CAD_HANDLERS': types.SimpleNamespace()}
exec(compile(sys.stdin.read(), '<facade-test>', 'exec'), namespace)
facade = namespace['FMCAD'](types.SimpleNamespace())
try:
    facade.emit(float('nan'))
except ValueError:
    pass
else:
    raise AssertionError('NaN must be rejected')
assert not facade.has_emitted
facade.emit(None)
assert facade.has_emitted
try:
    facade.emit({})
except RuntimeError:
    pass
else:
    raise AssertionError('Second emission must be rejected')
facade.terminal()
`,
      ],
      { input: source, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const observed = execute(
    selected.find((unit) => unit.id === "helpers")!.source,
  );
  assert.equal(
    observed,
    execute(full.find((unit) => unit.id === "helpers")!.source),
  );
  assert.deepEqual(JSON.parse(observed.replace(/^FMCAD_RESULT /, "")), {
    success: true,
    helperCallsOnly: [],
    result: null,
  });
});

test("definition dependencies do not turn an unreachable dynamic callable into a runtime root", () => {
  const sources = {
    core: "class CadContext:\n    pass\n",
    identity:
      "def _document_target(): pass\ndef _document_assert_identity(): pass\ndef _document_activate_target(): pass\n",
    helpers:
      "class FMCAD:\n    def __init__(self): pass\n    def emit(self): pass\n    def terminal(self): pass\n    def ping(self): return _bridge()\n",
    bridge: "def _bridge(): return _leaf()\n",
    leaf: "def _leaf(): return 42\ndef _unused(ctx, operation): return ctx.call(operation, {})\n",
    unrelated: "def _spare(): return 7\n",
  };
  const analyse = (leaf: string) => {
    const parsed = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-B",
        path.join(root, "runtime/python/entrypoints/dependency_facts.py"),
      ],
      {
        input: JSON.stringify({
          source: "def run(context):\n    FMCAD.ping()\n",
          units: Object.entries({ ...sources, leaf }).map(([id, source]) => ({
            id,
            filename: id + ".py",
            source,
            dependencies: [],
          })),
        }),
        encoding: "utf8",
      },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
    const result = JSON.parse(parsed.stdout) as {
      unsupported: boolean;
      facts: PythonSelectionFacts;
    };
    assert.equal(result.unsupported, false);
    return selectPythonSources(result.facts);
  };
  const selected = analyse(sources.leaf);
  assert.equal(selected.mode, "static");
  assert.ok(selected.units.includes("bridge"));
  assert.ok(selected.units.includes("leaf"));
  assert.ok(!selected.units.includes("unrelated"));
  const dynamic = analyse(
    "def _leaf(): return _unused(None, 'runtime')\ndef _unused(ctx, operation): return ctx.call(operation, {})\n",
  );
  assert.equal(dynamic.mode, "conservative");
  assert.ok(dynamic.units.includes("unrelated"));
});

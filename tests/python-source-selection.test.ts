import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import type { PythonSelectionFacts } from "../packages/core/src/application/cad/source-selection";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { selectPythonSources, unusedPythonDefinitions } = load(
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

test("declaration selection preserves eager effects, captured predecessors and checked type dependencies", () => {
  const source = `from typing import TYPE_CHECKING, TypedDict, Protocol, NotRequired as OptionalField, cast
from functools import wraps
events = []
class CadContext:
    pass
class Result:
    pass
class Unused:
    pass
class UnusedRecord(TypedDict):
    value: float | None
class UnusedCollectionRecord(TypedDict):
    origin: list[float]
    direction: list[float] | None
    connects: list['ResultType'] | tuple['ResultType', ...]
    rigid: OptionalField['ResultType']
class ReferencedRecord(TypedDict):
    values: list[float]
class CastRecord(TypedDict):
    values: list[float]
class UnusedProtocol(Protocol):
    values: list['ResultType']
if TYPE_CHECKING:
    class UnusedType:
        pass
    class ResultType:
        pass
def decorate(fn):
    events.append('decorator')
    return fn
def default():
    events.append('default')
    return 1
@decorate
def decorated():
    return 2
def initialized(value=default()):
    return value
def pure_factory(label):
    def decorate(handler):
        @wraps(handler)
        def wrapped(*args, **kwargs):
            return handler(*args, **kwargs)
        setattr(wrapped, 'label', label)
        return wrapped
    return decorate
@pure_factory('unused')
def unused_decorated():
    return 0
class Meta(type):
    def __new__(mcls, name, bases, namespace):
        events.append('metaclass')
        return super().__new__(mcls, name, bases, namespace)
class InitializedClass(metaclass=Meta):
    pass
class FieldType:
    def __class_getitem__(cls, item):
        events.append('subscription')
        return str
class InitializedRecord(TypedDict):
    value: FieldType[str]
def previous():
    return 40
captured = previous
def previous():
    return 99
def needed(record: 'ReferencedRecord' = None) -> 'ResultType':
    cast(CastRecord, record)
    return captured() + 2
def unused():
    return 0
CAD_HANDLERS = {}
CAD_HANDLERS.update({'unused.🧪': unused, 'demo.op': needed,
                     'unused.last': unused})
`;
  const sources = {
    core: source,
    identity:
      "def _document_target(): pass\ndef _document_assert_identity(): pass\ndef _document_activate_target(): pass\n",
    helpers:
      "class FMCAD:\n    def __init__(self): pass\n    def emit(self): pass\n    def terminal(self): pass\n",
  };
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
        source: "def run(context):\n    FMCAD.call('demo.op', {})\n",
        units: Object.entries(sources).map(([id, source]) => ({
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
  const selection = selectPythonSources(result.facts);
  assert.equal(selection.mode, "static");
  const removed = unusedPythonDefinitions(result.facts, selection);
  const bytes = Buffer.from(source);
  for (const entry of removed.filter((entry) => entry.unit === "core")) {
    if (entry.byteStart === undefined || entry.byteEnd === undefined) continue;
    for (let offset = entry.byteStart; offset < entry.byteEnd; offset++)
      if (bytes[offset] !== 10 && bytes[offset] !== 13) bytes[offset] = 32;
  }
  const lines = bytes.toString().split("\n");
  for (const entry of removed.filter((entry) => entry.unit === "core")) {
    if (entry.byteStart !== undefined) continue;
    for (let line = entry.start - 1; line < entry.end; line++) lines[line] = "";
    lines[entry.start - 1] = " ".repeat(entry.column) + "pass";
  }
  const selected = lines.join("\n");
  assert.doesNotMatch(
    selected,
    /class Unused|def unused\(|def unused_decorated\(/,
  );
  assert.match(selected, /class ResultType/);
  assert.match(selected, /class ReferencedRecord/);
  assert.match(selected, /class CastRecord/);
  assert.match(selected, /@decorate/);
  assert.match(selected, /value=default\(\)/);
  const executed = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      selected +
        "\nassert needed() == 42\nassert events == ['decorator', 'default', 'metaclass', 'subscription']\nassert set(CAD_HANDLERS) == {'demo.op'}\n",
    ],
    { encoding: "utf8" },
  );
  assert.equal(executed.status, 0, executed.stderr);
});

test("qualified typing guards require an unshadowed, unescaped module import", () => {
  for (const [setup, guard, removable] of [
    ["import typing", "typing.TYPE_CHECKING", true],
    ["import typing as types", "types.TYPE_CHECKING", true],
    ["import other as types", "types.TYPE_CHECKING", false],
    ["import typing as types\ntypes = custom", "types.TYPE_CHECKING", false],
    [
      "import typing as types\ntypes.TYPE_CHECKING = True",
      "types.TYPE_CHECKING",
      false,
    ],
    ["import typing as types\nmutate(types)", "types.TYPE_CHECKING", false],
    [
      "import typing as types\nnamespace = types.__dict__",
      "types.TYPE_CHECKING",
      false,
    ],
    [
      "import typing as types\nfrom other import value as types",
      "types.TYPE_CHECKING",
      false,
    ],
  ] as const) {
    const source = `${setup}\nif ${guard}:\n    class Guarded(effect()):\n        pass\n`;
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
          source: "def run(context): pass",
          generated: true,
          units: [
            { id: "core", filename: "core.py", source, dependencies: [] },
          ],
        }),
        encoding: "utf8",
      },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
    const result = JSON.parse(parsed.stdout) as { facts: PythonSelectionFacts };
    const declaration = result.facts.definitions?.find((entry) =>
      entry.defines.includes("Guarded"),
    );
    assert.ok(declaration, source);
    assert.equal(declaration.removable, removable, source);
  }
});

test("TypedDict annotation selection retains shadowed providers and evaluated type operators", () => {
  for (const [setup, annotation] of [
    ["list = factory()", "list[float]"],
    ["from other import list", "list[float]"],
    ["OptionalField = factory()", "OptionalField[str]"],
    ["from other import NotRequired as OptionalField", "OptionalField[str]"],
    ["", "list[UserType]"],
    ["", "list[UserType | None]"],
    ["", "list[make_type()]"],
    ["", "'Forward' | None"],
    ["", "OptionalField['Forward'] | None"],
  ]) {
    const source = `from typing import TypedDict, NotRequired as OptionalField
${setup}
class Record(TypedDict):
    field: ${annotation}
`;
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
          source: "def run(context): pass",
          generated: true,
          units: [
            { id: "core", filename: "core.py", source, dependencies: [] },
          ],
        }),
        encoding: "utf8",
      },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
    const result = JSON.parse(parsed.stdout) as {
      facts: PythonSelectionFacts;
    };
    const record = result.facts.definitions?.find((entry) =>
      entry.defines.includes("Record"),
    );
    assert.ok(record, source);
    assert.equal(record.removable, false, source);
  }
});

test("unused builtin exception subclasses are prunable only when declaration creation is inert", () => {
  const analyse = (
    runtime: string,
    user = "def run(context):\n    pass\n",
  ): PythonSelectionFacts => {
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
          source: user,
          generated: true,
          units: [
            {
              id: "core",
              filename: "core.py",
              source: runtime,
              dependencies: [],
            },
          ],
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
    return result.facts;
  };
  const removable = (runtime: string, name = "Candidate") => {
    const definition = analyse(runtime).definitions?.find((entry) =>
      entry.defines.includes(name),
    );
    assert.ok(definition, name);
    return definition.removable;
  };

  assert.equal(removable("class Candidate(Exception):\n    pass\n"), true);
  for (const [name, runtime] of [
    [
      "decorator",
      "def decorate(cls): return cls\n@decorate\nclass Candidate(Exception):\n    pass\n",
    ],
    [
      "effectful base",
      "def make_base(): return Exception\nclass Candidate(make_base()):\n    pass\n",
    ],
    [
      "class-body call",
      "def initialize(): return 1\nclass Candidate(Exception):\n    value = initialize()\n",
    ],
    [
      "class-body subscription",
      "events = []\nclass TypeFactory:\n    def __class_getitem__(cls, item):\n        events.append(item)\n        return item\nclass Candidate(Exception):\n    value: TypeFactory[str]\n",
    ],
    ["metaclass", "class Candidate(Exception, metaclass=type):\n    pass\n"],
    [
      "shadowed builtin base",
      "Exception = type('LocalException', (), {})\nclass Candidate(Exception):\n    pass\n",
    ],
  ] as const)
    assert.equal(removable(runtime), false, name);

  const facts = analyse(
    "def _error_message(): return 'unhealthy'\nclass UsedError(Exception):\n    def __init__(self): super().__init__(_error_message())\nclass UnusedError(Exception):\n    pass\n",
    "def run(context):\n    raise UsedError()\n",
  );
  const unused = unusedPythonDefinitions(facts, {
    units: ["core"],
    methods: [],
    mode: "static",
    operations: [],
  });
  const unusedNames = new Set(unused.flatMap((entry) => entry.defines));
  assert.ok(!unusedNames.has("UsedError"));
  assert.ok(!unusedNames.has("_error_message"));
  assert.ok(unusedNames.has("UnusedError"));
});

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
  const hookUnits = selectRunBundle(
    root,
    "def run(context):\n    FMCAD.call('frame.context_audit', {})\n",
  );
  assert.ok(
    hookUnits.some((unit) => unit.id === "semantic-model-state-application"),
  );
  assert.ok(
    hookUnits.some((unit) => unit.id === "semantic-model-state-fusion"),
  );
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

test("AST dependency closure handles aliases, registration hooks and dynamic reachability", () => {
  const sources = {
    core: "class CadContext:\n    pass\n",
    identity:
      "def _document_target(): pass\ndef _document_assert_identity(): pass\ndef _document_activate_target(): pass\n",
    helpers:
      "class FMCAD:\n    def __init__(self): pass\n    def emit(self): pass\n    def terminal(self): pass\n    def ping(self): return _bridge()\n",
    bridge: "def _bridge(): return _leaf()\n",
    leaf: "def _leaf(): return 42\ndef _unused(ctx, operation): return ctx.call(operation, {})\n",
    unrelated: "def _spare(): return 7\n",
    needed: "class Needed:\n    pass\n",
  };
  const analyse = (
    leaf: string,
    extra: Record<string, string> = {},
    user = "def run(context):\n    FMCAD.ping()\n",
  ) => {
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
          source: user,
          units: Object.entries({ ...sources, leaf, ...extra }).map(
            ([id, source]) => ({
              id,
              filename: id + ".py",
              source,
              dependencies: [],
            }),
          ),
        }),
        encoding: "utf8",
      },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
    const result = JSON.parse(parsed.stdout) as {
      unsupported: boolean;
      facts: PythonSelectionFacts;
    };
    if (result.unsupported)
      return { mode: "unsupported" as const, units: [] as string[] };
    return selectPythonSources(result.facts);
  };
  const selected = analyse(sources.leaf);
  assert.equal(selected.mode, "static");
  assert.ok(selected.units.includes("bridge"));
  assert.ok(selected.units.includes("leaf"));
  assert.ok(!selected.units.includes("unrelated"));
  const alias = analyse(
    "from typing import cast as adapt\ndef _leaf(): return adapt('Needed', None)\n",
  );
  assert.equal(alias.mode, "static");
  assert.ok(alias.units.includes("needed"));
  const dynamic = analyse(
    "def _leaf(): return _unused(None, 'runtime')\ndef _unused(ctx, operation): return ctx.call(operation, {})\n",
  );
  assert.equal(dynamic.mode, "conservative");
  assert.ok(dynamic.units.includes("unrelated"));
  const hooked = analyse(
    sources.leaf,
    {
      registrar:
        "def register(registry):\n    registry.update({'custom.operation': _leaf})\n",
      registration: "register(CAD_HANDLERS)\n",
    },
    "def run(context):\n    FMCAD.call('custom.operation', {})\n",
  );
  assert.equal(hooked.mode, "static");
  for (const id of ["registrar", "registration", "leaf"])
    assert.ok(hooked.units.includes(id), id);
  assert.ok(!hooked.units.includes("unrelated"));
  const initializer = analyse(sources.leaf, {
    initializer: "exec('namespace_change = True')\n",
  });
  assert.equal(initializer.mode, "conservative");
  assert.ok(initializer.units.includes("unrelated"));
  const escapedRegistry = analyse(sources.leaf, {
    registrar: "registry = CAD_HANDLERS\nregistry.update({})\n",
  });
  assert.equal(escapedRegistry.mode, "unsupported");
});

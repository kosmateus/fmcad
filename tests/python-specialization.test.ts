import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

interface Probe {
  readonly operation: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly noArguments?: boolean;
}

interface PythonException {
  readonly type: string;
  readonly message: string;
}

interface PythonObservation {
  readonly moduleException: PythonException | null;
  readonly stdout: string;
  readonly events: readonly unknown[];
  readonly outcomes: readonly {
    readonly operation: string;
    readonly result?: unknown;
    readonly generator?: boolean;
    readonly exception?: PythonException;
  }[];
}

interface SourceUnit {
  readonly id: string;
  readonly source: string;
}

const projectRoot = path.resolve(__dirname, "../..");
const load = createRequire(path.join(projectRoot, "package.json"));
const { selectRunBundle } = load(
  "./packages/node-adapters/dist/python/source-selection",
) as {
  selectRunBundle: (
    root: string,
    source: string,
    generated?: boolean,
  ) => readonly SourceUnit[];
};
const { cadBundleUnits } = load(
  "./packages/node-adapters/dist/python/bundle",
) as {
  cadBundleUnits: (root: string) => readonly SourceUnit[];
};

const fixtureDirectory = path.resolve(
  projectRoot,
  "tests/fixtures/python-specialization",
);
const fixtureUnits = new Map([
  ["core.py", readFileSync(path.join(fixtureDirectory, "core.py"), "utf8")],
  [
    "helpers.py",
    readFileSync(path.join(fixtureDirectory, "helpers.py"), "utf8"),
  ],
  [
    "shapes.py",
    readFileSync(path.join(fixtureDirectory, "handlers.py"), "utf8"),
  ],
]);

const pythonRunner = `
import contextlib
import io
import inspect
import json
import sys

request = json.load(sys.stdin)
class HandlerRegistry(dict):
    def __init__(self, *args, **kwargs):
        super().__init__()

namespace = {
    "CAD_HANDLERS": HandlerRegistry(),
    "unknown_receiver_callback": lambda receiver: receiver,
}
captured = io.StringIO()
module_exception = None
outcomes = []

def describe(error):
    return {"type": type(error).__name__, "message": str(error)}

with contextlib.redirect_stdout(captured):
    try:
        for index, source in enumerate(request["sources"]):
            exec(compile(source, f"<synthetic-python-unit-{index}>", "exec"), namespace)
    except BaseException as error:
        module_exception = describe(error)
    for probe in request["probes"]:
        try:
            handler = namespace["CAD_HANDLERS"][probe["operation"]]
            if probe.get("noArguments", False):
                result = handler()
            else:
                result = handler(probe.get("data", {}))
            if inspect.isgenerator(result):
                try:
                    first = next(result)
                except StopIteration as stop:
                    outcomes.append({
                        "operation": probe["operation"],
                        "generator": True,
                        "result": stop.value,
                    })
                else:
                    outcomes.append({
                        "operation": probe["operation"],
                        "generator": True,
                        "result": first,
                    })
            else:
                outcomes.append({"operation": probe["operation"], "result": result})
        except BaseException as error:
            outcomes.append({"operation": probe["operation"], "exception": describe(error)})

print(json.dumps({
    "moduleException": module_exception,
    "stdout": captured.getvalue(),
    "events": namespace.get("events", []),
    "outcomes": outcomes,
}, ensure_ascii=True, sort_keys=True))
`;

let runtimeRoot: string;

before(() => {
  runtimeRoot = createSyntheticRuntimeRoot();
});

after(() => {
  rmSync(runtimeRoot, { recursive: true, force: true });
});

test("literal and unknown factory arguments preserve handler behavior", () => {
  const probes: readonly Probe[] = [
    { operation: "fixture.literal" },
    { operation: "fixture.unknown" },
  ];
  const observed = compareWithFullBundle(probes);
  assert.deepEqual(
    observed.outcomes.map((entry) => entry.result),
    ["known", "other"],
  );
});

test("defaults, decorators, captured predecessors and distinct instances keep their effects", () => {
  const probes: readonly Probe[] = [
    { operation: "fixture.effects", noArguments: true },
    { operation: "fixture.left" },
    { operation: "fixture.right" },
  ];
  const observed = compareWithFullBundle(probes);
  assert.deepEqual(observed.events.slice(0, 2), ["default", "decorator"]);
  assert.ok(observed.events.includes("wrapper"));
  assert.deepEqual(
    observed.outcomes.map((entry) => entry.result),
    [["captured predecessor", "default"], "left", "right"],
  );
});

test("aliases, reflection, unknown receivers and subclass dispatch retain behavior", () => {
  const probes: readonly Probe[] = [
    {
      operation: "fixture.reflection",
      data: { method: "hidden" },
    },
    { operation: "fixture.subclass" },
    { operation: "fixture.unknown_receiver" },
  ];
  const observed = compareWithFullBundle(probes);
  assert.deepEqual(
    observed.outcomes.map((entry) => entry.result),
    ["reflected method", "subclass override", "unknown receiver method"],
  );
});

test("unreachable assignments keep UnboundLocalError and unreachable yields keep generators", () => {
  const probes: readonly Probe[] = [
    { operation: "fixture.unbound" },
    { operation: "fixture.generator" },
  ];
  const observed = compareWithFullBundle(probes);
  assert.equal(observed.outcomes[0]?.exception?.type, "UnboundLocalError");
  assert.deepEqual(observed.outcomes[1], {
    operation: "fixture.generator",
    generator: true,
    result: "generator return value",
  });
});

test("equal string values with different identity remain distinguishable", () => {
  const observed = compareWithFullBundle([{ operation: "fixture.identity" }]);
  assert.equal(observed.outcomes[0]?.result, "distinct object");
});

test("unknown short-circuit operands preserve side-effect order", () => {
  const probes: readonly Probe[] = [
    { operation: "fixture.short_and", data: { enabled: false } },
    { operation: "fixture.short_or", data: { enabled: true } },
    { operation: "fixture.short_and", data: { enabled: true } },
    { operation: "fixture.short_or", data: { enabled: false } },
  ];
  const observed = compareWithFullBundle(probes);
  assert.deepEqual(
    observed.outcomes.map((entry) => entry.result),
    ["and skipped", "or taken", "and taken", "or taken"],
  );
  assert.equal(
    observed.events.filter((event) => event === "short-circuit right side")
      .length,
    2,
  );
});

test("Unicode before rewritten declarations preserves executable source", () => {
  const observed = compareWithFullBundle([{ operation: "fixture.unicode" }]);
  assert.ok(observed.stdout.includes("wynik 🌻 — zachowany"));
  assert.equal(observed.outcomes[0]?.result, "zachowany 🧩");
});

test("dynamic public dispatch keeps the synthetic runtime behavior", () => {
  const probes: readonly Probe[] = [{ operation: "fixture.literal" }];
  const observed = compareWithFullBundle(
    probes,
    "def run(context):\n    FMCAD.call(context.operation, {})\n",
  );
  assert.equal(observed.outcomes[0]?.result, "known");
});

test("selection observes changed runtime and parser bytes without timing assumptions", () => {
  const root = createSyntheticRuntimeRoot();
  const probes: readonly Probe[] = [{ operation: "fixture.literal" }];
  const source = publicSourceFor(probes);
  try {
    const first = selectRunBundle(root, source);
    assert.deepEqual(selectRunBundle(root, source), first);
    assert.equal(
      executeSyntheticPython(
        first.map((unit) => unit.source),
        probes,
      ).outcomes[0]?.result,
      "known",
    );

    const fixturePath = path.join(root, "assets/cad/shapes.py");
    const revised = readFileSync(fixturePath, "utf8").replace(
      'return "known"',
      'return "revised"',
    );
    writeFileSync(fixturePath, revised);
    const updated = selectRunBundle(root, source);
    const originalUpdated = cadBundleUnits(root);
    const updatedResult = executeSyntheticPython(
      updated.map((unit) => unit.source),
      probes,
    );
    assert.deepEqual(
      updatedResult,
      executeSyntheticPython(
        originalUpdated.map((unit) => unit.source),
        probes,
      ),
    );
    assert.equal(updatedResult.outcomes[0]?.result, "revised");

    const parserPath = path.join(
      root,
      "runtime/python/entrypoints/dependency_facts.py",
    );
    writeFileSync(parserPath, 'raise SystemExit("changed synthetic parser")\n');
    assert.throws(
      () => selectRunBundle(root, source),
      /Offline Python dependency analysis failed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function compareWithFullBundle(
  probes: readonly Probe[],
  source = publicSourceFor(probes),
): PythonObservation {
  const full = cadBundleUnits(runtimeRoot);
  assert.ok(
    full.some((unit) => unit.id === "shapes"),
    "synthetic handler unit is present in the original bundle",
  );
  const selected = selectRunBundle(runtimeRoot, source);
  assert.ok(
    selected.some((unit) => unit.id === "shapes"),
    "requested handlers remain available in the selected bundle",
  );

  const baseline = executeSyntheticPython(
    full.map((unit) => unit.source),
    probes,
  );
  const actual = executeSyntheticPython(
    selected.map((unit) => unit.source),
    probes,
  );
  assert.equal(baseline.moduleException, null, "original fixture initializes");
  assert.equal(actual.moduleException, null, "selected fixture initializes");
  assert.deepEqual(
    actual,
    baseline,
    "selected Python changed runtime semantics",
  );
  return actual;
}

function publicSourceFor(probes: readonly Probe[]): string {
  const calls = probes
    .map(({ operation }) => `    FMCAD.call(${JSON.stringify(operation)}, {})`)
    .join("\n");
  return `def run(context):\n${calls}\n`;
}

function executeSyntheticPython(
  sources: readonly string[],
  probes: readonly Probe[],
): PythonObservation {
  const result = spawnSync("python3", ["-I", "-S", "-B", "-c", pythonRunner], {
    input: JSON.stringify({ sources, probes }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as PythonObservation;
}

function createSyntheticRuntimeRoot(): string {
  const temporaryRoot = path.join(os.tmpdir(), "opencode");
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(
    path.join(temporaryRoot, "fmcad-python-specialization-"),
  );
  const assetRoot = path.join(root, "assets/cad");
  mkdirSync(assetRoot, { recursive: true });
  for (const entry of readdirSync(path.join(projectRoot, "assets/cad"))) {
    if (!entry.endsWith(".py")) continue;
    writeFileSync(path.join(assetRoot, entry), fixtureUnits.get(entry) ?? "");
  }

  mirrorEmptyPythonFiles(
    path.join(projectRoot, "runtime/python/fmcad"),
    path.join(root, "runtime/python/fmcad"),
  );
  const parser = path.join(
    root,
    "runtime/python/entrypoints/dependency_facts.py",
  );
  mkdirSync(path.dirname(parser), { recursive: true });
  copyFileSync(
    path.join(projectRoot, "runtime/python/entrypoints/dependency_facts.py"),
    parser,
  );
  copyFileSync(
    path.join(
      projectRoot,
      "runtime/python/entrypoints/lower_domain_imports.py",
    ),
    path.join(root, "runtime/python/entrypoints/lower_domain_imports.py"),
  );
  return root;
}

function mirrorEmptyPythonFiles(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      mirrorEmptyPythonFiles(sourcePath, destinationPath);
    } else if (entry.isFile() && entry.name.endsWith(".py")) {
      writeFileSync(destinationPath, "");
    }
  }
}

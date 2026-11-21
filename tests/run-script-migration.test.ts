import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { AsyncLocalStorage } from "node:async_hooks";
type RunApi = typeof import("../src/composition/run.js");
type RunArguments = Parameters<RunApi["prepareRunScript"]>;
type SourceUnit = ReturnType<RunApi["prepareRunScript"]>["units"][number];
function assertSelectedProvenance(unit: SourceUnit, original: SourceUnit) {
  assert.equal(unit.id, original.id);
  assert.equal(unit.filename, original.filename);
  assert.equal(unit.role, original.role);
  assert.equal(
    unit.sha256,
    createHash("sha256").update(unit.source).digest("hex"),
  );
  if (unit.source === original.source || unit.role !== "runtime") {
    assert.deepEqual(unit, original);
    return;
  }
  const originalHash = createHash("sha256")
    .update(original.source)
    .digest("hex");
  assert.equal(original.sha256, originalHash);
  const marker = `\n# Automatic source selection; original-sha256=${originalHash}\n`;
  assert.ok(
    unit.source.endsWith(marker),
    `${unit.id}: original source binding`,
  );
  // Only complete declarations and complete registry entries may disappear.
  // Retained functions (including their guards) are compared as whole AST nodes.
  const checked = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-c",
      `
import ast, json, sys
original, selected = (ast.parse(s) for s in json.load(sys.stdin))
def same(a, b):
    return ast.dump(a, include_attributes=False) == ast.dump(b, include_attributes=False)
def registry(node):
    return (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == "update"
        and isinstance(node.value.func.value, ast.Name) and node.value.func.value.id == "CAD_HANDLERS"
        and len(node.value.args) == 1 and isinstance(node.value.args[0], ast.Dict)
        and not node.value.keywords)
def matches(a, b):
    if same(a, b): return True
    if isinstance(a, ast.If) and isinstance(b, ast.If) and same(a.test, b.test):
        return body_matches(a.body, b.body) and body_matches(a.orelse, b.orelse)
    if isinstance(a, ast.ClassDef) and isinstance(b, ast.ClassDef):
        fields = [name for name in a._fields if name != "body"]
        for name in fields:
            left, right = getattr(a, name), getattr(b, name)
            if isinstance(left, list):
                if len(left) != len(right) or any(not same(x, y) for x, y in zip(left, right)): return False
            elif isinstance(left, ast.AST):
                if not same(left, right): return False
            elif left != right: return False
        return body_matches(a.body, b.body)
    if registry(a) and registry(b):
        left, right = a.value.args[0], b.value.args[0]
        pairs = list(zip(left.keys, left.values))
        cursor = 0
        for key, value in zip(right.keys, right.values):
            if key is None: return False
            while cursor < len(pairs) and not (pairs[cursor][0] is not None and same(pairs[cursor][0], key) and same(pairs[cursor][1], value)):
                cursor += 1
            if cursor == len(pairs): return False
            cursor += 1
        return True
    return False
def body_matches(left, right):
    left = [node for node in left if not isinstance(node, ast.Pass)]
    right = [node for node in right if not isinstance(node, ast.Pass)]
    cursor = 0
    def removable(node):
        return (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            or isinstance(node, ast.Assign) and all(isinstance(target, ast.Name) for target in node.targets)
            or isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name))
    for node in right:
        while cursor < len(left) and not matches(left[cursor], node):
            if not removable(left[cursor]): return False
            cursor += 1
        if cursor == len(left): return False
        cursor += 1
    return all(removable(node) for node in left[cursor:])
assert body_matches(original.body, selected.body), "changed retained code"
`,
    ],
    {
      input: JSON.stringify([original.source, unit.source]),
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(checked.status, 0, `${unit.id}: ${checked.stderr}`);
}
const current = load("./src/run.js") as RunApi;
test("selected provenance rejects removed function guards and partial registry keys", () => {
  const values = fs.readFileSync(
    path.join(root, "runtime/python/fmcad/domain/values.py"),
    "utf8",
  );
  const withoutGuard = values.replace(
    "        if not _value_math.isfinite(value):\n            raise ValueError('Non-finite value cannot be serialized')\n",
    "",
  );
  assert.notEqual(withoutGuard, values);
  for (const [source, changed] of [
    [values, withoutGuard],
    [
      "CAD_HANDLERS.update({'body.list': _body_list})\n",
      "CAD_HANDLERS.update({' ody.list': _body_list})\n",
    ],
    ["CAD_HANDLERS.owner = 'owner'\n", "pass\n"],
  ]) {
    const original: SourceUnit = {
      id: "review-reproducer",
      filename: "review.py",
      role: "runtime",
      source: source!,
      sha256: createHash("sha256").update(source!).digest("hex"),
    };
    const selected =
      changed +
      `\n# Automatic source selection; original-sha256=${original.sha256}\n`;
    assert.throws(
      () =>
        assertSelectedProvenance(
          {
            ...original,
            source: selected,
            sha256: createHash("sha256").update(selected).digest("hex"),
          },
          original,
        ),
      /changed retained code/,
    );
  }
});
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
const previous = historical(
  "d496c734d63661f2f131b6797ce171e9373a58f4",
  "src/run.js",
) as RunApi;
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "run migration żółć "),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source.py");
  const source =
    'ARGS = []\nDOC_NAME = ""\ndef run(context):\n    return ARGS\n';
  fs.writeFileSync(file, source);
  return { directory, file, source };
}

const cases: [string, RunArguments[4], RunArguments[5], RunArguments[6]][] = [
  ["plain", {}, undefined, []],
  ["creation ID", { docId: "creation-A" }, undefined, []],
  ["file ID", { docFileId: "urn:file:A" }, undefined, []],
  [
    "read-only",
    { docId: "creation-A", docFileId: "urn:file:A", readOnly: true },
    undefined,
    [],
  ],
  ["helpers", { docId: "creation-A" }, "cad-v1", []],
  [
    "read-only helpers",
    { docFileId: "urn:file:A", readOnly: true },
    "cad-v1",
    ["body.list"],
  ],
];
for (const [label, identity, helper, operations] of cases) {
  test(`run migration preserves ${label} source, guards and raw provenance`, (t) => {
    const f = fixture(t);
    const args: RunArguments = [
      f.file,
      { text: "Zażółć 🧪 $&", yes: true, value: null },
      true,
      "Model A",
      identity,
      helper,
      operations,
      { trustedStageContext: { runId: "stage-A" } },
    ];
    const before = {},
      after = {};
    const { context } = load("./src/invocation.js") as {
      context: AsyncLocalStorage<Record<string, unknown>>;
    };
    const historical = context.run(before, () =>
      previous.prepareRunScript(...args),
    );
    const migrated = context.run(after, () =>
      current.prepareRunScript(...args),
    );
    if (helper) {
      assert.ok(migrated.units.length < historical.units.length);
      assert.deepEqual(migrated.context, historical.context);
      assert.deepEqual(migrated.request, historical.request);
      for (const unit of migrated.units) {
        if (unit.id === "helpers") continue;
        const original = historical.units.find((entry) => entry.id === unit.id);
        assert.ok(original, `Unknown source unit ${unit.id}`);
        assertSelectedProvenance(unit, original);
        if (unit.source !== original.source) {
          const source = "raise RuntimeError('tampered')\n" + unit.source;
          assert.notEqual(source, unit.source);
          assert.throws(
            () =>
              assertSelectedProvenance(
                {
                  ...unit,
                  source,
                  sha256: createHash("sha256").update(source).digest("hex"),
                },
                original,
              ),
            /changed retained code/,
          );
          assert.throws(() =>
            assertSelectedProvenance(
              {
                ...unit,
                sha256: original.sha256,
              },
              original,
            ),
          );
        }
      }
    } else {
      assert.deepEqual(migrated, historical);
    }
    assert.deepEqual(after, before);
    assert.deepEqual(after, {
      sourcePath: f.file,
      sourceHash: createHash("sha256").update(f.source).digest("hex"),
    });
    assert.equal(current.buildRunScript(...args), migrated.script);
    assert.equal(fs.readFileSync(f.file, "utf8"), f.source);
  });
}

test("script search, listing, validation and missing-slot failures retain their contract", (t) => {
  const f = fixture(t);
  const config = path.join(f.directory, "config.json");
  const scripts = path.join(f.directory, "scripts");
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, "box.py"), f.source);
  fs.writeFileSync(path.join(scripts, "z.py"), "# user script\n");
  fs.writeFileSync(path.join(scripts, "ignored.txt"), "not Python");
  for (const api of [previous, current]) {
    assert.equal(
      api.resolveScript("box", { config }),
      path.join(scripts, "box.py"),
    );
    assert.equal(api.resolveScript(f.file), f.file);
    assert.equal(
      api.listScripts({ config }).filter((item) => item.name === "box").length,
      2,
    );
  }
  assert.deepEqual(
    current.listScripts({ config }),
    previous.listScripts({ config }),
  );
  for (const name of [
    "nonexistent-script-93848",
    path.join(f.directory, "missing.py"),
  ]) {
    let expected: string | undefined;
    try {
      previous.resolveScript(name, { config });
    } catch (error) {
      assert.ok(error instanceof Error);
      expected = error.message;
    }
    assert.throws(() => current.resolveScript(name, { config }), {
      message: expected,
    });
  }
  for (const args of [
    [f.file, [], false, undefined, { docId: "id" }],
    [f.file, [], false, "Model", {}, "unknown"],
    [f.file, [], false, "Model", {}, "cad-v1"],
  ] as RunArguments[]) {
    let expected: string | undefined;
    try {
      previous.prepareRunScript(...args);
    } catch (error) {
      assert.ok(error instanceof Error);
      expected = error.message;
    }
    assert.equal(typeof expected, "string");
    assert.throws(() => current.prepareRunScript(...args), {
      message: expected,
    });
  }
  fs.writeFileSync(f.file, 'print("no injection slots")\n');
  for (const args of [
    [f.file, [], true],
    [f.file, [], false, "Model"],
  ] as RunArguments[]) {
    let expected: string | undefined;
    try {
      previous.prepareRunScript(...args);
    } catch (error) {
      assert.ok(error instanceof Error);
      expected = error.message;
    }
    assert.throws(() => current.prepareRunScript(...args), {
      message: expected,
    });
  }
});

test("both versions reject changed or unpinned queued source before preparing an artifact", (t) => {
  const f = fixture(t);
  const keys = ["FMCAD_QUEUE_WORKER_JOB", "FMCAD_QUEUE_INPUT_FILES"];
  const original = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, index) => {
      if (original[index] === undefined) delete process.env[key];
      else process.env[key] = original[index];
    }),
  );
  process.env["FMCAD_QUEUE_WORKER_JOB"] = "run-migration";
  const pin = [
    {
      path: f.file,
      sha256: createHash("sha256").update(f.source).digest("hex"),
    },
  ];
  for (const api of [previous, current]) {
    process.env["FMCAD_QUEUE_INPUT_FILES"] = JSON.stringify(pin);
    fs.writeFileSync(f.file, f.source);
    assert.equal(api.prepareRunScript(f.file, [], false).script, f.source);
    fs.writeFileSync(f.file, f.source + "# changed after queue acceptance\n");
    assert.throws(() => api.prepareRunScript(f.file, [], false), {
      code: "INPUT_CHANGED",
    });
    fs.writeFileSync(f.file, f.source);
    process.env["FMCAD_QUEUE_INPUT_FILES"] = "[]";
    assert.throws(() => api.prepareRunScript(f.file, [], false), {
      code: "INPUT_CHANGED",
    });
  }
});

test("source verification and preparation use the same read even if the file changes", (t) => {
  const f = fixture(t);
  let observed: Buffer | undefined;
  let verified: string | undefined;
  const { createRunScriptAdapter } = load(
    "./src/dist/python/run-script.js",
  ) as typeof import("../packages/node-adapters/src/python/run-script.js");
  const api = createRunScriptAdapter({
    observeSource(filename, bytes) {
      assert.equal(filename, f.file);
      observed = bytes;
      fs.writeFileSync(filename, 'raise RuntimeError("replacement")\n');
    },
    verifySource(filename, bytes) {
      assert.equal(filename, f.file);
      assert.equal(bytes, observed);
      verified = bytes.toString("utf8");
    },
  });
  const artifact = api.prepareRunScript(f.file, [], false);
  assert.equal(verified, f.source);
  assert.equal(artifact.script, f.source);
  assert.match(fs.readFileSync(f.file, "utf8"), /replacement/);
});

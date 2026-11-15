import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  ModelingApi,
  Descriptor,
  AuditedManual,
} from "./modeling-unit-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/animation-sequence.test.ts"),
);
import fs from "node:fs";
type PreparedCadArtifact = {
  script: string;
  units: { filename: string; source: string }[];
};
const { validateCad, prepareCadScript } = load("../src/cad") as ModelingApi & {
  prepareCadScript(
    operation: string,
    data: unknown,
    context: unknown,
  ): PreparedCadArtifact;
};

const catalog = load("../src/catalog/animation-sequence.json") as Record<
  string,
  Descriptor
>;
const manual = load("../src/manual/animation-sequence.json") as Record<
  string,
  AuditedManual
>;

function assertAnimationRegistry(script: string, operation: string): void {
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `import ast, json, sys, types
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
class Registry(dict):
    def update(self, entries):
        for key, handler in entries.items():
            assert key not in self, 'Duplicate handler: ' + key
            assert callable(handler), key
            self[key] = handler
tree = ast.parse(sys.stdin.read())
namespace = {'Registry': Registry}
for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'CAD_HANDLERS' for target in node.targets):
        node.value = ast.Call(func=ast.Name(id='Registry', ctx=ast.Load()), args=[], keywords=[])
ast.fix_missing_locations(tree)
exec(compile(tree, '<animation-registry>', 'exec'), namespace)
print(json.dumps(sorted(namespace['CAD_HANDLERS'])))`,
    ],
    { input: script, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const registered = JSON.parse(result.stdout) as string[];
  assert.ok(registered.includes(operation), `${operation} is registered`);
  assert.deepEqual(
    registered.filter((name) => name.startsWith("animation.")),
    [operation],
  );
}

test("GM36 animation sequence/export catalog and manual cover the same operations", () => {
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(catalog).sort());
  for (const [operation, entry] of Object.entries(catalog)) {
    assert.equal(typeof entry.summary, "string", operation);
    assert.ok(Array.isArray(entry.required), operation);
    assert.ok(entry.example && typeof entry.example === "object", operation);
    assert.equal(typeof entry.readOnly, "boolean", operation);
    assert.equal(entry.envelope, true, operation);
    assert.ok(Array.isArray(entry.limitations), operation);
    const m = manual[operation];
    assert.ok(m, `Unfinished command: ${operation}`);
    assert.ok(
      m.sections.some((s) => /Return Contract/i.test(s.title)),
      operation,
    );
    assert.ok(m.audit.sources.length, operation);
    assert.ok(m.audit.verified.length, operation);
    assert.ok(m.audit.tests.length, operation);
    assert.deepEqual(m.audit.gaps, [], operation);
    assert.ok(m.examples.length, operation);
    for (const example of m.examples) {
      assert.equal(typeof example.label, "string");
      assert.ok(example.requires.length > 0, operation);
      assert.ok(example.output.length > 0, operation);
      assert.doesNotThrow(
        () => validateCad(operation, example.data),
        `${operation}: ${example.label}`,
      );
    }
  }
});

test("GM36 animation operations keep owned registry entries without bundling siblings", () => {
  const handlers = {
    "animation.sequence": "animation_sequence",
    "animation.export": "animation_export",
  } as const;
  const entries = Object.entries(handlers);

  for (const [operation, handler] of entries) {
    const artifact = prepareCadScript(operation, catalog[operation]!.example, {
      doc: "GM36",
    });
    const sibling = entries.find(([candidate]) => candidate !== operation)!;
    const animationSource = artifact.units.find(
      ({ filename }) =>
        filename === "runtime/python/fmcad/adapters/fusion/animation2.py",
    );

    assert.ok(animationSource, `${operation} source provenance`);
    assert.ok(animationSource.source.includes(`def ${handler}`), operation);
    assert.ok(
      animationSource.source.includes(`'${operation}': ${handler}`),
      `${operation} registry ownership`,
    );
    assert.ok(artifact.script.includes(`def ${handler}`), operation);
    assert.ok(
      artifact.script.includes(`'${operation}': ${handler}`),
      `${operation} registration`,
    );
    assert.ok(!artifact.script.includes(`def ${sibling[1]}`), operation);
    assert.ok(
      !artifact.script.includes(`'${sibling[0]}': ${sibling[1]}`),
      `${operation} must not register its sibling`,
    );
    assertAnimationRegistry(artifact.script, operation);
  }
});

test("GM36 animation test evidence files exist", () => {
  const seen = new Set();
  for (const entry of Object.values(manual)) {
    for (const evidence of entry.audit.tests) {
      const file = evidence.split(/[: ]/)[0];
      assert.ok(file);
      seen.add(file);
      assert.ok(fs.existsSync(file), `missing test evidence ${file}`);
    }
  }
});

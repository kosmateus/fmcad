import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import {
  admissionContext,
  prepareCoordinatedModelingProgram,
} from "./modeling-admission-fixtures.ts";

const root = process.cwd();
const load = createRequire(path.join(root, "package.json"));
const { createPythonChecker } = load(
  "./src/dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { prepareCadScript, catalog } = load("./src/cad") as {
  prepareCadScript: typeof import("../src/composition/cad").prepareCadScript;
  catalog: Record<string, { example: Record<string, unknown> }>;
};
interface OperationContract {
  operation: string;
  owner: string;
  route: string;
  nativeProgram: string | null;
}
const contracts = load(
  "./tests/fixtures/modeling-operation-contracts.json",
) as {
  families: string[];
  operations: OperationContract[];
};
test("modeling admission inventory covers every assigned public descriptor", () => {
  const expected = Object.keys(catalog).filter((operation) =>
    contracts.families.includes(operation.split(".")[0] ?? ""),
  );
  assert.deepEqual(
    contracts.operations.map((row) => row.operation).sort(),
    expected.sort(),
  );
  assert.equal(
    new Set(contracts.operations.map((row) => row.operation)).size,
    expected.length,
  );
});
// G runs all disjoint shards. An ordinary local invocation covers the entire matrix.
const shardText = process.env["FMCAD_MODELING_ADMISSION_SHARD"] ?? "0/1";
assert.match(shardText, /^\d+\/\d+$/);
const [shardIndex = -1, shardCount = 0] = shardText.split("/").map(Number);
assert.ok(
  Number.isSafeInteger(shardIndex) &&
    Number.isSafeInteger(shardCount) &&
    shardCount > 0 &&
    shardIndex >= 0 &&
    shardIndex < shardCount,
);
const direct = contracts.operations.filter(
  (row) => row.owner === "C" && row.nativeProgram !== null,
);
for (const [index, row] of direct.entries()) {
  if (index % shardCount !== shardIndex) continue;
  const operation = row.operation;
  test(
    `${operation}: generated public program passes pinned production admission`,
    { timeout: 300_000 },
    async () => {
      const example = catalog[operation]?.example;
      assert.ok(example, `${operation} must have an executable public example`);
      const typingRoot = path.join(root, "dist/runtime/python/typing");
      const checker = createPythonChecker({
        typingRoot,
        definitionsRoot: typingRoot,
        pythonPlatform: "Windows",
      });
      const artifact =
        row.route === "host-service"
          ? await prepareCoordinatedModelingProgram(operation)
          : prepareCadScript(operation, example, admissionContext);
      const report = await checker.check({
        artifact,
        context: { kind: "bundle" },
      });
      assert.equal(report.status, "passed", JSON.stringify(report));
      assert.equal(report.provenance.checker, "basedpyright");
      assert.equal(report.provenance.artifactHash, artifact.artifactHash);
      assert.equal(
        report.provenance.definitionsHash,
        "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
      );
    },
  );
}

test(
  "public section.inspect prunes an unused exception while visibility.finalize retains its behavior",
  { timeout: 300_000 },
  async () => {
    const inspect = prepareCadScript(
      "section.inspect",
      catalog["section.inspect"]!.example,
      admissionContext,
    );
    const inspectionSource = inspect.units.find(
      (unit) => unit.id === "presentation",
    );
    assert.ok(inspectionSource);
    assert.equal(
      /class _UnhealthyHistory\b/.test(inspectionSource.source),
      false,
      "section.inspect must prune its unused exception class",
    );

    const finalize = prepareCadScript(
      "visibility.finalize",
      catalog["visibility.finalize"]!.example,
      admissionContext,
    );
    const finalizeSource = finalize.units.find(
      (unit) => unit.id === "presentation",
    );
    assert.ok(finalizeSource);
    assert.match(
      finalizeSource.source,
      /class _UnhealthyHistory\(Exception\):/,
    );
    assert.match(finalizeSource.source, /raise _UnhealthyHistory\(health\)/);
    assert.match(
      finalizeSource.source,
      /isinstance\(error, _UnhealthyHistory\)/,
    );

    const executed = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        `
import ast, sys
tree = ast.parse(sys.stdin.read())
declaration = next(item for item in tree.body
                   if isinstance(item, ast.ClassDef) and item.name == '_UnhealthyHistory')
namespace = {}
exec(compile(ast.Module(body=[declaration], type_ignores=[]), '<selected exception>', 'exec'), namespace)
error_type = namespace['_UnhealthyHistory']
health = {'unhealthy': [{'name': 'Feature'}]}
error = error_type(health)
assert isinstance(error, Exception)
assert str(error) == 'Unhealthy timeline history'
assert error.health is health
try:
    raise error
except error_type as caught:
    assert caught is error
else:
    raise AssertionError('selected exception was not catchable')
`,
      ],
      { input: finalizeSource.source, encoding: "utf8" },
    );
    assert.equal(executed.status, 0, executed.stderr);

    const typingRoot = path.join(root, "dist/runtime/python/typing");
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    });
    for (const artifact of [inspect, finalize]) {
      const report = await checker.check({
        artifact,
        context: { kind: "bundle" },
      });
      assert.equal(report.status, "passed", JSON.stringify(report));
      assert.deepEqual(report.diagnostics, []);
      assert.equal(report.provenance.checker, "basedpyright");
      assert.equal(report.provenance.artifactHash, artifact.artifactHash);
    }
  },
);

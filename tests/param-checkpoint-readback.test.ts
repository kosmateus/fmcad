import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { planCadScript } from "../packages/core/src/application/cad/prepare";
import { decodeDocumentCheckpointReadback } from "../src/document-checkpoint-readback";

const context = { doc: "Owned target", docId: "creation-A" };
const entry = {
  summary: "Inspect parameters",
  inputs: {},
  required: [],
  example: {},
  limitations: [],
  readOnly: true,
};
const literal = (value: unknown) =>
  `json.loads(${JSON.stringify(JSON.stringify(value))})`;

function execute(privateReadback?: "param-checkpoint") {
  const plan = planCadScript(
    "param.inspect",
    { includeModel: true },
    context,
    entry,
    literal,
    privateReadback,
  );
  const program = `
import json, sys
class CadContext:
    def __init__(self, name, component, project, creation, file):
        assert creation == "creation-A"
        self.doc = type("Document", (), {"name": name})()
        self.created = False
    def assert_identity(self): pass
    def activate_target(self): raise AssertionError("read activated global document")
    def call(self, operation, data):
        assert operation == "param.inspect" and data == {"includeModel": True}
        return {"parameters": [{"name": "size"}]}
def _cad_param_checkpoint(ctx):
    return {"schema": "fmcad.param-checkpoint-v1",
            "document": {"identity": {"creationId": "creation-A"}, "fingerprint": "a" * 64},
            "parameters": [{"name": "size"}]}
def _cad_json(value): return value
exec(compile(sys.stdin.read(), "<private-readback-wrapper>", "exec"))
run("owned-fixture")
`;
  const result = spawnSync("python3", ["-B", "-c", program], {
    input: plan.wrapper,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout
    .split("\n")
    .find((value) => value.startsWith("FMCAD_RESULT "));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice("FMCAD_RESULT ".length)) as {
    success: boolean;
    result: Record<string, unknown>;
  };
}

test("private checkpoint readback routes one callback to the full checkpoint producer", () => {
  const actual = execute("param-checkpoint");
  assert.equal(actual.success, true);
  assert.equal(actual.result["schema"], "fmcad.param-checkpoint-v1");
  assert.deepEqual(actual.result["document"], {
    identity: { creationId: "creation-A" },
    fingerprint: "a".repeat(64),
  });
});

test("ordinary parameter inspection keeps its existing public response", () => {
  assert.deepEqual(execute().result, { parameters: [{ name: "size" }] });
});

test("private readback refuses mutations, partial reads and unresolved targets before compilation", () => {
  const cases = [
    { operation: "param.apply", data: { includeModel: true }, context },
    { operation: "param.inspect", data: { includeModel: false }, context },
    {
      operation: "param.inspect",
      data: { includeModel: true, names: ["size"] },
      context,
    },
    {
      operation: "param.inspect",
      data: { includeModel: true },
      context: { doc: "Only a name" },
    },
    {
      operation: "param.inspect",
      data: { includeModel: true },
      context: { ...context, component: "part" },
    },
  ];
  for (const value of cases)
    assert.throws(
      () =>
        planCadScript(
          value.operation,
          value.data,
          value.context,
          entry,
          literal,
          "param-checkpoint",
        ),
      /exact whole-document/,
    );
  assert.throws(
    () =>
      planCadScript(
        "param.inspect",
        { includeModel: true },
        context,
        { ...entry, readOnly: false },
        literal,
        "param-checkpoint",
      ),
    /exact whole-document/,
  );
});

test("the actual compiled checkpoint payload returns identity, fingerprint and all parameters without writes", () => {
  const root = process.cwd();
  const load = createRequire(path.join(root, "package.json"));
  const compiler = load(
    "./packages/node-adapters/dist/python/cad-script.js",
  ) as typeof import("../packages/node-adapters/src/python/cad-script");
  const adapter = compiler.createCadScriptAdapter({
    validate: () => entry,
    inspection: (data) => data,
    curve: (_operation, data) => data,
    dataImport: () => {
      throw new Error("Unexpected import");
    },
  });
  const prepared = adapter.prepareCadScript(
    "param.inspect",
    { includeModel: true },
    { doc: "Checkpoint target", docId: "creation-1", docFileId: "file-1" },
    undefined,
    undefined,
    "param-checkpoint",
  );
  assert.equal(
    prepared.sha256,
    createHash("sha256").update(prepared.script).digest("hex"),
  );
  assert.ok(prepared.units.some((unit) => unit.id === "legacy-queue_document"));
  assert.ok(!prepared.units.some((unit) => unit.id === "legacy-review"));
  const program = `
import contextlib, io, json, sys, types
sys.path.insert(0, ${JSON.stringify(path.join(root, "tests"))})
import core_test as fixture
case = fixture.CoreTests()
case.setUp()
case.doc.name = "Checkpoint target"
case.doc.creationId = "creation-1"
case.doc.dataFile.id = "file-1"
case.doc.dataFile.versionNumber = 7
case.apply([{"name": "size", "expression": "1 mm", "unit": "mm"}])
case.parameters.writes.clear()
adsk = types.ModuleType("adsk")
adsk.core = types.ModuleType("adsk.core")
adsk.fusion = types.ModuleType("adsk.fusion")
adsk.core.Application = types.SimpleNamespace(get=lambda: case.app)
adsk.core.ValueInput = types.SimpleNamespace(createByString=lambda value: value)
adsk.fusion.Design = types.SimpleNamespace(cast=lambda product: product)
sys.modules.update({"adsk": adsk, "adsk.core": adsk.core, "adsk.fusion": adsk.fusion})
namespace = {}
exec(compile(sys.stdin.read(), "<compiled-checkpoint-readback>", "exec"), namespace)
output = io.StringIO()
with contextlib.redirect_stdout(output):
    namespace["run"]("owned-fixture")
print(json.dumps({"output": output.getvalue(), "writes": case.parameters.writes}))
`;
  const result = spawnSync("python3", ["-B", "-c", program], {
    input: prepared.script,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const execution = JSON.parse(result.stdout) as {
    output: string;
    writes: unknown[];
  };
  assert.deepEqual(execution.writes, []);
  const line = execution.output
    .split("\n")
    .find((value) => value.startsWith("FMCAD_RESULT "));
  assert.ok(line, execution.output);
  const response = JSON.parse(line.slice("FMCAD_RESULT ".length)) as {
    success: boolean;
    result: unknown;
  };
  assert.equal(response.success, true);
  const checkpoint = decodeDocumentCheckpointReadback(response.result, {
    creationId: "creation-1",
    fileId: "file-1",
  });
  assert.equal(checkpoint.document.identity.version, 7);
  assert.match(checkpoint.document.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(checkpoint.parameters[0]?.name, "size");
  assert.throws(
    () =>
      decodeDocumentCheckpointReadback(response.result, {
        creationId: "another-document",
      }),
    { code: "DOCUMENT_STATE_CHANGED" },
  );
  for (const change of [
    (value: Record<string, unknown>) => {
      delete value["document"];
    },
    (value: Record<string, unknown>) => {
      value["parameters"] = [{ ...checkpoint.parameters[0], value: true }];
    },
    (value: Record<string, unknown>) => {
      value["parameters"] = [
        checkpoint.parameters[0],
        checkpoint.parameters[0],
      ];
    },
    (value: Record<string, unknown>) => {
      value["schema"] = "unverified";
    },
  ]) {
    const invalid: Record<string, unknown> = { ...structuredClone(checkpoint) };
    change(invalid);
    assert.throws(
      () =>
        decodeDocumentCheckpointReadback(invalid, {
          creationId: "creation-1",
          fileId: "file-1",
        }),
      { code: "DOCUMENT_STATE_CHANGED" },
    );
  }
});

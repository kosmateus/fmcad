import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import type { CadData, CadContext } from "@fmcad/core";
import type {
  CadPreparationPorts,
  ParamCheckpointGuardV1,
} from "../packages/node-adapters/src/python/cad-script.js";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact.js";

const root = path.resolve(process.cwd());
const load = createRequire(path.join(root, "package.json"));
const compiler = load(
  "./packages/node-adapters/dist/python/cad-script.js",
) as typeof import("../packages/node-adapters/src/python/cad-script.js");
const python = load(
  "./packages/node-adapters/dist/python/context-binding.js",
) as typeof import("../packages/node-adapters/src/python/context-binding.js");
const inventory = load(
  "./packages/node-adapters/dist/python/bundle-inventory.js",
) as typeof import("../packages/node-adapters/src/python/bundle-inventory.js");
const context: CadContext = {
  doc: "Checkpoint target",
  docId: "creation-1",
  docFileId: "file-1",
};
const declaration = {
  summary: "Apply parameters",
  inputs: { parameters: "Parameter specifications" },
  required: ["parameters"],
  example: {},
  limitations: [],
  readOnly: false,
};
const guard: ParamCheckpointGuardV1 = {
  schema: "fmcad.param-checkpoint-v1",
  document: {
    identity: {
      creationId: "creation-1",
      name: "Checkpoint target",
      fileId: "file-1",
      version: 7,
      isSaved: true,
      isModified: false,
    },
    fingerprint: "a".repeat(64),
  },
  parameters: [],
};
const adapter = compiler.createCadScriptAdapter({
  validate: () => declaration,
  inspection: (input) => input,
  curve: (_operation, input) => input,
  dataImport: () => {
    throw new Error("Unexpected data import");
  },
} satisfies CadPreparationPorts);

function data(): CadData {
  return {
    parameters: [{ name: "checkpointed", expression: "1 mm", unit: "mm" }],
  };
}

function artifact(
  input: CadData,
  checkpoint?: ParamCheckpointGuardV1,
): PreparedPythonArtifact {
  return adapter.prepareCadScript(
    "param.apply",
    input,
    context,
    undefined,
    checkpoint,
  );
}

const fixtureSetup = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, "tests"))})
import core_test as fixture
case = fixture.CoreTests()
case.setUp()
case.doc.name = "Checkpoint target"
case.doc.creationId = "creation-1"
case.doc.dataFile.id = "file-1"
case.doc.dataFile.versionNumber = 7
`;

function checkpointGuard(setup: string): ParamCheckpointGuardV1 {
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `${fixtureSetup}\n${setup}\nprint(json.dumps(case.checkpoint(), allow_nan=False))`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as ParamCheckpointGuardV1;
}

function executeArtifact(
  prepared: PreparedPythonArtifact,
  setup: string,
  mutation: string,
): { error: string | null; expression: string; writes: string[] } {
  const program = `${fixtureSetup}
import contextlib, io, json, types
${setup}
adsk = types.ModuleType("adsk")
adsk.core = types.ModuleType("adsk.core")
adsk.fusion = types.ModuleType("adsk.fusion")
adsk.core.Application = types.SimpleNamespace(get=lambda: case.app)
adsk.core.ValueInput = types.SimpleNamespace(createByString=lambda value: value)
adsk.fusion.Design = types.SimpleNamespace(cast=lambda product: product)
sys.modules.update({"adsk": adsk, "adsk.core": adsk.core, "adsk.fusion": adsk.fusion})
namespace = {}
exec(compile(sys.stdin.read(), "<compiled-param-apply>", "exec"), namespace)
${mutation}
parameter = case.parameters.itemByName("size")
error = None
try:
    with contextlib.redirect_stdout(io.StringIO()):
        namespace["run"]("context")
except Exception as caught:
    error = str(caught)
print(json.dumps({"error": error, "expression": parameter.expression, "writes": case.parameters.writes}))
`;
  const result = spawnSync("python3", ["-B", "-c", program], {
    cwd: root,
    input: prepared.script,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    error: string | null;
    expression: string;
    writes: string[];
  };
}

test("checkpoint guard is compiler-injected, source-bound and minimal to param.apply", () => {
  const ordinary = artifact(data());
  const accepted = artifact(data(), guard);
  const manifest = python.pythonArtifactManifest(accepted);
  const unitIds = accepted.units.map((unit) => unit.id);
  const fullUnitCount = inventory.cadBundleUnits(root).length;
  const request = accepted.request as { data: Record<string, unknown> };

  assert.deepEqual(request.data["_fmcadCheckpointGuard"], guard);
  assert.equal(
    createHash("sha256").update(accepted.script).digest("hex"),
    manifest.sha256,
  );
  assert.equal(manifest.sha256, accepted.sha256);
  assert.ok(accepted.script.includes("_fmcadCheckpointGuard"));
  assert.ok(accepted.script.includes("_qd_capture"));
  assert.ok(unitIds.includes("core"));
  assert.ok(unitIds.includes("identity"));
  assert.ok(
    unitIds.includes("legacy-queue_document"),
    `Expected queue-document provider in payload; retained: ${unitIds.join(", ")}`,
  );
  assert.ok(unitIds.length < fullUnitCount);
  assert.ok(!unitIds.includes("legacy-review"));
  assert.ok(
    !(
      ordinary.request as { data: Record<string, unknown> }
    ).data["_fmcadCheckpointGuard"],
  );
});

test("compiled param.apply rejects protected metadata changing from boolean to number before writes", () => {
  const setup = `case.apply([{
    "name": "size", "expression": "1 mm", "unit": "mm",
    "metadata": {"protected": True}
}])`;
  const checkpoint = checkpointGuard(setup);
  const compiled = artifact(
    {
      parameters: [{ name: "size", expression: "2 mm", unit: "mm" }],
      overwrite: true,
    },
    checkpoint,
  );
  const result = executeArtifact(
    compiled,
    setup,
    `case.parameters.itemByName("size").attributes.itemByName(
    "fmcad.parameter", "metadata"
).value = '{"protected":1}'`,
  );

  assert.match(result.error ?? "", /DOCUMENT_STATE_CHANGED/);
  assert.equal(result.expression, "1 mm");
  assert.deepEqual(result.writes, ["size"]);
});

test("compiled param.apply accepts unchanged text parameters and rejects stale text", () => {
  const setup = `case.apply([{
    "name": "size", "expression": "1 mm", "unit": "mm"
}])
note = fixture.Entity("UserParameter", "note")
note.expression = "'hello'"
note.unit, note.comment, note.textValue = "Text", "", "hello"
case.parameters.items.append(note)`;
  const checkpoint = checkpointGuard(setup);
  const compiled = artifact(
    {
      parameters: [{ name: "size", expression: "2 mm", unit: "mm" }],
      overwrite: true,
    },
    checkpoint,
  );

  const accepted = executeArtifact(compiled, setup, "");
  assert.equal(accepted.error, null);
  assert.equal(accepted.expression, "2 mm");

  const stale = executeArtifact(
    compiled,
    setup,
    `case.parameters.itemByName("note").textValue = "changed"`,
  );
  assert.match(stale.error ?? "", /DOCUMENT_STATE_CHANGED/);
  assert.equal(stale.expression, "1 mm");
  assert.deepEqual(stale.writes, ["size"]);
});

test("clients cannot supply the compiler-owned parameter checkpoint field", () => {
  assert.throws(
    () => artifact({ ...data(), _fmcadCheckpointGuard: guard }),
    /compiler-owned/,
  );
  assert.throws(
    () =>
      adapter.prepareCadScript(
        "document.status",
        {},
        context,
        undefined,
        guard,
      ),
    /only valid for param.apply/,
  );
});

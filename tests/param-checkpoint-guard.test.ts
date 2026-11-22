import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

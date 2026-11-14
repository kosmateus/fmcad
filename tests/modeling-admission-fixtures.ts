import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact";
import type {
  BrepBaselineManifest,
  BrepBaselineReference,
} from "../packages/core/src/ports/brep-baseline";

const load = createRequire(path.join(process.cwd(), "package.json"));
const { prepareCadScript } = load(
  "./src/cad",
) as typeof import("../src/composition/cad");
const { executeSelectionRule } = load(
  "./src/dist/core/application/modeling/selection-service",
) as typeof import("../packages/core/src/application/modeling/selection-service");
const { createBrepBaselineService } = load(
  "./src/dist/core/application/cad/brep-baseline",
) as typeof import("../packages/core/src/application/cad/brep-baseline");
const selectionAuthorization = load(
  "./src/catalog/selection-rules-internal",
) as { authorize(operation: string, data: Record<string, unknown>): void };
const brepAuthorization = load("./src/catalog/brep-baseline-internal") as {
  authorize(data: Record<string, unknown>): void;
};
export const admissionContext = {
  doc: "Owned model",
  docId: "modeling-owner-A",
  docFileId: "file-A",
  projectId: "project-A",
};
const owner = {
  projectId: admissionContext.projectId,
  documentCreationId: admissionContext.docId,
  documentFileId: admissionContext.docFileId,
};
const selectionReference = {
  version: 1,
  artifactId: "rule-A",
  ...owner,
  sha256: "a".repeat(64),
};
const selectionManifest = {
  schemaVersion: 1,
  revision: 1,
  owner,
  rule: {
    id: "outer-side",
    version: 1,
    query: {
      schemaVersion: 1,
      kind: "face",
      occurrence: "Part:1",
      filters: { geometry: "plane", axis: [1, 0, 0] },
      expect: { min: 1, max: 1 },
    },
    exclude: [],
  },
  source: { documentName: admissionContext.doc, version: 11 },
  instanceScope: { occurrence: "Part:1" },
  lastResolution: {
    sourceVersion: 11,
    count: 1,
    selectedReferences: [{ reference: { kind: "face", token: "face-A" } }],
  },
  provenance: {
    definedBy: "selection.rule.define",
    resolver: "entity._entity_query",
    ...owner,
    sourceVersion: 11,
  },
};
const brepReference: BrepBaselineReference = {
  version: 1,
  scope: "durable",
  owner: "a".repeat(64),
  id: "baseline-A",
  sha256: "b".repeat(64),
};
const brepManifest: BrepBaselineManifest = {
  version: 1,
  scope: "durable",
  source: { document: "file-A", version: "11" },
  frame: "assembly",
  bodies: [
    {
      role: "housing",
      body: "body-A",
      instance: "occurrence:Part:1",
      pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ],
};
/** Captures the real coordinator's authorized program. Storage here is a port fixture,
 * never evidence that a real file, native serialization or geometry operation passed. */
export async function prepareCoordinatedModelingProgram(
  operation: string,
): Promise<PreparedPythonArtifact> {
  let captured: PreparedPythonArtifact | undefined;
  let nativeCalls = 0;
  if (operation.startsWith("selection.rule.")) {
    await executeSelectionRule(
      true,
      operation,
      operation === "selection.rule.define"
        ? {
            ruleId: "outer-side",
            query: {
              kind: "face",
              occurrence: "Part:1",
              filters: { geometry: "plane", axis: [1, 0, 0] },
              expect: 1,
            },
            exclude: [],
          }
        : { artifact: selectionReference },
      admissionContext,
      {
        store: () => ({
          read: async () => selectionManifest,
          write: async () => selectionReference,
        }),
        async executeNative(internal, data, context) {
          nativeCalls++;
          selectionAuthorization.authorize(internal, data);
          captured = prepareCadScript(internal, data, context);
          return {
            success: true,
            operation,
            status: "resolved",
            manifest: selectionManifest,
            count: 1,
          };
        },
      },
    );
  } else {
    assert.ok(
      operation === "measure.baseline.capture" ||
        operation === "measure.baseline.compare",
    );
    const service = createBrepBaselineService({
      artifacts: {
        publish: () => brepReference,
        read: () => ({
          manifest: brepManifest,
          exactBodies: [new Uint8Array([1])],
          bodyPayloads: [{ role: "housing", bytes: 1, sha256: "c".repeat(64) }],
        }),
      },
      stage: () => ({
        id: "stage-A",
        fusionPaths: ["C:/owned/baseline-stage/body0.smt"],
        read: () => new Uint8Array([1]),
        write: () => {},
        dispose: () => {},
      }),
      newSession: () => "session-A",
      async executeNative(action, data) {
        nativeCalls++;
        brepAuthorization.authorize(data);
        captured = prepareCadScript(
          "measure.baseline." + action + "_internal",
          data,
          admissionContext,
        );
        return {
          status: "unsupported",
          reason: "Admission fixture does not run native serialization",
        };
      },
    });
    const bodies = [
      { role: "housing", body: { kind: "body", token: "body-A" } },
    ];
    await service.execute(
      operation,
      operation === "measure.baseline.capture"
        ? { bodies, frame: "assembly", scope: "durable" }
        : {
            bodies,
            baseline: brepReference,
            tolerances: {
              volume: "0.001 mm^3",
              length: "0.001 mm",
              angle: "0.001 deg",
            },
          },
      admissionContext,
    );
  }
  assert.equal(nativeCalls, 1);
  assert.ok(
    captured,
    operation + " must produce its authorized internal program",
  );
  return captured;
}

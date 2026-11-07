import type {
  SemanticModelStateRequest,
  SemanticModelSnapshot,
} from "../packages/core/src";

const scope = {
  kind: "explicit-bindings",
  document: { creationId: "creation", fileId: "file", version: 3 },
} as const;
const snapshot: SemanticModelSnapshot = {
  schemaVersion: 2,
  status: "partial",
  coverage: "partial",
  precision: "observational",
  exactBRepEquivalence: false,
  scope,
  entities: [
    {
      role: "drive",
      source: {
        id: "motor-definition",
        document: {
          creationId: "source-creation",
          fileId: "source-file",
          version: 2,
        },
      },
      instance: ["Root:1", "Motor:2"],
      geometry: { volumeCm3: 42 },
      pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      attributes: [],
      topology: { vertices: 8 },
      visibility: { proxyVisible: true },
    },
  ],
};

export const validRequests: readonly SemanticModelStateRequest[] = [
  {
    operation: "frame.context_audit",
    data: {
      ref: { kind: "body", name: "Housing" },
      sourceId: "housing-v1",
      instance: ["Root:1", "Housing:1"],
      datumToRoot: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      datumSource: { kind: "analytic-fixture", version: 1 },
      matrixTolerance: 1e-9,
    },
  },
  {
    operation: "snapshot.capture_v2",
    data: {
      scope,
      bindings: [
        {
          role: "drive",
          sourceId: "motor-definition",
          ref: "Drive",
          instance: ["Root:1", "Motor:2"],
        },
      ],
    },
  },
  {
    operation: "snapshot.diff_v2",
    data: {
      before: snapshot,
      after: snapshot,
      allowedMovedSubtrees: [["Root:1", "Motor:2"]],
      tolerances: { pose: 1e-8, geometry: 1e-7 },
    },
  },
];

const unsupportedOperation: SemanticModelStateRequest = {
  // @ts-expect-error only the versioned public operation names are accepted
  operation: "snapshot.diff",
  // @ts-expect-error request data must match the selected operation
  data: {},
};
const emptyAllowedSubtree: SemanticModelStateRequest = {
  operation: "snapshot.diff_v2",
  data: {
    before: snapshot,
    after: snapshot,
    // @ts-expect-error a moved subtree must contain at least one path segment
    allowedMovedSubtrees: [[]],
  },
};

void unsupportedOperation;
void emptyAllowedSubtree;

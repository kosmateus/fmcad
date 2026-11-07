import type {
  FmcadServices,
  SelectionRuleArtifactReference,
  SelectionRuleInvocation,
} from "../src/api/contracts";

const artifact: SelectionRuleArtifactReference = {
  version: 1,
  artifactId: "selection-artifact-1",
  projectId: "project-1",
  documentFileId: "file-1",
  documentCreationId: "creation-1",
  sha256: "a".repeat(64),
};

const definition: SelectionRuleInvocation = {
  version: 1,
  kind: "cad",
  operation: "selection.rule.define",
  doc: "Model",
  docFileId: "file-1",
  data: {
    ruleId: "outer-face",
    query: {
      kind: "face",
      scope: { occurrence: "Part:1" },
      filters: { name: "Outer" },
      expect: 1,
    },
    exclude: [],
  },
};

const inspect: SelectionRuleInvocation = {
  version: 1,
  kind: "cad",
  operation: "selection.rule.inspect",
  doc: "Model",
  docFileId: "file-1",
  data: { artifact },
};

const missingScope: SelectionRuleInvocation = {
  version: 1,
  kind: "cad",
  operation: "selection.rule.define",
  doc: "Model",
  docFileId: "file-1",
  // @ts-expect-error A query without an explicit scope is not a selection rule.
  data: {
    ruleId: "outer-face",
    query: { kind: "face", filters: { name: "Outer" }, expect: 1 },
  },
};

const missingExpectedBounds: SelectionRuleInvocation = {
  version: 1,
  kind: "cad",
  operation: "selection.rule.define",
  doc: "Model",
  docFileId: "file-1",
  // @ts-expect-error A cardinality range needs at least one bound.
  data: {
    ruleId: "outer-face",
    query: {
      kind: "face",
      scope: { occurrence: "Part:1" },
      filters: { name: "Outer" },
      expect: {},
    },
  },
};

const unresolvedArtifact: SelectionRuleInvocation = {
  version: 1,
  kind: "cad",
  operation: "selection.rule.check",
  doc: "Model",
  docFileId: "file-1",
  // @ts-expect-error Artifact provenance requires a SHA-256 digest.
  data: {
    artifact: {
      version: 1,
      artifactId: "selection-artifact-1",
      projectId: "project-1",
      documentFileId: "file-1",
      documentCreationId: "creation-1",
    },
  },
};

export function typedSelectionRuleApi(services: FmcadServices) {
  return [
    services.execute(definition, { requestId: "selection-define" }),
    services.execute(inspect, { requestId: "selection-inspect" }),
    services.execute(missingScope, { requestId: "selection-invalid-scope" }),
    services.execute(missingExpectedBounds, {
      requestId: "selection-invalid-cardinality",
    }),
    services.execute(unresolvedArtifact, {
      requestId: "selection-invalid-artifact",
    }),
  ];
}

import { CONTRACT_VERSION } from "../domain/contracts";
import type { EvidenceStatus } from "../domain/contracts";
import type { OperationContract } from "./index";

export interface CapabilitySearchInput {
  readonly query?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface CapabilityItem {
  readonly id: string;
  readonly kind: "operation" | "helper";
  readonly method: string;
  readonly summary: string;
  readonly implementation: "catalog-declared" | "cad-v1-helper";
  readonly service: string;
  readonly prerequisites: {
    readonly backend: readonly string[];
    readonly sdk: string;
    readonly cloud: string;
    readonly requiredInputs: readonly string[];
    readonly build: {
      readonly contractVersion: number;
      readonly nativeCompatibility: "unknown";
    };
    readonly identity: {
      readonly documentRequired: boolean;
      readonly targetInspected: false;
      readonly pinning: "operation-specific";
    };
  };
  readonly mutation: {
    readonly readOnlyRequested: boolean | null;
    readonly readOnlyEnforced: false;
    readonly possible: "none" | "possible" | "unknown";
    readonly restoration: "not-applicable" | "operation-specific" | "unknown";
  };
  readonly evidence: {
    readonly status: EvidenceStatus;
    readonly precision: EvidenceStatus;
    readonly coverage: EvidenceStatus;
    readonly sdkProbe: "not-run";
  };
  readonly limitations: readonly string[];
}

interface HelperDeclaration {
  readonly id: string;
  readonly method: string;
  readonly summary: string;
  readonly searchTerms: readonly string[];
  readonly possibleMutation: "none" | "possible" | "unknown";
  readonly restoration: "not-applicable" | "operation-specific" | "unknown";
  readonly limitations: readonly string[];
}

/** This describes only the public cad-v1 facade methods. Tests keep this list
 * aligned with the actual helpers.py class; it is not a second command list. */
export const CAD_V1_HELPERS: readonly HelperDeclaration[] = [
  {
    id: "call",
    method: "FMCAD.call",
    summary:
      "Dispatch one catalog operation through the current cad-v1 context.",
    searchTerms: ["execute", "operation", "read only", "mutation"],
    possibleMutation: "possible",
    restoration: "operation-specific",
    limitations: [
      "The effect and restoration behavior come from the selected operation; this facade is not a sandbox or rollback mechanism.",
    ],
  },
  {
    id: "resolve",
    method: "FMCAD.resolve",
    summary: "Resolve a reference to one entity of an optional expected kind.",
    searchTerms: ["find", "lookup", "entity", "reference", "ambiguous"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Resolution depends on the active context and supported entity resolver; ambiguous or stale references are not accepted as unique.",
    ],
  },
  {
    id: "frame_context_audit",
    method: "FMCAD.frame_context_audit",
    summary:
      "Audit independent datum, native/proxy transforms and sampled BRep points for one explicit instance.",
    searchTerms: ["frame", "context", "transform", "proxy", "datum", "BRep"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Datum provenance must be independent of the transform being audited; BRep witnesses are sampled, not exact equivalence.",
    ],
  },
  {
    id: "snapshot_capture_v2",
    method: "FMCAD.snapshot_capture_v2",
    summary:
      "Capture an inline semantic model snapshot v2 for explicit role/source/instance bindings.",
    searchTerms: [
      "snapshot",
      "semantic",
      "model state",
      "identity",
      "visibility",
    ],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "The snapshot is returned inline; no global snapshot store or exact BRep equivalence is provided.",
    ],
  },
  {
    id: "snapshot_diff_v2",
    method: "FMCAD.snapshot_diff_v2",
    summary:
      "Diff inline semantic model snapshots by identity and observed state channels.",
    searchTerms: [
      "snapshot",
      "diff",
      "pose",
      "geometry",
      "topology",
      "allowed subtree",
    ],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Allowlisted moved subtrees permit only pose differences and do not prove exact geometry equivalence.",
    ],
  },
  {
    id: "stage",
    method: "FMCAD.stage",
    summary: "Read the authenticated queued worker's attached stage journal snapshot.",
    searchTerms: ["stage", "journal", "queue", "worker", "reconciliation"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Available only to the authenticated queued worker context; not a filesystem or broker query facade.",
    ],
  },
  {
    id: "journalInspect",
    method: "FMCAD.journalInspect",
    summary: "Inspect the authenticated queued worker's attached stage journal evidence.",
    searchTerms: ["stage", "journal", "inspect", "reconciliation"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Returns only the immutable snapshot injected by the authenticated worker; it does not inspect arbitrary paths or reconcile work.",
    ],
  },
  {
    id: "resumePlan",
    method: "FMCAD.resumePlan",
    summary: "Read the authenticated queued worker's safe stage continuation plan.",
    searchTerms: ["stage", "resume", "plan", "reconciliation"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "The plan is descriptive and never resumes or retries a stage by itself.",
    ],
  },
  {
    id: "selection_rule_define",
    method: "FMCAD.selection_rule_define",
    summary: "Define a scoped in-memory native entity selection rule manifest.",
    searchTerms: ["selection", "rule", "entity", "scope", "manifest"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "The current entity query must satisfy explicit expected cardinality and component/occurrence/instance scope before an inline manifest is returned.",
      "The cad-v1 helper returns an inline manifest and does not persist it; it has no durable ArtifactStore port. Use selection.rule.define through CLI/MCP for project-owned persistence.",
      "This does not mutate CAD geometry or qualify native Fusion behavior.",
    ],
  },
  {
    id: "selection_rule_inspect",
    method: "FMCAD.selection_rule_inspect",
    summary: "Inspect an owned selection rule manifest without resolving topology.",
    searchTerms: ["selection", "rule", "inspect", "provenance", "owner"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "The exact project and document owner are required; inspection does not check current topology.",
      "The cad-v1 helper accepts an inline manifest only; use selection.rule.inspect through CLI/MCP for an owned artifact reference.",
    ],
  },
  {
    id: "selection_rule_resolve",
    method: "FMCAD.selection_rule_resolve",
    summary: "Re-run a persisted selection rule against current native topology.",
    searchTerms: ["selection", "rule", "resolve", "split", "merge", "stale", "ambiguous"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Resolution reports topology changes explicitly and never chooses a first match or repairs historical references.",
      "The cad-v1 helper accepts and returns inline manifests but does not persist an update. Use selection.rule.resolve through CLI/MCP for an owned artifact reference.",
      "Native Fusion qualification remains pending.",
    ],
  },
  {
    id: "selection_rule_check",
    method: "FMCAD.selection_rule_check",
    summary: "Require an owned selection rule to resolve with exact cardinality and current source version.",
    searchTerms: ["selection", "rule", "check", "acceptance", "cardinality"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Only an unambiguous resolved result passes; native topology correctness and physical CAD acceptance are not implied.",
      "The cad-v1 helper checks an inline manifest only; use selection.rule.check through CLI/MCP for durable project/document ownership.",
    ],
  },
  {
    id: "length",
    method: "FMCAD.length",
    summary: "Create a length value using the current cad-v1 context.",
    searchTerms: ["dimension", "units", "distance"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Unit parsing and native feasibility are delegated to the current context and are not independently qualified here.",
    ],
  },
  {
    id: "angle",
    method: "FMCAD.angle",
    summary: "Create an angle value using the current cad-v1 context.",
    searchTerms: ["rotation", "units", "orientation"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Unit parsing and native feasibility are delegated to the current context and are not independently qualified here.",
    ],
  },
  {
    id: "point",
    method: "FMCAD.point",
    summary: "Create a point value using the current cad-v1 context.",
    searchTerms: ["coordinate", "position", "vector"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Coordinate frame and unit behavior are delegated to the current context and must be checked by the caller.",
    ],
  },
  {
    id: "value",
    method: "FMCAD.value",
    summary: "Evaluate or wrap a value using the current cad-v1 context.",
    searchTerms: ["expression", "parameter", "units"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Evaluation semantics are delegated to the current context; a returned value is not evidence that a model update is feasible.",
    ],
  },
  {
    id: "collection",
    method: "FMCAD.collection",
    summary: "Create a collection using the current cad-v1 context.",
    searchTerms: ["entities", "selection", "collection"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Accepted collection elements and native behavior are delegated to the current context.",
    ],
  },
  {
    id: "parameter_test",
    method: "FMCAD.parameter_test",
    summary:
      "Run parameter cases with caller-supplied case and restoration checks.",
    searchTerms: ["parameter", "sensitivity", "restore", "regenerate"],
    possibleMutation: "possible",
    restoration: "operation-specific",
    limitations: [
      "The helper may change parameters while evaluating cases; caller callbacks must verify the requested state and restoration.",
      "A helper result does not make an incomplete or unknown case a pass.",
    ],
  },
  {
    id: "temporary_body",
    method: "FMCAD.temporary_body",
    summary:
      "Measure a body using a temporary construction in the current context.",
    searchTerms: ["temporary", "body", "measurement", "restore"],
    possibleMutation: "possible",
    restoration: "operation-specific",
    limitations: [
      "Temporary geometry and cleanup are implementation-specific; inspect returned restoration evidence before treating the result as complete.",
    ],
  },
  {
    id: "compare_bodies",
    method: "FMCAD.compare_bodies",
    summary: "Compare two bodies using the requested frame and tolerances.",
    searchTerms: ["compare", "difference", "geometry", "tolerance", "BRep"],
    possibleMutation: "unknown",
    restoration: "operation-specific",
    limitations: [
      "The underlying method determines precision and coverage; this catalog entry does not claim exact equivalence or a native qualification.",
    ],
  },
  {
    id: "require_pass",
    method: "FMCAD.require_pass",
    summary:
      "Require an unambiguous passing result and reject unresolved evidence states.",
    searchTerms: [
      "acceptance",
      "gate",
      "unknown",
      "partial",
      "unsupported",
      "missing",
      "stale",
      "blocked",
    ],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "This checks the supplied result fields; it does not rerun a control, validate geometry, or supply missing evidence.",
    ],
  },
  {
    id: "require_history_end",
    method: "FMCAD.require_history_end",
    summary:
      "Require the design history marker to be at the end of the timeline.",
    searchTerms: ["timeline", "history", "rollback", "end"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "A marker-at-end check does not prove that features are healthy or that geometry is correct.",
    ],
  },
  {
    id: "emit",
    method: "FMCAD.emit",
    summary:
      "Publish one JSON-serializable result through the cad-v1 terminal envelope.",
    searchTerms: ["result", "output", "json"],
    possibleMutation: "none",
    restoration: "not-applicable",
    limitations: [
      "Emission is limited to one JSON-serializable value and does not itself validate its claims.",
    ],
  },
];

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

function searchParts(input: unknown): {
  query: string;
  tokens: string[];
  limit: number;
  offset: number;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Capability search input must be an object");
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).filter(
    (key) => !["query", "limit", "offset"].includes(key),
  );
  if (unknown.length)
    throw new Error("Unknown capability search inputs: " + unknown.join(", "));
  const query = Object.hasOwn(value, "query") ? value["query"] : "";
  if (
    typeof query !== "string" ||
    Array.from(query).length > 256 ||
    /[\x00-\x1f\x7f-\x9f]/u.test(query)
  )
    throw new Error("Capability query must be up to 256 printable characters");
  const limit = Object.hasOwn(value, "limit") ? value["limit"] : 50;
  const offset = Object.hasOwn(value, "offset") ? value["offset"] : 0;
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > 100
  )
    throw new Error("Capability limit must be an integer from 1 to 100");
  if (
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    (offset as number) > 1_000_000
  )
    throw new Error("Capability offset must be a nonnegative safe integer");
  const normalizedQuery = query.trim();
  const tokens = normalize(normalizedQuery).match(/[\p{L}\p{N}]+/gu) ?? [];
  return {
    query: normalizedQuery,
    tokens,
    limit: limit as number,
    offset: offset as number,
  };
}

export function validateCapabilitySearchInput(input: unknown): void {
  searchParts(input);
}

function operationItem(contract: OperationContract): {
  item: CapabilityItem;
  searchText: string;
  example: Readonly<Record<string, unknown>>;
} {
  const declaration = contract.declaration;
  const item: CapabilityItem = {
    id: contract.operation,
    kind: "operation",
    method: contract.cli.key,
    summary: declaration.summary,
    implementation: "catalog-declared",
    service: `${contract.service.kind}:${contract.service.handler}`,
    prerequisites: {
      backend:
        contract.service.kind === "local"
          ? ["local"]
          : [...contract.requirements.backends],
      sdk: contract.requirements.sdk,
      cloud: contract.requirements.cloud,
      requiredInputs: [...contract.schema.required],
      build: {
        contractVersion: CONTRACT_VERSION,
        nativeCompatibility: "unknown",
      },
      identity: {
        documentRequired: contract.requirements.document,
        targetInspected: false,
        pinning: "operation-specific",
      },
    },
    mutation: {
      readOnlyRequested: contract.readOnlyRequested,
      readOnlyEnforced: false,
      possible:
        contract.operation === "capabilities.inspect"
          ? "none"
          : contract.readOnlyRequested
            ? "unknown"
            : "possible",
      restoration:
        contract.operation === "capabilities.inspect"
          ? "not-applicable"
          : "unknown",
    },
    evidence: {
      status: "unknown",
      precision: "unknown",
      coverage: "unknown",
      sdkProbe: "not-run",
    },
    limitations: [...declaration.limitations],
  };
  return {
    item,
    searchText: [
      contract.operation,
      contract.cli.key,
      ...contract.cli.aliases,
      declaration.summary,
      ...Object.keys(contract.schema.properties),
      ...Object.values(contract.schema.properties).map(
        (property) => property.description,
      ),
      ...declaration.required,
      JSON.stringify(declaration.example),
      ...declaration.limitations,
      ...Object.values(declaration).filter(
        (entry): entry is string => typeof entry === "string",
      ),
    ].join(" "),
    example: declaration.example,
  };
}

function helperItem(helper: HelperDeclaration): {
  item: CapabilityItem;
  searchText: string;
  example: null;
} {
  const item: CapabilityItem = {
    id: `helper.${helper.id}`,
    kind: "helper",
    method: helper.method,
    summary: helper.summary,
    implementation: "cad-v1-helper",
    service: "fusion-script:cad-v1",
    prerequisites: {
      backend: ["fmcad run --helpers cad-v1"],
      sdk: "conditional",
      cloud: "none",
      requiredInputs: [],
      build: {
        contractVersion: CONTRACT_VERSION,
        nativeCompatibility: "unknown",
      },
      identity: {
        documentRequired: true,
        targetInspected: false,
        pinning: "operation-specific",
      },
    },
    mutation: {
      readOnlyRequested: null,
      readOnlyEnforced: false,
      possible: helper.possibleMutation,
      restoration: helper.restoration,
    },
    evidence: {
      status: "unknown",
      precision: "unknown",
      coverage: "unknown",
      sdkProbe: "not-run",
    },
    limitations: [...helper.limitations],
  };
  return {
    item,
    example: null,
    searchText: [
      helper.id,
      helper.method,
      helper.summary,
      ...helper.searchTerms,
      ...helper.limitations,
    ].join(" "),
  };
}

/** Pure, offline projection of registered operation contracts and cad-v1 helpers. */
export function inspectCapabilities(
  contracts: Readonly<Record<string, OperationContract>>,
  input: CapabilitySearchInput,
) {
  const { query, tokens, limit, offset } = searchParts(input);
  const entries = [
    ...Object.values(contracts)
      .filter((contract) => !contract.declaration.internalOnly)
      .map(operationItem),
    ...CAD_V1_HELPERS.map(helperItem),
  ];
  const ranked = entries
    .map((entry) => {
      const text = normalize(entry.searchText);
      const score = tokens.reduce(
        (sum, token) => sum + (text.includes(token) ? 1 : 0),
        0,
      );
      return { ...entry, score };
    })
    .filter((entry) => !query || entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.item.id < right.item.id
          ? -1
          : left.item.id > right.item.id
            ? 1
            : 0),
    );
  const page = ranked.slice(offset, offset + limit);
  return {
    success: true,
    status: "pass" as const,
    schemaVersion: 1 as const,
    source: "catalog+cad-v1" as const,
    query: query || null,
    totalMatches: ranked.length,
    offset,
    limit,
    nextOffset:
      offset + page.length < ranked.length ? offset + page.length : null,
    items: page.map(({ item }) => item),
    cookbook: page.flatMap(({ item, example }) =>
      item.kind === "operation" && example
        ? [
            {
              capabilityId: item.id,
              method: item.method,
              title: item.summary,
              example,
            },
          ]
        : [],
    ),
    boundaries: {
      inventoryCoverage: "exact-registered-catalog-and-public-helper-index",
      modelValidation: "not-performed",
      nativeSdkProbe:
        "not-run; separate explicit broker SDK probe port required",
    },
  };
}

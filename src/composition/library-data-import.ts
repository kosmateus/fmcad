import { createRequire } from "node:module";
import type { OperationDeclaration } from "@fmcad/core";
const load = createRequire(__filename);
const {
  stable,
  csv,
  multiply,
  inverse,
  rigid,
  transform,
}: typeof import("../../packages/core/src/application/documents/import-values.js") =
  load("../core/application/documents/import-values.js");
const {
  dataImportFiles: localFiles,
}: typeof import("../../packages/node-adapters/src/persistence/data-import-files.js") =
  load("../node-adapters/persistence/data-import-files.js");
const {
  createImportWorkflow,
}: typeof import("../../packages/core/src/application/documents/import-workflow.js") =
  load("../core/application/documents/import-workflow.js");

// GM-02 owns the public descriptors, file adapter and offline preflight.
const common = {
  version: "Required integer 1 (adapter format version).",
  source:
    "CSV/JSON path on the CLI host; mutually exclusive with records. Relative paths use baseDir (default CLI cwd).",
  records: "Inline array of records, mutually exclusive with source.",
  baseDir:
    "Absolute CLI-host directory for source and model paths. Never interpreted on the Fusion host.",
  schema:
    "Optional {recordsPath, columns, defaults, values, delimiter}. columns maps canonical field names to source dotted paths; values provides explicit enum/value maps. Nested CSV values are JSON. See docs/DATA_IMPORT.md.",
  owner: "Required nonempty import ownership namespace for mutations.",
  revision:
    "Required nonempty source revision for mutations; retained with SHA256 provenance.",
  onExisting:
    "error (default), reuse (exact owned revision/content/state), update (owned prior revision with expectedRevision).",
  expectedRevision:
    "Required prior owned revision for update; no adoption of unowned objects.",
  maxItems:
    "Positive integer work/expansion bound, default 10000, maximum 100000.",
  budgetMs:
    "Positive integer native cooperative execution budget in milliseconds; default 120000. An in-flight SDK call cannot be cancelled; partial results require inspection.",
  inspectModel:
    "Checks only: true compares current Fusion state; otherwise checks supplied data offline without a backend.",
  observed:
    "Optional check evidence: catalog {instances:[{id,item,parent}], identity?, revision?} or placement {poses:[{id,transform}], identity?,revision?}. Historical snapshot, not live proof.",
};
const catalogInputs = {
  bom: "Optional array {id,quantity,basis:physical|purchase|contents}, or {source,schema?,baseDir?} CSV/JSON adapter. Quantities compared independently; no inferred PCBA mass.",
  instances:
    "Optional explicit array {id,item,parent,localKey,placement?}. parent is another instance ID or null. Reused assembly definitions must have identical local child structure.",
};
const descriptors: Record<string, OperationDeclaration> = {};
for (const op of [
  "param.import",
  "catalog.import",
  "catalog.check",
  "placement.import",
  "placement.check",
  "cots.replace",
]) {
  const check = op.endsWith(".check");
  descriptors[op] = {
    summary: `${op.replace(".", " ")}: versioned data preflight, explicit units, provenance and ownership; ${check ? "offline ledger or requested live comparison" : "guarded document mutation"}.`,
    dataImport: true,
    requiresDoc: !check,
    readOnly: check,
    required: ["version"],
    inputs: {
      ...common,
      ...(op.startsWith("catalog.") ? catalogInputs : {}),
      ...(op.startsWith("placement.")
        ? {
            tolerance:
              "Check translation tolerance with units (default 0.001 mm).",
            angleTolerance:
              "Check rotation tolerance with units (default 0.01 deg).",
          }
        : {}),
      ...(op === "cots.replace"
        ? {
            target: "Owned catalog item ID to replace.",
            model:
              "Required {path,representation:vendor|envelope,source,status,revision?,sha256?}; native geometry, never scaled.",
            occurrencePolicy:
              "all or selected; selected requires exact occurrence refs. Replacement invalidates geometry refs.",
            occurrences: "Exact occurrence refs for selected policy.",
            childrenPolicy:
              "error (default) or preserve. Preserve separately cataloged child occurrences in world space; requires model.includedItems and rejects duplicate included children.",
            datumMap:
              "Nonempty array {name,old,new}; old/new are complete local-to-component rigid transforms. Every datum must imply the same replacement transform.",
            impacts:
              "Required {matingParts,routings,refs,mass}; each {status:known|unknown,items:[],source?}. Missing evidence stays unknown.",
            acceptInvalidation:
              "Exactly true acknowledges invalidated geometry refs and downstream checks; constrained/externally referenced targets remain blocked.",
            mass: "Optional replacement mass evidence object; absent mass remains unknown, never zero.",
          }
        : {}),
    },
    example: { version: 1, owner: "example", revision: "r1", records: [] },
    usage: `${op.replace(".", " ")} ${check ? "[--doc <name> --inspect-model true] " : "--doc <name> "}--file <adapter.json> [--json] [--preview]`,
    limitations: [
      "See docs/DATA_IMPORT.md for typed record schemas. Full data preflight precedes mutations; kernel failures can leave partial state and are never retried.",
      "Offline checks do not inspect Fusion. Neutral geometry is importedReference, poses are snapshots, parameters reuse native expressions. Missing evidence is unknown, not pass.",
      "No implicit save, scaling, source approval, material substitution or automatic downstream reference repair.",
    ],
  };
}
const examplePose = {
  frame: "parent",
  translation: ["0 mm", "0 mm", "0 mm"],
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};
descriptors["param.import"]!.example["records"] = [
  {
    name: "wall",
    expression: "2 mm",
    unit: "mm",
    status: "CONFIRMED",
    source: "Fixture drawing",
  },
];
for (const op of ["catalog.import", "catalog.check"])
  descriptors[op]!.example = {
    version: 1,
    owner: "example",
    revision: "r1",
    ...(op.endsWith(".check") ? { inspectModel: true } : {}),
    records: [
      {
        id: "plate",
        name: "Plate",
        kind: "part",
        quantity: 1,
        parent: null,
        placement: examplePose,
        status: "CONFIRMED",
      },
    ],
  };
for (const op of ["placement.import", "placement.check"])
  descriptors[op]!.example = {
    version: 1,
    owner: "example",
    revision: "r1",
    ...(op.endsWith(".check") ? { inspectModel: true } : {}),
    records: [
      {
        id: "plate:1",
        occurrence: "Plate:1",
        placement: examplePose,
        status: "CONFIRMED",
      },
    ],
  };
descriptors["cots.replace"]!.example = {
  version: 1,
  owner: "example",
  revision: "r2",
  expectedRevision: "r1",
  target: "sensor",
  model: {
    path: "replacement.step",
    representation: "envelope",
    source: "Example only",
    status: "ESTIMATED",
  },
  occurrencePolicy: "all",
  datumMap: [
    {
      name: "mount",
      old: { ...examplePose, frame: "component" },
      new: { ...examplePose, frame: "component" },
    },
  ],
  impacts: Object.fromEntries(
    ["matingParts", "routings", "refs", "mass"].map((k) => [
      k,
      { status: "unknown", items: [] },
    ]),
  ),
  acceptInvalidation: true,
};

const workflow = createImportWorkflow(
  (op) => (descriptors[op] ? Object.keys(descriptors[op].inputs) : null),
  localFiles,
);

const prepare: ReturnType<typeof createImportWorkflow>["prepare"] =
  workflow.prepare;
const offlineResult: ReturnType<typeof createImportWorkflow>["offlineResult"] =
  workflow.offlineResult;

function isOffline(operation: string, data: Record<string, unknown>) {
  return (
    !!descriptors[operation] &&
    operation.endsWith(".check") &&
    data["inspectModel"] !== true
  );
}

const manuals = Object.fromEntries(
  Object.entries(descriptors).map(([op, spec]) => [
    op,
    {
      sections: [
        { title: "Return Contract", text: spec.summary },
        { title: "Source And Limitations", text: spec.limitations.join(" ") },
      ],
      examples: [
        {
          label: op,
          requires:
            "Existing names/IDs from discovery and model paths on the CLI host. See docs/DATA_IMPORT.md.",
          data: spec.example,
          output:
            "Versioned preflight/plan or check envelope; inspect status, unresolved, differences and provenance.",
        },
      ],
      audit: {
        sources: ["src/data-import.js", "docs/DATA_IMPORT.md"],
        verified: [
          "versioned adapter preflight and strict CSV/JSON parsing",
          "ownership/revision/provenance and onExisting policy",
          "catalog/placement/param record validation and offline checks",
          "cots.replace datum-map consistency and impact invalidation",
        ],
        tests: ["tests/data_import.test.ts", "tests/data_import_test.py"],
        gaps: [],
        bugs: [
          "Offline checks do not inspect a live Fusion model; kernel failures are never retried.",
        ],
      },
    },
  ]),
);

export {
  descriptors,
  prepare,
  offlineResult,
  isOffline,
  csv,
  transform,
  rigid,
  multiply,
  inverse,
  stable,
  manuals,
};

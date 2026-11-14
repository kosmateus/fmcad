import type { SpawnSyncReturns } from "node:child_process";
import assert from "node:assert/strict";
import {
  asArray,
  asRecord,
  type JsonRecord,
  type LiveDocumentSnapshot,
  type PublicQueueJob,
  type QueueOutputDescriptor,
} from "./live-import-receipts.js";

/** Pure validation used unchanged by the retained native runner and offline fault cases. */
export interface RuntimeConfig extends JsonRecord {
  backend: string;
  transport: string;
  timeoutMs: number;
}

export interface ParameterReadback extends JsonRecord {
  name: string;
  expression: string;
  unit?: string;
  value: number;
}

export interface CatalogInstance extends JsonRecord {
  id: string;
  occurrence: EntityReference;
  item?: string;
  parent?: string | null;
  componentName?: string;
}

export interface EntityReference extends JsonRecord {
  path?: string;
}

export interface FailureResult extends JsonRecord {
  error: string;
  mutationMayHaveOccurred?: boolean;
}

export interface ParameterResult extends JsonRecord {
  parameters: ParameterReadback[];
}

export interface CatalogImportResult extends JsonRecord {
  instances: CatalogInstance[];
  idMap: Record<string, CatalogIdMapEntry>;
}

export interface CatalogCheckResult extends JsonRecord {
  differences: unknown[];
  instances: CatalogInstance[];
}

export interface PlacementPose extends JsonRecord {
  status: string;
  actual: number[];
}
export interface PlacementResult extends JsonRecord {
  poses: PlacementPose[];
}

export interface CotsReplacementResult extends JsonRecord {
  replacements: Array<
    { before: EntityReference; after: EntityReference } & JsonRecord
  >;
  datumChecks: Array<{ status: string } & JsonRecord>;
  unresolved: Array<{ id: string; field: string; status: string } & JsonRecord>;
}

export interface EntityInspectResult extends JsonRecord {
  kind: string;
  occurrencePath: string;
}

export interface ComponentResult extends JsonRecord {
  component: { name: string } & JsonRecord;
  bodies: EntityReference[];
}

export interface ComponentCreateResult extends JsonRecord {
  component: { name: string } & JsonRecord;
}

export interface ShapeResult extends JsonRecord {
  bodies: EntityReference[];
}

export interface VolumeResult extends JsonRecord {
  value: number;
}

export interface ExportResult extends JsonRecord {
  exists: boolean;
  bytes: number;
}

export interface EntityListResult extends JsonRecord {
  entities: Array<{ path: string } & JsonRecord>;
}

export type GenericResult = JsonRecord;

export interface OperationResultMap {
  "param.import": ParameterResult;
  "param.inspect": ParameterResult;
  "catalog.import": CatalogImportResult;
  "catalog.check": CatalogCheckResult;
  "placement.import": PlacementResult;
  "placement.check": PlacementResult;
  "cots.replace": CotsReplacementResult;
  "entity.inspect": EntityInspectResult;
  "component.inspect": ComponentResult;
  "component.create": ComponentCreateResult;
  "shape.box": ShapeResult;
  "measure.volume": VolumeResult;
  "export.step": ExportResult;
  "entity.list": EntityListResult;
  "document.status": GenericResult;
}

export type DataOperationResult =
  OperationResultMap[Operation] | FailureResult | GenericResult;

export interface CadCliOutput<
  T extends JsonRecord = DataOperationResult & JsonRecord,
> extends JsonRecord {
  success: boolean;
  status?: string;
  result: T;
  document?: string;
  documentIdentity?: { creationId?: string } | null;
  method?: string;
  modelValidated?: boolean;
  mutation?: boolean;
  error?: string;
  workerEvidence?: { receipt: PublicQueueJob; workerOutput: WorkerOutput };
}

export interface WorkerOutput {
  stdout: string | null;
  stderr: string | null;
  descriptors: Record<string, QueueOutputDescriptor> | null;
}

export interface CatalogIdMapEntry extends JsonRecord {
  definition: string;
}

export type Operation = (typeof operationNames)[number];

export interface CadOptions {
  component?: string;
  native?: boolean;
  expect?: "pass" | "blocked" | "unknown" | "local-pass" | "local-unknown";
}

export function requiredItem<T>(
  values: readonly T[],
  index: number,
  label: string,
): T {
  const value = values[index];
  assert.ok(value, `${label}[${index}] is missing`);
  return value;
}

export function parseCadCliOutput(value: unknown, label: string): CadCliOutput {
  const row = asRecord(value, `${label} output`);
  assert.equal(
    typeof row["success"],
    "boolean",
    `${label}.success must be boolean`,
  );
  const result =
    row["result"] === undefined
      ? {}
      : asRecord(row["result"], `${label}.result`);
  let documentIdentity: { creationId?: string } | null | undefined;
  if (row["documentIdentity"] === null) documentIdentity = null;
  else if (row["documentIdentity"] !== undefined) {
    const identityRow = asRecord(
      row["documentIdentity"],
      `${label}.documentIdentity`,
    );
    assert.ok(
      identityRow["creationId"] === undefined ||
        typeof identityRow["creationId"] === "string",
    );
    documentIdentity =
      typeof identityRow["creationId"] === "string"
        ? { creationId: identityRow["creationId"] }
        : {};
  }
  return {
    success: row["success"] as boolean,
    ...(typeof row["status"] === "string" ? { status: row["status"] } : {}),
    result: result as DataOperationResult,
    ...(typeof row["document"] === "string"
      ? { document: row["document"] }
      : {}),
    ...(documentIdentity === null
      ? { documentIdentity: null }
      : documentIdentity
        ? { documentIdentity }
        : {}),
    ...(typeof row["method"] === "string" ? { method: row["method"] } : {}),
    ...(typeof row["modelValidated"] === "boolean"
      ? { modelValidated: row["modelValidated"] }
      : {}),
    ...(typeof row["mutation"] === "boolean"
      ? { mutation: row["mutation"] }
      : {}),
    ...(typeof row["error"] === "string" ? { error: row["error"] } : {}),
  };
}

export function requireArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

export function validateOperationResult(
  operation: Operation,
  expectation: CadOptions["expect"],
  result: JsonRecord,
): void {
  if (expectation === "blocked") {
    assert.equal(
      typeof result["error"],
      "string",
      `${operation} failure must include its native error`,
    );
    return;
  }
  if (expectation === "local-pass" || expectation === "local-unknown") return;

  if (operation === "param.import" || operation === "param.inspect") {
    for (const [index, value] of requireArray(
      result["parameters"],
      `${operation}.parameters`,
    ).entries()) {
      const row = asRecord(value, `${operation}.parameters[${index}]`);
      assert.equal(typeof row["name"], "string");
      assert.equal(typeof row["expression"], "string");
      assert.equal(typeof row["value"], "number");
    }
  } else if (operation === "catalog.import" || operation === "catalog.check") {
    const instances = requireArray(
      result["instances"],
      `${operation}.instances`,
    );
    for (const [index, value] of instances.entries()) {
      const row = asRecord(value, `${operation}.instances[${index}]`);
      assert.equal(typeof row["id"], "string");
      asRecord(
        row["occurrence"],
        `${operation}.instances[${index}].occurrence`,
      );
    }
    if (operation === "catalog.import") {
      const idMap = asRecord(result["idMap"], "catalog.import.idMap");
      for (const [id, value] of Object.entries(idMap)) {
        const entry = asRecord(value, `catalog.import.idMap.${id}`);
        assert.equal(typeof entry["definition"], "string");
      }
    } else requireArray(result["differences"], "catalog.check.differences");
  } else if (
    operation === "placement.import" ||
    operation === "placement.check"
  ) {
    for (const [index, value] of requireArray(
      result["poses"],
      `${operation}.poses`,
    ).entries()) {
      const row = asRecord(value, `${operation}.poses[${index}]`);
      assert.equal(typeof row["status"], "string");
      const actual = requireArray(
        row["actual"],
        `${operation}.poses[${index}].actual`,
      );
      assert.ok(
        actual.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ),
        `${operation}.poses[${index}].actual must contain finite numbers`,
      );
    }
  } else if (operation === "cots.replace") {
    for (const [index, value] of requireArray(
      result["replacements"],
      "cots.replace.replacements",
    ).entries()) {
      const row = asRecord(value, `cots.replace.replacements[${index}]`);
      asRecord(row["before"], `cots.replace.replacements[${index}].before`);
      asRecord(row["after"], `cots.replace.replacements[${index}].after`);
    }
    requireArray(result["datumChecks"], "cots.replace.datumChecks");
    requireArray(result["unresolved"], "cots.replace.unresolved");
  } else if (operation === "entity.inspect") {
    assert.equal(typeof result["kind"], "string");
    assert.equal(typeof result["occurrencePath"], "string");
  } else if (operation === "component.inspect") {
    const component = asRecord(
      result["component"],
      "component.inspect.component",
    );
    assert.equal(typeof component["name"], "string");
    requireArray(result["bodies"], "component.inspect.bodies");
  } else if (operation === "component.create") {
    const component = asRecord(
      result["component"],
      "component.create.component",
    );
    assert.equal(typeof component["name"], "string");
  } else if (operation === "shape.box")
    requireArray(result["bodies"], "shape.box.bodies");
  else if (operation === "measure.volume") {
    const value = result["value"];
    assert.equal(typeof value, "number");
    assert.ok(Number.isFinite(value));
  } else if (operation === "export.step") {
    assert.equal(typeof result["exists"], "boolean");
    assert.equal(typeof result["bytes"], "number");
  } else if (operation === "entity.list") {
    for (const [index, value] of requireArray(
      result["entities"],
      "entity.list.entities",
    ).entries()) {
      assert.equal(
        typeof asRecord(value, `entity.list.entities[${index}]`)["path"],
        "string",
      );
    }
  }
}

export function parseDocumentSnapshot(
  value: unknown,
  label: string,
): LiveDocumentSnapshot {
  const row = asRecord(value, label);
  const documents = asArray(row["documents"], `${label}.documents`).map(
    (entry, index) => {
      const document = asRecord(entry, `${label}.documents[${index}]`);
      assert.equal(typeof document["creationId"], "string");
      assert.equal(typeof document["name"], "string");
      assert.equal(typeof document["saved"], "boolean");
      assert.equal(typeof document["modified"], "boolean");
      assert.ok(
        document["fileId"] === null || typeof document["fileId"] === "string",
      );
      return {
        creationId: document["creationId"] as string,
        name: document["name"] as string,
        saved: document["saved"] as boolean,
        modified: document["modified"] as boolean,
        fileId: document["fileId"] as string | null,
      };
    },
  );
  const identities = new Set<string>();
  for (const document of documents) {
    assert.ok(
      !identities.has(document.creationId),
      `${label} contains duplicate creationId ${document.creationId}`,
    );
    identities.add(document.creationId);
  }
  assert.ok(
    row["activeCreationId"] === null ||
      typeof row["activeCreationId"] === "string",
    `${label}.activeCreationId must be a creationId or null`,
  );
  if (typeof row["activeCreationId"] === "string")
    assert.ok(
      identities.has(row["activeCreationId"]),
      `${label}.activeCreationId does not identify an open document`,
    );
  return {
    documents,
    activeCreationId: row["activeCreationId"] as string | null,
  };
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const loaded = asRecord(value, "Runtime configuration result");
  const cfg = asRecord(loaded["cfg"], "Runtime configuration cfg");
  assert.equal(typeof cfg["backend"], "string");
  assert.equal(typeof cfg["transport"], "string");
  assert.equal(typeof cfg["timeoutMs"], "number");
  return cfg as RuntimeConfig;
}

export const operationNames = [
  "param.import",
  "param.inspect",
  "catalog.import",
  "catalog.check",
  "placement.import",
  "placement.check",
  "cots.replace",
  "entity.inspect",
  "component.inspect",
  "component.create",
  "shape.box",
  "measure.volume",
  "export.step",
  "entity.list",
  "document.status",
] as const;

export function assertLocalImportOutcome(
  operation: string,
  result: Pick<
    SpawnSyncReturns<string>,
    "status" | "signal" | "stdout" | "stderr"
  >,
  output: CadCliOutput,
  status: unknown,
  expect: "local-pass" | "local-unknown",
): void {
  if (expect === "local-pass") {
    assert.equal(
      result.status,
      0,
      `${operation} local preflight failed: ${result.stderr || result.stdout}`,
    );
    assert.equal(output.success, true);
    assert.equal(status, "pass");
    assert.equal(
      output.documentIdentity,
      null,
      "Local preflight unexpectedly claimed a live document identity",
    );
    assert.equal(output.method, "CLI data preflight");
    assert.equal(
      output.modelValidated,
      false,
      "Local preflight claimed native model validation",
    );
    assert.equal(output.mutation, false);
  } else if (expect === "local-unknown") {
    assert.equal(
      result.status,
      0,
      `${operation} completed local check retains unknown evidence without claiming native acceptance`,
    );
    assert.equal(
      result.signal,
      null,
      `${operation} local check ended by signal`,
    );
    assert.equal(
      output.success,
      true,
      `${operation} local result should not claim a native failure`,
    );
    assert.equal(
      status,
      "unknown",
      `${operation} without observations must remain unknown`,
    );
    assert.equal(
      output.documentIdentity,
      null,
      "Local preflight unexpectedly claimed a live document identity",
    );
    assert.equal(output.method, "CLI data preflight");
    assert.equal(
      output.modelValidated,
      false,
      "Local preflight claimed native model validation",
    );
    assert.equal(output.mutation, false);
  }
}

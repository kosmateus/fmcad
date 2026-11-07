import path from "node:path";
import { createRequire } from "node:module";
import type {
  CadData,
  CadContext,
  CadOutput,
  BatchCatalog,
  BatchServices,
  BatchValidation,
  DiagnosticBackend,
} from "@fmcad/core";
import type { AtomicClient } from "./batch-atomic.js";
const load = createRequire(__filename);
const core = load(
  "../core/index.js",
) as typeof import("../../packages/core/src/index.js");
const { failedOutcome, redactDiagnostic } = core;
const { hash, clone, resolveReferences } = load(
  "../core/application/cad/json.js",
) as typeof import("../../packages/core/src/application/cad/json.js");
const application = load(
  "../core/application/cad/batch.js",
) as typeof import("../../packages/core/src/application/cad/batch.js");
const planning = load(
  "../core/application/cad/batch-plan.js",
) as typeof import("../../packages/core/src/application/cad/batch-plan.js");
const { expandDefinition } = load(
  "../core/application/cad/definition.js",
) as typeof import("../../packages/core/src/application/cad/definition.js");
const persistence = load(
  "../node-adapters/persistence/batch-journal.js",
) as typeof import("../../packages/node-adapters/src/persistence/batch-journal.js");
const { run: runLocal, localOperations } = load(
  "../../engineering-local.js",
) as {
  run(operation: string, data: CadData): CadOutput;
  localOperations: Record<string, unknown>;
};
export interface BatchClient extends AtomicClient {
  server?: NonNullable<AtomicClient["server"]> & DiagnosticBackend;
}
type Client = BatchClient | null | undefined;
type Execute = (
  client: Client,
  operation: string,
  data: CadData,
  context: CadContext,
) => Promise<CadOutput>;
export interface BatchStages {
  beforeRun(input: {
    data: CadData;
    context: CadContext;
    validation: BatchValidation;
    atomic: boolean;
    requestHash: string;
  }): Promise<void>;
}
const isLocal = (operation: string): boolean =>
  Object.hasOwn(localOperations, operation);
export const validateBatch = (data: unknown, catalog: BatchCatalog) =>
  planning.validateBatch(data, catalog, isLocal);
export function batchServices(
  client: Client,
  executeCad: Execute | undefined,
  catalog: BatchCatalog,
  stageDependencies?: BatchStages,
): BatchServices {
  return {
    catalog,
    isLocal,
    local: runLocal,
    async beforeRun(data, context, validation, atomic) {
      const mutates = (validation.operations || []).some(
        (step) =>
          !isLocal(step.operation) &&
          catalog[step.operation]?.readOnly !== true,
      );
      if (!mutates || !stageDependencies) return;
      const request = structuredClone(data);
      delete request["mode"];
      delete request["reportPath"];
      const requestHash = hash({ request, context: structuredClone(context) });
      await stageDependencies.beforeRun({
        data,
        context,
        validation,
        atomic,
        requestHash,
      });
    },
    execute:
      typeof executeCad === "function"
        ? (operation, data, context) =>
            executeCad(client, operation, data, context)
        : undefined,
    atomic: (data, context, validation) =>
      (
        load("./batch-atomic.js") as typeof import("./batch-atomic.js")
      ).runAtomicBatch(client, data, context, executeCad, catalog, validation),
    reportPath: (data) =>
      path.resolve(
        (data["reportPath"] as string) ||
          path.join(".fmcad-batch", data["runId"] as string),
      ),
    now: () => performance.now(),
    timestamp: () => new Date().toISOString(),
    redact: (value) => redactDiagnostic(value, client?.server),
    failed: failedOutcome,
    open: persistence.openBatchJournal,
  };
}
export const runBatch = (
  client: Client,
  data: CadData,
  context: CadContext = {},
  executeCad: Execute | undefined,
  catalog: BatchCatalog,
  stageDependencies?: BatchStages,
) =>
  application.runBatch(
    data,
    context,
    batchServices(client, executeCad, catalog, stageDependencies),
  );
export const runBatchEntry = (
  client: Client,
  data: CadData,
  context: CadContext = {},
  executeCad: Execute | undefined,
  catalog: BatchCatalog,
  stageDependencies?: BatchStages,
) =>
  application.runBatchEntry(
    data,
    context,
    batchServices(client, executeCad, catalog, stageDependencies),
  );
export async function definitionInstantiate(
  client: Client,
  data: CadData,
  context: CadContext,
  executeCad: Execute | undefined,
  catalog: BatchCatalog,
  stageDependencies?: BatchStages,
) {
  return {
    ...(await runBatch(
      client,
      data,
      context,
      executeCad,
      catalog,
      stageDependencies,
    )),
    operation: "definition.instantiate",
  };
}
export function definitionInspect(
  data: CadData,
  catalog: BatchCatalog,
  operation = "definition.inspect",
) {
  const result = validateBatch({ runId: "inspection", ...data }, catalog);
  return {
    ...result,
    operation,
    status: result.success ? "pass" : "fail",
    mutated: false,
    documentIdentity: null,
    associativity: data["recipe"] ? "recipeRegeneration" : "snapshot",
    units: "inherited from leaf operations",
    frame: "per-step component/sketch",
    provenance: {
      sourceHash: hash(data),
      formatVersion: data["formatVersion"] ?? "legacy",
    },
    definitions: Object.keys(data["definitions"] ?? {}),
    warnings: ["Offline expansion is not native model acceptance."],
  };
}
export const { readBatchSummary, readBatchReportSync } = persistence;
export const { formatBatchSummary } = core;
export const { validateBatchMode, atomicInfo, ATOMIC_BACKENDS } = planning;
export { hash, clone, resolveReferences, expandDefinition };

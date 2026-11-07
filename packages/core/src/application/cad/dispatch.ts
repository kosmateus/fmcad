import type { OperationDeclaration } from "../../catalog";
import type { CadContext, CadData, CadOutput } from "./contracts";

type DispatchResult = CadOutput | Promise<CadOutput>;
export interface CadDispatchPorts {
  curve(operation: string, data: CadData): CadData;
  importOffline(operation: string, data: CadData): boolean;
  importResult(operation: string, data: CadData, preview: boolean): CadOutput;
  definitionInspect(operation: string, data: CadData): CadOutput;
  definitionInstantiate(data: CadData, context: CadContext): DispatchResult;
  batch(data: CadData, context: CadContext): DispatchResult;
  node(
    operation: string,
    data: CadData,
    context: CadContext,
  ): DispatchResult | undefined;
}

/** Synchronous route selection keeps native preparation before the first await. */
export function dispatchCad(
  operation: string,
  data: CadData,
  context: CadContext,
  entry: OperationDeclaration,
  ports: CadDispatchPorts,
): DispatchResult | undefined {
  if (entry["curve"] && context.preview)
    return {
      success: true,
      status: "notEvaluated",
      operation,
      mutation: false,
      plan: ports.curve(operation, data),
      limitations: [
        "Input preflight only; native geometry and kernel not evaluated.",
      ],
    };
  if (operation === "mechanism.drive-test" && context.preview)
    return {
      success: true,
      operation,
      state: "input-validated-only",
      mutation: false,
      document: context.doc,
      data,
      nativeCapability: { status: "unknown", qualified: false },
      limitations: [
        "Bounded driver/follower input structure and math preflight only; no entity resolution, native reads, motion, restore or solver/coupling qualification occurred.",
      ],
    };
  if (
    entry.dataImport &&
    (context.preview || ports.importOffline(operation, data))
  )
    return ports.importResult(operation, data, !!context.preview);
  if (entry.definitionMode) return ports.definitionInspect(operation, data);
  const batch = () =>
    operation === "definition.instantiate"
      ? ports.definitionInstantiate(data, context)
      : ports.batch({ ...data, mode: entry.batchMode }, context);
  if (
    context.preview &&
    (operation === "definition.instantiate" || entry.batchMode)
  )
    return Promise.resolve(batch()).then((result) => ({
      ...result,
      mutation: false,
    }));
  if (context.preview) return undefined;
  if (!entry.nodeOnly) return undefined;
  const result = ports.node(operation, data, context);
  if (result !== undefined) return result;
  if (operation === "definition.instantiate" || entry.batchMode) return batch();
  throw new Error("Unknown Node-only CAD operation: " + operation);
}

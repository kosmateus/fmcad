import {
  record,
  type CadContext,
  type CadData,
  type CadOutput,
  type CadServices,
} from "./contracts";
import { parseNativeResult, unknownNativeOutcome } from "./native-result";

export function previewCad(
  operation: string,
  data: CadData,
  context: CadContext,
  offline: boolean,
  sketchValidates: boolean,
): CadOutput {
  return {
    success: true,
    operation,
    state: "input-validated-only",
    mutation: false,
    document: context.doc,
    data,
    limitations: [
      "Entity resolution and kernel feasibility not tested.",
      sketchValidates
        ? "GM06 nested input shapes and expression-string syntax checked; Fusion expressions, entity selectors and solver feasibility remain unvalidated."
        : "Only outer payload keys and unconditional required-key presence checked; nested schemas/types, conditional fields, units and supported mode values are not validated.",
      ...(offline ? ["No stored report was read or validated."] : []),
    ],
  };
}

/** Shared CLI/MCP/library orchestration: no argv, filesystem or output streams. */
export async function executeCad(
  operation: string,
  data: CadData,
  context: CadContext,
  services: CadServices,
): Promise<CadOutput> {
  // Transitional JS callers may spell absent optional pins as own undefined
  // fields. Normalize them once before canonical batch request/context binding.
  context = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
  const entry = services.validate(operation, data);
  const dispatched = services.dispatch(operation, data, context, entry);
  if (dispatched !== undefined) return dispatched;
  if (context.preview)
    return previewCad(
      operation,
      data,
      context,
      entry.offline === true,
      services.sketchValidates(operation),
    );
  const artifact = services.prepare(operation, data, context);
  const out = await services.execution.execute({
    operation,
    context: { ...context },
    artifact,
    readOnly:
      entry.readOnly ||
      (operation === "document.clear" && data["dryRun"] === true),
  });
  const text = out.text || "";
  if (
    out.failed ||
    !text.split(/\r?\n/).some((value) => value.startsWith("FMCAD_RESULT "))
  )
    throw unknownNativeOutcome(
      new Error(
        `${operation} failed; model may contain partial changes. Inspect before retry. ${text}`,
      ),
    );
  const output = parseNativeResult(text);
  if (services.failed(output)) output["success"] = false;
  const result = output["result"];
  if (!record(result)) return output;
  if (
    entry.dataImport ||
    (result["schemaVersion"] === 1 &&
      /^(entity|datum|joint|occurrence)\./.test(operation))
  ) {
    for (const key of [
      "status",
      "documentIdentity",
      "units",
      "frame",
      "associativity",
      "warnings",
      "method",
      "limitations",
      "provenance",
    ])
      if (Object.hasOwn(result, key)) output[key] = result[key];
    output["affected"] =
      result["affected"] ||
      result["occurrenceMap"] ||
      result["poses"] ||
      result["instances"] ||
      result["parameters"] ||
      [];
  }
  if (
    (operation.startsWith("sketch.") ||
      entry["curve"] ||
      entry["surface"] ||
      entry["envelope"] ||
      data["solid"] === false) &&
    result["schemaVersion"] === 1
  )
    for (const key of [
      "status",
      "documentIdentity",
      "units",
      "frame",
      "associativity",
      "warnings",
      "method",
      "limitations",
      "provenance",
      "affected",
    ])
      if (Object.hasOwn(result, key)) output[key] = result[key];
  return output;
}

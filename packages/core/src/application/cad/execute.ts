import {
  record,
  type CadContext,
  type CadData,
  type CadOutput,
  type CadServices,
  type CameraAliasObservation,
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
  if (operation === "camera.save" && typeof context.component === "string")
    data = { ...data }; // camera.save has no accepted input fields
  const send = async (alias?: CameraAliasObservation) => {
    const artifact = services.prepare(operation, data, context, alias);
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
    return parseNativeResult(text);
  };
  let output = await send();
  if (operation === "camera.save" && Object.hasOwn(output, "_cameraAlias")) {
    const observed = output["_cameraAlias"];
    if (
      typeof context.component !== "string" ||
      output["operation"] !== operation ||
      output["document"] !== context.doc ||
      !record(observed) ||
      observed["name"] !== context.component ||
      typeof observed["raw"] !== "string" ||
      typeof observed["docId"] !== "string" ||
      !observed["docId"] ||
      (context.docId != null && observed["docId"] !== context.docId)
    )
      throw unknownNativeOutcome(
        new Error("Camera selector returned a mismatched continuation"),
      );
    output = await send({
      name: context.component,
      raw: observed["raw"],
      docId: observed["docId"],
    });
    if (Object.hasOwn(output, "_cameraAlias"))
      throw new Error("Unresolved nested camera alias continuation");
  }
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

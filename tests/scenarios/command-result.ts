import type { Document } from "./contracts";
import { record } from "./contracts";

/** A completed transport is not proof that a native command transaction settled. */
export function commandResult(
  stdout: string,
  targets?: readonly Document[],
  expectedOperation?: string,
): Record<string, unknown> {
  const output = record(JSON.parse(stdout) as unknown);
  if (typeof output["success"] !== "boolean")
    throw new Error("CAD result has no explicit outcome");
  if (
    expectedOperation !== undefined &&
    output["operation"] !== expectedOperation
  )
    throw new Error(
      "Original CAD command operation does not match its request",
    );
  const unsettled = new Set([
    "unknown",
    "running",
    "pending",
    "started",
    "cleanup_pending",
  ]);
  // These read-only evaluators use `unknown` for incomplete declared evidence.
  const declaredUnknown =
    expectedOperation === output["operation"] &&
    output["status"] === "unknown" &&
    ["check.set", "evidence.package", "evidence.check", "deliver"].includes(
      expectedOperation ?? "",
    );
  for (const field of ["status", "outcome", "executionOutcome"])
    if (
      unsettled.has(String(output[field])) &&
      !(field === "status" && declaredUnknown)
    )
      throw new Error(
        "Original CAD command remains unsettled: " +
          field +
          "=" +
          String(output[field]),
      );
  if (output["completed"] === false)
    throw new Error("Original CAD command has not completed");
  if (output["context"] !== undefined && targets) {
    const context = record(output["context"]);
    if (
      !targets.some(
        (target) =>
          context["doc"] === target.name &&
          context["docId"] === target.creationId &&
          (context["docFileId"] ?? null) === (target.file?.fileId ?? null),
      )
    )
      throw new Error(
        "Foreign CAD context; recover the original command before cleanup",
      );
  } else if (
    output["context"] === undefined &&
    output["success"] === true &&
    !["preview", "validate"].includes(String(output["mode"])) &&
    ["definition.instantiate", "batch.run"].includes(
      String(output["operation"]),
    )
  )
    throw new Error("Successful batch has no pinned context");
  return output;
}

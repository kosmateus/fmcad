import type { Document } from "./contracts";
import { record } from "./contracts";

/** A completed transport is not proof that a native command transaction settled. */
export function commandResult(
  stdout: string,
  targets?: readonly Document[],
): Record<string, unknown> {
  const output = record(JSON.parse(stdout) as unknown);
  if (typeof output["success"] !== "boolean")
    throw new Error("CAD result has no explicit outcome");
  const unsettled = new Set([
    "unknown",
    "running",
    "pending",
    "started",
    "cleanup_pending",
  ]);
  for (const field of ["status", "outcome", "executionOutcome"])
    if (unsettled.has(String(output[field])))
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
          context["docFileId"] === (target.file?.fileId ?? null),
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

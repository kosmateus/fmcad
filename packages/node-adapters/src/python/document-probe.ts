import { documentIoFamilyUnits } from "./document-io-manifest.js";
import type { SourceInput } from "./artifact.js";

/** Self-contained Python helpers for the broker's read-only document probe.
 *
 * The caller owns the existing probe wrapper, selector injection and prepared
 * artifact/receipt binding. Prepend these units once instead of reading both
 * assets/cad/identity.py and assets/queue_document.py. No SDK, subprocess,
 * activation, retry, save or admission is performed by this local adapter.
 * The wrapper can call _qd_capture(app, selector), preserving its exact DTO.
 */
export function queueDocumentSnapshotUnits(
  runtimeRoot: string,
): readonly SourceInput[] {
  return [
    ...documentIoFamilyUnits(runtimeRoot, "identity"),
    ...documentIoFamilyUnits(runtimeRoot, "legacy-queue_document"),
  ];
}

/** Compatibility for the existing string probe builder; final binding stays later. */
export function queueDocumentSnapshotSource(runtimeRoot: string): string {
  return queueDocumentSnapshotUnits(runtimeRoot)
    .map((unit) => unit.source)
    .join("\n\n");
}

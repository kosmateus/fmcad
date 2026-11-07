import { record, type CadContext, type CadData } from "./contracts";
import { hash } from "./json";
import { validateAtomicHistory, type AtomicReport } from "./atomic";

/** A consistent history is not evidence for an unrelated owning job. */
export function validateOwnedAtomicHistory(
  records: readonly unknown[],
  binding: { request: CadData; context: CadContext },
  pinned: unknown,
): AtomicReport {
  const report = validateAtomicHistory(records);
  // The atomic runner persists the effective mode, including an omitted default.
  const request: CadData = { ...binding.request, atomic: true };
  const context = binding.context;
  const expected = report.documentIdentity.expected;
  const resolved = report.documentIdentity.resolved;
  if (
    binding.request["atomic"] === false ||
    !record(pinned) ||
    typeof pinned["creationId"] !== "string" ||
    !pinned["creationId"] ||
    !(typeof pinned["fileId"] === "string" || pinned["fileId"] === null) ||
    report.runId !== request["runId"] ||
    report.requestHash !== hash({ request, context }) ||
    hash(report.request) !== hash(request) ||
    hash(report.context) !== hash(context) ||
    !record(expected) ||
    expected["creationId"] !== (context.docId ?? null) ||
    expected["fileId"] !== (context.docFileId ?? null) ||
    (context.docId != null && context.docId !== pinned["creationId"]) ||
    (context.docFileId != null && context.docFileId !== pinned["fileId"]) ||
    (expected["name"] !== undefined && expected["name"] !== context.doc) ||
    (resolved !== null &&
      (!record(resolved) ||
        resolved["creationId"] !== pinned["creationId"] ||
        resolved["fileId"] !== pinned["fileId"] ||
        (resolved["name"] !== undefined &&
          resolved["name"] !== context.doc))) ||
    (report.outcome === "committed" && resolved === null)
  )
    throw new Error(
      "Atomic receipt belongs to a different request or document",
    );
  return report;
}

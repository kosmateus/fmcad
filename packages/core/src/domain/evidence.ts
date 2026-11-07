import type { EvidenceStatus, ValidationStatus } from "./contracts";

export const EVIDENCE_STATUSES = [
  "pass",
  "fail",
  "partial",
  "unknown",
  "unsupported",
  "missing",
  "stale",
  "blocked",
] as const;

const statusAliases: Readonly<Record<string, ValidationStatus>> = {
  pass: "pass",
  fail: "fail",
  failed: "fail",
  error: "fail",
  partial: "partial",
  sampled: "partial",
  unknown: "unknown",
  unresolved: "unknown",
  not_checked: "unknown",
  notchecked: "unknown",
  not_evaluated: "unknown",
  notevaluated: "unknown",
  unsupported: "unsupported",
  missing: "missing",
  stale: "stale",
  blocked: "blocked",
  unavailable: "unavailable",
};

const unresolvedStatuses: readonly ValidationStatus[] = [
  "blocked",
  "unsupported",
  "missing",
  "stale",
  "unknown",
  "partial",
  "unavailable",
];

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function isEvidenceStatus(value: unknown): value is EvidenceStatus {
  return EVIDENCE_STATUSES.includes(value as EvidenceStatus);
}

/** Classify result evidence without allowing a positive flag to erase a
 * contradictory unresolved, partial, or unsupported status. */
export function classifyEvidence(value: unknown): ValidationStatus {
  const evidence = record(value);
  if (!evidence) return "not_checked";

  const statusFields = ["status", "evidenceStatus", "checkOutcome"];
  const qualityFields = ["precision", "coverage"];
  const suppliedStatuses = [...statusFields, ...qualityFields]
    .filter((key) => Object.hasOwn(evidence, key))
    .flatMap((key) => {
      const raw = evidence[key];
      if (typeof raw !== "string") return ["unknown" as const];
      const mapped = statusAliases[raw.toLowerCase()];
      if (mapped) return [mapped];
      return ["evidenceStatus", "checkOutcome"].includes(key)
        ? ["unknown" as const]
        : [];
    });

  const failed =
    evidence["passed"] === false ||
    evidence["sampledPassed"] === false ||
    evidence["checkOutcome"] === "fail" ||
    evidence["failed"] === true ||
    (evidence["restored"] === false &&
      evidence["leftRequestedState"] !== true &&
      evidence["status"] !== "pass");
  if (failed || suppliedStatuses.includes("fail")) return "fail";
  if (evidence["unsupported"] === true || evidence["supported"] === false)
    return "unsupported";
  if (
    [
      "status",
      "evidenceStatus",
      "checkOutcome",
      "precision",
      "coverage",
      "passed",
      "sampledPassed",
    ].some((key) => Object.hasOwn(evidence, key) && evidence[key] === null)
  )
    return "unknown";

  for (const status of unresolvedStatuses) {
    if (suppliedStatuses.includes(status)) return status;
  }
  if (evidence["sampledPassed"] === true) return "partial";
  if (
    evidence["passed"] === true ||
    evidence["checkOutcome"] === "pass" ||
    suppliedStatuses.includes("pass")
  )
    return "pass";
  if (
    statusFields.some((key) => Object.hasOwn(evidence, key)) ||
    ["passed", "sampledPassed"].some((key) => Object.hasOwn(evidence, key))
  )
    return "unknown";
  return "not_checked";
}

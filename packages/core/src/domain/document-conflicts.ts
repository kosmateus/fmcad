import type {
  QueueIsolationTarget,
  QueueQuarantine,
  QueueSnapshot,
} from "./queue-model";
import { quarantineTargetConflicts } from "./queue-quarantine";
import {
  verifiedRuntimeRetirementScope,
  runtimeRetiredJob,
  type RuntimeRetirementAuthority,
  type RuntimeRetiredExposure,
} from "./runtime-retirement";

/** A runtime retirement is NOT an authenticated per-turn release. Keep its
 * provenance distinct while presenting one complete conflict set to checkpoint
 * CAS and diagnostics. Neither kind settles the historical UNKNOWN. */
export interface RetiredDocumentConflict {
  fenceKind: "runtime_retired";
  key: string;
  jobId: string;
  requestId: string;
  jobHash: string;
  catalogDigest: string;
  evidenceReference: string;
  target: QueueIsolationTarget | null;
  retirement: RuntimeRetiredExposure;
}
export type DocumentConflict = QueueQuarantine | RetiredDocumentConflict;
const verifiedRuntimeConflicts = new WeakSet<object>();

function targetConflicts(
  left: QueueIsolationTarget | null,
  right: QueueIsolationTarget | null,
): boolean {
  if (!left || !right) return true;
  if (left.creationId && left.creationId === right.creationId) return true;
  if (left.fileId && right.fileId) return left.fileId === right.fileId;
  if (left.fileId || right.fileId) return true;
  return !left.creationId || !right.creationId;
}

export function documentConflicts(
  snapshot: QueueSnapshot,
  target: QueueIsolationTarget | null,
  authority: RuntimeRetirementAuthority | undefined,
  canonical: (value: unknown) => string,
): DocumentConflict[] {
  const released = quarantineTargetConflicts(snapshot, target);
  if (!snapshot.appliedRuntimeRetirement && !snapshot.runtimeRetiredExposures)
    return released;
  const verified = verifiedRuntimeRetirementScope(authority);
  if (
    canonical(snapshot.appliedRuntimeRetirement) !==
      canonical(verified.marker) ||
    canonical(snapshot.runtimeRetiredExposures) !==
      canonical(verified.exposures)
  )
    throw Object.assign(
      new Error(
        "Document conflict coverage differs from the verified runtime root",
      ),
      { code: "RUNTIME_RETIREMENT_CHANGED" },
    );
  // The original quarantine stays in durable history. If this exact immutable
  // record and its exact original job are covered by the stronger runtime
  // retirement, report that provenance instead of treating its raw scope as an
  // unfenced new exposure. A later/mutated quarantine cannot inherit it.
  const result: DocumentConflict[] = released.filter((record) => {
    const original = verified.frozenQuarantined?.[record.jobId];
    const job = snapshot.jobs[record.jobId];
    if (
      !original ||
      !job ||
      canonical(original) !== canonical(record) ||
      !runtimeRetiredJob(snapshot, job, authority, canonical)
    )
      return true;
    return !Object.values(verified.exposures).some(
      (entry) =>
        entry.source.kind === "job" &&
        entry.source.jobId === record.jobId &&
        entry.source.requestId === record.requestId &&
        entry.source.clientId === record.clientId &&
        entry.source.jobHash === record.jobHash,
    );
  });
  for (const [key, retirement] of Object.entries(verified.exposures)) {
    if (!targetConflicts(retirement.target, target)) continue;
    const original = retirement.source;
    const syntheticId = "runtime-" + retirement.entryDigest;
    const conflict: RetiredDocumentConflict = {
      fenceKind: "runtime_retired",
      key,
      jobId: original.kind === "job" ? original.jobId : syntheticId,
      requestId: original.kind === "job" ? original.requestId : syntheticId,
      jobHash:
        original.kind === "job" ? original.jobHash : original.valueDigest,
      catalogDigest:
        original.kind === "job" ? original.catalogDigest : original.valueDigest,
      evidenceReference:
        "fmcad-runtime-retirement:sha256:" +
        retirement.recordDigest +
        ":" +
        retirement.entryDigest,
      target: retirement.target,
      retirement,
    };
    verifiedRuntimeConflicts.add(conflict);
    result.push(Object.freeze(conflict));
  }
  return result.sort((left, right) => {
    const a = left.jobId + ("key" in left ? ":" + left.key : "");
    const b = right.jobId + ("key" in right ? ":" + right.key : "");
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** A raw per-turn quarantine still cannot authorize identity lookup. A genuine
 * runtime retirement can authorize a bounded read, never an unbounded write. */
export function documentConflictAllowsInspection(conflict: DocumentConflict) {
  return conflict.target !== null || verifiedRuntimeConflicts.has(conflict);
}

/** Preserve the distinction between a verified whole-runtime retirement and
 * an original per-turn quarantine. A field copied from JSON is not provenance. */
export function documentConflictFence(conflict: DocumentConflict): "runtime_retired" | "released" {
  return verifiedRuntimeConflicts.has(conflict) ? "runtime_retired" : "released";
}

// Runtime retirement preserves historical UNKNOWN; it never settles execution.
import type {
  QueueIsolationTarget,
  QueueJob,
  QueueSnapshot,
} from "./queue-model";
import { quarantineTarget } from "./queue-quarantine";
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface RuntimeRetiredExposure {
  kind: "runtime_retired";
  key: string;
  rootHead: string;
  recordDigest: string;
  layer: string;
  entryDigest: string;
  target: QueueIsolationTarget | null;
  source:
    | {
        kind: "job";
        jobId: string;
        requestId: string;
        clientId: string;
        jobHash: string;
        catalogDigest: string;
      }
    | { kind: "local" | "control"; valueDigest: string };
}
export interface AppliedRuntimeRetirement {
  rootHead: string;
  recordDigest: string;
  layer: string;
  frozenDigest: string;
}
export interface VerifiedRuntimeRetirement {
  marker: AppliedRuntimeRetirement;
  /** Exact current queue bytes, observed again under the actual writer claim. */
  currentSnapshotDigest: string;
  frozen: QueueSnapshot;
  jobs: Readonly<
    Record<
      string,
      {
        original: QueueJob;
        outcome: "unknown" | "not_started";
      }
    >
  >;
  exposures: Readonly<Record<string, RuntimeRetiredExposure>>;
}
export interface RuntimeRetirementAuthority {
  /** Runtime membership, not this structural declaration, carries authority. */
  readonly __runtimeRetirementAuthority: "private-runtime-retirement";
}
const authorities = new WeakMap<
  RuntimeRetirementAuthority,
  () => VerifiedRuntimeRetirement
>();

/** Trusted composition supplies a live verifier bound to a genuinely approved
 * native root. JSON, a root hash or a boolean cannot create this capability.
 */
export function createRuntimeRetirementAuthority(
  verify: () => VerifiedRuntimeRetirement,
): RuntimeRetirementAuthority {
  if (typeof verify !== "function")
    throw new Error("A trusted retirement verifier is required");
  const authority = Object.freeze({}) as RuntimeRetirementAuthority;
  authorities.set(authority, verify);
  return authority;
}
function refused(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function same(
  value: unknown,
  other: unknown,
  canonical: (value: unknown) => string,
) {
  return canonical(value) === canonical(other);
}

export function verifiedRuntimeRetirement(
  authority: RuntimeRetirementAuthority | undefined,
): VerifiedRuntimeRetirement {
  const verify = authority && authorities.get(authority);
  if (!verify)
    refused(
      "RUNTIME_RETIREMENT_AUTHORITY_REQUIRED",
      "Verify the consumed native runtime root before restoring retired work",
    );
  const coverage = copy(verify());
  for (const exposure of Object.values(coverage.exposures)) {
    if (exposure.source.kind !== "job") {
      if (exposure.target !== null)
        refused(
          "RUNTIME_RETIREMENT_CHANGED",
          "Local/control UNKNOWN cannot acquire a document scope",
        );
      continue;
    }
    if (exposure.layer !== coverage.marker.layer) {
      // Foreign layers have no original job in this layer's frozen snapshot.
      // They can contribute only conservative global conflicts here.
      if (exposure.target !== null)
        refused(
          "RUNTIME_RETIREMENT_CHANGED",
          "Foreign-layer scope requires its original frozen job",
        );
      continue;
    }
    const original = coverage.frozen.jobs[exposure.source.jobId];
    if (!original)
      refused(
        "RUNTIME_RETIREMENT_CHANGED",
        "Retired scope has no original job",
      );
    const expected = quarantineTarget(original.request);
    if (
      exposure.target !== null &&
      (!expected ||
        exposure.target.creationId !== expected.creationId ||
        exposure.target.fileId !== expected.fileId ||
        Object.keys(exposure.target).some(
          (key) => key !== "creationId" && key !== "fileId",
        ))
    )
      refused(
        "RUNTIME_RETIREMENT_CHANGED",
        "Runtime retirement cannot narrow an original UNKNOWN scope",
      );
  }
  return coverage;
}

/** Pure first-bootstrap projection. The caller commits this result with its
 * marker atomically BEFORE normal uncertain-work/phase recovery. It must hold
 * the real canonical writer claim and compare frozen/current bytes.
 */
export function projectRuntimeRetirement(
  current: QueueSnapshot,
  authority: RuntimeRetirementAuthority,
  canonical: (value: unknown) => string,
  hash: (value: string) => string,
  now: number,
): QueueSnapshot {
  const coverage = verifiedRuntimeRetirement(authority);
  const existing = current.appliedRuntimeRetirement;
  if (existing) {
    if (
      !same(existing, coverage.marker, canonical) ||
      !same(current.runtimeRetiredExposures, coverage.exposures, canonical)
    )
      refused(
        "RUNTIME_RETIREMENT_CHANGED",
        "Retirement coverage no longer matches its authenticated root",
      );
    return copy(current);
  }
  if (!same(current, coverage.frozen, canonical))
    refused(
      "RUNTIME_RETIREMENT_UNAPPLIED",
      "Initial retirement projection requires the exact frozen queue snapshot",
    );
  if (coverage.currentSnapshotDigest !== coverage.marker.frozenDigest)
    refused(
      "RUNTIME_RETIREMENT_UNAPPLIED",
      "Current queue bytes differ from the frozen publication input",
    );
  for (const [field, kind] of [
    ["localUnknown", "local"],
    ["controlBlocked", "control"],
  ] as const) {
    const value = current[field];
    if (
      value !== undefined &&
      !Object.values(coverage.exposures).some(
        (entry) =>
          entry.layer === coverage.marker.layer &&
          entry.target === null &&
          entry.source.kind === kind &&
          "valueDigest" in entry.source &&
          entry.source.valueDigest === hash(canonical(value)),
      )
    )
      refused(
        "RUNTIME_RETIREMENT_CHANGED",
        "A local/control exposure is not covered by this exact runtime retirement",
      );
  }
  for (const [id, job] of Object.entries(current.jobs)) {
    if (
      job.state === "preparing" ||
      job.state === "processing" ||
      job.state === "queued" ||
      job.state === "running" ||
      job.state === "sending" ||
      job.state === "needs_reconciliation"
    ) {
      if (!coverage.jobs[id])
        refused(
          "RUNTIME_RETIREMENT_CHANGED",
          "An unsettled job is missing from the authenticated retirement classification",
        );
    }
  }
  if (
    (current.active && !coverage.jobs[current.active]) ||
    (current.blocked && !coverage.jobs[current.blocked.id])
  )
    refused(
      "RUNTIME_RETIREMENT_CHANGED",
      "An execution reservation is not covered by this runtime retirement",
    );
  const next = copy(current);
  for (const [id, covered] of Object.entries(coverage.jobs)) {
    const job = next.jobs[id];
    if (!job || !same(job, covered.original, canonical))
      refused(
        "RUNTIME_RETIREMENT_CHANGED",
        "An original job changed before retirement classification",
      );
    if (covered.outcome === "not_started") {
      if (
        job.state !== "queued" ||
        job.dispatch ||
        job.physicalTurns ||
        job.physicalDispatchCount ||
        job.physicalDispatches?.length ||
        job.startedAt !== undefined ||
        current.active === id ||
        current.blocked?.id === id ||
        current.lease?.clientId === job.clientId
      )
        refused(
          "RUNTIME_RETIREMENT_CHANGED",
          "A potentially started job cannot be classified as not started",
        );
      job.state = "failed";
      job.code = "RUNTIME_RETIRED_NOT_STARTED";
      job.finishedAt = now;
      job.details = {
        executionOutcome: "not_started",
        userScriptSubmitted: false,
        mayHaveMutated: false,
        code: "RUNTIME_RETIRED_NOT_STARTED",
      };
    } else {
      if (
        ![
          "preparing",
          "processing",
          "queued",
          "running",
          "sending",
          "needs_reconciliation",
        ].includes(job.state)
      )
        refused(
          "RUNTIME_RETIREMENT_CHANGED",
          "Only potentially started work can remain UNKNOWN after retirement",
        );
      const catalogDigest = hash(
        canonical(job.physicalDispatches ?? job.dispatch ?? null),
      );
      if (
        !Object.values(coverage.exposures).some(
          (exposure) =>
            exposure.layer === coverage.marker.layer &&
            exposure.rootHead === coverage.marker.rootHead &&
            exposure.recordDigest === coverage.marker.recordDigest &&
            exposure.entryDigest === hash(canonical(job)) &&
            (exposure.target === null ||
              same(
                exposure.target,
                quarantineTarget(job.request),
                canonical,
              )) &&
            exposure.source.kind === "job" &&
            exposure.source.jobId === id &&
            exposure.source.requestId === job.requestId &&
            exposure.source.clientId === job.clientId &&
            exposure.source.jobHash === job.hash &&
            exposure.source.catalogDigest === catalogDigest,
        )
      )
        refused(
          "RUNTIME_RETIREMENT_CHANGED",
          "UNKNOWN work lacks its exact original job and dispatch retirement proof",
        );
      // No succeeded/failed settlement is invented for an uncertain operation.
      job.state = "needs_reconciliation";
    }
  }
  if (next.active && coverage.jobs[next.active]) next.active = null;
  if (next.blocked && coverage.jobs[next.blocked.id]) next.blocked = null;
  // Exact frozen-snapshot equality above binds these reservations/records too.
  // They remain in the immutable root; only the stale execution slot is freed.
  next.lease = null;
  delete next.localUnknown;
  delete next.controlBlocked;
  next.appliedRuntimeRetirement = copy(coverage.marker);
  next.runtimeRetiredExposures = copy(coverage.exposures);
  next.revision++;
  return next;
}

/** A persisted marker is data, not authority. Every restore needs the private
 * verifier again; only an exact original job can be detached from recovery. */
export function runtimeRetiredJob(
  current: QueueSnapshot,
  job: QueueJob,
  authority: RuntimeRetirementAuthority | undefined,
  canonical: (value: unknown) => string,
): boolean {
  if (!current.appliedRuntimeRetirement && !current.runtimeRetiredExposures)
    return false;
  const coverage = verifiedRuntimeRetirement(authority);
  if (
    !same(current.appliedRuntimeRetirement, coverage.marker, canonical) ||
    !same(current.runtimeRetiredExposures, coverage.exposures, canonical)
  )
    refused(
      "RUNTIME_RETIREMENT_CHANGED",
      "Persisted retirement does not match the authenticated runtime root",
    );
  const covered = coverage.jobs[job.id];
  if (!covered || covered.outcome !== "unknown") return false;
  const projected = { ...covered.original, state: "needs_reconciliation" };
  return same(job, projected, canonical);
}

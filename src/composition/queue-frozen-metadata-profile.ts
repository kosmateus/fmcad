import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { TrustedAddinMetadataAdmission } from "../queue-broker-ports";

type Process = { pid: number; birth: string };
export type FrozenMetadataProvisioning = Omit<
  TrustedAddinMetadataAdmission,
  "token"
>;
export interface FrozenWork {
  store: "root" | "epoch";
  id: string;
  state: "queued" | "needs_reconciliation";
  requestId: string;
  clientId: string;
  hash: string;
}
export interface FrozenMetadataProfile {
  version: 1;
  purpose: "dead-frozen-predecessor-metadata-v1";
  ownerClientId: string;
  beneficiary: string;
  metadataRequestId: string;
  previousConfigHash: string;
  successorConfigHash: string;
  sourceCommit: string;
  buildHash: string;
  expectedProcess: Process;
  provisioning: FrozenMetadataProvisioning;
  unresolved: FrozenWork[];
}
/** Facts must be reconstructed from pinned files/process evidence, not approval. */
export interface FrozenMetadataFacts {
  ownerClientId: string;
  registeredOwnerMatches: boolean | undefined;
  previousConfigHash: string;
  successorConfigHash: string;
  sourceCommit: string;
  buildHash: string;
  expectedProcess: Process;
  previousProcessesDead: boolean | undefined;
  expectedProcessAlive: boolean | undefined;
  producersDead: boolean | undefined;
  queuedNeverStarted: boolean | undefined;
  unresolved: FrozenWork[];
  provisioning: FrozenMetadataProvisioning;
}
function fail(): never {
  throw Object.assign(
    new Error(
      "Exact frozen predecessor, existing owner and metadata-only runtime bindings required",
    ),
    { code: "FROZEN_METADATA_FENCE_CHANGED" },
  );
}
/** V1 preserves the complete physical configuration, including connection tuning. */
export function assertFrozenMetadataConnection(
  previous: unknown,
  successor: unknown,
): void {
  if (
    !previous ||
    !successor ||
    typeof previous !== "object" ||
    typeof successor !== "object" ||
    Array.isArray(previous) ||
    Array.isArray(successor)
  )
    fail();
  const before: Record<string, unknown> = { ...previous };
  const after: Record<string, unknown> = { ...successor };
  if (before["backend"] !== "addin" || !isDeepStrictEqual(before, after))
    fail();
}
/** Validate private input before publishing any launch or authority journal. */
export function assertFrozenMetadataStartup(
  profile: FrozenMetadataProfile | undefined,
  admission: TrustedAddinMetadataAdmission | undefined,
  cfg: unknown,
): void {
  if (!profile) {
    if (admission !== undefined) fail();
    return;
  }
  if (
    !admission ||
    typeof admission.token !== "string" ||
    !/^[\x21-\x7e]{32,}$/.test(admission.token)
  )
    fail();
  const { token, ...binding } = admission;
  if (!isDeepStrictEqual(binding, profile.provisioning)) fail();
  const contains = (value: unknown): boolean => {
    if (typeof value === "string") return value.includes(token);
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(
      ([key, entry]) => key.includes(token) || contains(entry),
    );
  };
  if (contains(cfg) || contains(profile)) fail();
}

export function assertFrozenMetadataRequest(
  scope:
    | Pick<FrozenMetadataProfile, "beneficiary" | "metadataRequestId">
    | undefined,
  request: {
    clientId: string;
    requestId: string;
    kind: string;
    metadata: boolean;
  },
): void {
  if (
    scope &&
    (request.clientId !== scope.beneficiary ||
      request.requestId !== scope.metadataRequestId ||
      request.kind !== "rpc" ||
      !request.metadata)
  )
    fail();
}
function keys(value: object, expected: string[]): void {
  if (Object.keys(value).sort().join() !== expected.sort().join()) fail();
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function process(value: Process): void {
  keys(value, ["pid", "birth"]);
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !text(value.birth))
    fail();
}
function work(rows: FrozenWork[]): FrozenWork[] {
  if (!Array.isArray(rows) || rows.length === 0) fail();
  const seen = new Set<string>();
  for (const row of rows) {
    keys(row, ["store", "id", "state", "requestId", "clientId", "hash"]);
    const identity = `${row.store}:${row.id}`;
    if (
      !["root", "epoch"].includes(row.store) ||
      !["queued", "needs_reconciliation"].includes(row.state) ||
      ![row.id, row.requestId, row.clientId].every(text) ||
      !/^[a-f0-9]{64}$/.test(row.hash) ||
      seen.has(identity)
    )
      fail();
    seen.add(identity);
  }
  return [...rows].sort((a, b) =>
    `${a.store}:${a.id}`.localeCompare(`${b.store}:${b.id}`),
  );
}

/** Read only the two pinned stores; never load credential-bearing request files. */
export function inspectFrozenMetadataWork(
  root: string,
  epochRoot: string,
): {
  unresolved: FrozenWork[];
  queuedNeverStarted: boolean;
  workers: Process[];
} {
  const unresolved: FrozenWork[] = [];
  const workers: Process[] = [];
  let queuedNeverStarted = true;
  for (const [store, directory] of [
    ["root", root],
    ["epoch", epochRoot],
  ] as const) {
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(directory, "queue-state.json"), "utf8"),
    ) as {
      jobs: Record<string, FrozenWork & { startedAt?: unknown }>;
      active: string | null;
      lease: { jobId?: string; id?: string } | null;
    };
    for (const [id, job] of Object.entries(snapshot.jobs)) {
      if (["succeeded", "failed", "cancelled", "expired"].includes(job.state))
        continue;
      if (
        job.id !== id ||
        !["queued", "needs_reconciliation"].includes(job.state)
      )
        fail();
      unresolved.push({
        store,
        id,
        state: job.state,
        requestId: job.requestId,
        clientId: job.clientId,
        hash: job.hash,
      });
      const jobDirectory = path.join(directory, "jobs", id);
      // IDs are used as filenames only after the component has been checked.
      if (!/^[A-Za-z0-9_-]+$/.test(id)) fail();
      const exists = fs.existsSync(jobDirectory);
      if (exists) {
        const stat = fs.lstatSync(jobDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
      }
      const files = exists ? fs.readdirSync(jobDirectory) : [];
      if (job.state === "queued") {
        if (
          job.startedAt !== undefined ||
          snapshot.active === id ||
          snapshot.lease?.jobId === id ||
          snapshot.lease?.id === id ||
          files.some((name) => name !== "phase-timings.json")
        )
          queuedNeverStarted = false;
        if (files.includes("phase-timings.json")) {
          const timingFile = path.join(jobDirectory, "phase-timings.json");
          if (fs.lstatSync(timingFile).isSymbolicLink()) fail();
          const timing = JSON.parse(fs.readFileSync(timingFile, "utf8")) as {
            jobId: string;
            jobHash: string;
            totals: Record<string, unknown>;
            active?: { local?: unknown };
          };
          if (
            timing.jobId !== id ||
            timing.jobHash !== job.hash ||
            Object.keys(timing.totals).some((name) => name !== "queueWait") ||
            timing.active?.local != null
          )
            queuedNeverStarted = false;
        }
      }
      if (files.includes("worker-identity.json")) {
        const file = path.join(jobDirectory, "worker-identity.json");
        if (fs.lstatSync(file).isSymbolicLink()) fail();
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Process;
        const worker = { pid: raw.pid, birth: raw.birth };
        process(worker);
        workers.push(worker);
      }
    }
  }
  return { unresolved: work(unresolved), queuedNeverStarted, workers };
}

/** Pure fail-closed authorization fence. This function never claims or runs work. */
export function assertFrozenMetadataProfile(
  profile: FrozenMetadataProfile,
  facts: FrozenMetadataFacts,
): void {
  keys(profile, [
    "version",
    "purpose",
    "ownerClientId",
    "beneficiary",
    "metadataRequestId",
    "previousConfigHash",
    "successorConfigHash",
    "sourceCommit",
    "buildHash",
    "expectedProcess",
    "provisioning",
    "unresolved",
  ]);
  process(profile.expectedProcess);
  keys(profile.provisioning, [
    "capability",
    "owner",
    "endpoint",
    "pid",
    "birth",
    "instance",
    "epoch",
    "source",
    "build",
  ]);
  let endpoint: URL;
  try {
    endpoint = new URL(profile.provisioning.endpoint);
  } catch {
    fail();
  }
  const approvedWork = work(profile.unresolved);
  const observedWork = work(facts.unresolved);
  if (
    profile.version !== 1 ||
    profile.purpose !== "dead-frozen-predecessor-metadata-v1" ||
    ![
      profile.ownerClientId,
      profile.beneficiary,
      profile.metadataRequestId,
    ].every(text) ||
    profile.ownerClientId !== facts.ownerClientId ||
    facts.registeredOwnerMatches !== true ||
    ![
      profile.previousConfigHash,
      profile.successorConfigHash,
      profile.buildHash,
    ].every((value) => /^[a-f0-9]{64}$/.test(value)) ||
    !/^[a-f0-9]{40}$/.test(profile.sourceCommit) ||
    profile.previousConfigHash !== facts.previousConfigHash ||
    profile.previousConfigHash !== profile.successorConfigHash ||
    profile.successorConfigHash !== facts.successorConfigHash ||
    profile.buildHash !== facts.buildHash ||
    profile.sourceCommit !== facts.sourceCommit ||
    !isDeepStrictEqual(profile.expectedProcess, facts.expectedProcess) ||
    facts.previousProcessesDead !== true ||
    facts.expectedProcessAlive !== true ||
    facts.producersDead !== true ||
    facts.queuedNeverStarted !== true ||
    !isDeepStrictEqual(approvedWork, observedWork) ||
    !approvedWork.some(
      (row) => row.store === "root" && row.state === "needs_reconciliation",
    ) ||
    !approvedWork.some(
      (row) => row.store === "epoch" && row.state === "needs_reconciliation",
    ) ||
    !approvedWork.some(
      (row) => row.store === "epoch" && row.state === "queued",
    ) ||
    approvedWork.some((row) => row.requestId === profile.metadataRequestId) ||
    !isDeepStrictEqual(profile.provisioning, facts.provisioning) ||
    profile.provisioning.capability !== "get_open_document_metadata" ||
    profile.provisioning.owner !== profile.beneficiary ||
    profile.provisioning.pid !== profile.expectedProcess.pid ||
    profile.provisioning.birth !== profile.expectedProcess.birth ||
    ![
      profile.provisioning.instance,
      profile.provisioning.epoch,
      profile.provisioning.source,
      profile.provisioning.build,
    ].every(text) ||
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.port !== "8765" ||
    endpoint.pathname !== "/admission/v1" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  )
    fail();
}

import { createRequire } from "node:module";
import * as fs from "node:fs";
import path from "node:path";

const runtimeRequire = createRequire(__filename);
const { readJson, hash, sameInstance } = runtimeRequire(
  "../../queue-instance.js",
) as {
  readJson(file: string): unknown;
  hash(bytes: Buffer): string;
  sameInstance(left: unknown, right: unknown): boolean;
};

// In this attested build, FUSION_BUSY can leave preflight only after a valid
// synchronous identity response was parsed. No worker or product RPC exists yet.
// This compatibility classifier is not a synthetic SDK completion receipt.
export const LEGACY_BUSY_BUILD =
  "762241f5fc33c6e4d4b22755bb10b0cb35cf461db1942af9afe444498986fcf0";

interface LegacyBusyJob {
  readonly id: string;
  readonly state: string;
  readonly details?: { readonly reason?: string };
  readonly dispatch?: {
    readonly rpcCount?: number;
    readonly completedCount?: number;
  };
  readonly requestId?: string;
  readonly clientId?: string;
  readonly hash?: string;
}

interface LegacyBusySnapshot {
  readonly active?: string | null;
  readonly blocked?: { readonly id?: string; readonly reason?: string } | null;
  readonly jobs?: Record<string, LegacyBusyJob>;
}

interface PreflightStart {
  readonly jobId?: string;
  readonly buildHash?: string;
  readonly instance?: unknown;
}

interface LegacyBusyEvidence {
  readonly version: 1;
  readonly method: "attested-legacy-control-flow";
  readonly jobId: string;
  readonly requestId?: string;
  readonly originalClientId?: string;
  readonly originalRequestHash?: string;
  readonly buildHash: string;
  readonly preflightStartSHA256: string;
  readonly probeCompleted: true;
  readonly observedIdle: false;
  readonly observedCommandId: null;
  readonly userScriptSubmitted: false;
  readonly rpcCount: 0;
  readonly limitation: string;
}

export function legacyBusyEvidence(
  data: LegacyBusySnapshot,
  expectedInstance: unknown,
  previousBuild: string | undefined,
  directory: string,
): LegacyBusyEvidence | null {
  if (
    previousBuild !== LEGACY_BUSY_BUILD ||
    !data.active ||
    data.blocked?.id !== data.active ||
    data.blocked.reason !== "FUSION_BUSY"
  )
    return null;
  const job = data.jobs?.[data.active];
  if (
    !job ||
    job.id !== data.active ||
    job.state !== "needs_reconciliation" ||
    job.details?.reason !== "FUSION_BUSY" ||
    (job.dispatch?.rpcCount || 0) !== 0 ||
    (job.dispatch?.completedCount || 0) !== 0
  )
    return null;
  const files = fs.readdirSync(directory);
  if (
    !files.includes("preflight-start.json") ||
    files.some(
      (name) =>
        ![
          "preflight-start.json",
          "legacy-preflight-busy-evidence.json",
        ].includes(name),
    )
  )
    return null;
  const file = path.join(directory, "preflight-start.json");
  const started = readJson(file) as PreflightStart;
  if (
    started.jobId !== job.id ||
    started.buildHash !== previousBuild ||
    !sameInstance(started.instance, expectedInstance)
  )
    return null;
  return {
    version: 1,
    method: "attested-legacy-control-flow",
    jobId: job.id,
    ...(job.requestId === undefined ? {} : { requestId: job.requestId }),
    ...(job.clientId === undefined ? {} : { originalClientId: job.clientId }),
    ...(job.hash === undefined ? {} : { originalRequestHash: job.hash }),
    buildHash: previousBuild,
    preflightStartSHA256: hash(fs.readFileSync(file)),
    probeCompleted: true,
    observedIdle: false,
    observedCommandId: null,
    userScriptSubmitted: false,
    rpcCount: 0,
    limitation:
      "Completion is derived from the attested typed rejection path; the original command id/identity response was not persisted. This is not an original SDK receipt.",
  };
}

import type {
  QueueRequest,
  QueueSnapshot,
} from "../../packages/core/src/domain/queue-model";
import type { EpochUpgradeSnapshot } from "../../packages/core/src/application/cad/epoch-upgrade";
import type {
  Approval,
  Authority,
  Inspection,
  Owner,
  Reference,
} from "../../src/composition/queue-epoch-successor-types";
import type { openIsolatedEpoch } from "../../src/queue-isolated-epoch";
import type { serve } from "../../src/queue-broker";

// Types for the existing synthetic on-disk fixtures. They do not construct or
// normalize evidence; invalid test inputs still reach production validators.
export type FixturePointer = NonNullable<
  ReturnType<typeof openIsolatedEpoch>["epoch"]
>;
export interface CurrentEpochFixture {
  dir: string;
  audit: string;
  nonce: string;
  pointer: FixturePointer;
  cfg: Parameters<typeof serve>[0];
  token: string;
  clientId: string;
  oldOwner: { pid: number; birth: string; nonce: string };
  approval: {
    clientId: string;
    granteeClientId: string;
    requestId: string;
    buildHash: string;
    sourceCommit: string;
    rejectedJobIds: string[];
  };
  paused: {
    pointer: FixturePointer;
    state: QueueSnapshot;
    identity: {
      buildHash: string;
      configHash: string;
      instance: FixturePointer["currentInstance"];
    };
    rootStateHash: string;
    rootIdentityHash: string;
    grantsHash: string;
  };
  guard: { kind: string; nonce: string; audit: string; clientId: string };
}
export interface DeadEpochFixture extends Omit<
  CurrentEpochFixture,
  "approval"
> {
  requestId: string;
  previousOwner: Owner;
  authority: Authority;
  authorityEntry: Reference;
  identity: {
    configHash: string;
    buildHash: string;
    sourceCommit: string;
    instance: FixturePointer["currentInstance"];
  };
  approval: Approval;
  inspection: Inspection;
  priorJob: { id: string; requestId: string; request: QueueRequest };
  auditIdentity: {
    commandId: string;
    resolvedIdentity: { name: string; creationId: string; fileId: null };
  };
  initialization: { createdAtMs: number; bindingHash: string };
}
export interface SettledEpochFixture extends Omit<
  CurrentEpochFixture,
  "approval" | "paused"
> {
  approval: Omit<CurrentEpochFixture["approval"], "rejectedJobIds"> & {
    version: number;
    purpose: string;
    previousBuildHash: string;
    epochId: string;
    document: FixturePointer["document"];
    currentInstance: FixturePointer["currentInstance"];
    candidateRoot: string;
    pointerHash: string;
    settledJobIds: string[];
    settledEvidenceHash: string;
  };
  paused: CurrentEpochFixture["paused"] &
    EpochUpgradeSnapshot & { settledEvidence: Reference[] };
}

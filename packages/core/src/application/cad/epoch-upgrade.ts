import { record } from "./contracts";
import { sha256 } from "../../domain/engineering/sha256";
import type { MigrationOwner } from "./owner-migration";
export interface EpochUpgradeJob {
  id: string;
  state: string;
  code?: string;
  physicalTurns?: number;
  sequenceId?: unknown;
  dispatch?: { rpcCount?: number };
  details?: {
    executionOutcome?: string;
    mayHaveMutated?: boolean;
    userScriptSubmitted?: boolean;
    sdkSettled?: boolean;
  };
}
export interface EpochUpgradeIdentity {
  buildHash: string;
  instance: unknown;
  sourceCommit?: unknown;
}
export interface EpochUpgradeSnapshot {
  state: {
    jobs: Record<string, EpochUpgradeJob>;
    active?: unknown;
    blocked?: unknown;
    localUnknown?: unknown;
    controlBlocked?: unknown;
    lease?: unknown;
    controlGeneration?: number;
    contextEpoch?: number;
    paused?: boolean;
  };
  pointer: {
    kind: string;
    epochId: string;
    ownerClientId: string;
    ownerTokenHash: string;
    document: { fileId: string | null; [key: string]: unknown };
    currentInstance: unknown;
    historicalSnapshotHash: string;
    historicalIdentityHash: string;
  };
  identity: EpochUpgradeIdentity;
  owner: MigrationOwner;
  control: {
    activeOperations: number;
    activeIds?: string[];
    instanceId: string;
    buildHash: string;
    generation: number;
    contextEpoch: number;
    gateClosed: boolean;
  };
  ownerTokenHash: string;
  pointerHash: string;
  rootStateHash: string;
  rootIdentityHash: string;
  closed?: unknown;
  cleanupIntent?: unknown;
  pending?: unknown;
  selectedLive: boolean;
  historicalDead: boolean;
  brokerLive: boolean;
  grantsHash: string;
  evidenceHash: string;
  settledEvidence?: unknown[];
}
export interface EpochUpgradeApproval {
  version: number;
  purpose: string;
  epochId: string;
  clientId: string;
  document: unknown;
  currentInstance: unknown;
  previousBuildHash: string;
  pointerHash: string;
  rejectedJobIds?: string[];
  settledJobIds?: string[];
  settledEvidenceHash?: string;
  buildHash: string;
  sourceCommit?: unknown;
  requestId: string;
  qualification?: unknown;
  stateOptions?: unknown;
  granteeClientId?: string;
}
export interface EpochStages {
  initial: EpochUpgradeSnapshot;
  paused: EpochUpgradeSnapshot;
  complete: Record<string, unknown>;
  escrow: unknown;
  stopped: unknown;
  "stop-intent": unknown;
  installed: unknown;
  "launch-intent": unknown;
  identity: { previous: EpochUpgradeIdentity; current: EpochUpgradeIdentity };
}
export interface EpochUpgradePorts {
  authenticate(): Promise<void>;
  claim(): Promise<void>;
  unclaim(): void;
  approve(): Promise<EpochUpgradeApproval>;
  read<K extends keyof EpochStages>(stage: K): EpochStages[K] | undefined;
  publish<K extends keyof EpochStages>(stage: K, value: EpochStages[K]): void;
  observe(): Promise<EpochUpgradeSnapshot>;
  release(value: unknown): Promise<void>;
  pause(snapshot: EpochUpgradeSnapshot): Promise<void>;
  escrow(snapshot: EpochUpgradeSnapshot): Promise<unknown>;
  verifyEscrow(value: unknown): Promise<void>;
  guardStartup(): Promise<void>;
  stop(snapshot: EpochUpgradeSnapshot): Promise<void>;
  waitDead(owner: MigrationOwner): Promise<void>;
  localFence(snapshot: EpochUpgradeSnapshot): Promise<void>;
  install(approval: EpochUpgradeApproval): Promise<unknown>;
  verifyInstalled(approval: EpochUpgradeApproval): Promise<void>;
  writeEpochIdentity(
    previous: EpochUpgradeIdentity,
    next: EpochUpgradeIdentity,
  ): Promise<void>;
  start(approval: EpochUpgradeApproval): Promise<void>;
  observeReady(approval: EpochUpgradeApproval): Promise<EpochUpgradeSnapshot>;
}
type FenceOptions = { paused?: boolean; initial?: EpochUpgradeSnapshot };
type Fence = (
  snapshot: EpochUpgradeSnapshot,
  approval: EpochUpgradeApproval,
  options?: FenceOptions,
) => void;
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const digest = (value: unknown) => sha256(JSON.stringify(value));

function strings(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => typeof value[key] === "string");
}
function optional(
  value: Record<string, unknown>,
  key: string,
  kind: "string" | "number" | "boolean",
): boolean {
  return value[key] === undefined || typeof value[key] === kind;
}
function stringList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}
export function epochState(
  value: unknown,
): value is EpochUpgradeSnapshot["state"] {
  if (!record(value) || !record(value["jobs"])) return false;
  const state = value;
  return (
    ["controlGeneration", "contextEpoch"].every((key) =>
      optional(state, key, "number"),
    ) &&
    optional(state, "paused", "boolean") &&
    Object.values(value["jobs"]).every((job) => {
      if (
        !record(job) ||
        !strings(job, ["id", "state"]) ||
        !optional(job, "code", "string") ||
        !optional(job, "physicalTurns", "number")
      )
        return false;
      const dispatch = job["dispatch"],
        details = job["details"];
      return (
        (dispatch === undefined ||
          (record(dispatch) && optional(dispatch, "rpcCount", "number"))) &&
        (details === undefined ||
          (record(details) &&
            optional(details, "executionOutcome", "string") &&
            ["mayHaveMutated", "userScriptSubmitted", "sdkSettled"].every(
              (key) => optional(details, key, "boolean"),
            )))
      );
    })
  );
}
export function epochSnapshot(value: unknown): value is EpochUpgradeSnapshot {
  if (!record(value)) return false;
  const state = value["state"],
    pointer = value["pointer"],
    identity = value["identity"],
    owner = value["owner"],
    control = value["control"];
  if (
    !record(state) ||
    !record(state["jobs"]) ||
    !record(pointer) ||
    !record(identity) ||
    !record(owner) ||
    !record(control)
  )
    return false;
  const document = pointer["document"];
  return (
    record(document) &&
    (document["fileId"] === null || typeof document["fileId"] === "string") &&
    strings(pointer, [
      "kind",
      "epochId",
      "ownerClientId",
      "ownerTokenHash",
      "historicalSnapshotHash",
      "historicalIdentityHash",
    ]) &&
    strings(identity, ["buildHash"]) &&
    strings(owner, ["nonce"]) &&
    strings(control, ["instanceId", "buildHash"]) &&
    ["activeOperations", "generation", "contextEpoch"].every(
      (key) => typeof control[key] === "number",
    ) &&
    typeof control["gateClosed"] === "boolean" &&
    stringList(control["activeIds"]) &&
    ["controlGeneration", "contextEpoch"].every((key) =>
      optional(state, key, "number"),
    ) &&
    optional(state, "paused", "boolean") &&
    strings(value, [
      "ownerTokenHash",
      "pointerHash",
      "rootStateHash",
      "rootIdentityHash",
      "grantsHash",
      "evidenceHash",
    ]) &&
    ["selectedLive", "historicalDead", "brokerLive"].every(
      (key) => typeof value[key] === "boolean",
    ) &&
    (value["settledEvidence"] === undefined ||
      Array.isArray(value["settledEvidence"])) &&
    epochState(state)
  );
}
export function epochApproval(value: unknown): value is EpochUpgradeApproval {
  return (
    record(value) &&
    typeof value["version"] === "number" &&
    strings(value, [
      "purpose",
      "epochId",
      "clientId",
      "previousBuildHash",
      "pointerHash",
      "buildHash",
      "requestId",
    ]) &&
    stringList(value["rejectedJobIds"]) &&
    stringList(value["settledJobIds"]) &&
    optional(value, "settledEvidenceHash", "string") &&
    optional(value, "granteeClientId", "string")
  );
}

export function epochUpgradePolicy(
  sameInstance: (a: unknown, b: unknown) => boolean,
) {
  function assertEpochFence(
    snapshot: EpochUpgradeSnapshot,
    approval: EpochUpgradeApproval,
    { paused = false, initial }: FenceOptions = {},
  ) {
    const { state, pointer, identity, owner, control } = snapshot;
    if (
      approval.version !== 1 ||
      pointer.kind !== "isolated-fresh-scratch-epoch" ||
      pointer.epochId !== approval.epochId ||
      pointer.ownerClientId !== approval.clientId ||
      pointer.ownerTokenHash !== snapshot.ownerTokenHash ||
      !equal(pointer.document, approval.document) ||
      pointer.document.fileId !== null ||
      !sameInstance(pointer.currentInstance, approval.currentInstance) ||
      identity.buildHash !== approval.previousBuildHash ||
      !sameInstance(identity.instance, approval.currentInstance) ||
      snapshot.pointerHash !== approval.pointerHash ||
      snapshot.rootStateHash !== pointer.historicalSnapshotHash ||
      snapshot.rootIdentityHash !== pointer.historicalIdentityHash ||
      snapshot.closed ||
      snapshot.cleanupIntent ||
      snapshot.pending ||
      state.active ||
      state.blocked ||
      state.localUnknown ||
      state.controlBlocked ||
      state.lease ||
      control.activeOperations !== 0 ||
      control.activeIds?.length ||
      control.instanceId !== owner.nonce ||
      control.buildHash !== approval.previousBuildHash ||
      control.generation !== (state.controlGeneration || 0) ||
      control.contextEpoch !== (state.contextEpoch || 0) ||
      (paused && (!state.paused || control.gateClosed !== true)) ||
      snapshot.selectedLive !== true ||
      snapshot.historicalDead !== true ||
      snapshot.brokerLive !== true
    )
      fail(
        "EPOCH_UPGRADE_FENCE_CHANGED",
        "Exact owner, epoch, historical hashes, process, no-lease and zero-active fences required",
      );
    if (
      initial &&
      (!equal(state.jobs, initial.state.jobs) ||
        !equal(pointer, initial.pointer) ||
        !equal(identity, initial.identity) ||
        !equal(owner, initial.owner) ||
        snapshot.grantsHash !== initial.grantsHash ||
        snapshot.evidenceHash !== initial.evidenceHash)
    )
      fail(
        "EPOCH_UPGRADE_HISTORY_CHANGED",
        "Jobs, grants, new scratch proof or original identity changed",
      );
  }

  function assertEpochUpgrade(
    snapshot: EpochUpgradeSnapshot,
    approval: EpochUpgradeApproval,
    options?: FenceOptions,
  ) {
    if (approval.purpose !== "quiescent-isolated-epoch-checker-upgrade-v1")
      fail(
        "EPOCH_UPGRADE_FENCE_CHANGED",
        "The historical checker repair purpose is required",
      );
    assertEpochFence(snapshot, approval, options);
    const jobs = Object.values(snapshot.state.jobs);
    if (
      !Array.isArray(approval.rejectedJobIds) ||
      approval.rejectedJobIds.length !== 2 ||
      jobs.length !== 2 ||
      jobs.some(
        (job) =>
          !approval.rejectedJobIds!.includes(job.id) ||
          job.state !== "failed" ||
          job.code !== "PYTHON_CHECK_REJECTED" ||
          job.physicalTurns ||
          job.dispatch?.rpcCount ||
          job.sequenceId ||
          job.details?.executionOutcome !== "not_started" ||
          job.details.mayHaveMutated !== false ||
          job.details.userScriptSubmitted !== false ||
          job.details.sdkSettled !== true,
      )
    )
      fail(
        "EPOCH_UPGRADE_REQUIRES_SDK0",
        "Only the two exact terminal pre-dispatch checker rejections may be carried through this repair",
      );
  }

  function assertSettledEpochUpgrade(
    snapshot: EpochUpgradeSnapshot,
    approval: EpochUpgradeApproval,
    options?: FenceOptions,
  ) {
    if (
      approval.purpose !== "quiescent-settled-isolated-epoch-upgrade-v1" ||
      approval.rejectedJobIds !== undefined ||
      !Array.isArray(approval.settledJobIds) ||
      new Set(approval.settledJobIds).size !== approval.settledJobIds.length ||
      !approval.settledJobIds.length ||
      !equal(
        Object.keys(snapshot.state.jobs).sort(),
        [...approval.settledJobIds].sort(),
      ) ||
      !Array.isArray(snapshot.settledEvidence) ||
      !snapshot.settledEvidence.length ||
      digest(snapshot.settledEvidence) !== approval.settledEvidenceHash
    )
      fail(
        "EPOCH_UPGRADE_UNSETTLED",
        "A distinct owner-approved exact settled job/evidence set is required",
      );
    assertEpochFence(snapshot, approval, options);
    if (
      Object.values(snapshot.state.jobs).some(
        (job) => job.state !== "succeeded" || job.details?.sdkSettled !== true,
      )
    )
      fail(
        "EPOCH_UPGRADE_UNSETTLED",
        "No unknown, failed or unsettled SDK job may use the successful live handoff",
      );
  }

  // Small existing-epoch transaction. No SDK/process-signal port; old broker stops
  // cooperatively through its authenticated lifecycle route. No historical copy.
  function epochRuntimeUpgrade(
    p: EpochUpgradePorts,
    assertSnapshot: Fence,
    settled: boolean,
  ) {
    return async () => {
      await p.authenticate();
      await p.claim();
      try {
        const approval = await p.approve();
        const initial = p.read("initial") || (await p.observe());
        if (!p.read("initial")) {
          assertSnapshot(initial, approval);
          p.publish("initial", initial);
        }
        if (p.read("complete")) {
          await p.release(p.read("complete"));
          return p.read("complete");
        }
        let paused = p.read("paused");
        if (!paused) {
          const current = await p.observe();
          assertSnapshot(current, approval, { initial });
          await p.pause(current);
          paused = await p.observe();
          assertSnapshot(paused, approval, { initial, paused: true });
          p.publish("paused", paused);
        }
        if (!p.read("escrow")) p.publish("escrow", await p.escrow(paused));
        await p.verifyEscrow(p.read("escrow"));
        if (!p.read("stopped")) {
          await p.guardStartup(); // recovery.lock blocks other startup; old public stop remains supported.
          const stopping = p.read("stop-intent");
          if (!stopping) {
            const current = await p.observe();
            assertSnapshot(current, approval, { initial, paused: true });
            if (!equal(current.state, paused.state))
              fail(
                "EPOCH_UPGRADE_HISTORY_CHANGED",
                "Paused state changed before cooperative stop",
              );
            p.publish("stop-intent", { owner: paused.owner });
            await p.stop(current);
          }
          // On uncertain stop never send it again: observe exact old PID/birth.
          await p.waitDead(paused.owner);
          await p.localFence(paused);
          p.publish("stopped", { owner: paused.owner });
        }
        if (!p.read("launch-intent")) await p.localFence(paused);
        if (!p.read("installed"))
          p.publish("installed", await p.install(approval));
        await p.verifyInstalled(approval);
        if (!p.read("identity")) {
          const identity = {
            ...paused.identity,
            buildHash: approval.buildHash,
            sourceCommit: approval.sourceCommit,
          };
          await p.writeEpochIdentity(paused.identity, identity);
          p.publish("identity", {
            previous: paused.identity,
            current: identity,
          });
        }
        if (!p.read("launch-intent"))
          p.publish("launch-intent", { buildHash: approval.buildHash });
        await p.start(approval); // Exclusive worker claim; live worker is observed, never duplicated.
        const after = await p.observeReady(approval);
        if (
          !equal(after.state, paused.state) ||
          !equal(after.pointer, paused.pointer) ||
          after.grantsHash !== paused.grantsHash ||
          after.evidenceHash !== paused.evidenceHash ||
          after.rootStateHash !== paused.rootStateHash ||
          after.rootIdentityHash !== paused.rootIdentityHash ||
          !equal(after.identity, p.read("identity")!.current) ||
          after.owner.nonce === paused.owner.nonce ||
          after.control.buildHash !== approval.buildHash ||
          after.control.instanceId !== after.owner.nonce ||
          after.control.generation !== (after.state.controlGeneration || 0) ||
          after.control.contextEpoch !== (after.state.contextEpoch || 0) ||
          after.control.activeOperations !== 0 ||
          after.control.activeIds?.length ||
          !after.control.gateClosed ||
          after.selectedLive !== true ||
          after.historicalDead !== true ||
          after.brokerLive !== true
        )
          fail(
            "EPOCH_UPGRADE_HANDOFF_UNPROVEN",
            "Replacement did not preserve exact paused epoch, history, grants and live selected process",
          );
        if (
          settled &&
          digest(after.settledEvidence) !== approval.settledEvidenceHash
        )
          fail(
            "EPOCH_UPGRADE_HANDOFF_UNPROVEN",
            "Settled physical evidence changed during handoff",
          );
        const complete: Record<string, unknown> = {
          version: 1,
          kind: settled
            ? "quiescent-settled-isolated-epoch-runtime-upgrade"
            : "quiescent-isolated-epoch-runtime-upgrade",
          requestId: approval.requestId,
          sourceCommit: approval.sourceCommit,
          qualification: approval.qualification,
          epochId: approval.epochId,
          document: approval.document,
          previousBuildHash: approval.previousBuildHash,
          buildHash: approval.buildHash,
          previousOwner: paused.owner,
          owner: after.owner,
          stateHash: digest(after.state),
          pointerHash: after.pointerHash,
          grantsHash: after.grantsHash,
          evidenceHash: after.evidenceHash,
          historicalOutcome: "unknown",
          sdkRequestsSent: 0,
          modelValidation: "not_performed",
          rollbackVerification: "not_performed",
          gateClosed: true,
          localRejectedJobIds: approval.rejectedJobIds,
          grantScopeChanged: false,
        };
        complete["operationalQueueBudget"] = approval.stateOptions;
        if (settled) {
          delete complete["localRejectedJobIds"];
          complete["settledJobIds"] = approval.settledJobIds;
          complete["settledEvidenceHash"] = approval.settledEvidenceHash;
        }
        const publicReceipt: Record<string, unknown> = {
          kind: complete["kind"],
          epochId: approval.epochId,
          document: approval.document,
          previousBuildHash: approval.previousBuildHash,
          sourceCommit: approval.sourceCommit,
          buildHash: approval.buildHash,
          rejectedJobIds: approval.rejectedJobIds,
          ownerClientId: approval.clientId,
          clientId: approval.granteeClientId,
          ownerTokenBound: true,
          sdkRequestsSent: 0,
          historicalOutcome: "unknown",
          grantScopeChanged: false,
          gateClosed: true,
        };
        if (settled) {
          delete publicReceipt["rejectedJobIds"];
          publicReceipt["settledJobIds"] = approval.settledJobIds;
          publicReceipt["settledEvidenceHash"] = approval.settledEvidenceHash;
        }
        complete["publicReceipt"] = publicReceipt;
        p.publish("complete", complete);
        await p.release(complete);
        return complete;
      } finally {
        p.unclaim();
      }
    };
  }

  const createEpochRuntimeUpgrade = (p: EpochUpgradePorts) =>
    epochRuntimeUpgrade(p, assertEpochUpgrade, false);
  const createSettledEpochRuntimeUpgrade = (p: EpochUpgradePorts) =>
    epochRuntimeUpgrade(p, assertSettledEpochUpgrade, true);

  function assertSettledEpochUpgradeRecord(
    snapshot: unknown,
    approval: unknown,
    options?: FenceOptions,
  ): void {
    if (!epochSnapshot(snapshot) || !epochApproval(approval))
      fail(
        "EPOCH_UPGRADE_CLAIM_UNPROVEN",
        "Stored epoch snapshot/approval schema is invalid",
      );
    assertSettledEpochUpgrade(snapshot, approval, options);
  }
  return {
    assertEpochUpgrade,
    assertSettledEpochUpgrade,
    assertSettledEpochUpgradeRecord,
    createEpochRuntimeUpgrade,
    createSettledEpochRuntimeUpgrade,
  };
}

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { record } from "../../../core/src/application/cad/contracts";
import { readJson } from "../persistence/records";
import { fileHash, directory } from "../persistence/migration-files";
import type { createEpochPrerequisite } from "./epoch-prerequisite";
export interface AuditEvidenceReference extends Record<string, unknown> {
  path: string;
  sha256: string;
}
export interface AuditResponseRecovery extends Record<string, unknown> {
  originalIdentity: unknown;
  currentInstance: unknown;
  files: { migrationComplete: AuditEvidenceReference };
  key: { clientId: string };
}
type EpochReader = ReturnType<typeof createEpochPrerequisite>;
export interface AuditUpgradePorts {
  jobId: string;
  sameInstance(a: unknown, b: unknown): boolean;
  auditResponseProof(
    input: unknown,
    dir: string,
    scope: { jobId: string; observationJobId: string },
  ): AuditResponseRecovery;
  auditResponseProofStillCurrent(value: AuditResponseRecovery): boolean;
  epochAuditPrerequisite: EpochReader["epochAuditPrerequisite"];
  epochPrerequisiteStillCurrent: EpochReader["epochPrerequisiteStillCurrent"];
}
export interface AuditUpgradeProof {
  purpose: string;
  observationJobId: string;
  departingBuildHash: string;
  observationBuildHash?: string;
  currentInstance?: unknown;
  originalBuildHash: unknown;
  previousOwner: unknown;
  previousComplete: AuditEvidenceReference;
  observationProof: AuditEvidenceReference;
  remoteReceipt: AuditEvidenceReference;
  firstBackupManifest: AuditEvidenceReference;
  identity: unknown;
  originalInvocationHash: unknown;
  sourceEnvelope: unknown;
  reportFingerprint: unknown;
  epochPrerequisite?: ReturnType<EpochReader["epochAuditPrerequisite"]>;
  auditResponseRecovery?: AuditResponseRecovery;
}
const observationJobId = "3627db2e-0b9d-4e4f-927f-20cb45deae74";
const previousRequestId = "measured-fasteners-owner-migration-20261029-v2";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "AUDIT_UPGRADE_PROOF_INVALID",
  });
}
function object(value: unknown): Record<string, unknown> {
  if (!record(value)) fail("Object-shaped immutable audit evidence required");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value)
    fail("Exact audit evidence identifier required");
  return value;
}
function read(file: string) {
  return object(readJson(file, 256 * 1024 * 1024));
}
function reference(value: unknown): AuditEvidenceReference {
  const row = object(value);
  return { ...row, path: text(row["path"]), sha256: text(row["sha256"]) };
}
export function createAuditUpgrade(p: AuditUpgradePorts) {
  function auditUpgradeApproval(
    input: unknown,
    dir: string,
  ): AuditUpgradeProof | null {
    const approval = object(input),
      purpose = approval["purpose"];
    if (purpose === undefined) return null;
    if (
      purpose === "atomic-audit-facts-recovery-upgrade-v1" ||
      purpose === "isolated-scratch-epoch-upgrade-v1"
    ) {
      const base = auditUpgradeApproval(
        {
          ...approval,
          purpose: "atomic-recovery-process-loss-audit-upgrade-v1",
        },
        dir,
      );
      if (!base) fail("Process-loss base approval required");
      const scope = { jobId: p.jobId, observationJobId };
      if (purpose === "atomic-audit-facts-recovery-upgrade-v1") {
        const proof = p.auditResponseProof(
          approval["auditResponseRecovery"],
          dir,
          scope,
        );
        if (
          JSON.stringify(base.identity) !==
            JSON.stringify(proof.originalIdentity) ||
          !p.sameInstance(approval["currentInstance"], proof.currentInstance)
        )
          fail(
            "Response recovery cannot change the owned identity or select another current process",
          );
        const complete = read(proof.files.migrationComplete.path);
        return {
          ...base,
          purpose,
          observationBuildHash: base.departingBuildHash,
          departingBuildHash: text(complete["observerBuildHash"]),
          previousOwner: complete["owner"],
          auditResponseRecovery: proof,
        };
      }
      const prerequisite = p.epochAuditPrerequisite(
        approval["epochPrerequisite"],
        dir,
        { currentInstance: approval["currentInstance"] },
        scope,
      );
      if (
        JSON.stringify(base.identity) !== JSON.stringify(prerequisite.identity)
      )
        fail("Current audit identity differs from the immutable holder");
      return {
        ...base,
        purpose,
        observationBuildHash: base.departingBuildHash,
        departingBuildHash: text(prerequisite.departingBuildHash),
        previousOwner: prerequisite.previousOwner,
        epochPrerequisite: prerequisite,
      };
    }
    if (
      purpose !== "atomic-recovery-audit-upgrade-v1" &&
      purpose !== "atomic-recovery-process-loss-audit-upgrade-v1"
    )
      fail("Unknown migration purpose");
    const processLoss =
      purpose === "atomic-recovery-process-loss-audit-upgrade-v1";
    if (processLoss) {
      const selected = object(approval["currentInstance"]);
      if (
        !Number.isSafeInteger(selected["pid"]) ||
        typeof selected["pid"] !== "number" ||
        selected["pid"] <= 0 ||
        Object.keys(selected).sort().join(",") !== "birth,pid,version" ||
        typeof selected["birth"] !== "string" ||
        !selected["birth"] ||
        typeof selected["version"] !== "string" ||
        !selected["version"]
      )
        fail(
          "Process-loss purpose requires an explicitly selected distinct current process tuple",
        );
    }
    const value = object(approval["auditUpgrade"]),
      previousReference = reference(value["previousComplete"]),
      observationReference = reference(value["observationProof"]);
    const previous = path.join(
      dir,
      "atomic-migrations",
      hash(previousRequestId),
      "complete.json",
    );
    const proofPath = path.join(
      dir,
      "jobs",
      observationJobId,
      "atomic-observation-proof.json",
    );
    if (
      value["observationJobId"] !== observationJobId ||
      previousReference.path !== previous ||
      observationReference.path !== proofPath
    )
      fail(
        "Second handoff is restricted to the exact completed migration and unavailable observer",
      );
    for (const root of [path.dirname(previous), path.dirname(proofPath)]) {
      directory(root);
      if (fs.realpathSync(root) !== root)
        fail("Prior handoff evidence must not traverse a symlink");
    }
    for (const entry of [previousReference, observationReference]) {
      if (
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        fileHash(entry.path).sha256 !== entry.sha256
      )
        fail("Prior migration/observation proof digest changed");
    }
    const complete = read(previous),
      observed = read(proofPath),
      backup = object(complete["backup"]),
      summary = object(observed["summary"]);
    if (
      complete["kind"] !== "atomic-owner-migration" ||
      complete["requestId"] !== previousRequestId ||
      complete["jobId"] !== p.jobId ||
      complete["gateClosed"] !== true ||
      complete["unresolved"] !== true ||
      complete["sdkRequestsSent"] !== 0 ||
      complete["nativeOutcome"] !== "unknown" ||
      backup["audit"] !== path.dirname(previous) ||
      backup["manifest"] !== "backup-manifest.json" ||
      observed["kind"] !== "atomic_holder_status" ||
      observed["targetJobId"] !== p.jobId ||
      observed["observerJobId"] !== observationJobId ||
      observed["observerBuildHash"] !== complete["observerBuildHash"] ||
      observed["originalBuildHash"] !== complete["originalBuildHash"] ||
      observed["remoteOutcome"] !== "succeeded" ||
      observed["toolFailed"] !== false ||
      observed["identityMatches"] !== false ||
      summary["status"] !== "unavailable" ||
      summary["outcome"] !== "unknown" ||
      summary["destroyed"] !== false ||
      summary["completed"] !== false
    )
      fail(
        "Previous handoff or unavailable observation is not the approved history",
      );
    const remotePath = path.join(
      dir,
      "jobs",
      observationJobId,
      `atomic-observation-${observed["rpcId"]}.receipt.json`,
    );
    if (observed["receipt"] !== remotePath)
      fail("Unavailable observation receipt escaped its job directory");
    const remote = read(remotePath),
      binding = object(observed["binding"]);
    if (
      remote["terminal"] !== true ||
      remote["outcome"] !== "succeeded" ||
      binding["jobId"] !== observationJobId ||
      binding["buildHash"] !== complete["observerBuildHash"] ||
      !["jobId", "rpcId", "requestHash", "sourceHash", "buildHash"].every(
        (k) => remote[k] === binding[k],
      ) ||
      !p.sameInstance(remote["instance"], observed["observerInstance"])
    )
      fail("Unavailable observation has no exact terminal transport binding");
    const manifest = path.join(
      path.dirname(previous),
      text(backup["manifest"]),
    );
    if (
      backup["audit"] !== path.dirname(previous) ||
      fileHash(manifest).sha256 !== backup["sha256"]
    )
      fail("Original immutable escrow manifest changed");
    return {
      purpose,
      observationJobId,
      departingBuildHash: text(complete["observerBuildHash"]),
      ...(processLoss ? { currentInstance: approval["currentInstance"] } : {}),
      originalBuildHash: complete["originalBuildHash"],
      previousOwner: complete["owner"],
      previousComplete: previousReference,
      observationProof: observationReference,
      remoteReceipt: { path: remotePath, sha256: fileHash(remotePath).sha256 },
      firstBackupManifest: { path: manifest, sha256: text(backup["sha256"]) },
      identity: observed["identity"],
      originalInvocationHash: observed["originalInvocationHash"],
      sourceEnvelope: observed["sourceEnvelope"],
      reportFingerprint: observed["reportFingerprint"],
    };
  }
  function assertAuditUpgradeSnapshot(
    input: unknown,
    snapshotInput: unknown,
    clientId: string,
  ): void {
    const upgrade = object(input),
      snapshot = object(snapshotInput),
      state = object(snapshot["state"]),
      jobs = object(state["jobs"]);
    const identity = object(snapshot["identity"]),
      target = object(jobs[p.jobId]),
      observer = object(jobs[text(upgrade["observationJobId"])]);
    const dispatch = object(observer["dispatch"]),
      workflow = object(observer["workflowObservation"]);
    if (
      observer["clientId"] !== clientId ||
      target["clientId"] !== clientId ||
      (upgrade["epochPrerequisite"] &&
        object(upgrade["epochPrerequisite"])["clientId"] !== clientId) ||
      (upgrade["auditResponseRecovery"] &&
        object(object(upgrade["auditResponseRecovery"])["key"])["clientId"] !==
          clientId) ||
      observer["state"] !== "needs_reconciliation" ||
      dispatch["rpcCount"] !== 1 ||
      dispatch["completedCount"] !== 1 ||
      workflow["targetJobId"] !== target["id"] ||
      workflow["targetJobHash"] !== target["hash"] ||
      workflow["observerJobHash"] !== observer["hash"] ||
      object(observer["request"])["buildHash"] !==
        (upgrade["observationBuildHash"] || upgrade["departingBuildHash"]) ||
      identity["buildHash"] !== upgrade["originalBuildHash"] ||
      object(target["request"])["buildHash"] !== upgrade["originalBuildHash"] ||
      JSON.stringify(snapshot["owner"]) !==
        JSON.stringify(upgrade["previousOwner"])
    )
      fail(
        "Second handoff no longer owns the exact two unresolved jobs and departing broker",
      );
  }
  function auditUpgradeStillCurrent(
    upgrade: AuditUpgradeProof | null | undefined,
  ): boolean {
    if (!upgrade) return true;
    try {
      return (
        [
          upgrade.previousComplete,
          upgrade.observationProof,
          upgrade.remoteReceipt,
          upgrade.firstBackupManifest,
        ].every(
          (entry) =>
            fs.existsSync(entry.path) &&
            fileHash(entry.path).sha256 === entry.sha256,
        ) &&
        (!upgrade.epochPrerequisite ||
          p.epochPrerequisiteStillCurrent(upgrade.epochPrerequisite)) &&
        (!upgrade.auditResponseRecovery ||
          p.auditResponseProofStillCurrent(upgrade.auditResponseRecovery))
      );
    } catch {
      return false;
    }
  }
  return {
    auditUpgradeApproval,
    assertAuditUpgradeSnapshot,
    auditUpgradeStillCurrent,
  };
}

import { record } from "../../../core/src/application/cad/contracts";
import {
  epochApproval,
  epochSnapshot,
  epochState,
} from "../../../core/src/application/cad/epoch-upgrade";
import type {
  EpochUpgradeApproval,
  EpochUpgradeSnapshot,
  EpochUpgradeIdentity,
  EpochStages,
} from "../../../core/src/application/cad/epoch-upgrade";
export interface OperatorReference {
  path: string;
  sha256: string;
}
export interface OperatorApproval extends EpochUpgradeApproval {
  candidateRoot: string;
  installRoot: string;
  sourceCommit: string;
  granteeClientId: string;
  adapterSha256: string;
  qualification: OperatorReference;
  previousQualifiedRuntime: string;
  ledgerReferences: OperatorReference[];
  stateOptions: { idleMs: number; leaseMs: number };
}
type EpochPointer = EpochUpgradeSnapshot["pointer"];
export interface OperatorPointer extends EpochPointer {
  root: string;
  originalInstance: unknown;
  qualificationEvidence: OperatorReference[];
  qualificationReceipt: OperatorReference;
}
export interface OperatorSnapshot extends EpochUpgradeSnapshot {
  pointer: OperatorPointer;
  owner: EpochUpgradeSnapshot["owner"] & { pid: number; birth: string };
}
export interface OperatorIntent {
  version: number;
  nonce: string;
  approval: OperatorApproval;
  ownerTokenHash: string;
}
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "EPOCH_UPGRADE_EVIDENCE_INVALID",
  });
}
export function operatorObject(value: unknown): Record<string, unknown> {
  if (!record(value)) fail("Object-shaped persisted upgrade evidence required");
  return value;
}
export function operatorText(value: unknown): string {
  if (typeof value !== "string")
    fail("String-shaped persisted upgrade identity required");
  return value;
}
function isReference(value: unknown): value is OperatorReference {
  return (
    record(value) &&
    typeof value["path"] === "string" &&
    typeof value["sha256"] === "string"
  );
}
export function operatorReference(value: unknown): OperatorReference {
  if (!isReference(value)) fail("Exact persisted reference required");
  return value;
}
export function operatorReferences(value: unknown): OperatorReference[] {
  if (!Array.isArray(value) || !value.every(isReference))
    fail("Complete persisted evidence references required");
  return value;
}
function isApproval(value: unknown): value is OperatorApproval {
  if (!epochApproval(value) || !record(value)) return false;
  const budgets = value["stateOptions"];
  return (
    [
      "candidateRoot",
      "installRoot",
      "sourceCommit",
      "granteeClientId",
      "adapterSha256",
      "previousQualifiedRuntime",
    ].every((key) => typeof value[key] === "string") &&
    isReference(value["qualification"]) &&
    Array.isArray(value["ledgerReferences"]) &&
    value["ledgerReferences"].every(isReference) &&
    record(budgets) &&
    typeof budgets["idleMs"] === "number" &&
    typeof budgets["leaseMs"] === "number"
  );
}
export function operatorApproval(value: unknown): OperatorApproval {
  if (!isApproval(value))
    fail("Complete owner-approved upgrade schema required");
  return value;
}
function isPointer(value: unknown): value is OperatorPointer {
  if (!record(value)) return false;
  const document = value["document"];
  return (
    [
      "root",
      "kind",
      "epochId",
      "ownerClientId",
      "ownerTokenHash",
      "historicalSnapshotHash",
      "historicalIdentityHash",
    ].every((key) => typeof value[key] === "string") &&
    record(document) &&
    (document["fileId"] === null || typeof document["fileId"] === "string") &&
    isReference(value["qualificationReceipt"]) &&
    Array.isArray(value["qualificationEvidence"]) &&
    value["qualificationEvidence"].every(isReference)
  );
}
export function operatorPointer(value: unknown): OperatorPointer {
  if (!isPointer(value)) fail("Complete persisted epoch pointer required");
  return value;
}
function isSnapshot(value: unknown): value is OperatorSnapshot {
  if (!epochSnapshot(value)) return false;
  return (
    isPointer(value.pointer) &&
    typeof value.owner["pid"] === "number" &&
    typeof value.owner["birth"] === "string"
  );
}
export function operatorSnapshot(value: unknown): OperatorSnapshot {
  if (!isSnapshot(value)) fail("Complete persisted epoch snapshot required");
  return value;
}
export function operatorIntent(value: unknown): OperatorIntent {
  const row = operatorObject(value);
  if (
    typeof row["version"] !== "number" ||
    typeof row["nonce"] !== "string" ||
    typeof row["ownerTokenHash"] !== "string"
  )
    fail("Complete persisted owner intent required");
  return {
    ...row,
    version: row["version"],
    nonce: row["nonce"],
    ownerTokenHash: row["ownerTokenHash"],
    approval: operatorApproval(row["approval"]),
  };
}
export function operatorIdentity(value: unknown): EpochUpgradeIdentity {
  const row = operatorObject(value);
  return {
    ...row,
    buildHash: operatorText(row["buildHash"]),
    instance: row["instance"],
  };
}

export function operatorState(value: unknown): EpochUpgradeSnapshot["state"] {
  if (!epochState(value)) fail("Complete persisted epoch state required");
  return value;
}
export interface OperatorProcess extends Record<string, unknown> {
  pid: number;
  birth: string;
}
export interface OperatorOwner extends OperatorProcess {
  nonce: string;
}
function isProcess(value: unknown): value is OperatorProcess {
  return (
    record(value) &&
    typeof value["pid"] === "number" &&
    Number.isSafeInteger(value["pid"]) &&
    value["pid"] > 0 &&
    typeof value["birth"] === "string"
  );
}
export function operatorProcess(value: unknown): OperatorProcess {
  if (!isProcess(value)) fail("Exact persisted process tuple required");
  return value;
}
export function operatorOwner(value: unknown): OperatorOwner {
  const process = operatorProcess(value);
  if (typeof process["nonce"] !== "string")
    fail("Exact persisted broker nonce required");
  return { ...process, nonce: process["nonce"] };
}
export function operatorClients(value: unknown): Record<string, string> {
  const clients = operatorObject(value);
  const result: Record<string, string> = {};
  for (const [key, token] of Object.entries(clients))
    result[key] = operatorText(token);
  return result;
}
export interface OperatorGrant extends Record<string, unknown> {
  clientId: string;
  clientTokenHash: string;
  epochId: string;
  document: unknown;
}
export function operatorGrant(value: unknown): OperatorGrant {
  const grant = operatorObject(value);
  return {
    ...grant,
    clientId: operatorText(grant["clientId"]),
    clientTokenHash: operatorText(grant["clientTokenHash"]),
    epochId: operatorText(grant["epochId"]),
    document: grant["document"],
  };
}
export interface OperatorEscrow extends Record<string, unknown> {
  evidence: OperatorReference[];
  originalRootState: OperatorReference;
  originalRootIdentity: OperatorReference;
  previousQualifiedRuntime: string;
}
export function operatorEscrow(value: unknown): OperatorEscrow {
  const row = operatorObject(value);
  return {
    ...row,
    evidence: operatorReferences(row["evidence"]),
    originalRootState: operatorReference(row["originalRootState"]),
    originalRootIdentity: operatorReference(row["originalRootIdentity"]),
    previousQualifiedRuntime: operatorText(row["previousQualifiedRuntime"]),
  };
}
const stageDecoders: {
  [K in keyof EpochStages]: (value: unknown) => EpochStages[K];
} = {
  initial: operatorSnapshot,
  paused: operatorSnapshot,
  complete: operatorObject,
  identity: (value) => {
    const row = operatorObject(value);
    return {
      previous: operatorIdentity(row["previous"]),
      current: operatorIdentity(row["current"]),
    };
  },
  escrow: (value) => value,
  stopped: (value) => value,
  "stop-intent": (value) => value,
  installed: (value) => value,
  "launch-intent": (value) => value,
};
export function operatorStage<K extends keyof EpochStages>(
  stage: K,
  value: unknown,
): EpochStages[K] {
  return stageDecoders[stage](value);
}

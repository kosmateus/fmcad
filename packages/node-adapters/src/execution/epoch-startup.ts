import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { record } from "../../../core/src/application/cad/contracts";
import { readJson, durable } from "../persistence/records";
import { fileHash } from "../persistence/migration-files";
export interface EpochStartupPorts {
  priorProcessAlive(value: unknown): boolean | null;
  assertSettled(
    snapshot: Record<string, unknown>,
    approval: Record<string, unknown>,
    options: { paused: boolean },
  ): void;
  settledEvidence(
    directory: string,
    state: unknown,
    pointer: Record<string, unknown>,
  ): unknown;
  installation(): string;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const object = (value: unknown): Record<string, unknown> =>
  record(value) ? value : {};
function text(value: unknown): string {
  if (typeof value !== "string")
    fail(
      "EPOCH_UPGRADE_CLAIM_UNPROVEN",
      "Exact epoch evidence path/identity required",
    );
  return value;
}
function read(file: string, limit?: number): Record<string, unknown> {
  const value = readJson(file, limit);
  if (!record(value))
    fail("EPOCH_UPGRADE_CLAIM_UNPROVEN", "Epoch evidence must be an object");
  return value;
}
/** Claim only from original durable authority; no repair, probe or SDK send. */
export function claimEpochRuntimeBroker(
  ports: EpochStartupPorts,
  dir: string,
  marker: unknown,
  nonce: string,
  codeHash: string,
): string {
  const guard = read(path.join(dir, "recovery.lock"));
  const audit = text(guard["audit"]);
  if (
    guard["kind"] !== "isolated-epoch-runtime-upgrade" ||
    guard["nonce"] !== nonce ||
    path.dirname(audit) !== path.join(dir, "epoch-runtime-upgrades") ||
    fs.realpathSync(audit) !== audit
  )
    fail(
      "EPOCH_UPGRADE_GUARD_CHANGED",
      "Original epoch-upgrade startup guard required",
    );
  const stage = (name: string) =>
    read(path.join(audit, name + ".json"), 256 * 1024 * 1024);
  const intent = stage("intent"),
    paused = stage("paused"),
    identity = stage("identity");
  const approval = object(intent["approval"]),
    current = object(identity["current"]),
    pointer = object(paused["pointer"]);
  const clientId = text(approval["clientId"]),
    owner = object(paused["owner"]);
  if (
    !equal(guard, {
      kind: "isolated-epoch-runtime-upgrade",
      nonce: intent["nonce"],
      audit,
      clientId,
    }) ||
    !equal(read(path.join(dir, "atomic-migration.lock")), guard) ||
    !stage("stopped") ||
    !stage("installed") ||
    !stage("launch-intent") ||
    approval["buildHash"] !== codeHash ||
    ports.priorProcessAlive(owner) !== false ||
    current["buildHash"] !== codeHash ||
    current["sourceCommit"] !== approval["sourceCommit"] ||
    pointer["ownerClientId"] !== clientId ||
    read(path.join(dir, "clients.json"))[clientId] !==
      intent["ownerTokenHash"] ||
    pointer["ownerTokenHash"] !== intent["ownerTokenHash"] ||
    fs.existsSync(path.join(dir, "broker.lock")) ||
    !equal(read(path.join(dir, "isolated-admission-epoch.json")), pointer) ||
    fileHash(path.join(dir, "queue-state.json")).sha256 !==
      paused["rootStateHash"] ||
    fileHash(path.join(dir, "instance.json")).sha256 !==
      paused["rootIdentityHash"] ||
    !equal(
      read(
        path.join(text(pointer["root"]), "queue-state.json"),
        256 * 1024 * 1024,
      ),
      paused["state"],
    ) ||
    !equal(read(path.join(text(pointer["root"]), "instance.json")), current) ||
    ports.priorProcessAlive(pointer["currentInstance"]) !== true ||
    ports.priorProcessAlive(pointer["originalInstance"]) !== false
  )
    fail(
      "EPOCH_UPGRADE_CLAIM_UNPROVEN",
      "Exact preserved epoch/state/identity/process and dead previous broker required",
    );
  const qualification = pointer["qualificationEvidence"],
    ledger = approval["ledgerReferences"];
  if (
    !Array.isArray(qualification) ||
    (ledger !== undefined && !Array.isArray(ledger))
  )
    fail(
      "EPOCH_UPGRADE_CLAIM_UNPROVEN",
      "Bounded qualification and ledger reference lists required",
    );
  for (const entry of [
    ...qualification,
    pointer["qualificationReceipt"],
    ...(ledger || []),
  ]) {
    const reference = object(entry);
    if (fileHash(text(reference["path"])).sha256 !== reference["sha256"])
      fail(
        "EPOCH_UPGRADE_CLAIM_UNPROVEN",
        "Preserved scratch or rejected-attempt evidence changed",
      );
  }
  if (approval["purpose"] === "quiescent-settled-isolated-epoch-upgrade-v1") {
    ports.assertSettled(paused, approval, { paused: true });
    const evidence = ports.settledEvidence(dir, paused["state"], pointer);
    if (
      digest(evidence) !== approval["settledEvidenceHash"] ||
      !equal(evidence, paused["settledEvidence"])
    )
      fail(
        "EPOCH_UPGRADE_CLAIM_UNPROVEN",
        "Settled physical evidence changed before broker claim",
      );
    const release = stage("cooperative-release");
    const requestId = text(approval["requestId"]);
    const releaseFile = path.join(
      dir,
      "console-release-" + hash(requestId + ":pause-stop") + ".json",
    );
    const receipt = read(releaseFile);
    if (
      release["path"] !== releaseFile ||
      fileHash(releaseFile).sha256 !== release["sha256"] ||
      receipt["terminal"] !== true ||
      receipt["outcome"] !== "released" ||
      receipt["instanceId"] !== owner["nonce"] ||
      receipt["buildHash"] !== approval["previousBuildHash"] ||
      receipt["requestId"] !== requestId + ":pause-stop" ||
      ports.installation() !== approval["candidateRoot"]
    )
      fail(
        "EPOCH_UPGRADE_CLAIM_UNPROVEN",
        "Successful bound cooperative release and exact immutable candidate root required",
      );
  }
  const grants = fs
    .readdirSync(text(pointer["root"]))
    .filter((name) => /^access-[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .map((name) => ({
      name,
      ...fileHash(path.join(text(pointer["root"]), name)),
    }));
  if (digest(grants) !== paused["grantsHash"])
    fail(
      "EPOCH_UPGRADE_CLAIM_UNPROVEN",
      "Registered-client grants changed before startup",
    );
  durable(path.join(dir, "broker.lock"), marker, true);
  return text(paused["rootStateHash"]);
}

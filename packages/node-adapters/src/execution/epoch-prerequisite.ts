import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { hash as canonicalHash } from "../../../core/src/application/cad/json";
import { record } from "../../../core/src/application/cad/contracts";
import { auditSummary } from "../../../core/src/application/cad/recovery-audit";
import { bindPythonArtifactManifest } from "../python/context-binding";
import { readJson as rawJson } from "../persistence/records";
import { fileHash, directory } from "../persistence/migration-files";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "EPOCH_AUDIT_PREREQUISITE_INVALID",
  });
}
function object(value: unknown): Record<string, unknown> {
  if (!record(value)) fail("Object-shaped immutable epoch evidence required");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string")
    fail("Exact epoch evidence identifier/path required");
  return value;
}
function objectLength(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value))
    fail("Active operation identities must be an array");
  return value.length;
}
function numeric(value: unknown): number {
  if (typeof value !== "number")
    fail("Exact numeric control generation required");
  return value;
}
function readJson(file: string, limit?: number): Record<string, unknown> {
  return object(rawJson(file, limit));
}
export interface EvidenceReference {
  path: string;
  sha256: string;
}
export interface AuditFiles {
  auditIntent: EvidenceReference;
  auditResult: EvidenceReference;
  auditStart: EvidenceReference;
  auditWire: EvidenceReference;
  migrationComplete: EvidenceReference;
  remoteReceipt: EvidenceReference;
}
function reference(value: unknown): EvidenceReference {
  const row = object(value);
  if (
    Object.keys(row).sort().join(",") !== "path,sha256" ||
    typeof row["path"] !== "string" ||
    typeof row["sha256"] !== "string"
  )
    fail("Pinned current audit evidence changed");
  return { path: row["path"], sha256: row["sha256"] };
}
function files(value: unknown): AuditFiles {
  const row = object(value);
  if (
    Object.keys(row).sort().join(",") !==
    "auditIntent,auditResult,auditStart,auditWire,migrationComplete,remoteReceipt"
  )
    fail("Complete immutable current audit and migration evidence is required");
  return {
    auditIntent: reference(row["auditIntent"]),
    auditResult: reference(row["auditResult"]),
    auditStart: reference(row["auditStart"]),
    auditWire: reference(row["auditWire"]),
    migrationComplete: reference(row["migrationComplete"]),
    remoteReceipt: reference(row["remoteReceipt"]),
  };
}
export interface Authorization {
  files: Record<string, EvidenceReference> | AuditFiles;
  clientId: string;
  hash: string;
}
export interface InheritedPauseInput {
  initial: Record<string, unknown>;
  current: Record<string, unknown>;
  intent: Record<string, unknown>;
  upgrade: {
    previousComplete: { path: string };
    epochPrerequisite?: Authorization;
    auditResponseRecovery?: {
      files: Record<string, EvidenceReference>;
      key: { clientId: string };
      evidenceHash: string;
    };
  };
  clientId: string;
  dir: string;
}
export function createEpochPrerequisite(
  sameInstance: (a: unknown, b: unknown) => boolean,
) {
  // Every byte in this closed set is pinned by the separately qualified migration
  // approval. No caller may substitute an audit-result path or claim audit success.
  function epochAuditPrerequisite(
    input: unknown,
    dir: string,
    approval: { currentInstance: unknown },
    scope: { jobId: string; observationJobId: string },
  ) {
    const value = files(input);
    const auditDir = path.join(
      dir,
      "jobs",
      scope.jobId,
      "atomic-recovery-audit",
    );
    for (const [name, entry] of Object.entries(value)) {
      if (
        !entry ||
        Object.keys(entry).sort().join(",") !== "path,sha256" ||
        !path.isAbsolute(entry.path || "") ||
        !/^[a-f0-9]{64}$/.test(entry.sha256 || "") ||
        fileHash(entry.path).sha256 !== entry.sha256
      )
        fail("Pinned current audit evidence changed");
      directory(path.dirname(entry.path));
      if (fs.realpathSync(entry.path) !== entry.path)
        fail("Current audit evidence must not traverse symlinks");
      if (name !== "migrationComplete" && path.dirname(entry.path) !== auditDir)
        fail("Current audit evidence escaped its exact job directory");
    }
    for (const [name, filename] of Object.entries({
      auditIntent: "intent.json",
      auditResult: "result.json",
      auditStart: "start.json",
      auditWire: "wire.json",
    }))
      if (
        value[name as keyof AuditFiles].path !== path.join(auditDir, filename)
      )
        fail("Current audit evidence path was substituted");
    const read = (entry: EvidenceReference) =>
      readJson(entry.path, 256 * 1024 * 1024);
    const complete = read(value.migrationComplete),
      intent = read(value.auditIntent),
      result = read(value.auditResult),
      start = read(value.auditStart),
      wire = read(value.auditWire),
      remote = read(value.remoteReceipt);
    if (
      value.migrationComplete.path !==
        path.join(
          dir,
          "atomic-migrations",
          hash(text(complete["requestId"])),
          "complete.json",
        ) ||
      complete["kind"] !== "atomic-owner-migration" ||
      complete["jobId"] !== scope.jobId ||
      complete["purpose"] !== "atomic-recovery-process-loss-audit-upgrade-v1" ||
      complete["gateClosed"] !== true ||
      complete["unresolved"] !== true ||
      complete["sdkRequestsSent"] !== 0 ||
      complete["nativeOutcome"] !== "unknown" ||
      complete["currentModelingAdmission"] !== "blocked" ||
      !sameInstance(complete["currentAuditInstance"], approval.currentInstance)
    )
      fail(
        "A completed process-loss audit-only migration for this current process is required",
      );
    const b = object(intent["binding"]),
      key = object(intent["key"]);
    if (
      !b ||
      !key ||
      result["kind"] !== "atomic-recovery-audit" ||
      result["status"] !== "complete" ||
      result["jobId"] !== scope.jobId ||
      result["observationJobId"] !== scope.observationJobId ||
      result["clientId"] !== key["clientId"] ||
      result["requestId"] !== key["requestId"] ||
      b["targetJobId"] !== scope.jobId ||
      b["observationJobId"] !== scope.observationJobId ||
      b["clientId"] !== key["clientId"] ||
      b["purpose"] !== "atomic-recovery-audit-v1" ||
      b["auditBuildHash"] !== complete["observerBuildHash"] ||
      result["sdkRequestsSent"] !== 1 ||
      result["endpointVerified"] !== true ||
      result["currentModelingAdmission"] !== "blocked" ||
      result["nativeOutcome"] !== "unknown" ||
      result["modelValidation"] !== "not_performed" ||
      result["rollbackVerification"] !== "not_performed" ||
      !sameInstance(result["currentInstance"], approval.currentInstance) ||
      !sameInstance(b["currentInstance"], approval.currentInstance) ||
      result["historicalProcessState"] !== "terminated"
    )
      fail("Actual durable successful current audit facts are required");
    const summary = auditSummary(
      {
        result: {
          content: [
            {
              type: "text",
              text: "FMCAD_RESULT " + JSON.stringify(result["summary"]),
            },
          ],
        },
      },
      intent["identity"],
    );
    if (
      object(summary["ui"])["idle"] !== true ||
      summary["modulePresent"] !== false ||
      object(summary["commandDefinition"])["status"] !== "absent"
    )
      fail(
        "The current instance must be idle with no surviving original holder or command definition",
      );
    const binding = object(start["binding"]),
      payload = object(wire["outgoing"]);
    const params = object(payload["params"]),
      args = object(params["arguments"]),
      artifact = object(wire["artifact"]);
    if (
      start["receipt"] !== value.remoteReceipt.path ||
      object(start["pythonCheck"])["status"] !== "passed" ||
      binding["purpose"] !== "atomic-recovery-audit-v1" ||
      binding["jobId"] !== scope.jobId ||
      binding["buildHash"] !== complete["observerBuildHash"] ||
      binding["auditBindingHash"] !== canonicalHash(b) ||
      binding["requestHash"] === undefined ||
      binding["sourceHash"] === undefined ||
      !sameInstance(
        binding["auditExpectedInstance"],
        approval.currentInstance,
      ) ||
      !sameInstance(start["instance"], approval.currentInstance) ||
      remote["terminal"] !== true ||
      remote["outcome"] !== "succeeded" ||
      !sameInstance(remote["instance"], approval.currentInstance) ||
      ![
        "jobId",
        "rpcId",
        "requestHash",
        "sourceHash",
        "buildHash",
        "purpose",
        "auditBindingHash",
        "pythonOriginHash",
      ].every((k) => remote[k] === binding[k]) ||
      payload["id"] !== "fmcad:" + binding["rpcId"] ||
      !artifact ||
      object(object(artifact["context"])["origin"])["artifactHash"] !==
        binding["pythonOriginHash"] ||
      start["originArtifactHash"] !== binding["pythonOriginHash"] ||
      payload["method"] !== "tools/call" ||
      params["name"] !== "execute_python" ||
      args["persistent"] !== false
    )
      fail(
        "The current audit lacks its real checker, exact final wire and successful process-bound physical receipt",
      );
    bindPythonArtifactManifest(text(args["code"]), artifact);
    return {
      files: value,
      clientId: text(key["clientId"]),
      departingBuildHash: complete["observerBuildHash"],
      previousOwner: complete["owner"],
      currentInstance: approval.currentInstance,
      originalInstance: result["historicalInstance"],
      identity: intent["identity"],
      documentFacts: summary["document"],
      hash: canonicalHash(value),
      historicalOutcome: "unknown",
    };
  }

  function epochPrerequisiteStillCurrent(value: Authorization) {
    try {
      return Object.values(value.files).every(
        (entry) => fileHash(entry.path).sha256 === entry.sha256,
      );
    } catch {
      return false;
    }
  }

  function inheritedClosedPause({
    initial,
    current,
    intent,
    upgrade,
    clientId,
    dir,
    authorization,
  }: InheritedPauseInput & { authorization?: Authorization | undefined }) {
    const initialState = initial["state"],
      initialOwner = initial["owner"],
      initialIdentity = initial["identity"];
    const state = object(current["state"]),
      status = object(current["status"]),
      owner = object(current["owner"]),
      intentBinding = object(intent["binding"]);
    if (
      !authorization ||
      !epochPrerequisiteStillCurrent(authorization) ||
      authorization.clientId !== clientId ||
      intentBinding["clientId"] !== clientId ||
      JSON.stringify(initialState) !== JSON.stringify(state) ||
      JSON.stringify(initialOwner) !== JSON.stringify(owner) ||
      JSON.stringify(initialIdentity) !== JSON.stringify(current["identity"])
    )
      fail("Inherited pause history/owner changed");
    const preceding = readJson(upgrade.previousComplete.path),
      requestId = preceding["requestId"] + ":pause";
    const proof = readJson(
      path.join(dir, "lifecycle-control-" + hash(requestId) + ".json"),
    );
    const b = object(proof["binding"]),
      r = object(proof["result"]),
      c = object(status["control"]);
    const controlRequests = object(state["controlRequests"]),
      sourceRequest = object(controlRequests[requestId]);
    if (
      !b ||
      !r ||
      proof["status"] !== "completed" ||
      b["action"] !== "pause" ||
      b["clientId"] !== clientId ||
      b["requestId"] !== requestId ||
      b["instanceId"] !== object(preceding["previousOwner"])["nonce"] ||
      b["buildHash"] !== preceding["originalBuildHash"] ||
      r["requestId"] !== requestId ||
      r["instanceId"] !== b["instanceId"] ||
      r["buildHash"] !== b["buildHash"] ||
      r["gateClosed"] !== true ||
      r["activeOperations"] !== 0 ||
      objectLength(r["activeIds"]) ||
      r["generation"] !== c["generation"] ||
      r["contextEpoch"] !== c["contextEpoch"] ||
      b["expectedGeneration"] !== numeric(c["generation"]) - 1 ||
      sourceRequest["paused"] !== true ||
      sourceRequest["generation"] !== c["generation"] ||
      !state["paused"] ||
      !status["paused"] ||
      c["gateClosed"] !== true ||
      c["activeOperations"] !== 0 ||
      objectLength(c["activeIds"]) ||
      state["lease"] ||
      status["lease"] ||
      c["instanceId"] !== owner["nonce"] ||
      c["generation"] !== state["controlGeneration"] ||
      c["contextEpoch"] !== state["contextEpoch"] ||
      status["stopping"]
    )
      fail("No exact authenticated continuously inherited closed-pause proof");
    return {
      version: 1,
      kind: "owner-bound-existing-closed-pause-adoption",
      requestId: intentBinding["requestId"],
      clientId,
      migrationNonce: intent["nonce"],
      sourcePauseRequestId: requestId,
      stateHash: hash(JSON.stringify(state)),
      prerequisiteHash: authorization.hash,
      publicPauseSent: false,
      sdkRequestsSent: 0,
    };
  }

  function inheritedEpochPause(args: InheritedPauseInput) {
    return inheritedClosedPause({
      ...args,
      authorization: args.upgrade.epochPrerequisite,
    });
  }
  function inheritedAuditResponsePause(args: InheritedPauseInput) {
    const proof = args.upgrade.auditResponseRecovery;
    return inheritedClosedPause({
      ...args,
      authorization: proof && {
        files: proof["files"],
        clientId: proof["key"]["clientId"],
        hash: proof["evidenceHash"],
      },
    });
  }

  return {
    epochAuditPrerequisite,
    epochPrerequisiteStillCurrent,
    inheritedEpochPause,
    inheritedAuditResponsePause,
  };
}

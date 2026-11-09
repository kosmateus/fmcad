import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { AuditBinding } from "../packages/node-adapters/src/execution/recovery-audit";
import type { Reference } from "./queue-epoch-lineage";
const load = createRequire(__filename);
type Data = Record<string, unknown>;
const names = [
  "migrationIntent",
  "migrationComplete",
  "auditIntent",
  "auditStart",
  "auditWire",
  "auditResult",
  "auditRemote",
] as const;
type Name = (typeof names)[number];
export type AuditResponseManifest = Record<Name, Reference>;
export interface AuditResponseScope {
  jobId: string;
  observationJobId: string;
}
function fields(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
}
function string(value: unknown): string {
  if (typeof value !== "string")
    fail("Original evidence requires a string identity or path");
  return value;
}
function read(file: string, limit = 256 * 1024 * 1024): Data {
  const value = readJson(file, limit);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("Object-shaped original evidence required");
  return value as Data;
}
function manifest(value: unknown): AuditResponseManifest {
  const data = fields(value);
  if (Object.keys(data).sort().join(",") !== [...names].sort().join(","))
    fail("Complete original evidence manifest required");
  const entry = (name: Name): Reference => {
    const value = fields(data[name]);
    if (
      typeof value["path"] !== "string" ||
      typeof value["sha256"] !== "string"
    )
      fail("Original evidence references require path and hash");
    return { ...value, path: value["path"], sha256: value["sha256"] };
  };
  return {
    migrationIntent: entry("migrationIntent"),
    migrationComplete: entry("migrationComplete"),
    auditIntent: entry("auditIntent"),
    auditStart: entry("auditStart"),
    auditWire: entry("auditWire"),
    auditResult: entry("auditResult"),
    auditRemote: entry("auditRemote"),
  };
}
const { hash, readJson, sameInstance, buildHash } = load(
  "./queue-instance",
) as {
  hash(value: string): string;
  readJson(file: string, max?: number): unknown;
  sameInstance(a: unknown, b: unknown): boolean;
  buildHash(root: string): string;
};
const { fileHash, directory } = load(
  "./queue-atomic-migration-files",
) as typeof import("./queue-atomic-migration-files");
const canonicalHash = (value: unknown): string =>
  (
    load(
      "./dist/core/application/cad/json",
    ) as typeof import("../packages/core/src/application/cad/json")
  ).hash(value);
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "AUDIT_RESPONSE_PROOF_INVALID",
  });
}
const frozen843 =
  "14aca04a4c37e5a3142d2493fc9e559987864779bad0b25dee41d166bcd3960d";

export function collectAuditResponseFiles(
  dir: string,
  migrationAudit: string,
  scope: AuditResponseScope,
): AuditResponseManifest {
  const audit = path.join(dir, "jobs", scope.jobId, "atomic-recovery-audit");
  const start = read(path.join(audit, "start.json"), 16 * 1024 * 1024);
  if (path.dirname(string(start["receipt"] ?? "")) !== audit)
    fail("Original physical receipt escaped the exact audit directory");
  const paths = {
    migrationIntent: path.join(migrationAudit, "intent.json"),
    migrationComplete: path.join(migrationAudit, "complete.json"),
    auditIntent: path.join(audit, "intent.json"),
    auditStart: path.join(audit, "start.json"),
    auditWire: path.join(audit, "wire.json"),
    auditResult: path.join(audit, "result.json"),
    auditRemote: string(start["receipt"]),
  };
  return manifest(
    Object.fromEntries(
      Object.entries(paths).map(([name, file]) => [
        name,
        { path: file, sha256: fileHash(file).sha256 },
      ]),
    ),
  );
}

// File-only proof. A successful Python receipt proves execution, never the
// dynamic facts that were printed to a response body which was not persisted.
export function auditResponseProof(
  input: unknown,
  dir: string,
  scope: AuditResponseScope,
) {
  const files = manifest(input);
  for (const entry of Object.values(files)) {
    if (
      !entry ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 || "") ||
      !path.isAbsolute(entry.path || "") ||
      fileHash(entry.path).sha256 !== entry.sha256
    )
      fail("Original evidence bytes changed");
    directory(path.dirname(entry.path));
    if (fs.realpathSync(entry.path) !== entry.path)
      fail("Original evidence must not traverse a symlink");
  }
  const evidence = (key: Name): Data => read(files[key].path);
  const migration = evidence("migrationIntent"),
    complete = evidence("migrationComplete"),
    intent = evidence("auditIntent"),
    start = evidence("auditStart"),
    wire = evidence("auditWire"),
    result = evidence("auditResult"),
    remote = evidence("auditRemote");
  const migrationAudit = path.join(
    dir,
    "atomic-migrations",
    hash(string(complete["requestId"] ?? "")),
  );
  const audit = path.join(dir, "jobs", scope.jobId, "atomic-recovery-audit");
  const paths = {
    migrationIntent: path.join(migrationAudit, "intent.json"),
    migrationComplete: path.join(migrationAudit, "complete.json"),
    auditIntent: path.join(audit, "intent.json"),
    auditStart: path.join(audit, "start.json"),
    auditWire: path.join(audit, "wire.json"),
    auditResult: path.join(audit, "result.json"),
    auditRemote: string(start["receipt"]),
  };
  if (
    Object.entries(paths).some(
      ([key, file]) => files[key as Name].path !== file,
    ) ||
    path.dirname(string(start["receipt"] ?? "")) !== audit ||
    complete["kind"] !== "atomic-owner-migration" ||
    complete["purpose"] !== "atomic-recovery-process-loss-audit-upgrade-v1" ||
    complete["jobId"] !== scope.jobId ||
    complete["sdkRequestsSent"] !== 0 ||
    complete["nativeOutcome"] !== "unknown" ||
    complete["gateClosed"] !== true ||
    complete["unresolved"] !== true ||
    complete["observerBuildHash"] !== frozen843 ||
    complete["currentModelingAdmission"] !== "blocked" ||
    fields(migration["approved"])["buildHash"] !== frozen843 ||
    fields(migration["binding"])["requestId"] !== complete["requestId"] ||
    hash(JSON.stringify(migration["approved"])) !==
      fields(migration["binding"])["approvalHash"]
  )
    fail(
      "Original completed 843 process-loss migration and approval do not match",
    );
  const key = fields(intent["key"]),
    binding: AuditBinding = fields(intent["binding"]);
  if (
    !key ||
    !binding ||
    key["jobId"] !== scope.jobId ||
    key["observationJobId"] !== scope.observationJobId ||
    binding["targetJobId"] !== key["jobId"] ||
    binding["observationJobId"] !== key["observationJobId"] ||
    binding["clientId"] !== key["clientId"] ||
    binding["purpose"] !== "atomic-recovery-audit-v1" ||
    binding["auditBuildHash"] !== frozen843 ||
    fields(migration["binding"])["clientId"] !== key["clientId"] ||
    fields(binding["control"])["instanceId"] !==
      fields(complete["owner"])["nonce"] ||
    !sameInstance(
      binding["currentInstance"],
      complete["currentAuditInstance"],
    ) ||
    !sameInstance(
      binding["currentInstance"],
      fields(migration["approved"])["currentInstance"],
    ) ||
    result["kind"] !== "atomic-recovery-audit" ||
    result["status"] !== "failed" ||
    result["code"] !== "EPROTO" ||
    result["sdkRequestsSent"] !== 1 ||
    result["endpointVerified"] !== false ||
    result["summary"] !== undefined ||
    result["currentModelingAdmission"] !== "blocked" ||
    result["historicalProcessState"] !== "terminated" ||
    !sameInstance(
      result["historicalInstance"],
      binding["historicalInstance"],
    ) ||
    Object.entries(key).some(([k, v]) => result[k] !== v) ||
    result["nativeOutcome"] !== "unknown" ||
    result["modelValidation"] !== "not_performed" ||
    result["rollbackVerification"] !== "not_performed" ||
    !sameInstance(result["currentInstance"], binding["currentInstance"])
  )
    fail("Only the exact owned failed EPROTO audit is eligible");
  const root = string(fields(migration["approved"])["candidateRoot"]);
  if (
    !path.isAbsolute(root || "") ||
    fs.realpathSync(root) !== root ||
    buildHash(root) !== frozen843
  )
    fail(
      "Original immutable qualified producer runtime is unavailable or changed",
    );
  // The literal caller ID is an actual contract of this frozen McpClient, not a
  // guess from a synthetic response. Reconstruct every original final byte.
  const original = load(
    path.join(root, "src/queue-atomic-recovery-audit"),
  ) as typeof import("./queue-atomic-recovery-audit");
  const reader = original.prepareRecoveryAudit(
    root,
    intent["identity"],
    binding,
  );
  const payload = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "execute_python",
      arguments: {
        code: reader.artifact.script + '\n\nrun("")\n',
        persistent: false,
      },
    },
  };
  const expected = original.prepareRecoveryAuditWire({
    payload,
    reader,
    receipt: string(start["receipt"]),
    instance: binding["currentInstance"],
    buildHash: frozen843,
    jobId: string(key["jobId"]),
    auditBinding: binding,
    rpcId: string(fields(start["binding"])["rpcId"]),
  });
  if (
    reader.artifact.artifactHash !== intent["sourceArtifactHash"] ||
    reader.sourceSha256 !== intent["sourceSha256"] ||
    canonicalHash(start["binding"]) !==
      canonicalHash(expected.record.binding) ||
    canonicalHash(wire["outgoing"]) !== canonicalHash(expected.outgoing) ||
    fields(wire["artifact"])["artifactHash"] !==
      expected.artifact.artifactHash ||
    start["originArtifactHash"] !== reader.artifact.artifactHash ||
    fields(start["pythonCheck"])["status"] !== "passed" ||
    fields(fields(start["pythonCheck"])["provenance"])["artifactHash"] !==
      fields(wire["artifact"])["artifactHash"] ||
    fields(fields(start["pythonCheck"])["provenance"])["wireHash"] !==
      expected.artifact.sha256 ||
    !sameInstance(start["instance"], binding["currentInstance"])
  )
    fail(
      "Original checker/source/origin/final-wire binding does not reconstruct exactly",
    );
  (
    load(
      path.join(root, "src/python"),
    ) as typeof import("../packages/node-adapters/src/python/context-binding")
  ).bindPythonArtifactManifest(
    string(
      fields(fields(fields(wire["outgoing"])["params"])["arguments"])["code"],
    ),
    wire["artifact"],
  );
  if (
    remote["terminal"] !== true ||
    remote["outcome"] !== "succeeded" ||
    remote["error"] ||
    Object.entries(fields(start["binding"])).some(
      ([k, v]) => canonicalHash(remote[k] ?? null) !== canonicalHash(v),
    ) ||
    !sameInstance(remote["instance"], binding["currentInstance"])
  )
    fail("Physical execution has no exact successful process-bound receipt");
  return {
    version: 1,
    kind: "atomic-audit-response-postmortem-v1",
    key,
    originalStatus: {
      status: result["status"],
      code: result["code"],
      endpointVerified: result["endpointVerified"],
    },
    originalRpcId: fields(start["binding"])["rpcId"],
    currentInstance: binding["currentInstance"],
    originalIdentity: intent["identity"],
    originalHistoricalInstance: binding["historicalInstance"],
    producerBuildHash: frozen843,
    files,
    evidenceHash: canonicalHash(files),
    executionProof: {
      expectedInstanceMatched: true,
      exactGuardBeforeBodyVerified: true,
      synchronousBodyCompleted: true,
    },
    responseContract: {
      callerId: payload.id,
      wireId: fields(wire["outgoing"])["id"],
      idRestorationMissingInFrozenAudit: true,
      ordinaryBrokerRestoresCallerId: true,
    },
    facts: {
      available: false,
      summary: null,
      reason:
        "Original frozen controller persisted no raw reply or summary after caller protocol failure",
    },
    epochEligible: false,
    historicalOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
    sdkRequestsSent: 0,
  };
}

export function auditResponseProofStillCurrent(proof: unknown): boolean {
  try {
    return Object.values(manifest(fields(proof)["files"])).every(
      (entry) => fileHash(entry.path).sha256 === entry.sha256,
    );
  } catch {
    return false;
  }
}

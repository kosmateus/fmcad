import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { PreparedPythonArtifact } from "@fmcad/core";
import { hash as canonicalHash } from "../../../core/src/application/cad/json";
import { record } from "../../../core/src/application/cad/contracts";
import { preparePythonArtifact } from "../python/artifact";
import {
  pythonArtifactManifest,
  retainPythonOrigin,
} from "../python/context-binding";
import type {
  AuditBinding,
  AuditReader,
  AuditRpc,
  AuditWire,
} from "./recovery-audit";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function literal(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (Array.isArray(value)) return "[" + value.map(literal).join(", ") + "]";
  if (record(value))
    return (
      "{" +
      Object.entries(value)
        .map(([key, item]) => JSON.stringify(key) + ": " + literal(item))
        .join(", ") +
      "}"
    );
  if (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  return fail(
    "AUDIT_REQUEST_INVALID",
    "Audit identity must contain finite JSON values",
  );
}
export function prepareRecoveryAudit(
  installation: string,
  identity: unknown,
  context: AuditBinding,
): AuditReader {
  const filename = "runtime/python/recovery/atomic_audit.py";
  const file = path.join(installation, filename),
    bytes = fs.readFileSync(file);
  const artifact = preparePythonArtifact(
    [
      {
        id: "atomic-recovery-audit",
        filename,
        role: "runtime",
        source: bytes.toString("utf8"),
      },
      {
        id: "wrapper",
        filename: "<fmcad-recovery-audit>",
        role: "wrapper",
        source: `
_AA_REQUEST: AaObject = ${literal({ identity })}
def run(_context: str) -> None:
    import adsk.core
    value = atomic_recovery_audit(_aa_cast(AaApplication, adsk.core.Application.get()), _AA_REQUEST)
    print('FMCAD_RESULT ' + _aa_json.dumps(value, allow_nan=False))
`,
      },
    ],
    {
      request: { identity },
      context: { kind: "atomic-recovery-audit-v1", ...context },
    },
  );
  return { artifact, sourceFile: file, sourceSha256: hash(bytes) };
}
export type ReceiptPreparer = (
  code: string,
  official: boolean,
  receipt: string,
  binding: Record<string, unknown>,
) => PreparedPythonArtifact;
export interface RecoveryWireInput {
  payload: AuditRpc;
  reader: AuditReader;
  receipt: string;
  instance: unknown;
  buildHash: string;
  jobId: string;
  auditBinding: AuditBinding;
  rpcId?: string;
}
export function prepareRecoveryAuditWire(
  prepareReceiptScript: ReceiptPreparer,
  {
    payload,
    reader,
    receipt,
    instance,
    buildHash,
    jobId,
    auditBinding,
    rpcId = randomUUID(),
  }: RecoveryWireInput,
): AuditWire {
  const origin = pythonArtifactManifest(reader.artifact);
  const code = payload.params?.arguments?.code;
  if (typeof code !== "string")
    return fail(
      "AUDIT_REQUEST_INVALID",
      "Audit wire requires exact Python source",
    );
  const binding = {
    jobId,
    rpcId,
    requestHash: hash(JSON.stringify(payload)),
    buildHash,
    sourceHash: hash(code),
    purpose: auditBinding["purpose"] || "atomic-recovery-audit-v1",
    auditBindingHash: canonicalHash(auditBinding),
    pythonOriginHash: origin.artifactHash,
    ...(auditBinding.currentInstance
      ? { auditExpectedInstance: auditBinding.currentInstance }
      : {}),
    ...(auditBinding["expectedProcess"]
      ? { auditExpectedProcess: auditBinding["expectedProcess"] }
      : {}),
    ...(auditBinding["expectedDocument"]
      ? { auditExpectedDocument: auditBinding["expectedDocument"] }
      : {}),
    ...(auditBinding["expectedSavedDocument"]
      ? { auditExpectedSavedDocument: auditBinding["expectedSavedDocument"] }
      : {}),
    ...(auditBinding["firstSave"] === true ? { auditFirstSave: true } : {}),
  };
  const artifact = retainPythonOrigin(
    prepareReceiptScript(code, false, receipt, binding),
    origin,
  );
  const outgoing = structuredClone(payload);
  outgoing.id = "fmcad:" + rpcId;
  outgoing.params = {
    ...outgoing.params,
    arguments: { ...outgoing.params?.arguments, code: artifact.script },
  };
  return {
    outgoing,
    artifact,
    record: { binding, instance, receipt },
    certificate: null,
  };
}
export async function auditAtomic(
  client: { call(action: string, message?: unknown): Promise<unknown> },
  {
    jobId,
    observationJobId,
    requestId,
    buildHash,
  }: {
    jobId: string;
    observationJobId: string;
    requestId: string;
    buildHash: string;
  },
) {
  const status = await client.call("queue-summary");
  if (
    !record(status) ||
    !record(status["features"]) ||
    status["features"]["atomicRecoveryAudit"] !== true
  )
    return fail(
      "AUDIT_UNSUPPORTED",
      "Installed broker has no scoped recovery audit; nothing submitted",
    );
  const control = status["control"];
  if (!record(control) || control["buildHash"] !== buildHash)
    return fail(
      "BUILD_CHANGED",
      "Audit CLI and broker must have the same approved build",
    );
  return client.call("audit-atomic", {
    jobId,
    observationJobId,
    requestId,
    control: {
      instanceId: control["instanceId"],
      buildHash: control["buildHash"],
      generation: control["generation"],
      contextEpoch: control["contextEpoch"],
    },
  });
}

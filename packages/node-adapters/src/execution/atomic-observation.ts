import { createHash } from "node:crypto";
import type { PreparedPythonArtifact } from "@fmcad/core";
import { hash as canonicalHash } from "../../../core/src/application/cad/json";
import { record } from "../../../core/src/application/cad/contracts";
import {
  atomicObservationIdentityHash,
  assertAtomicObservationIdentity,
} from "../../../core/src/application/cad/observation-binding";
import { verifyPythonArtifact } from "../python/artifact";
import {
  pythonArtifactManifest,
  retainPythonOrigin,
} from "../python/context-binding";
import type { AuditRpc } from "./recovery-audit";
import type { ReceiptPreparer } from "./recovery-python";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function assertAtomicObservationWire(
  code: unknown,
  artifact: PreparedPythonArtifact,
): void {
  try {
    verifyPythonArtifact(artifact);
  } catch {
    throw Object.assign(
      new Error("Final atomic observation artifact identity changed"),
      { code: "WORKFLOW_ARTIFACT_CHANGED" },
    );
  }
  if (typeof code !== "string" || code !== artifact.script)
    throw Object.assign(
      new Error(
        "Actual atomic observation wire bytes differ from the verified artifact",
      ),
      { code: "WORKFLOW_ARTIFACT_CHANGED" },
    );
}
export interface AtomicObservationInput {
  payload: AuditRpc;
  rpcId: string;
  observerJobId: string;
  targetJobId: string;
  codeHash: string;
  identity: unknown;
  instance: unknown;
  receipt: string;
  dispatchTimeoutMs: number;
  originArtifact: PreparedPythonArtifact;
  atomicRuntimeAbi: {
    proof: { identityHash: string; [key: string]: unknown };
    hash: string;
  };
}
/** Prepares bytes only. The broker retains publication and physical send authority. */
export function prepareAtomicObservationWire(
  prepareReceiptScript: ReceiptPreparer,
  {
    payload,
    rpcId,
    observerJobId,
    targetJobId,
    codeHash,
    identity,
    instance,
    receipt,
    dispatchTimeoutMs,
    originArtifact,
    atomicRuntimeAbi,
  }: AtomicObservationInput,
) {
  if (
    !atomicRuntimeAbi ||
    canonicalHash(atomicRuntimeAbi.proof) !== atomicRuntimeAbi.hash ||
    !record(originArtifact?.context) ||
    originArtifact.context["atomicRuntimeAbiHash"] !== atomicRuntimeAbi.hash
  )
    throw Object.assign(
      new Error(
        "Atomic wire requires its verified ABI proof and exact original executed manifest",
      ),
      { code: "BUILD_CHANGED" },
    );
  const origin = pythonArtifactManifest(originArtifact);
  const code = payload.params?.arguments?.code;
  if (typeof code !== "string")
    throw Object.assign(new Error("Atomic wire requires exact Python source"), {
      code: "WORKFLOW_ARTIFACT_CHANGED",
    });
  const request = {
    jsonrpc: "2.0",
    method: payload.method,
    ...(Object.hasOwn(payload, "id") ? { id: payload.id } : {}),
  };
  const binding = {
    jobId: observerJobId,
    rpcId,
    requestHash: hash(JSON.stringify(payload)),
    buildHash: codeHash,
    sourceHash: hash(code),
    observationKind: "atomic_holder_status",
    observationTargetJobId: targetJobId,
    observationIdentityHash: atomicObservationIdentityHash(identity),
    atomicRuntimeAbiHash: atomicRuntimeAbi.hash,
    pythonOriginHash: origin.artifactHash,
  };
  assertAtomicObservationIdentity(
    identity,
    binding.observationIdentityHash,
    atomicRuntimeAbi.proof.identityHash,
  );
  const artifact = retainPythonOrigin(
    prepareReceiptScript(code, false, receipt, binding),
    origin,
  );
  verifyPythonArtifact(artifact);
  const wire = structuredClone(payload);
  if (Object.hasOwn(wire, "id")) wire.id = "fmcad:" + rpcId;
  wire.params = {
    ...wire.params,
    arguments: { ...wire.params?.arguments, code: artifact.script },
  };
  const entry = {
    binding,
    instance,
    request,
    wireRequest: {
      jsonrpc: "2.0",
      method: wire.method,
      ...(Object.hasOwn(wire, "id") ? { id: wire.id } : {}),
    },
    terminal: false,
    method: payload.method,
    receipt,
    atomicRuntimeAbi: atomicRuntimeAbi.proof,
    pythonArtifact: {
      version: artifact.version,
      sha256: artifact.sha256,
      artifactHash: artifact.artifactHash,
      sourceMap: artifact.sourceMap,
      context: artifact.context,
      request: artifact.request,
      units: artifact.units.map(({ id, filename, role, sha256 }) => ({
        id,
        filename,
        role,
        sha256,
      })),
    },
  };
  return {
    record: entry,
    rpcId,
    outgoing: wire,
    pythonArtifact: artifact,
    dispatchTimeoutMs,
  };
}

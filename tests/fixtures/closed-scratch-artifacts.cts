import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
interface Pointer {
  epochId: string;
  root: string;
  ownerClientId: string;
  ownerTokenHash: string;
  document: { name: string; creationId: string; fileId: null };
  currentInstance: unknown;
  qualificationReceipt: { path: string; sha256: string };
  succession?: unknown;
  restoreActiveCreationId?: string | null;
}
function syntheticClosedScratch(
  root: string,
  pointer: Pointer,
  repo: string,
  admissionMode?: string,
) {
  const runtimeRequire = createRequire(__filename);
  const api = runtimeRequire(repo + "/src/queue-instance") as {
    durable(file: string, value: unknown, exclusive?: boolean): void;
  };
  const { reference } = runtimeRequire(repo + "/src/queue-epoch-lineage") as {
    reference(file: string): { path: string; sha256: string };
  };
  const digest = (value: unknown): string =>
    (
      runtimeRequire(repo + "/src/dist/core/application/cad/json") as {
        hash(value: unknown): string;
      }
    ).hash(value);
  const control = pointer.succession
    ? path.dirname(path.dirname(pointer.qualificationReceipt.path))
    : root;
  const dir = path.join(control, "isolated-scratch-close");
  fs.mkdirSync(dir, { recursive: true });
  const binding = {
    purpose: "isolated-scratch-close-v1",
    epochId: pointer.epochId,
    clientId: pointer.ownerClientId,
    ...(admissionMode ? { admissionMode } : {}),
    ownerTokenHash: pointer.ownerTokenHash,
    document: pointer.document,
    currentInstance: pointer.currentInstance,
    sdkProofPath: path.join(dir, "sdk-closed.json"),
    ...(Object.hasOwn(pointer, "restoreActiveCreationId")
      ? { restoreActiveCreationId: pointer.restoreActiveCreationId }
      : {}),
  };
  const summary = {
    version: 1,
    purpose: binding.purpose,
    document: pointer.document,
    bindingHash: digest(binding),
    closed: true,
    saved: false,
    historicalOutcome: "unknown",
    originalModelValidation: "not_performed",
    originalRollbackVerification: "not_performed",
    ...(Object.hasOwn(binding, "restoreActiveCreationId")
      ? {
          activeBeforeCloseCreationId: pointer.document.creationId,
          restoredActiveCreationId: pointer.restoreActiveCreationId,
          activeDocumentRestored: true,
        }
      : {}),
  };
  const rpcId = randomUUID(),
    physical = {
      rpcId,
      purpose: binding.purpose,
      auditBindingHash: digest(binding),
      pythonOriginHash: "b".repeat(64),
      auditExpectedInstance: pointer.currentInstance,
    };
  const remote = path.join(dir, "remote-" + rpcId + ".json");
  api.durable(
    path.join(dir, "intent.json"),
    { binding, sourceArtifactHash: physical.pythonOriginHash },
    true,
  );
  api.durable(
    path.join(dir, "start.json"),
    { binding: physical, receipt: remote, pythonCheck: { status: "passed" } },
    true,
  );
  api.durable(path.join(dir, "wire.json"), { synthetic: true }, true);
  api.durable(binding.sdkProofPath, summary, true);
  api.durable(
    remote,
    {
      ...physical,
      terminal: true,
      outcome: "succeeded",
      instance: pointer.currentInstance,
    },
    true,
  );
  const result = path.join(dir, "result.json");
  api.durable(
    result,
    {
      kind: "isolated-scratch-close",
      status: "complete",
      sdkRequestsSent: 1,
      endpointVerified: true,
      clientId: pointer.ownerClientId,
      summary,
    },
    true,
  );
  const closedFile = path.join(pointer.root, "closed.json");
  api.durable(
    closedFile,
    {
      epochId: pointer.epochId,
      document: pointer.document,
      historicalOutcome: "unknown",
      receipt: reference(result),
      ...(admissionMode ? { admissionMode } : {}),
      qualificationEvidence: [
        "intent.json",
        "start.json",
        "wire.json",
        "sdk-closed.json",
        path.basename(remote),
      ].map((name) => reference(path.join(dir, name))),
    },
    true,
  );
  return reference(closedFile);
}
export = syntheticClosedScratch;

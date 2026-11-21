"use strict";
// Synthetic physical publication receipts, verified by the production reader.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

module.exports = function publish(f, repo) {
  const api = require(repo + "/src/queue-instance");
  const saved = require(repo + "/src/queue-saved-runtime");
  const { epochControlDirectory } = require(repo + "/src/queue-epoch-lineage");
  const { savedAuditKind } = require(repo + "/src/queue-saved-audit-path");
  const { hash: digest } = require(repo + "/src/dist/core/application/cad/json");
  const epoch = f.state.epoch;
  const requestId = "synthetic-publication-" + randomUUID();
  const kind = savedAuditKind("sp-", requestId);
  const directory = path.join(epochControlDirectory(f.dir, epoch), kind);
  fs.mkdirSync(directory, { recursive: true });
  const binding = {
    purpose: "saved-first-save-publication-v1", epochId: epoch.epochId,
    clientId: epoch.ownerClientId, ownerTokenHash: epoch.ownerTokenHash,
    document: epoch.document, currentInstance: epoch.currentInstance,
    sdkProofPath: path.join(directory, "sdk-publication.json"),
    sourceCommit: f.identity.sourceCommit, buildHash: f.identity.buildHash,
    firstSaveJobId: f.job.id,
    destination: { projectId: f.reply.target.projectId, folderId: f.grant.savedFirstSave.destination.folderId },
    expectedFileId: f.reply.targetObserved ? f.reply.current.fileId : null,
  };
  const sourceArtifactHash = "a".repeat(64);
  const rpcId = randomUUID(), receipt = path.join(directory, "remote-" + rpcId + ".json");
  const physical = {
    jobId: f.job.id, rpcId, buildHash: f.identity.buildHash,
    purpose: binding.purpose, auditBindingHash: digest(binding),
    pythonOriginHash: sourceArtifactHash, auditExpectedInstance: epoch.currentInstance,
  };
  const proof = {
    version: 1, purpose: binding.purpose, epochId: epoch.epochId,
    document: epoch.document, bindingHash: digest(binding),
    observed: f.observed, readOnly: true,
  };
  const files = {
    "intent.json": { binding, sourceArtifactHash },
    "start.json": { binding: physical, receipt, pythonCheck: { status: "passed" } },
    "wire.json": { synthetic: true },
    "sdk-publication.json": proof,
    ["remote-" + rpcId + ".json"]: { ...physical, terminal: true, outcome: "succeeded", instance: epoch.currentInstance },
  };
  for (const [name, value] of Object.entries(files)) api.durable(path.join(directory, name), value, true);
  const result = path.join(directory, "result.json");
  api.durable(result, {
    kind, requestId, status: "complete", sdkRequestsSent: 1, endpointVerified: true,
    clientId: epoch.ownerClientId, jobId: f.job.id, nativeOutcome: "unknown",
    modelValidation: "not_performed", rollbackVerification: "not_performed", summary: proof,
  }, true);
  const first = saved.firstSaveEvidence(f.dir, epoch, f.job.id);
  const publication = {
    version: 1, kind: "owner-verified-new-saved-publication",
    epochId: epoch.epochId, ownerClientId: epoch.ownerClientId, ownerTokenHash: epoch.ownerTokenHash,
    originDocument: epoch.document, sourceCommit: f.identity.sourceCommit, buildHash: f.identity.buildHash,
    firstSaveJobId: f.job.id, firstSaveEvidence: first.evidence,
    observationReceipt: saved.reference(result),
    observationEvidence: Object.keys(files).map(name => saved.reference(path.join(directory, name))),
    publication: saved.firstSavePublication(f.grant, f.reply, f.observed),
  };
  api.durable(path.join(epoch.root, "saved-first-save-publication.json"), publication, true);
  return saved.readSavedPublication(f.dir, epoch);
};

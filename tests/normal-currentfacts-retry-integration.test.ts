import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const normal = load("../src/dist/composition/queue-normal-cold-successor") as typeof import("../src/composition/queue-normal-cold-successor");
const { createFixture } = load("../../tests/fixtures/normal-currentfacts-retry.cjs");

test("legacy failed normal read traverses fresh authorization, retirement and existing successor inspectors on the same SDK", async (t) => {
  const repo = path.resolve(".");
  const f = createFixture(t, repo);
  const { write, ref, hash } = f;
  const { prepareRecoveryAuditWire } = load("../src/queue-atomic-recovery-audit") as typeof import("../src/queue-atomic-recovery-audit");
  const { createProductionQueueAdmission } = load("../src/queue-admission") as typeof import("../src/queue-admission");
  const sdkOs = load("../src/dist/composition/queue-epoch-successor-retirement") as typeof import("../src/composition/queue-epoch-successor-retirement");
  const querySdkProcess = sdkOs.querySdkProcess;
  sdkOs.querySdkProcess = f.ports.sdkProcess;
  t.after(() => { sdkOs.querySdkProcess = querySdkProcess; });
  const legacyRoot = path.join(f.dir, "legacy-runtime");
  const legacySourceFile = path.join(legacyRoot, "runtime/python/recovery/normal_currentstore.py");
  fs.mkdirSync(path.dirname(legacySourceFile), { recursive: true });
  // Frozen pre-fix schema: two arguments, no policy or file flags in the reply.
  fs.writeFileSync(legacySourceFile, `import json as _nc_json
import adsk.core as _nc_core
def normal_currentstore_facts(creation_id: str, document_name: str) -> dict[str, object]:
    app = _nc_core.Application.get()
    assert app is not None
    documents: list[dict[str, str]] = []
    present = False
    for index in range(app.documents.count):
        doc = app.documents.item(index)
        assert doc is not None
        documents.append({'creationId': doc.creationId, 'name': doc.name})
        if doc.creationId == creation_id or doc.name == document_name:
            present = True
    return {'kind': 'normal-currentstore-current-facts-v1', 'originalDocumentCreationId': creation_id,
            'originalDocumentName': document_name, 'originalDocumentPresent': present,
            'activeCommand': app.userInterface.activeCommand, 'documents': documents,
            'historicalOutcome': 'unknown', 'modelValidation': 'not_performed'}
`);
  const audit = path.join(f.dir, "epoch-successions", hash(f.baseRequestId));
  const currentOwner = { pid: 900002, birth: "synthetic-boot:current", nonce: randomUUID(), protocol: 2 };
  const priorQualification = path.join(audit, "qualification.json");
  write(priorQualification, { passed: true, productionAdmission: true, normalCurrentStoreSuccessorQualified: true });
  const authority = { kind: "owner-authenticated-dead-epoch-successor", requestId: f.baseRequestId,
    clientId: f.p.epochClientId, ownerTokenHash: hash(f.epochClient.auth.clientToken),
    sourceCommit: "4".repeat(40), buildHash: "5".repeat(64), candidateRoot: legacyRoot,
    qualification: ref(priorQualification), expectedProcess: f.expectedProcess,
    previousOwner: f.owner, predecessor: { pointer: ref(path.join(f.dir, "isolated-admission-epoch.json")) },
    normalCurrentStore: f.normalStore };
  const authorityFile = path.join(audit, "authority.json");
  write(authorityFile, authority);
  const previousAuthority = ref(authorityFile);
  write(path.join(f.dir, "active-epoch-succession.json"), { version: 1, authority: previousAuthority });
  write(path.join(f.dir, "broker.lock"), currentOwner);
  write(path.join(f.dir, `broker-lifecycle-${currentOwner.nonce}.json`), {
    owner: currentOwner, buildHash: authority.buildHash, configHash: f.p.configHash, stage: "recovery" });
  const identity = { kind: "normal-currentstore-v1", resolvedIdentity: { creationId: f.p.creationId, name: "Untitled" } };
  const binding = { purpose: "normal-currentstore-current-facts-v1", clientId: f.p.epochClientId,
    expectedProcess: f.expectedProcess, successorAuthorityHash: previousAuthority.sha256, normalCurrentStore: f.normalStore };
  const directory = path.join(audit, "dead-epoch-current-observation");
  fs.mkdirSync(directory);
  const receipt = path.join(directory, `remote-${randomUUID()}.json`);
  const reader = normal.prepareNormalCurrentFacts(legacyRoot, identity, binding);
  const prepared = prepareRecoveryAuditWire({ reader, receipt,
    instance: f.expectedProcess, buildHash: authority.buildHash, jobId: f.p.jobId, auditBinding: binding,
    payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fusion_mcp_execute",
      arguments: { featureType: "script", object: { script: reader.artifact.script, readOnly: true } } } } });
  const certificate = await createProductionQueueAdmission(path.resolve(__dirname, "../runtime/python")).admission.check(prepared.outgoing, prepared.artifact);
  certificate.fence(prepared.outgoing);
  const key = { jobId: f.p.jobId, observationJobId: f.p.rpcId,
    requestId: f.baseRequestId + ":observe", clientId: f.p.epochClientId };
  write(path.join(directory, "intent.json"), { version: 1, key, binding, identity,
    sourceSha256: reader.sourceSha256, sourceArtifactHash: reader.artifact.artifactHash });
  write(path.join(directory, "start.json"), { receipt, binding: prepared.record.binding, instance: f.expectedProcess,
    originArtifactHash: reader.artifact.artifactHash, pythonCheck: certificate.report });
  write(path.join(directory, "wire.json"), { outgoing: prepared.outgoing, artifact: prepared.artifact });
  write(receipt, { ...prepared.record.binding, terminal: true, outcome: "succeeded",
    instance: { ...f.expectedProcess, version: "2706-fixture" } });
  const summary = { kind: binding.purpose, originalDocumentCreationId: f.p.creationId,
    originalDocumentName: "Untitled", originalDocumentPresent: true, activeCommand: "SelectCommand",
    documents: [{ creationId: randomUUID(), name: "Untitled" }], historicalOutcome: "unknown", modelValidation: "not_performed" };
  write(path.join(directory, "received-response.json"), { version: 1, binding: prepared.record.binding,
    wireId: prepared.outgoing.id, callerId: 2, status: 200,
    raw: JSON.stringify({ jsonrpc: "2.0", id: prepared.outgoing.id,
      result: { content: [{ type: "text", text: "FMCAD_RESULT " + JSON.stringify(summary) }] } }) });
  write(path.join(directory, "result.json"), { kind: "dead-epoch-current-observation", ...key,
    status: "failed", code: "NORMAL_SUCCESSOR_UNPROVEN", sdkRequestsSent: 1, nativeOutcome: "unknown",
    modelValidation: "not_performed", rollbackVerification: "not_performed" });
  const frozenFiles = [f.rpcFile, path.join(directory, "result.json"), receipt,
    path.join(f.epoch, "queue-state.json"), path.join(f.dir, "queue-state.json")];
  const frozen = frozenFiles.map((file: string) => fs.readFileSync(file));
  assert.deepEqual(Object.keys(JSON.parse(frozen[0]!.toString()).instance.documents[0]).sort(), ["fileId", "id", "isModified", "isSaved"]);
  const candidate = { requestId: "fresh-read:" + randomUUID(), candidateRoot: repo,
    sourceCommit: "6".repeat(40), buildHash: "7".repeat(64), qualification: { path: "", sha256: "" },
    expectedProcess: { ...f.expectedProcess } };
  const qualificationFile = path.join(f.dir, "fresh-qualification.json");
  write(qualificationFile, { passed: true, productionAdmission: true, liveSdkRequestsSent: 0,
    sourceCommit: candidate.sourceCommit, buildHash: candidate.buildHash, runtime: repo,
    publicDirectAccessRefused: true, deadEpochSuccessorReadQualified: true, deadEpochSuccessorRestoreQualified: true,
    normalCurrentStoreSuccessorQualified: true, normalCurrentFactsRetryQualified: true });
  candidate.qualification = ref(qualificationFile);
  const evidence = { previousRequestId: f.baseRequestId, previousAuthority, physicalResult: ref(receipt),
    validationFailure: ref(path.join(directory, "result.json")), queueSummary: {
      sourceCommit: authority.sourceCommit, buildHash: authority.buildHash, stopping: false, paused: false,
      historicalOutcome: "unknown", historicalModelValidation: "not_performed",
      held: "metadata only", deadEpochSuccessor: { requestId: f.baseRequestId, expectedProcess: f.expectedProcess,
        predecessorEpochId: f.p.epochId, currentFactsAvailable: false, observationRequestId: key.requestId,
        creationRequestId: f.baseRequestId + ":create", historicalOutcome: "unknown" },
      control: { instanceId: currentOwner.nonce, buildHash: authority.buildHash,
        activeOperations: 0, activeIds: [], phase: "RECOVERY_BLOCKED", unresolved: true } } };
  const retry = normal.authorizeNormalCurrentFactsRetry(f.epochClient, evidence, candidate);
  assert.notEqual(candidate.requestId, f.baseRequestId);
  let absent = false;
  let effects = 0;
  const processProof = { ...currentOwner, exe: "/synthetic/node", exeSha256: "a".repeat(64),
    cmdline: ["/synthetic/node", "queue-epoch-successor-worker.js"], childrenByTask: { "1": [] }, socketRows: [] };
  const interpreter = { path: "/synthetic/python", sha256: "b".repeat(64), version: "fixture" };
  const ports: import("../src/composition/queue-normal-cold-successor").NormalMetadataRetirementPorts = {
    ...f.ports, buildHash: () => authority.buildHash, producerAbsent: () => absent,
    process(owner, runtime, refs, apply) {
      assert.equal(owner.pid, currentOwner.pid); assert.equal(runtime, legacyRoot);
      assert.ok(refs.every(entry => !entry.path.endsWith("request.json")));
      if (apply) { absent = true; effects++; }
      return { process: processProof, interpreter, retired: apply };
    },
  };
  normal.retireNormalCurrentFactsRetryProducer(f.epochClient, retry, false, ports);
  normal.retireNormalCurrentFactsRetryProducer(f.epochClient, retry, true, ports);
  assert.equal(effects, 1);
  const pins = { requestId: candidate.requestId, sourceCommit: candidate.sourceCommit,
    buildHash: candidate.buildHash, qualification: candidate.qualification, expectedProcess: candidate.expectedProcess };
  const inspected = normal.inspectNormalCurrentFactsRetry(f.dir, retry, pins, ports);
  assert.deepEqual(inspected.currentOwner, currentOwner);
  assert.deepEqual(inspected.expectedProcess, authority.expectedProcess);
  const approval = { requestId: candidate.requestId, clientId: f.p.epochClientId, previousBuildHash: f.p.buildHash,
    expectedProcess: candidate.expectedProcess, normalCurrentStore: f.normalStore, priorNormalCurrentFactsRetry: retry,
    sourceCommit: candidate.sourceCommit, buildHash: candidate.buildHash, qualification: candidate.qualification,
    candidateRoot: repo, previousOwner: currentOwner, version: 1, purpose: "dead-normal-currentstore-successor-v1",
    predecessorEpochId: f.p.epochId, pointerHash: ref(path.join(f.dir, "isolated-admission-epoch.json")).sha256,
    stateHash: ref(path.join(f.epoch, "queue-state.json")).sha256,
    rootStateHash: ref(path.join(f.dir, "queue-state.json")).sha256,
    rootIdentityHash: ref(path.join(f.dir, "instance.json")).sha256 } as import("../src/composition/queue-epoch-successor-types").Approval;
  // This is the existing preflight adapter, not a mocked retry validator.
  normal.inspectNormalCurrentStore(f.dir, approval, f.pointer, ports);
  // Replace only OS/runtime discovery; all authority and normal validators remain real.
  const osApi = load("../src/queue-instance") as {
    priorProcessAlive(value: { pid: number }): boolean;
    buildHash(): string;
    brokerConfigHash(value: unknown): string;
  };
  const originals = { priorProcessAlive: osApi.priorProcessAlive, buildHash: osApi.buildHash, brokerConfigHash: osApi.brokerConfigHash };
  const nextOwner = { pid: 900004, birth: "synthetic-boot:new", nonce: randomUUID(), protocol: 2 };
  let nextAlive = false;
  osApi.priorProcessAlive = process => process.pid === f.expectedProcess.pid || (nextAlive && process.pid === nextOwner.pid);
  osApi.buildHash = () => candidate.buildHash;
  osApi.brokerConfigHash = () => f.p.configHash;
  const platform = load("../src/dist/config-platform/runtime-paths") as { resolveRuntimePaths(input: unknown): Record<string, unknown> };
  const resolvePaths = platform.resolveRuntimePaths;
  platform.resolveRuntimePaths = input => ({ ...resolvePaths(input), installation: repo });
  const successorEntry = load.resolve("../src/dist/composition/queue-epoch-successor");
  const wrapperEntry = load.resolve("../src/queue-epoch-successor");
  const cached = [load.cache[successorEntry], load.cache[wrapperEntry]];
  delete load.cache[successorEntry]; delete load.cache[wrapperEntry];
  t.after(() => {
    Object.assign(osApi, originals); platform.resolveRuntimePaths = resolvePaths;
    for (const [index, file] of [successorEntry, wrapperEntry].entries()) {
      const original = cached[index];
      if (original) load.cache[file] = original;
      else delete load.cache[file];
    }
  });
  const successor = load("../src/queue-epoch-successor") as typeof import("../src/composition/queue-epoch-successor");
  const approvalFile = path.join(f.dir, "fresh-approval.json");
  write(approvalFile, approval);
  successor.inspectSuccessor(f.epochClient, {}, approvalFile, candidate.requestId);
  await successor.bootstrapSuccessor(f.epochClient, {}, { approval: approvalFile,
    requestId: candidate.requestId, preflight: true, confirmOwnership: true });
  const nextAudit = path.join(f.dir, "epoch-successions", hash(candidate.requestId));
  const children = load("node:child_process") as { spawn: (...args: unknown[]) => unknown };
  const spawn = children.spawn;
  t.after(() => { children.spawn = spawn; });
  let launches = 0;
  children.spawn = () => {
    launches++;
    return { on() {}, unref() {}, stdin: { on() {}, end(input: string) {
      const { nonce } = JSON.parse(input);
      assert.equal(fs.existsSync(path.join(f.dir, "broker.lock")), false);
      // This calls the real authority, lineage and normal validators before claim.
      successor.claimSuccessorBroker(f.dir, nextOwner, nonce, candidate.buildHash, {});
      nextAlive = true;
      write(path.join(nextAudit, "worker-ready.json"), { nonce, owner: nextOwner,
        buildHash: candidate.buildHash, sdkRequestsSent: 0 });
    } } };
  };
  const completed = await successor.bootstrapSuccessor(f.epochClient, {}, { approval: approvalFile,
    requestId: candidate.requestId, confirmOwnership: true });
  assert.equal((completed as { sdkRequestsSent: number }).sdkRequestsSent, 0);
  assert.equal(launches, 1);
  const nextRef = ref(path.join(nextAudit, "authority.json"));
  successor.assertCurrentPredecessor(f.dir, nextRef);
  normal.inspectNormalCurrentFactsRetry(f.dir, retry, pins, ports);
  const nextAuthority = JSON.parse(fs.readFileSync(nextRef.path, "utf8"));
  const checkedPredecessor = JSON.parse(JSON.stringify({ authority: nextAuthority, pointer: f.pointer }));
  normal.assertNormalCurrentPredecessor(f.dir, checkedPredecessor);
  const nextBinding = { ...binding, successorAuthorityHash: nextRef.sha256,
    priorNormalCurrentFactsRetry: retry, normalCurrentFactsRetryCandidate: pins };
  const nextReader = normal.prepareNormalCurrentFacts(repo, identity, nextBinding);
  assert.match(nextReader.artifact.script, /normal_currentstore_facts\([^\r\n]*, True\)/);
  frozenFiles.forEach((file: string, index: number) => assert.deepEqual(fs.readFileSync(file), frozen[index]));
  assert.equal(effects, 1);
});

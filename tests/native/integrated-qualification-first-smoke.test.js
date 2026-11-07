"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const firstSmoke = require("./integrated-qualification/first_smoke");
const { executeFirstSmoke } = require("./integrated-qualification/executor");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname,
  "integrated-qualification/manifest.json"), "utf8"));

const OWNER_JOBS = { targetJobId: "owner-target-job", observationJobId: "owner-observer-job" };
const DOCUMENT = { name: "FMCAD_EPOCH_SCRATCH_abc123", creationId: "created-scratch-id", fileId: null };
const SKETCH = { token: "native-sketch-token", kind: "sketch", name: "NQABCDEF12_Section" };
const PROFILE = { kind: "profile", sketch: SKETCH, index: 0 };
const BODY = { token: "native-body-token", kind: "body", name: "NQABCDEF12_Prism" };

function authority() {
  return {
    runtime: { ...firstSmoke.F708_RUNTIME },
    ownerJobs: { ...OWNER_JOBS },
    facts: {
      kind: "derived-current-audit-facts-v1", status: "complete", epochEligible: true, factsComplete: true,
      transportStatus: "complete", endpointVerified: true, sdkRequestsSent: 1,
      originalAuditFactsRecovered: false, historicalOutcome: "unknown", modelValidation: "not_performed",
      rollbackVerification: "not_performed", currentModelingAdmission: "blocked-pending-separate-facts-approval",
      originalRpcId: "original-rpc-id", originalAuditStatus: { status: "failed", code: "EPROTO", endpointVerified: false },
      key: { jobId: OWNER_JOBS.targetJobId, observationJobId: OWNER_JOBS.observationJobId,
        requestId: "original-audit-request", clientId: "original-owner-client" },
      files: Object.fromEntries(["captureIntent", "captureStart", "captureWire", "captureResult",
        "captureSdkFacts", "captureRemote"].map((key) => [key,
        { path: `/tmp/opencode/actual/${key}.json`, sha256: "a".repeat(64) }])),
    },
    approval: { permission: "one-proven-new-document-only", globalModelingAdmission: "blocked", historicalOutcome: "unknown" },
    creation: {
      kind: "isolated-scratch-qualification", status: "complete", requestId: "scratch-create-request",
      jobId: OWNER_JOBS.targetJobId, observationJobId: OWNER_JOBS.observationJobId,
      clientId: "original-owner-client",
      sdkRequestsSent: 1,
      activation: { epochId: "actual-epoch-id", document: { ...DOCUMENT }, admission: "qualified-fresh-scratch-only" },
    },
    grant: { epochId: "actual-epoch-id", clientId: "registered-qualified-agent", document: { ...DOCUMENT },
      scope: "qualified-fresh-scratch-only" },
  };
}

function upgradedAuthority() {
  const value = authority();
  const runtimeUpgrade = {
    kind: "quiescent-isolated-epoch-runtime-upgrade",
    epochId: "actual-epoch-id",
    document: { ...DOCUMENT },
    previousBuildHash: firstSmoke.F708_RUNTIME.buildHash,
    sourceCommit: "bf8302c47ac85ce58b043c27280b11476ebbca80",
    buildHash: "1f2251b8efb6a789199b2d62e5f4f8a9be0701c2ff2099e1c68f32bcdc2fb7e5",
    rejectedJobIds: ["25544931-282f-45ac-b519-807180e1a8f9", "12fd5289-5233-48b4-93d1-a194b92d2c19"],
    ownerClientId: "original-owner-client",
    clientId: "registered-qualified-agent",
    ownerTokenBound: true,
    sdkRequestsSent: 0,
    historicalOutcome: "unknown",
    grantScopeChanged: false,
    gateClosed: true,
  };
  value.runtime = { sourceCommit: runtimeUpgrade.sourceCommit, buildHash: runtimeUpgrade.buildHash };
  value.runtimeUpgrade = runtimeUpgrade;
  return value;
}

function apiResult(operation, data) {
  switch (operation) {
    case "sketch.create": return { sketch: { ...SKETCH, name: data.name } };
    case "sketch.geometry": return { entities: [1, 2, 3, 4].map((i) =>
      ({ token: `edge-${i}`, kind: "SketchLine", name: `edge-${i}` })),
    refs: { [`${data.geometry[0].name}`]: [1, 2, 3, 4].map((i) =>
      ({ token: `edge-${i}`, kind: "SketchLine", name: `edge-${i}` })) } };
    case "sketch.inspect": return { sketch: { ...SKETCH, name: "NQABCDEF12_Section" },
      profiles: [{ ref: { ...PROFILE, sketch: { ...SKETCH, name: "NQABCDEF12_Section" } }, loops: 1 }] };
    case "model.extrude": return { feature: { token: "feature-token", kind: "feature", name: data.name },
      bodies: [{ ...BODY, name: data.name }], healthState: 0, message: "" };
    case "entity.inspect": return { ...BODY, isSolid: true,
      boundingBox: { min: [0, 0, 0], max: [1, 0.6, 0.4], units: "cm" } };
    case "measure.volume": return { value: 240, units: "mm3", dimension: "volume" };
    case "document.status": return { name: DOCUMENT.name, creationId: DOCUMENT.creationId,
      saved: false, modified: true, fileId: null };
    default: throw new Error(`Unexpected test operation ${operation}`);
  }
}

function fakeServices({ statusRows, resultFactory, onExecute, onResult } = {}) {
  const executions = [];
  const resultByJob = new Map();
  let jobCounter = 0;
  let statusCounter = 0;
  const services = {
    versions: { ...firstSmoke.CONTRACT_VERSIONS },
    async execute(invocation, options) {
      executions.push({ invocation, options });
      if (onExecute) return onExecute({ invocation, options, executions });
      const jobId = `smoke-job-${++jobCounter}`;
      const result = resultFactory ? resultFactory(invocation, options, jobId)
        : { version: 1, requestId: options.requestId, jobId, sequenceId: options.sequence?.id ||
            (options.sequence?.action === "begin" ? "exclusive-sequence" : null),
          sequenceState: options.sequence?.action === "end" ? "ended" : "held", state: "succeeded",
          result: { success: true, operation: invocation.operation, document: invocation.doc,
            result: apiResult(invocation.operation, invocation.data) } };
      resultByJob.set(jobId, result);
      return { version: 1, requestId: options.requestId, jobId,
        sequenceId: options.sequence?.id || (options.sequence?.action === "begin" ? "exclusive-sequence" : null),
        sequenceState: "active", state: "queued", result: null };
    },
    query: {
      validate(invocation) { return invocation; },
      catalog() { return firstSmoke.OPERATIONS.map((operation) => ({ operation })); },
      async status() {
        const index = statusCounter++;
        return statusRows ? statusRows(index) : {
          version: 1, build: firstSmoke.F708_RUNTIME.buildHash, blocked: index > 0, active: false,
          clientId: "registered-qualified-agent",
          isolatedScratch: { epochId: "actual-epoch-id", document: { ...DOCUMENT },
            admission: index > 0 ? "closed" : "qualified-fresh-scratch-only" },
        };
      },
      async result(jobId) {
        if (onResult) return onResult({ jobId, executions, resultByJob });
        const receipt = resultByJob.get(jobId);
        assert.ok(receipt, `unknown result job ${jobId}`);
        return receipt;
      },
      async request() { return null; },
    },
    async control() { throw new Error("First smoke must not cancel/reconcile unknown work"); },
    executions,
  };
  return services;
}

function requestIds() {
  return Object.fromEntries(firstSmoke.SEQUENCE_PHASES.map((phase) => [phase, `smoke-${phase}-request` ]));
}

function inputFor(root, overrides = {}) {
  return {
    confirmFirstSmoke: true,
    services: fakeServices(),
    authority: authority(),
    ownerCleanup: {
      clientId: "original-owner-client",
      async closeIsolatedScratch(request) {
        assert.deepEqual(request, { targetJobId: OWNER_JOBS.targetJobId,
          observationJobId: OWNER_JOBS.observationJobId, requestId: "smoke-owner-close-request",
          epochId: "actual-epoch-id", document: DOCUMENT });
        return { kind: "isolated-scratch-close", status: "complete",
          requestId: request.requestId, jobId: OWNER_JOBS.targetJobId,
          observationJobId: OWNER_JOBS.observationJobId, clientId: "original-owner-client",
          activation: { epochId: "actual-epoch-id", document: { ...DOCUMENT }, admission: "closed",
            historicalOutcome: "unknown" }, sdkRequestsSent: 1 };
      },
    },
    evidenceDir: root,
    runId: "f708-first-smoke-run-1",
    sessionId: "registered-agent-session",
    fixturePrefix: "NQABCDEF12",
    requestIds: requestIds(),
    cleanupRequestId: "smoke-owner-close-request",
    queueTimeoutMs: 30000,
    operationTimeoutMs: 1000,
    pollIntervalMs: 50,
    ...overrides,
  };
}

function privateDir() {
  return fs.mkdtempSync("/tmp/opencode/first-smoke-fake-");
}

function interruptedFirstSketchLedger(input, { jobId, sequenceId }) {
  const authorityValue = firstSmoke.validateAuthority(input.authority);
  const file = path.join(input.evidenceDir, `first-smoke-${crypto
    .createHash("sha256").update(`${input.runId}\0${authorityValue.epochId}`).digest("hex")}.json`);
  const ledger = {
    schemaVersion: 1,
    kind: "f708-isolated-first-smoke",
    runId: input.runId,
    clientId: authorityValue.clientId,
    epochId: authorityValue.epochId,
    document: authorityValue.document,
    authority: {
      sourceCommit: authorityValue.sourceCommit,
      buildHash: authorityValue.buildHash,
      factsRequestId: authorityValue.factsRequestId,
      ownerJobs: authorityValue.ownerJobs,
      creationReceipt: { requestId: input.authority.creation.requestId,
        epochId: authorityValue.epochId, jobId: input.authority.creation.jobId },
      grant: { clientId: authorityValue.clientId, epochId: authorityValue.epochId },
      ...(authorityValue.runtimeUpgrade ? { runtimeUpgrade: authorityValue.runtimeUpgrade } : {}),
    },
    state: "unknown",
    sequenceId,
    operations: firstSmoke.OPERATIONS,
    steps: [{
      phase: "sketchCreate", operation: "sketch.create",
      requestId: input.requestIds.sketchCreate, jobId, state: "dispatching", sequenceId,
      receipt: { version: 1, requestId: input.requestIds.sketchCreate, jobId, sequenceId,
        sequenceState: "active", state: "running", result: null },
      result: null, pythonChecks: [], output: { stdout: "", stderr: "" },
    }],
    currentPhase: "sketchCreate",
    lastError: "Same-job result recovery failed before terminal readback",
  };
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return file;
}

function successfulSketchReadback(input, { jobId, sequenceId }) {
  const receipt = {
    version: 1,
    requestId: input.requestIds.sketchCreate,
    jobId,
    sequenceId,
    sequenceState: "held",
    state: "succeeded",
    outcome: { version: 1, requestId: input.requestIds.sketchCreate, jobId,
      acceptance: "accepted", executionOutcome: "succeeded", mayHaveMutated: true,
      validation: { status: "not_checked", source: null, artifactId: null, measurements: {} },
      code: "EXECUTION_COMPLETE" },
    result: { success: true, operation: "sketch.create", document: DOCUMENT.name,
      result: { sketch: { ...SKETCH, name: `${input.fixturePrefix}_Section` } } },
  };
  return { requestReceipt: structuredClone(receipt), resultReceipt: structuredClone(receipt) };
}

function writePrivateJson(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function geometryContinuationScenario(root) {
  const input = inputFor(root);
  input.authority = upgradedAuthority();
  input.cleanupRequestId = "luna-first-smoke-7e71c93b-4710-4071-962f-b4d2610014cd-owner-close";
  const priorRunId = "luna-native-first-smoke-authorized-run";
  const originalRequestIds = requestIds();
  const continuationRunId = `${priorRunId}-after-idle-v1`;
  const oldGeometryRequestId = originalRequestIds.sketchGeometry;
  const newGeometryRequestId = `${oldGeometryRequestId}-after-idle-v1`;
  const existingSketchJobId = "existing-successful-sketch-job";
  const expiredSequenceId = "expired-held-sequence";
  const priorEvidenceDir = path.join(root, "prior-evidence");
  fs.mkdirSync(priorEvidenceDir, { mode: 0o700 });
  const priorSketch = { ...SKETCH, name: `${input.fixturePrefix}_Section` };
  const priorReadback = successfulSketchReadback(input, { jobId: existingSketchJobId, sequenceId: expiredSequenceId });
  priorReadback.requestReceipt.result.result.sketch = priorSketch;
  priorReadback.resultReceipt.result.result.sketch = priorSketch;
  const priorLedgerPath = path.join(priorEvidenceDir, "prior-ledger.json");
  const priorLedger = {
    schemaVersion: 1, kind: "f708-isolated-first-smoke", runId: priorRunId,
    clientId: input.authority.grant.clientId, epochId: "actual-epoch-id", document: { ...DOCUMENT },
    authority: {
      sourceCommit: input.authority.runtime.sourceCommit,
      buildHash: input.authority.runtime.buildHash,
      factsRequestId: input.authority.facts.key.requestId,
      ownerJobs: { ...OWNER_JOBS },
      creationReceipt: { requestId: input.authority.creation.requestId,
        epochId: "actual-epoch-id", jobId: input.authority.creation.jobId },
      grant: { clientId: input.authority.grant.clientId, epochId: "actual-epoch-id" },
      runtimeUpgrade: input.authority.runtimeUpgrade,
    },
    state: "unknown", sequenceId: expiredSequenceId, operations: firstSmoke.OPERATIONS,
    steps: [
      { phase: "sketchCreate", operation: "sketch.create", requestId: originalRequestIds.sketchCreate,
        jobId: existingSketchJobId, state: "succeeded", sequenceId: expiredSequenceId,
        receipt: priorReadback.resultReceipt },
      { phase: "sketchGeometry", operation: "sketch.geometry", requestId: oldGeometryRequestId,
        jobId: null, state: "dispatching" },
    ],
    currentPhase: "sketchGeometry",
    lastError: "No owned request receipt is visible; the operation was not resubmitted",
  };
  const priorLedgerSha256 = writePrivateJson(priorLedgerPath, priorLedger);

  const proofPath = path.join(root, "actual-step2-admission-proof-fixture.json");
  const proof = {
    version: 1, kind: "read-only-step2-admission-diagnosis", requestId: oldGeometryRequestId,
    clientId: input.authority.grant.clientId, sourceCommit: input.authority.runtime.sourceCommit,
    buildHash: input.authority.runtime.buildHash, epochId: "actual-epoch-id", document: { ...DOCUMENT },
    idleMs: 180000, leaseMs: 1800000, admissionDelayAfterSketchMs: 1070622,
    originalSketch: { jobId: existingSketchJobId, sequenceId: expiredSequenceId, state: "succeeded" },
    current: { jobCount: 3, lease: null, active: null, blocked: null },
    existingEvidence: [
      { path: `/home/kamil/.local/state/fmcad/queue/admissions/${"a".repeat(64)}`, sha256: "a".repeat(64) },
      { path: `/home/kamil/.local/state/fmcad/queue/accepted/${"e".repeat(64)}`, sha256: "e".repeat(64) },
    ],
    reproduction: { kind: "offline installed domain clone with retained payload; no live IPC", jobAllocated: false },
  };
  const proofSha256 = writePrivateJson(proofPath, proof);
  const genesisPlanPath = path.join(root, "genesis-plan.json");
  writePrivateJson(genesisPlanPath, { attempt: { runId: priorRunId, requestIds: originalRequestIds,
    evidenceDir: priorEvidenceDir } });
  const qualificationPath = path.join(root, "parity-qualification.json");
  writePrivateJson(qualificationPath, { kind: "sequence-admission-parity-qualification",
    tests: { passed: 3, failed: 0, physicalSendCalls: 0, installedPublicApiThroughIsolatedIpc: true },
    runtimeChanged: false, deploymentRequired: false });

  const continuationEvidenceDir = root;
  const continuedRequestIds = { ...originalRequestIds, sketchGeometry: newGeometryRequestId };
  const decisionPath = path.join(root, "sdk0-continuation-decision.json");
  const decision = {
    version: 1, kind: "explicit-existing-sketch-geometry-continuation", epochId: "actual-epoch-id",
    document: { ...DOCUMENT }, clientId: "registered-qualified-agent", operatorSessionId: input.sessionId,
    runtime: { sourceCommit: input.authority.runtime.sourceCommit, buildHash: input.authority.runtime.buildHash },
    genesisPlan: { path: genesisPlanPath, sha256: crypto.createHash("sha256").update(fs.readFileSync(genesisPlanPath)).digest("hex") },
    preAcceptanceProof: { path: proofPath, sha256: proofSha256 },
    parityQualification: { path: qualificationPath,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(qualificationPath)).digest("hex") },
    predecessorLedger: { path: priorLedgerPath, sha256: priorLedgerSha256, mustRemainUnchanged: true },
    consumedGeometryRequestId: oldGeometryRequestId,
    predecessorSketchJobId: existingSketchJobId, expiredSequenceId,
    classification: { geometryAccepted: false, geometrySdkDispatch: false,
      noSyntheticTerminalJobReceipt: true, lostOriginalExceptionBytesRecovered: false,
      deterministicReproducerCode: "SEQUENCE_MISMATCH" },
    continuation: { runId: continuationRunId, evidenceDir: continuationEvidenceDir,
      requestIds: { sketchGeometry: newGeometryRequestId, sketchInspect: originalRequestIds.sketchInspect,
        extrude: originalRequestIds.extrude, bodyInspect: originalRequestIds.bodyInspect,
        volume: originalRequestIds.volume },
      firstOperation: "sketch.geometry", firstSequence: { action: "begin", mode: "exclusive" },
      remainingSequence: "continue; end on volume", createSketchPermitted: false },
    cleanup: { ownerOnly: true, requestId: input.cleanupRequestId },
    runtimeDeploymentRequired: false, additionalGrantRequired: false, actualGeometryPass: false,
  };
  const decisionSha256 = writePrivateJson(decisionPath, decision);
  const priorSketchEvidencePath = path.join(root, "prior-sketch-readback.json");
  const priorSketchReadbackEvidence = {
    kind: "fresh-owned-predecessor-sketch-readback",
    identity: { clientId: "registered-qualified-agent", sessionId: input.sessionId },
    requestWasNull: false, request: { state: "succeeded" }, result: { state: "succeeded" },
  };
  const priorSketchEvidenceSha256 = writePrivateJson(priorSketchEvidencePath, priorSketchReadbackEvidence);
  const oldGeometryEvidencePath = path.join(root, "old-geometry-readback.json");
  const oldGeometryReadbackEvidence = {
    kind: "allowlisted-same-client-sketchGeometry-status-and-request-readback",
    identity: { clientId: "registered-qualified-agent", sessionId: input.sessionId },
    requestId: oldGeometryRequestId, requestWasNull: true, resultQueryPerformed: false,
  };
  const oldGeometryEvidenceSha256 = writePrivateJson(oldGeometryEvidencePath, oldGeometryReadbackEvidence);
  const priorFailureEvidence = {};
  for (const name of ["report", "sameRequestReadback", "sameRequestFollowup", "publicStatusReadback"]) {
    const file = path.join(root, `${name}.evidence`);
    priorFailureEvidence[name] = { path: file, sha256: writePrivateJson(file, { kind: `${name}-hashproof` }) };
  }
  input.runId = continuationRunId;
  input.requestIds = continuedRequestIds;
  input.continuation = {
    decisionPath, decisionSha256,
    priorSketchReadback: { clientId: "registered-qualified-agent", sessionId: input.sessionId,
      requestWasNull: false,
      evidencePath: priorSketchEvidencePath, evidenceSha256: priorSketchEvidenceSha256,
      requestReceipt: priorReadback.requestReceipt, resultReceipt: priorReadback.resultReceipt },
    oldGeometryReadback: { clientId: "registered-qualified-agent", sessionId: input.sessionId,
      requestId: oldGeometryRequestId, receipt: null, evidencePath: oldGeometryEvidencePath,
      evidenceSha256: oldGeometryEvidenceSha256 },
    priorFailureEvidence,
  };
  return { input, priorLedgerPath, priorLedgerSha256, oldGeometryRequestId, newGeometryRequestId,
    expiredSequenceId, priorSketch, proofSha256, decisionSha256 };
}

test("first-smoke code, operation list and handoff stay aligned with the f708 manifest", () => {
  assert.equal(manifest.firstSmoke.entrypoint, "tests/native/integrated-qualification/first_smoke.js");
  assert.equal(manifest.firstSmoke.executor, "tests/native/integrated-qualification/executor.js:executeFirstSmoke");
  assert.deepEqual(manifest.firstSmoke.operations, firstSmoke.OPERATIONS);
  assert.match(manifest.firstSmoke.retryPolicy, /No replay/);
});

test("runtime-upgrade authority preserves f708 genesis pins and accepts a concrete owner-bound receipt", () => {
  const legacy = firstSmoke.validateAuthority(authority());
  assert.equal(legacy.sourceCommit, firstSmoke.F708_RUNTIME.sourceCommit);
  assert.equal(legacy.buildHash, firstSmoke.F708_RUNTIME.buildHash);
  assert.equal(legacy.runtimeUpgrade, undefined);

  const upgraded = firstSmoke.validateAuthority(upgradedAuthority());
  assert.equal(firstSmoke.F708_RUNTIME.buildHash, "0abaea48090ed901ca842604b66d1bf79978f8939c77a1250899da37417b08d0");
  assert.equal(upgraded.sourceCommit, "bf8302c47ac85ce58b043c27280b11476ebbca80");
  assert.equal(upgraded.buildHash, "1f2251b8efb6a789199b2d62e5f4f8a9be0701c2ff2099e1c68f32bcdc2fb7e5");
  assert.equal(upgraded.runtimeUpgrade.previousBuildHash, firstSmoke.F708_RUNTIME.buildHash);
  assert.equal(upgraded.runtimeUpgrade.ownerTokenBound, true);
  assert.equal(upgraded.runtimeUpgrade.sdkRequestsSent, 0);
  assert.equal(upgraded.runtimeUpgrade.grantScopeChanged, false);
});

test("runtime-upgrade authority rejects mismatched source/build, epoch, rejected jobs or unsafe gate fields", () => {
  const invalid = [
    value => { value.runtimeUpgrade.epochId = "other-epoch"; },
    value => { value.runtimeUpgrade.document.creationId = "other-document"; },
    value => { value.runtimeUpgrade.previousBuildHash = "0".repeat(64); },
    value => { value.runtimeUpgrade.buildHash = "*"; value.runtime.buildHash = "*"; },
    value => { value.runtimeUpgrade.sourceCommit = "*"; value.runtime.sourceCommit = "*"; },
    value => { value.runtimeUpgrade.buildHash = "d".repeat(64); value.runtime.buildHash = "d".repeat(64); },
    value => { value.runtimeUpgrade.sourceCommit = "e".repeat(40); value.runtime.sourceCommit = "e".repeat(40); },
    value => { value.runtimeUpgrade.operationalQueueBudget = { idleMs: 180000, leaseMs: 1800000 }; },
    value => { value.runtimeUpgrade.rejectedJobIds.pop(); },
    value => { value.runtimeUpgrade.ownerClientId = "other-owner"; },
    value => { value.runtimeUpgrade.clientId = "other-client"; },
    value => { value.runtimeUpgrade.ownerTokenBound = false; },
    value => { value.runtimeUpgrade.sdkRequestsSent = 1; },
    value => { value.runtimeUpgrade.historicalOutcome = "succeeded"; },
    value => { value.runtimeUpgrade.grantScopeChanged = true; },
    value => { value.runtimeUpgrade.gateClosed = false; },
    value => { value.runtime.buildHash = "d".repeat(64); },
  ];
  for (const mutate of invalid) {
    const value = upgradedAuthority();
    mutate(value);
    assert.throws(() => firstSmoke.validateAuthority(value));
  }
});

test("upgraded public status requires the new source/build and exact same scratch before execute", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    const upgraded = upgradedAuthority();
    input.authority = upgraded;
    let executeCalls = 0;
    input.services = fakeServices({
      statusRows: () => ({ version: 1, build: firstSmoke.F708_RUNTIME.buildHash,
        sourceCommit: upgraded.runtime.sourceCommit, blocked: false, active: false,
        clientId: "registered-qualified-agent",
        isolatedScratch: { epochId: "actual-epoch-id", document: { ...DOCUMENT },
          admission: "qualified-fresh-scratch-only" } }),
      onExecute() { executeCalls += 1; },
    });
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "NOTRUN");
    assert.match(result.reason, /Public client\/epoch preflight failed/);
    assert.equal(executeCalls, 0);
    assert.equal(input.services.executions.length, 0);
    assert.equal(fs.readdirSync(root).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("new qualified source/build status passes the runtime-upgrade path using only the fake API", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    const upgraded = upgradedAuthority();
    input.authority = upgraded;
    input.services = fakeServices({ statusRows: index => ({
      version: 1, build: upgraded.runtime.buildHash, sourceCommit: upgraded.runtime.sourceCommit,
      blocked: index > 0, active: false, clientId: "registered-qualified-agent",
      isolatedScratch: { epochId: "actual-epoch-id", document: { ...DOCUMENT },
        admission: index > 0 ? "closed" : "qualified-fresh-scratch-only" },
    }) });
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "PASS");
    const ledger = JSON.parse(fs.readFileSync(result.ledger, "utf8"));
    assert.equal(ledger.authority.sourceCommit, upgraded.runtime.sourceCommit);
    assert.equal(ledger.authority.buildHash, upgraded.runtime.buildHash);
    assert.deepEqual(ledger.authority.runtimeUpgrade, upgraded.runtimeUpgrade);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): exact f708 client executes the bounded scratch smoke and owner-only close", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root, { expectedRevision: 12 });
    const services = input.services;
    services.start = async () => assert.fail("first-smoke entrypoint must not start the client");
    services.dispose = async () => assert.fail("first-smoke entrypoint must not dispose the client");
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "PASS");
    assert.equal(services.executions.length, 6);
    assert.deepEqual(services.executions.map((row) => row.invocation.operation), firstSmoke.OPERATIONS);
    assert.ok(services.executions.every(({ invocation }) => invocation.doc === DOCUMENT.name &&
      invocation.docId === DOCUMENT.creationId && invocation.docFileId === undefined &&
      invocation.projectId === undefined && invocation.kind === "cad" && invocation.version === 1));
    assert.deepEqual(services.executions.map(({ options }) => options.sequence.action),
      ["begin", "continue", "continue", "continue", "continue", "end"]);
    assert.equal(services.executions[0].options.sequence.mode, "exclusive");
    assert.ok(services.executions.slice(1).every(({ options }) => options.sequence.id === "exclusive-sequence"));
    assert.ok(services.executions.every(({ options }) => options.queueTimeoutMs === 30000));
    assert.equal(services.executions[0].options.expectedRevision, 12);
    assert.ok(services.executions.slice(1).every(({ options }) => options.expectedRevision === undefined));
    assert.equal(services.executions[0].invocation.data.plane, "XY");
    const geometry = services.executions[1];
    // The old CLI path normalized operation/data/doc/docId separately; the typed
    // public call keeps those same fields and moves request/sequence into options.
    assert.deepEqual(geometry.invocation, {
      version: 1,
      kind: "cad",
      operation: "sketch.geometry",
      data: {
        sketch: { ...SKETCH, name: "NQABCDEF12_Section" },
        inferencePolicy: "explicit",
        geometry: [{ type: "rectangle", name: "NQABCDEF12_Rectangle",
          start: ["0 mm", "0 mm", "0 mm"], end: ["10 mm", "6 mm", "0 mm"] }],
      },
      doc: DOCUMENT.name,
      docId: DOCUMENT.creationId,
      purpose: "qualified first-smoke epoch actual-epoch-id: sketchGeometry",
    });
    assert.deepEqual(geometry.options, {
      requestId: "smoke-sketchGeometry-request",
      sessionId: "registered-agent-session",
      sequence: { action: "continue", id: "exclusive-sequence" },
      queueTimeoutMs: 30000,
    });
    assert.equal(services.executions[3].invocation.data.profile.index, 0);
    assert.equal(services.executions[3].invocation.data.distance, "4 mm");
    assert.deepEqual(result.geometry.volume, { value: 240, units: "mm3" });
    assert.deepEqual(result.geometry.bounds.spans, [1, 0.6, 0.4]);
    assert.equal(result.cleanup.admission, "closed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): pending result reads keep one request and never resubmit", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    let volumeReads = 0;
    input.services = fakeServices({ onResult({ jobId, resultByJob, executions }) {
      const terminal = resultByJob.get(jobId);
      if (executions.length === 6 && ++volumeReads === 1) {
        return { ...terminal, state: "running", result: null };
      }
      return terminal;
    } });
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "PASS");
    assert.equal(input.services.executions.length, 6);
    assert.equal(volumeReads, 2);
    assert.equal(input.services.executions.filter((row) => row.options.requestId === "smoke-volume-request").length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): terminal submit receipt reads its result by the same job ID", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    const services = input.services;
    const execute = services.execute.bind(services);
    let first = true;
    const resultReads = [];
    const result = services.query.result.bind(services.query);
    services.execute = async (invocation, options) => {
      const accepted = await execute(invocation, options);
      if (first) { first = false; return { ...accepted, state: "succeeded", result: null }; }
      return accepted;
    };
    services.query.result = async (jobId) => { resultReads.push(jobId); return result(jobId); };
    const report = await executeFirstSmoke(input);
    assert.equal(report.status, "PASS");
    assert.equal(services.executions.length, 6);
    assert.equal(resultReads.length, 6);
    assert.equal(resultReads[0], "smoke-job-1");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): transient same-job result-read fence waits, then binds the same receipt without replay", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    let failedRead = false;
    let failedReadAt = null, succeededReadAt = null, resultReadCount = 0;
    input.services = fakeServices({ onResult({ jobId, resultByJob }) {
      resultReadCount += 1;
      if (jobId === "smoke-job-1" && !failedRead) {
        failedRead = true;
        failedReadAt = Date.now();
        throw Object.assign(new Error("Invalid epoch directory selection or changed historical lineage"), {
          code: "EPOCH_PROOF_INVALID",
        });
      }
      if (jobId === "smoke-job-1" && succeededReadAt === null) succeededReadAt = Date.now();
      return resultByJob.get(jobId);
    } });
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "PASS");
    assert.equal(input.services.executions.length, 6);
    assert.equal(failedRead, true);
    assert.ok(succeededReadAt - failedReadAt >= input.pollIntervalMs - 5,
      "the same-job retry must wait rather than hit the same short pending-marker window");
    assert.equal(resultReadCount, 7);
    const ledger = JSON.parse(fs.readFileSync(result.ledger, "utf8"));
    assert.deepEqual(ledger.steps[0].sameJobReadErrorProof, {
      attempts: 1,
      firstError: { name: "Error", code: "EPOCH_PROOF_INVALID",
        messageSha256: crypto.createHash("sha256")
          .update("Invalid epoch directory selection or changed historical lineage").digest("hex") },
      lastError: { name: "Error", code: "EPOCH_PROOF_INVALID",
        messageSha256: crypto.createHash("sha256")
          .update("Invalid epoch directory selection or changed historical lineage").digest("hex") },
    });
    assert.equal(JSON.stringify(ledger).includes("Invalid epoch directory selection"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): persistent same-job read fence halts at deadline with redacted primary proof", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root, { operationTimeoutMs: 180, pollIntervalMs: 50 });
    let executeCalls = 0, resultReads = 0, cleanupCalls = 0;
    const primary = "Invalid epoch directory selection or changed historical lineage";
    input.services = fakeServices({ onExecute({ invocation, options, executions }) {
      executeCalls += 1;
      const jobId = "persistent-fenced-job";
      const sequenceId = options.sequence?.action === "begin" ? "exclusive-sequence" : options.sequence?.id;
      return { version: 1, requestId: options.requestId, jobId, sequenceId,
        sequenceState: "active", state: "running", result: null };
    } });
    input.services.query.result = async (jobId) => {
      resultReads += 1;
      assert.equal(jobId, "persistent-fenced-job");
      throw Object.assign(new Error(primary), { code: "EPOCH_PROOF_INVALID" });
    };
    input.ownerCleanup.closeIsolatedScratch = async () => { cleanupCalls += 1; throw new Error("must not close unknown work"); };

    const result = await executeFirstSmoke(input);

    assert.equal(result.status, "NOTRUN");
    assert.equal(result.executionStatus, "unknown");
    assert.equal(result.phase, "sketchCreate");
    assert.equal(result.jobId, "persistent-fenced-job");
    assert.equal(executeCalls, 1);
    assert.ok(resultReads >= 2);
    assert.equal(cleanupCalls, 0);
    assert.deepEqual(result.readErrorProof, {
      attempts: resultReads,
      firstError: { name: "Error", code: "EPOCH_PROOF_INVALID",
        messageSha256: crypto.createHash("sha256").update(primary).digest("hex") },
      lastError: { name: "Error", code: "EPOCH_PROOF_INVALID",
        messageSha256: crypto.createHash("sha256").update(primary).digest("hex") },
    });
    assert.equal("message" in result.readErrorProof.firstError, false);
    const ledger = JSON.parse(fs.readFileSync(result.ledger, "utf8"));
    assert.equal(ledger.state, "unknown");
    assert.equal(ledger.currentPhase, "sketchCreate");
    assert.equal(ledger.steps[0].jobId, "persistent-fenced-job");
    assert.equal(ledger.steps[0].state, "unknown");
    assert.deepEqual(ledger.lastSameJobReadErrorProof, result.readErrorProof);
    assert.equal(ledger.lastError, "Terminal result did not stabilize within its bounded read window; no later operations or cleanup were sent");
    assert.equal(JSON.stringify(ledger).includes(primary), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): lost execute ACK queries the same request once, blocks replay and skips cleanup", async () => {
  const root = privateDir();
  try {
    let executeCalls = 0;
    let requestReads = 0;
    let cleanupCalls = 0;
    const input = inputFor(root);
    input.services = fakeServices({ onExecute() { executeCalls += 1; throw new Error("lost ACK"); } });
    input.services.query.request = async (requestId) => {
      requestReads += 1;
      assert.equal(requestId, "smoke-sketchCreate-request");
      return null;
    };
    input.ownerCleanup.closeIsolatedScratch = async () => { cleanupCalls += 1; throw new Error("must not run"); };
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "NOTRUN");
    assert.equal(executeCalls, 1);
    assert.equal(requestReads, 1);
    assert.equal(cleanupCalls, 0);
    assert.deepEqual(result.executeError, {
      name: "Error", code: null,
      messageSha256: crypto.createHash("sha256").update("lost ACK").digest("hex"),
    });
    assert.equal("message" in result.executeError, false);
    const repeated = await executeFirstSmoke(input);
    assert.equal(repeated.reconciliationRequired, true);
    assert.equal(executeCalls, 1);
    assert.equal(requestReads, 1);
    const ledger = JSON.parse(fs.readFileSync(result.ledger, "utf8"));
    assert.deepEqual(ledger.lastExecuteError, result.executeError);
    assert.deepEqual(ledger.lastRequestLookup, {
      requestId: "smoke-sketchCreate-request", result: "not_found",
    });
    assert.match(ledger.lastError, /No owned request receipt/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): same-request terminal receipt recovers a lost ACK without execute replay", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    const services = input.services;
    const execute = services.execute.bind(services);
    let first = true;
    let executeAttempts = 0;
    let requestReads = 0;
    services.execute = async (invocation, options) => {
      executeAttempts += 1;
      if (first) { first = false; throw new Error("lost execute ACK after admission"); }
      return execute(invocation, options);
    };
    services.query.request = async (requestId) => {
      requestReads += 1;
      assert.equal(requestId, "smoke-sketchCreate-request");
      return { version: 1, requestId, jobId: "recovered-create-job", sequenceId: "recovered-sequence",
        sequenceState: "held", state: "succeeded",
        result: { success: true, operation: "sketch.create", document: DOCUMENT.name,
          result: { sketch: { ...SKETCH, name: "NQABCDEF12_Section" } } } };
    };
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "PASS");
    assert.equal(requestReads, 1);
    assert.equal(executeAttempts, 6);
    assert.equal(services.executions.length, 5);
    assert.equal(services.executions[0].options.requestId, "smoke-sketchGeometry-request");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): terminal same-job recovery continues the existing sequence without replaying sketch.create", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    input.authority = upgradedAuthority();
    const jobId = "recovered-terminal-sketch-job";
    const sequenceId = "recovered-held-exclusive-sequence";
    const ledgerPath = interruptedFirstSketchLedger(input, { jobId, sequenceId });
    const recovery = successfulSketchReadback(input, { jobId, sequenceId });
    input.recovery = recovery;
    const services = fakeServices({ statusRows: index => ({
      version: 1, build: input.authority.runtime.buildHash, sourceCommit: input.authority.runtime.sourceCommit,
      blocked: index > 0, active: false, clientId: "registered-qualified-agent",
      isolatedScratch: { epochId: "actual-epoch-id", document: { ...DOCUMENT },
        admission: index > 0 ? "closed" : "qualified-fresh-scratch-only" },
    }) });
    input.services = services;

    const result = await executeFirstSmoke(input);

    assert.equal(result.status, "PASS");
    assert.equal(services.executions.length, 5);
    assert.deepEqual(services.executions.map(row => row.invocation.operation), [
      "sketch.geometry", "sketch.inspect", "model.extrude", "entity.inspect", "measure.volume",
    ]);
    assert.deepEqual(services.executions.map(row => row.options.requestId), [
      input.requestIds.sketchGeometry, input.requestIds.sketchInspect, input.requestIds.extrude,
      input.requestIds.bodyInspect, input.requestIds.volume,
    ]);
    assert.ok(services.executions.every(row => row.options.sequence?.id === sequenceId));
    assert.equal(services.executions.at(-1).options.sequence.action, "end");
    assert.equal(result.ledger, ledgerPath);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    assert.equal(ledger.status, "PASS");
    assert.equal(ledger.steps.length, 6);
    assert.equal(ledger.steps[0].state, "succeeded");
    assert.equal(ledger.steps[0].receipt.jobId, jobId);
    assert.equal(ledger.steps[0].receipt.sequenceState, "held");
    assert.equal(ledger.recovery.kind, "terminal-same-job-readback-before-continuation");
    assert.deepEqual(ledger.recovery.requestReceipt, recovery.requestReceipt);
    assert.deepEqual(ledger.recovery.resultReceipt, recovery.resultReceipt);
    assert.equal(ledger.steps.at(-1).receipt.sequenceState, "ended");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): mismatched same-job recovery is rejected without ledger change or execute", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    const jobId = "recovered-terminal-sketch-job";
    const sequenceId = "recovered-held-exclusive-sequence";
    const ledgerPath = interruptedFirstSketchLedger(input, { jobId, sequenceId });
    const before = fs.readFileSync(ledgerPath);
    const recovery = successfulSketchReadback(input, { jobId, sequenceId });
    recovery.resultReceipt.jobId = "different-job";
    input.recovery = recovery;
    const result = await executeFirstSmoke(input);

    assert.equal(result.status, "NOTRUN");
    assert.match(result.reason, /Same-job recovery was not accepted/);
    assert.equal(input.services.executions.length, 0);
    assert.deepEqual(fs.readFileSync(ledgerPath), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): SDK0 expired-lease continuation begins at geometry on the existing sketch", async () => {
  const root = privateDir();
  try {
    const scenario = geometryContinuationScenario(root);
    const input = scenario.input;
    const services = fakeServices({ statusRows: index => ({
      version: 1, build: input.authority.runtime.buildHash, sourceCommit: input.authority.runtime.sourceCommit,
      blocked: index > 0, active: false, clientId: input.authority.grant.clientId,
      isolatedScratch: { epochId: "actual-epoch-id", document: { ...DOCUMENT },
        admission: index > 0 ? "closed" : "qualified-fresh-scratch-only" },
    }) });
    input.services = services;
    const execute = services.execute.bind(services);
    const resultRead = services.query.result.bind(services.query);
    let geometryJobId = null, geometryReadFailed = false, geometryReadFailureAt = null, geometryReadSuccessAt = null;
    services.execute = async (invocation, options) => {
      const receipt = await execute(invocation, options);
      if (invocation.operation === "sketch.geometry") geometryJobId = receipt.jobId;
      return receipt;
    };
    services.query.result = async jobId => {
      if (jobId === geometryJobId && !geometryReadFailed) {
        geometryReadFailed = true;
        geometryReadFailureAt = Date.now();
        throw Object.assign(new Error("Invalid epoch directory selection or changed historical lineage"), {
          code: "EPOCH_PROOF_INVALID",
        });
      }
      const receipt = await resultRead(jobId);
      if (jobId === geometryJobId && geometryReadSuccessAt === null) geometryReadSuccessAt = Date.now();
      return receipt;
    };
    let cleanupCalls = 0;
    input.ownerCleanup.closeIsolatedScratch = async request => {
      cleanupCalls += 1;
      assert.deepEqual(request, { targetJobId: OWNER_JOBS.targetJobId,
        observationJobId: OWNER_JOBS.observationJobId, requestId: input.cleanupRequestId,
        epochId: "actual-epoch-id", document: DOCUMENT });
      assert.equal(services.executions.at(-1).invocation.operation, "measure.volume");
      assert.equal(services.executions.at(-1).options.sequence.action, "end");
      return { kind: "isolated-scratch-close", status: "complete", requestId: request.requestId,
        jobId: OWNER_JOBS.targetJobId, observationJobId: OWNER_JOBS.observationJobId,
        clientId: "original-owner-client", sdkRequestsSent: 1,
        activation: { epochId: "actual-epoch-id", document: { ...DOCUMENT }, admission: "closed",
          historicalOutcome: "unknown" } };
    };
    const priorBytes = fs.readFileSync(scenario.priorLedgerPath);
    const priorLedgerSha256 = crypto.createHash("sha256").update(priorBytes).digest("hex");

    const result = await executeFirstSmoke(input);

    assert.equal(result.status, "PASS");
    assert.equal(services.executions.length, 5);
    assert.equal(geometryReadFailed, true);
    assert.ok(geometryReadSuccessAt - geometryReadFailureAt >= input.pollIntervalMs - 5);
    assert.deepEqual(services.executions.map(row => row.invocation.operation), [
      "sketch.geometry", "sketch.inspect", "model.extrude", "entity.inspect", "measure.volume",
    ]);
    assert.equal(services.executions.some(row => row.invocation.operation === "sketch.create"), false);
    const [geometry, inspect, extrude, bodyInspect, volume] = services.executions;
    assert.equal(geometry.options.requestId, scenario.newGeometryRequestId);
    assert.equal(geometry.options.sequence.action, "begin");
    assert.equal(geometry.options.sequence.mode, "exclusive");
    assert.equal(geometry.invocation.data.sketch.token, scenario.priorSketch.token);
    const newSequenceId = "exclusive-sequence";
    assert.notEqual(newSequenceId, scenario.expiredSequenceId);
    assert.equal(geometry.options.requestId, `${scenario.oldGeometryRequestId}-after-idle-v1`);
    assert.deepEqual(inspect.options.sequence, { action: "continue", id: newSequenceId });
    assert.deepEqual(extrude.options.sequence, { action: "continue", id: newSequenceId });
    assert.deepEqual(bodyInspect.options.sequence, { action: "continue", id: newSequenceId });
    assert.deepEqual(volume.options.sequence, { action: "end", id: newSequenceId });
    assert.deepEqual(services.executions.slice(1).map(row => row.options.requestId), [
      input.requestIds.sketchInspect, input.requestIds.extrude,
      input.requestIds.bodyInspect, input.requestIds.volume,
    ]);
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(result.geometry.volume, { value: 240, units: "mm3" });
    assert.equal(result.cleanup.admission, "closed");

    const ledgerPath = result.ledger;
    assert.notEqual(ledgerPath, scenario.priorLedgerPath);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    assert.equal(ledger.kind, "f708-isolated-first-smoke-continuation");
    assert.equal(ledger.status, "PASS");
    assert.equal(ledger.steps.length, 6);
    assert.equal(ledger.steps[0].phase, "sketchCreate");
    assert.equal(ledger.steps[0].state, "succeeded");
    assert.equal(ledger.steps[0].sequenceId, scenario.expiredSequenceId);
    assert.equal(ledger.steps[0].tokenSha256,
      crypto.createHash("sha256").update(scenario.priorSketch.token).digest("hex"));
    assert.equal(ledger.steps[1].phase, "sketchGeometry");
    assert.equal(ledger.steps[1].requestId, scenario.newGeometryRequestId);
    assert.equal(ledger.steps[1].sequenceId, newSequenceId);
    assert.equal(ledger.steps[1].sameJobReadErrorProof.attempts, 1);
    assert.equal(ledger.steps[1].sameJobReadErrorProof.firstError.code, "EPOCH_PROOF_INVALID");
    assert.equal(ledger.steps[1].sameJobReadErrorProof.firstError.messageSha256,
      crypto.createHash("sha256").update("Invalid epoch directory selection or changed historical lineage").digest("hex"));
    assert.equal(ledger.steps.at(-1).receipt.sequenceState, "ended");
    assert.equal(ledger.continuation.newSketchCreated, false);
    assert.equal(ledger.continuation.consumedGeometryRequestId, scenario.oldGeometryRequestId);
    assert.equal(ledger.continuation.newGeometryRequestId, scenario.newGeometryRequestId);
    assert.equal(ledger.continuation.proofSha256, scenario.proofSha256);
    assert.equal(ledger.continuation.decisionSha256, scenario.decisionSha256);
    assert.equal(ledger.steps[0].receipt, undefined);
    assert.equal(fs.readFileSync(scenario.priorLedgerPath).equals(priorBytes), true);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(scenario.priorLedgerPath)).digest("hex"),
      priorLedgerSha256);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): geometry continuation rejects the consumed old request ID before any execute", async () => {
  const root = privateDir();
  try {
    const scenario = geometryContinuationScenario(root);
    scenario.input.requestIds.sketchGeometry = scenario.oldGeometryRequestId;
    const priorBytes = fs.readFileSync(scenario.priorLedgerPath);
    await assert.rejects(executeFirstSmoke(scenario.input), /new geometry ID|geometry re-begin/);
    assert.equal(scenario.input.services.executions.length, 0);
    assert.deepEqual(fs.readFileSync(scenario.priorLedgerPath), priorBytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): preparing begin polls the same job until its sequence ID is assigned", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    const services = fakeServices();
    const execute = services.execute.bind(services);
    const result = services.query.result.bind(services.query);
    let beginJobId = null, beginResultReads = 0;
    services.execute = async (invocation, options) => {
      const accepted = await execute(invocation, options);
      if (options.sequence?.action !== "begin") return accepted;
      beginJobId = accepted.jobId;
      return { ...accepted, state: "preparing", sequenceId: null, sequenceState: null, result: null };
    };
    services.query.result = async (jobId) => {
      const receipt = await result(jobId);
      if (jobId !== beginJobId) return receipt;
      beginResultReads += 1;
      if (beginResultReads === 1) {
        return { ...receipt, state: "running", sequenceId: "assigned-exclusive-sequence",
          sequenceState: "active", result: null };
      }
      return { ...receipt, sequenceId: "assigned-exclusive-sequence" };
    };
    input.services = services;
    const resultReport = await executeFirstSmoke(input);
    assert.equal(resultReport.status, "PASS");
    assert.equal(beginResultReads, 2);
    assert.equal(services.executions.length, 6);
    const ledger = JSON.parse(fs.readFileSync(resultReport.ledger, "utf8"));
    assert.equal(ledger.sequenceId, "assigned-exclusive-sequence");
    assert.equal(ledger.steps[0].jobId, beginJobId);
    assert.equal(ledger.steps.every(step => step.sequenceId === "assigned-exclusive-sequence"), true);
    assert.equal(ledger.steps.at(-1).receipt.sequenceState, "ended");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): terminal checker rejection without sequence is durably failed", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    let resultReads = 0, requestReads = 0, cleanupCalls = 0;
    const acknowledgement = { version: 1, requestId: "smoke-sketchCreate-request", jobId: "checker-failed-job",
      sequenceId: null, sequenceState: null, state: "preparing",
      outcome: { version: 1, requestId: "smoke-sketchCreate-request", jobId: "checker-failed-job",
        acceptance: "accepted", executionOutcome: "not_started", mayHaveMutated: false,
        code: "PYTHON_CHECK_REJECTED" }, result: null };
    input.services = fakeServices({ onExecute({ invocation }) {
      assert.equal(invocation.operation, "sketch.create");
      return acknowledgement;
    } });
    input.services.query.result = async (jobId) => {
      resultReads += 1;
      assert.equal(jobId, "checker-failed-job");
      return { ...acknowledgement, state: "failed", pythonChecks: [{ status: "tool_error",
        reasons: ["Aggregate checker completed 1 of 5 required analyses"] }] };
    };
    input.services.query.request = async () => {
      requestReads += 1;
      throw new Error("must use same-job query.result for sequence assignment");
    };
    input.ownerCleanup.closeIsolatedScratch = async () => { cleanupCalls += 1; throw new Error("must not close on failed smoke"); };
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "FAIL");
    assert.equal(result.executionStatus, "failed");
    assert.equal(result.jobId, "checker-failed-job");
    assert.equal(result.receipt.outcome.code, "PYTHON_CHECK_REJECTED");
    assert.equal(result.receipt.outcome.executionOutcome, "not_started");
    assert.equal(result.receipt.outcome.mayHaveMutated, false);
    assert.equal(resultReads, 1);
    assert.equal(requestReads, 0);
    assert.equal(input.services.executions.length, 1);
    assert.equal(cleanupCalls, 0);
    const ledger = JSON.parse(fs.readFileSync(result.ledger, "utf8"));
    assert.equal(ledger.state, "failed");
    assert.equal(ledger.steps[0].jobId, "checker-failed-job");
    assert.equal(ledger.steps[0].state, "failed");
    assert.equal(ledger.steps[0].receipt.pythonChecks[0].status, "tool_error");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): needs-reconciliation without sequence halts as NOTRUN", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    let resultReads = 0, requestReads = 0, cleanupCalls = 0;
    input.services = fakeServices({ onExecute({ options }) {
      return { version: 1, requestId: options.requestId, jobId: "sequence-unknown-job",
        sequenceId: null, sequenceState: null, state: "preparing", result: null };
    } });
    input.services.query.result = async (jobId) => {
      resultReads += 1;
      assert.equal(jobId, "sequence-unknown-job");
      return { version: 1, requestId: "smoke-sketchCreate-request", jobId, sequenceId: null,
        sequenceState: "needs_reconciliation", state: "needs_reconciliation", result: null };
    };
    input.services.query.request = async () => { requestReads += 1; throw new Error("must read same job result"); };
    input.ownerCleanup.closeIsolatedScratch = async () => { cleanupCalls += 1; throw new Error("must not close unknown work"); };
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "NOTRUN");
    assert.equal(result.executionStatus, "unknown");
    assert.equal(result.requestId, "smoke-sketchCreate-request");
    assert.equal(result.jobId, "sequence-unknown-job");
    assert.equal(resultReads, 1);
    assert.equal(requestReads, 0);
    assert.equal(input.services.executions.length, 1);
    assert.equal(cleanupCalls, 0);
    const ledger = JSON.parse(fs.readFileSync(result.ledger, "utf8"));
    assert.equal(ledger.state, "unknown");
    assert.equal(ledger.steps[0].jobId, "sequence-unknown-job");
    assert.equal(ledger.steps[0].state, "unknown");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): current client/epoch mismatch gates before any execute", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    let executeCalls = 0;
    input.services = fakeServices({ statusRows: () => ({ version: 1, build: firstSmoke.F708_RUNTIME.buildHash,
      blocked: false, active: false, clientId: "foreign-client",
      isolatedScratch: { epochId: "wrong-epoch", document: { ...DOCUMENT },
        admission: "qualified-fresh-scratch-only" } }), onExecute() { executeCalls += 1; } });
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "NOTRUN");
    assert.equal(executeCalls, 0);
    assert.equal(fs.readdirSync(root).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FAKE API (offline): unknown terminal operation and uncertain owner close never advance", async () => {
  const root = privateDir();
  try {
    const input = inputFor(root);
    let closeCalls = 0;
    input.services = fakeServices({ resultFactory: (invocation, options, jobId) => ({
      version: 1, requestId: options.requestId, jobId,
      sequenceId: options.sequence?.id || (options.sequence?.action === "begin" ? "exclusive-sequence" : null),
      sequenceState: "needs_reconciliation", state: "needs_reconciliation", result: null,
    }) });
    input.ownerCleanup.closeIsolatedScratch = async () => { closeCalls += 1; return { status: "unknown" }; };
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "NOTRUN");
    assert.equal(closeCalls, 0);
    assert.equal(input.services.executions.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  const cleanupRoot = privateDir();
  try {
    const input = inputFor(cleanupRoot);
    let closeCalls = 0;
    input.ownerCleanup.closeIsolatedScratch = async () => { closeCalls += 1; return { status: "unknown" }; };
    const result = await executeFirstSmoke(input);
    assert.equal(result.status, "NOTRUN");
    assert.equal(closeCalls, 1);
    const repeated = await executeFirstSmoke(input);
    assert.equal(repeated.reconciliationRequired, true);
    assert.equal(closeCalls, 1);
  } finally { fs.rmSync(cleanupRoot, { recursive: true, force: true }); }
});
test('FAKE PORT: smoke accepts the historical and live native SketchLine envelope, not an invented line alias', async (t) => {
  const root = privateDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const services = fakeServices({ resultFactory(invocation, options, jobId) {
    const payload = apiResult(invocation.operation, invocation.data);
    if (invocation.operation === 'sketch.geometry') {
      payload.schemaVersion = 1;
      payload.status = 'pass';
      payload.units = { length: 'cm', angle: 'rad' };
      payload.entities = payload.entities.map(ref => ({ ...ref, kind: 'SketchLine' }));
      for (const key of Object.keys(payload.refs)) payload.refs[key] = payload.refs[key].map(ref => ({ ...ref, kind: 'SketchLine' }));
    }
    return { version: 1, requestId: options.requestId, jobId,
      sequenceId: options.sequence?.id || 'exclusive-sequence',
      sequenceState: options.sequence?.action === 'end' ? 'ended' : 'held', state: 'succeeded',
      result: { success: true, operation: invocation.operation, document: invocation.doc, result: payload } };
  } });
  const result = await executeFirstSmoke(inputFor(root, { services }));
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(services.executions.length, 6);
});

for (const [name, mutate] of [
  ['invented line alias', refs => { refs[0].kind = 'line'; }],
  ['different native curve type', refs => { refs[0].kind = 'SketchCircle'; }],
  ['missing native token', refs => { delete refs[0].token; }],
  ['three rectangle edges', refs => { refs.pop(); }],
]) test('FAKE PORT: smoke rejects ' + name + ' without another mutation or cleanup', async (t) => {
  const root = privateDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const services = fakeServices({ onResult({ jobId, resultByJob }) {
    const value = structuredClone(resultByJob.get(jobId));
    if (value.result.operation === 'sketch.geometry') {
      const label = Object.keys(value.result.result.refs)[0];
      mutate(value.result.result.refs[label]);
    }
    return value;
  } });
  let cleanupCalls = 0;
  const result = await executeFirstSmoke(inputFor(root, { services, ownerCleanup: {
    clientId: 'original-owner-client',
    async closeIsolatedScratch() { cleanupCalls++; throw new Error('Invalid native geometry must not be cleaned up automatically'); },
  } }));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.phase, 'sketchGeometry');
  assert.deepEqual(services.executions.map(row => row.invocation.operation), ['sketch.create', 'sketch.geometry']);
  assert.equal(cleanupCalls, 0);
});

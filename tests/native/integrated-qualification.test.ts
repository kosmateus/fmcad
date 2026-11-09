import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRequire } from "node:module";
import { qualificationRepository } from "../fixtures/qualification-repository";
import type {
  QualificationManifest,
  QualificationRunner,
  QualificationExecutor,
  DeferredAdapters,
  QualificationPort,
  RunScriptRequest,
  RunScriptResult,
  PortCalls,
} from "./qualification-test-contracts";
const sourceDirectory = path.join(process.cwd(), "tests/native");
const load = createRequire(
  path.join(sourceDirectory, "integrated-qualification.test.ts"),
);
const { classifyFeature, gateReadiness } = load(
  "./integrated-qualification/runner",
) as QualificationRunner;
const {
  createPrivateWorkspace,
  parseDocumentList,
  queueIsClear,
  queueJob,
  releasedGateMatches,
  runNativeSweep,
  validateBrokerStateHome,
  validateExplicitConfig,
} = load("./integrated-qualification/executor") as QualificationExecutor;
const deferredAdapters = load(
  "./integrated-qualification/deferred_adapters",
) as DeferredAdapters;
const manifest: QualificationManifest = JSON.parse(
  fs.readFileSync(
    path.join(sourceDirectory, "integrated-qualification/manifest.json"),
    "utf8",
  ),
);

test("OFFLINE synthetic Git candidate records exact ancestry and leaves all native cases NOTRUN", (t) => {
  const fixture = qualificationRepository(t);
  const report = (load(fixture.runner) as QualificationRunner).buildReport();
  assert.equal(report.candidate.base, fixture.base);
  assert.equal(report.features.length, 11);
  assert.equal(report.fusionSessions, 1);
  assert.equal(report.nativeQualification, "NOTRUN");
  assert.ok(report.features.every((feature) => feature.status === "NOTRUN"));
  assert.ok(
    report.candidate.sourceBlobs.some(
      (row) => row.equivalentCommit === fixture.base,
    ),
  );
});

test("unknown broker outcomes stay NOTRUN and require reconciliation", () => {
  const feature = {
    id: "sample",
    ticket: "fmcad-sample",
    requiredCases: ["positive"],
  };
  const result = classifyFeature(
    feature,
    {
      featureId: "sample",
      candidateCommit: "candidate-sha",
      integrationRunId: "native-run-test",
      fusionSessionId: "fusion-session-test",
      fusionBuild: "2706.1.14",
      document: { name: "owned-scratch", creationId: "creation-id" },
      jobs: [
        {
          requestId: "request",
          jobId: "job",
          docId: "creation-id",
          status: "needs_reconciliation",
        },
      ],
    },
    {
      gateReady: true,
      workingTreeClean: true,
      candidateCommit: "candidate-sha",
      integrationRunId: "native-run-test",
      fusionSessionId: "fusion-session-test",
      fusionBuild: "2706.1.14",
    },
  );
  assert.equal(result.status, "NOTRUN");
  assert.equal(result.requiresReconciliation, true);
});

test("gate receipt must reconcile both held jobs and prove fresh contract-qualified runtime", (t) => {
  const evidenceDir = fs.mkdtempSync(
    "/tmp/opencode/native-qualification-gate-test-",
  );
  t.after(() => fs.rmSync(evidenceDir, { recursive: true, force: true }));
  const gate = {
    status: "released",
    observedAt: new Date().toISOString(),
    recovery: {
      ownerConfirmed: true,
      resolvedJobIds: [...manifest.hold.jobs],
    },
    integrationRunId: "native-run-test",
    fusionSessionId: "fusion-session-test",
    queue: {
      fresh: true,
      paused: false,
      held: false,
      stopping: false,
      state: "RUNNING",
      active: null,
      blocked: null,
      lease: null,
      unresolved: false,
      activeOperations: 0,
      nonterminalJobCount: 0,
    },
    runtime: {
      contractQualified: true,
      fusionBuild: "2706.1.14",
      buildHash: "qualified-build",
      sourceCommit: "candidate-sha",
    },
  };
  fs.writeFileSync(path.join(evidenceDir, "gate.json"), JSON.stringify(gate), {
    flag: "wx",
  });
  assert.equal(
    gateReadiness(evidenceDir, manifest, "candidate-sha").ready,
    true,
  );
  gate.observedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(evidenceDir, "gate.json"), JSON.stringify(gate));
  assert.equal(
    gateReadiness(evidenceDir, manifest, "candidate-sha").ready,
    false,
  );
  gate.observedAt = new Date().toISOString();
  gate.recovery.resolvedJobIds.pop();
  fs.writeFileSync(path.join(evidenceDir, "gate.json"), JSON.stringify(gate));
  assert.equal(
    gateReadiness(evidenceDir, manifest, "candidate-sha").ready,
    false,
  );
});

test("case failure and incomplete restore can never become a feature PASS", (t) => {
  const evidenceDir = fs.mkdtempSync(
    "/tmp/opencode/native-qualification-test-",
  );
  t.after(() => fs.rmSync(evidenceDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(evidenceDir, "result.json"),
    "verified evidence\n",
    { flag: "wx" },
  );
  fs.writeFileSync(
    path.join(evidenceDir, "restore.json"),
    JSON.stringify({
      status: "pass",
      jobId: "cleanup-job",
      requestId: "cleanup-request",
      sequenceId: "sequence",
      releaseStatus: "succeeded",
      requestIds: { begin: "begin-request", release: "release-request" },
      jobs: [
        {
          jobId: "cleanup-job",
          requestId: "cleanup-request",
          status: "succeeded",
        },
      ],
      documentCreationId: "creation-id",
      ownScratchAbsent: true,
      protectedDocumentsUnchanged: true,
      activeDocumentRestored: true,
      expectedActiveCreationId: null,
      activeAfter: null,
      protectedBeforeCount: 1,
      protectedAfterCount: 1,
      protectedBeforeSha256: "a".repeat(64),
      protectedAfterSha256: "a".repeat(64),
    }),
    { flag: "wx" },
  );
  const artifactHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(evidenceDir, "result.json")))
    .digest("hex");
  const restoreHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(evidenceDir, "restore.json")))
    .digest("hex");
  const feature = {
    id: "sample",
    ticket: "fmcad-sample",
    requiredCases: ["positive", "negative"],
  };
  const context = {
    gateReady: true,
    workingTreeClean: true,
    candidateCommit: "candidate-sha",
    integrationRunId: "native-run-test",
    fusionSessionId: "fusion-session-test",
    fusionBuild: "2706.1.14",
    evidenceDir,
  };
  const proof = {
    featureId: "sample",
    candidateCommit: "candidate-sha",
    integrationRunId: "native-run-test",
    fusionSessionId: "fusion-session-test",
    fusionBuild: "2706.1.14",
    document: { name: "owned-scratch", creationId: "creation-id" },
    jobs: [
      {
        requestId: "request",
        jobId: "job",
        docId: "creation-id",
        status: "succeeded",
      },
    ],
    cases: [
      {
        id: "positive",
        status: "PASS",
        observation: "pass",
        jobId: "job",
        evidence: ["result.json"],
      },
      {
        id: "negative",
        status: "FAIL",
        observation: "fail",
        jobId: "job",
        evidence: ["result.json"],
      },
    ],
    restore: {
      status: "PASS",
      jobId: "cleanup-job",
      requestId: "cleanup-request",
      sequenceId: "sequence",
      jobStatus: "succeeded",
      ownScratchAbsent: true,
      activeDocumentRestored: true,
      protectedDocumentsUnchanged: true,
      evidence: ["restore.json"],
    },
    artifacts: [
      { path: "result.json", sha256: artifactHash },
      { path: "restore.json", sha256: restoreHash },
    ],
  };
  assert.equal(classifyFeature(feature, proof, context).status, "FAIL");

  proof.cases[1] = {
    id: "negative",
    status: "PASS",
    observation: "expected negative detected",
    jobId: "job",
    evidence: ["result.json"],
  };
  proof.restore.ownScratchAbsent = false;
  assert.equal(classifyFeature(feature, proof, context).status, "NOTRUN");
});

test("all required cases, exact pins, terminal jobs, restore, and hashed evidence are needed for PASS", (t) => {
  const evidenceDir = fs.mkdtempSync(
    "/tmp/opencode/native-qualification-pass-test-",
  );
  t.after(() => fs.rmSync(evidenceDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(evidenceDir, "result.json"), "proof bytes\n", {
    flag: "wx",
  });
  fs.writeFileSync(
    path.join(evidenceDir, "restore.json"),
    JSON.stringify({
      status: "pass",
      jobId: "cleanup-job",
      requestId: "cleanup-request",
      sequenceId: "sequence",
      releaseStatus: "succeeded",
      requestIds: { begin: "begin-request", release: "release-request" },
      jobs: [
        {
          jobId: "cleanup-job",
          requestId: "cleanup-request",
          status: "succeeded",
        },
      ],
      documentCreationId: "creation-id",
      ownScratchAbsent: true,
      protectedDocumentsUnchanged: true,
      activeDocumentRestored: true,
      expectedActiveCreationId: null,
      activeAfter: null,
      protectedBeforeCount: 1,
      protectedAfterCount: 1,
      protectedBeforeSha256: "b".repeat(64),
      protectedAfterSha256: "b".repeat(64),
    }),
    { flag: "wx" },
  );
  const sha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(evidenceDir, "result.json")))
    .digest("hex");
  const restoreHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(evidenceDir, "restore.json")))
    .digest("hex");
  const feature = {
    id: "sample",
    ticket: "fmcad-sample",
    requiredCases: ["positive", "negative"],
  };
  const result = classifyFeature(
    feature,
    {
      featureId: "sample",
      candidateCommit: "candidate-sha",
      integrationRunId: "native-run-test",
      fusionSessionId: "fusion-session-test",
      fusionBuild: "2706.1.14",
      document: { name: "owned-scratch", creationId: "creation-id" },
      jobs: [
        {
          requestId: "request",
          jobId: "job",
          docId: "creation-id",
          status: "succeeded",
        },
      ],
      cases: [
        {
          id: "positive",
          status: "PASS",
          observation: "pass",
          jobId: "job",
          evidence: ["result.json"],
        },
        {
          id: "negative",
          status: "PASS",
          observation: "expected negative detected",
          jobId: "job",
          evidence: ["result.json"],
        },
      ],
      restore: {
        status: "PASS",
        jobId: "cleanup-job",
        requestId: "cleanup-request",
        sequenceId: "sequence",
        jobStatus: "succeeded",
        ownScratchAbsent: true,
        activeDocumentRestored: true,
        protectedDocumentsUnchanged: true,
        evidence: ["restore.json"],
      },
      artifacts: [
        { path: "result.json", sha256 },
        { path: "restore.json", sha256: restoreHash },
      ],
    },
    {
      gateReady: true,
      workingTreeClean: true,
      candidateCommit: "candidate-sha",
      integrationRunId: "native-run-test",
      fusionSessionId: "fusion-session-test",
      fusionBuild: "2706.1.14",
      evidenceDir,
    },
  );
  assert.equal(result.status, "PASS");
});

function fakeGate() {
  return {
    ready: true,
    gate: {
      status: "released",
      observedAt: new Date().toISOString(),
      integrationRunId: "offline-native-run",
      fusionSessionId: "offline-fusion-session",
      recovery: {
        ownerConfirmed: true,
        resolvedJobIds: [...manifest.hold.jobs],
      },
      queue: {
        fresh: true,
        state: "RUNNING",
        active: null,
        blocked: null,
        lease: null,
        paused: false,
        held: false,
        stopping: false,
        unresolved: false,
        activeOperations: 0,
        nonterminalJobCount: 0,
      },
      runtime: {
        fusionBuild: "2706.1.14",
        buildHash: "fake-build",
        sourceCommit: "candidate-sha",
        contractQualified: true,
      },
    },
    gateSha256: "a".repeat(64),
  };
}

function fakeQueueStatus() {
  return {
    phase: "RUNNING",
    buildHash: "fake-build",
    paused: false,
    active: null,
    blocked: null,
    lease: null,
    unresolved: false,
    activeOperations: 0,
    nonterminalJobCount: 0,
    held: false,
    stopping: false,
  };
}

function fakePort({
  runScript,
}: {
  runScript?: (input: RunScriptRequest, calls: PortCalls) => RunScriptResult;
} = {}): QualificationPort {
  const calls = { status: 0, list: 0, create: 0, run: 0, cleanup: 0 };
  return {
    calls,
    async status() {
      calls.status += 1;
      return fakeQueueStatus();
    },
    async listDocuments() {
      calls.list += 1;
      return {
        status: "succeeded",
        documents: [
          {
            name: "Protected Design",
            creationId: "protected",
            isActive: true,
            isSaved: true,
            isModified: false,
          },
        ],
        jobId: `inventory-${calls.list}`,
        requestId: `inventory-request-${calls.list}`,
      };
    },
    async createScratch({
      name,
      baselineDocuments,
      requestId,
      baselineRequestId,
      baselineJobId,
      afterListRequestId,
    }) {
      calls.create += 1;
      return {
        status: "succeeded",
        createStatus: "succeeded",
        listStatus: "succeeded",
        createRequestId: requestId,
        createJobId: `create-${calls.create}`,
        baselineRequestId,
        baselineJobId,
        listRequestId: afterListRequestId,
        listJobId: `inventory-after-${calls.create}`,
        baselineDocuments,
        document: {
          name,
          creationId: `creation-${calls.create}`,
          isActive: true,
          isSaved: false,
          isModified: false,
        },
      };
    },
    async runScript(input) {
      calls.run += 1;
      return runScript
        ? runScript(input, calls)
        : {
            status: "succeeded",
            jobId: `run-${calls.run}`,
            requestId: `request-${calls.run}`,
            fmcadResult: {
              success: true,
              result: {
                featureId: "containment",
                nativeCasesStatus: "pass",
                document: { creationId: input.document.creationId },
              },
            },
          };
    },
    async cleanupScratch({ document, beforeDocuments, requestIds }) {
      calls.cleanup += 1;
      const active =
        beforeDocuments.find((row) => row.isActive === true)?.creationId ||
        null;
      return {
        status: "pass",
        jobId: `cleanup-${calls.cleanup}`,
        sequenceId: `sequence-${calls.cleanup}`,
        requestId: requestIds.post,
        documentCreationId: document.creationId,
        requestIds,
        jobs: [
          {
            jobId: `cleanup-${calls.cleanup}`,
            requestId: requestIds.post,
            status: "succeeded",
          },
        ],
        releaseStatus: "succeeded",
        ownScratchAbsent: true,
        protectedDocumentsUnchanged: true,
        activeDocumentRestored: true,
        expectedActiveCreationId: active,
        activeAfter: active,
      };
    },
  };
}

function fakeFeature(id: string, suiteId = id) {
  return {
    id,
    ticket: `fmcad-${id}`,
    scratchSlot: suiteId,
    requiredCases: ["native-case", "owned-scratch-restore-and-cleanup"],
    execution: {
      kind: "fmcad-run",
      suiteId,
      script: "tests/native/integrated-qualification/containment.py",
      scratchMode: "fresh-unsaved",
      documentPrefix: "FMCAD_NQ_",
      argsProfile: "native-body-containment-v1",
      resultStatusField: "nativeCasesStatus",
      timeoutMs: 10,
    },
  };
}

test("FAKE PORT (offline): opt-in gate prevents every dispatch before authorization", async () => {
  const calls: string[] = [];
  const port = {
    async status() {
      calls.push("status");
      return fakeQueueStatus();
    },
  };
  const root = fs.mkdtempSync("/tmp/opencode/native-qualification-optin-test-");
  fs.mkdirSync(path.join(root, "evidence"), { mode: 0o700 });
  try {
    const result = await runNativeSweep({
      manifest: { features: [fakeFeature("containment")] },
      candidateCommit: "candidate-sha",
      workingTreeClean: true,
      evidenceDir: path.join(root, "evidence"),
      gateReceipt: fakeGate(),
      bindings: {
        integrationRunId: "offline-native-run",
        fusionSessionId: "offline-fusion-session",
      },
      port,
      optIn: false,
    });
    assert.equal(result.status, "blocked");
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FAKE PORT (offline): one shared fixture suite dispatches once and records cleanup", async () => {
  const root = fs.mkdtempSync(
    "/tmp/opencode/native-qualification-shared-suite-test-",
  );
  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  const report = {
    featureIds: ["native-drive-test", "motion-link"],
    nativeCasesStatus: "pass",
    cases: Object.fromEntries(
      [
        "disconnected-follower-detected",
        "native-joint-readback",
        "native-motion-link-readback",
        "linked-driver-positive",
        "wrong-ratio-negative",
        "wrong-phase-negative",
        "driver-restore-readback",
      ].map((id) => [id, { status: "pass" }]),
    ),
  };
  const port = fakePort({
    runScript(input) {
      return {
        status: "succeeded",
        jobId: "one-native-job",
        requestId: "one-native-request",
        fmcadResult: {
          success: true,
          result: {
            ...report,
            document: { creationId: input.document.creationId },
          },
        },
      };
    },
  });
  const sharedExecution = {
    ...fakeFeature("native-drive-test", "drive-motion-link").execution,
    argsProfile: "drive-motion-link-v1",
  };
  const features = [
    {
      ...fakeFeature("native-drive-test", "drive-motion-link"),
      requiredCases: [
        "disconnected-or-wrong-follower-detected",
        "native-driver-and-follower-readback",
        "joint-and-transform-restore-readback",
        "owned-scratch-restore-and-cleanup",
      ],
      execution: sharedExecution,
    },
    {
      ...fakeFeature("motion-link", "drive-motion-link"),
      requiredCases: [
        "native-motion-link-created-from-pinned-joints",
        "link-and-joint-native-readback",
        "wrong-ratio-and-phase-negative",
        "joint-state-restored",
        "owned-scratch-restore-and-cleanup",
      ],
      execution: sharedExecution,
    },
  ];
  try {
    const result = await runNativeSweep({
      manifest: { features },
      candidateCommit: "candidate-sha",
      workingTreeClean: true,
      evidenceDir,
      gateReceipt: fakeGate(),
      bindings: {
        integrationRunId: "offline-native-run",
        fusionSessionId: "offline-fusion-session",
        features: {},
      },
      port,
      optIn: true,
    });
    assert.equal(result.status, "PASS");
    assert.deepEqual(
      result.features.map((item) => item.status),
      ["PASS", "PASS"],
    );
    assert.equal(port.calls.create, 1);
    assert.equal(port.calls.run, 1);
    assert.equal(port.calls.cleanup, 1);
    assert.ok(fs.existsSync(path.join(evidenceDir, "native-drive-test.json")));
    assert.ok(fs.existsSync(path.join(evidenceDir, "motion-link.json")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FAKE PORT (offline): unknown stops later suites, skips cleanup, and ledger forbids replay", async () => {
  const root = fs.mkdtempSync(
    "/tmp/opencode/native-qualification-unknown-test-",
  );
  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  const port = fakePort({
    runScript() {
      return {
        status: "unknown",
        requestId: "unresolved-request",
        reason: "fake lost receipt",
      };
    },
  });
  const features = [fakeFeature("first"), fakeFeature("second")];
  const options = {
    manifest: { features },
    candidateCommit: "candidate-sha",
    workingTreeClean: true,
    evidenceDir,
    gateReceipt: fakeGate(),
    bindings: {
      integrationRunId: "offline-native-run",
      fusionSessionId: "offline-fusion-session",
      features: {},
    },
    port,
    optIn: true,
  };
  try {
    const result = await runNativeSweep(options);
    assert.equal(result.status, "NOTRUN");
    assert.equal(result.stoppedForUnknown, true);
    assert.equal(port.calls.run, 1);
    assert.equal(port.calls.cleanup, 0);
    const beforeReplayCalls = { ...port.calls };
    const replay = await runNativeSweep(options);
    assert.equal(replay.requiresReconciliation, true);
    assert.deepEqual(port.calls, beforeReplayCalls);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FAKE PORT (offline): queue receipts require exact request/job terminal IDs; unknown never retries", () => {
  const terminal = queueJob(
    'FMCAD_RESULT {"success":true}\n',
    [
      `FMCAD_QUEUE_REQUEST ${JSON.stringify({ requestId: "req-1", clientId: "owner" })}`,
      `FMCAD_QUEUE_JOB ${JSON.stringify({ requestId: "req-1", jobId: "job-1" })}`,
      `FMCAD_QUEUE_RESULT ${JSON.stringify({ id: "job-1", requestId: "req-1", state: "succeeded" })}`,
    ].join("\n"),
    "req-1",
  );
  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.jobId, "job-1");
  assert.deepEqual(terminal.fmcadResult, { success: true });
  const missing = queueJob("", "", "req-unknown");
  assert.equal(missing.status, "unknown");
  assert.equal(missing.jobId, undefined);
});

test("FAKE PORT (offline): released gate binds the candidate and freshly reconciled queue", () => {
  const receipt = fakeGate();
  assert.equal(
    releasedGateMatches(receipt, { hold: { jobs: [] } }, "candidate-sha"),
    true,
  );
  assert.equal(
    releasedGateMatches(receipt, { hold: { jobs: [] } }, "different-sha"),
    false,
  );
  receipt.gate.queue.nonterminalJobCount = 1;
  assert.equal(
    releasedGateMatches(receipt, { hold: { jobs: [] } }, "candidate-sha"),
    false,
  );
});

test("FAKE PORT (offline): inventory pins exact creationIds and private workspace owns project .cad", (t) => {
  const root = fs.mkdtempSync(
    "/tmp/opencode/native-qualification-private-workspace-",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = createPrivateWorkspace(root);
  assert.ok(
    fs.existsSync(path.join(workspace.project, ".cad", "native-qualification")),
  );
  assert.ok(workspace.home.startsWith(root));
  const docs = parseDocumentList(
    [
      "DOC name=Protected Design id=file-1 creationId=creation-1 isActive=true isModified=false isSaved=true",
      "DOC name=FMCAD_RUN_1 creationId=creation-2 isActive=false isModified=true isSaved=false",
      "DONE",
    ].join("\n"),
  );
  assert.equal(docs.length, 2);
  assert.equal(docs[0]!.name, "Protected Design");
  assert.equal(docs[1]!.creationId, "creation-2");
  assert.equal(docs[1]!.isModified, true);
  assert.equal(
    queueIsClear(
      {
        phase: "RECOVERY_BLOCKED",
        buildHash: "b",
        paused: false,
        active: null,
        blocked: { id: "held" },
        lease: null,
        unresolved: true,
        activeOperations: 0,
        nonterminalJobCount: 1,
      },
      "b",
    ),
    false,
  );
  fs.mkdirSync(path.join(root, "broker", "fmcad", "queue"), {
    recursive: true,
    mode: 0o700,
  });
  assert.equal(
    validateBrokerStateHome(path.join(root, "broker")),
    path.join(root, "broker"),
  );
  const configPath = path.join(root, "fmcad.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      backend: "addin",
      routing: "queue",
      queue: { autoStart: false },
    }),
  );
  assert.equal(validateExplicitConfig(configPath), configPath);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      backend: "addin",
      routing: "queue",
      queue: { autoStart: true },
    }),
  );
  assert.throws(() => validateExplicitConfig(configPath), /autoStart=false/);
});

test("FAKE PORT (offline): unknown cleanup stops the sweep and never retries the close", async () => {
  const root = fs.mkdtempSync(
    "/tmp/opencode/native-qualification-cleanup-unknown-test-",
  );
  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  const port = fakePort();
  port.cleanupScratch = async () => {
    port.calls.cleanup += 1;
    return {
      status: "unknown",
      requestId: "cleanup-unknown-request",
      sequenceId: "cleanup-sequence",
      jobs: [
        { requestId: "close-request", jobId: "close-job", status: "unknown" },
      ],
      reason: "fake lost close receipt",
    };
  };
  const features = [
    {
      ...fakeFeature("containment"),
      requiredCases: [
        "native-body-inside-outside-boundary",
        "temporary-copy-leaves-document-unchanged",
        "owned-scratch-restore-and-cleanup",
      ],
    },
    fakeFeature("second"),
  ];
  port.runScript = async ({ document }) => {
    port.calls.run += 1;
    return {
      status: "succeeded",
      jobId: "native-job",
      requestId: "native-request",
      fmcadResult: {
        success: true,
        result: {
          nativeCasesStatus: "pass",
          modelUnchangedDuringEvidence: true,
          document: { creationId: document.creationId },
          cases: {
            "native-body-inside-outside-boundary": { status: "pass" },
            "temporary-copy-leaves-document-unchanged": { status: "pass" },
          },
        },
      },
    };
  };
  try {
    const result = await runNativeSweep({
      manifest: { features },
      candidateCommit: "candidate-sha",
      workingTreeClean: true,
      evidenceDir,
      gateReceipt: fakeGate(),
      bindings: {
        integrationRunId: "offline-native-run",
        fusionSessionId: "offline-fusion-session",
        features: {},
      },
      port,
      optIn: true,
    });
    assert.equal(result.stoppedForUnknown, true);
    assert.equal(port.calls.run, 1);
    assert.equal(port.calls.cleanup, 1);
    assert.equal(result.features[0]!.status, "NOTRUN");
    assert.equal(result.features[1]!.status, "NOTRUN");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FAKE PORT (offline): main remains queue-inert when --run-native lacks coordinator release", (t) => {
  const evidenceDir = fs.mkdtempSync(
    "/tmp/opencode/native-qualification-main-gate-test-",
  );
  t.after(() => fs.rmSync(evidenceDir, { recursive: true, force: true }));
  const fixture = qualificationRepository(t);
  const result = spawnSync(
    process.execPath,
    [
      fixture.runner,
      "--run-native",
      "--evidence-dir",
      evidenceDir,
      "--cli",
      "/missing/fmcad.js",
      "--installation-root",
      "/missing",
      "--config",
      "/missing/config.json",
      "--broker-state-home",
      "/missing/state",
      "--client-id",
      "offline-client",
    ],
    { cwd: fixture.root, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const output: { execution: { status: string; portCalls: number } } =
    JSON.parse(result.stdout);
  assert.equal(output.execution.status, "blocked");
  assert.equal(output.execution.portCalls, 0);
  assert.equal(
    fs.existsSync(path.join(evidenceDir, "dispatch-ledger.json")),
    false,
  );
});

test("offline deferred adapters require exact typed pins and report explicit NOTRUN capabilities", (t) => {
  const outputRoot = fs.mkdtempSync("/tmp/opencode/capture-output-");
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const brep = deferredAdapters.validateBrepRequest({
    schemaVersion: 1,
    clientId: "registered-client",
    document: {
      name: "SavedScratch",
      creationId: "creation",
      projectId: "project",
      fileId: "file",
      version: 4,
      isSaved: true,
      isModified: false,
    },
    requestIds: Object.fromEntries(
      Object.keys(deferredAdapters.BREP_PHASES).map((phase) => [
        phase,
        `brep-${phase}`,
      ]),
    ),
    caseIds: [...deferredAdapters.BREP_CASES],
    fixture: {
      frame: "assembly",
      bodyRoles: ["before", "after"],
      equalVolumeControl: true,
      changedPoseControl: true,
    },
  });
  assert.equal(brep.status, "NOTRUN");
  assert.equal(
    brep.unsupportedCapability,
    "saved-versioned-document-and-broker-owned-exact-brep-staging",
  );
  assert.equal(
    brep.unsupportedCapability,
    manifest.features.find((feature) => feature.id === "brep-baselines")!
      .deferredAdapter!.capability,
  );

  const capture = deferredAdapters.validateCaptureRequest({
    schemaVersion: 1,
    clientId: "current-owner",
    fusionSessionId: "current-session",
    documents: {
      BLANK: {
        name: "Scratch-BLANK",
        creationId: "creation-BLANK",
        isSaved: false,
        isModified: false,
        geometryReadback: { bodyCount: 0 },
      },
      ASYMMETRIC: {
        name: "Scratch-ASYMMETRIC",
        creationId: "creation-ASYMMETRIC",
        isSaved: false,
        isModified: true,
        geometryReadback: {
          bodyCount: 1,
          bodyValid: true,
          volume: 8,
          minimum: [0, 0, 0],
          maximum: [4, 2, 1],
        },
      },
      SYMMETRIC: {
        name: "Scratch-SYMMETRIC",
        creationId: "creation-SYMMETRIC",
        isSaved: false,
        isModified: true,
        geometryReadback: {
          bodyCount: 1,
          bodyValid: true,
          volume: 8,
          minimum: [0, 0, 0],
          maximum: [2, 2, 2],
        },
      },
    },
    sectionName: "FMCAD_CAPTURE_SECTION_0123456789ab",
    requestIds: Object.fromEntries(
      deferredAdapters.CAPTURE_PHASES.map((phase) => [
        phase,
        `capture-${phase}`,
      ]),
    ),
    caseIds: [...deferredAdapters.CAPTURE_CASES],
    outputRoot,
  });
  assert.equal(capture.status, "NOTRUN");
  assert.equal(
    capture.unsupportedCapability,
    "three-document-capture-fixture-and-current-client-bound-review-host",
  );
  assert.equal(
    capture.unsupportedCapability,
    manifest.features.find((feature) => feature.id === "capture-integrity")!
      .deferredAdapter!.capability,
  );

  const selection = deferredAdapters.validateSelectionRequest({
    schemaVersion: 1,
    clientId: "current-owner",
    document: {
      name: "SavedModel",
      creationId: "creation",
      projectId: "project",
      fileId: "file",
      version: 2,
      isSaved: true,
      isModified: false,
    },
    requestIds: Object.fromEntries(
      deferredAdapters.SELECTION_PHASES.map((phase) => [
        phase,
        `selection-${phase}`,
      ]),
    ),
    fixture: {
      component: "root",
      caseIds: [...deferredAdapters.SELECTION_CASES],
      faces: [
        {
          path: "root/Body:1/FaceA",
          occurrencePath: "root/Bracket:1",
          semanticLabel: "front",
        },
        {
          path: "root/Body:2/FaceB",
          occurrencePath: "root/Bracket:2",
          semanticLabel: "back",
        },
      ],
    },
  });
  assert.equal(selection.status, "NOTRUN");
  assert.equal(
    selection.unsupportedCapability,
    "saved-file-selection-artifact-persistence-and-cross-invocation-reread",
  );
  assert.equal(
    selection.unsupportedCapability,
    manifest.features.find((feature) => feature.id === "selection-rules")!
      .deferredAdapter!.capability,
  );

  const sketch = deferredAdapters.validateSketchRequest({
    schemaVersion: 1,
    clientId: "registered-epoch-client",
    ownerJobs: {
      targetJobId: manifest.hold.jobs[0],
      observationJobId: manifest.hold.jobs[1],
    },
    creationReceipt: {
      status: "succeeded",
      requestId: "scratch-create-request",
      jobId: "scratch-create-job",
      epochId: "actual-epoch-from-owner-receipt",
      document: {
        name: "FMCAD_EPOCH_SKETCH",
        creationId: "creation-from-receipt",
      },
    },
    fixturePrefix: "NQABCDEF1234",
    requestIds: Object.fromEntries(
      deferredAdapters.SKETCH_OPERATIONS.map((phase) => [
        phase,
        `sketch-${phase}`,
      ]),
    ),
    cleanupRequestId: "owner-close-request",
  });
  assert.equal(sketch.status, "NOTRUN");
  assert.equal(
    sketch.unsupportedCapability,
    manifest.features.find((feature) => feature.id === "sketch-geometry-proof")!
      .deferredAdapter!.capability,
  );
  assert.equal(sketch.calls.length, deferredAdapters.SKETCH_OPERATIONS.length);
  assert.ok(
    sketch.calls.every(
      (call) =>
        call.toolRequest.action === "execute" &&
        call.toolRequest.invocation.version === 1 &&
        call.toolRequest.invocation.kind === "cad" &&
        call.clientId === "registered-epoch-client" &&
        call.toolRequest.invocation.doc === sketch.document.name &&
        call.toolRequest.invocation.docId === sketch.document.creationId &&
        call.epochId === "actual-epoch-from-owner-receipt" &&
        deferredAdapters.SKETCH_ALLOWED_OPERATIONS.has(
          call.toolRequest.invocation.operation,
        ),
    ),
  );
  assert.deepEqual(sketch.unsupportedCases, [
    "coordinate-positive",
    "shifted-center-negative",
    "bad-diameter-negative",
  ]);
  assert.equal(sketch.cleanup.ownerJobs.targetJobId, manifest.hold.jobs[0]);
  assert.equal(
    sketch.cleanup.ownerJobs.observationJobId,
    manifest.hold.jobs[1],
  );
  assert.ok(
    Object.values(sketch.caseResults).every((row) => row.status === "NOTRUN"),
  );
  assert.equal(
    Object.keys(sketch.casePhases).length,
    deferredAdapters.SKETCH_CASES.length,
  );
  assert.ok(
    sketch.calls.every(
      (call) =>
        !Object.hasOwn(call, "argv") &&
        !Object.hasOwn(call, "script") &&
        !Object.hasOwn(call, "python"),
    ),
  );
  assert.throws(
    () =>
      deferredAdapters.validateSketchRequest({
        schemaVersion: 1,
        clientId: "registered-epoch-client",
        ownerJobs: { targetJobId: "target", observationJobId: "observer" },
        creationReceipt: {
          status: "succeeded",
          requestId: "create-request",
          jobId: "create-job",
          epochId: "epoch",
          document: {
            name: "Scratch",
            creationId: "creation",
            fileId: "must-not-be-accepted",
          },
        },
        fixturePrefix: "NQABCDEF1234",
        requestIds: Object.fromEntries(
          deferredAdapters.SKETCH_OPERATIONS.map((phase) => [
            phase,
            `sketch-${phase}`,
          ]),
        ),
        cleanupRequestId: "owner-close-request",
      }),
    /unsupported field fileId/,
  );
  assert.throws(
    () =>
      deferredAdapters.validateBrepRequest({
        schemaVersion: 1,
        clientId: "client",
        document: {
          name: "Saved",
          creationId: "creation",
          projectId: "project",
          fileId: "file",
          version: 0,
          isSaved: true,
          isModified: false,
        },
      }),
    /saved\/versioned/,
  );
  assert.throws(
    () => deferredAdapters.validateCaptureRequest({ schemaVersion: 1 }),
    /current registered client\/Fusion session/,
  );
  assert.throws(
    () => deferredAdapters.validateSelectionRequest({ schemaVersion: 1 }),
    /registered client/,
  );
});

test("FAKE PORT (offline): typed unsupported adapters perform zero queue or Fusion dispatches", async (t) => {
  const root = fs.mkdtempSync(
    "/tmp/opencode/native-qualification-deferred-test-",
  );
  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const features = manifest.features.filter((feature) =>
    [
      "brep-baselines",
      "capture-integrity",
      "selection-rules",
      "sketch-geometry-proof",
    ].includes(feature.id),
  );
  const port = fakePort();
  const result = await runNativeSweep({
    manifest: { hold: manifest.hold, features },
    candidateCommit: "candidate-sha",
    workingTreeClean: true,
    evidenceDir,
    gateReceipt: fakeGate(),
    bindings: {
      integrationRunId: "offline-native-run",
      fusionSessionId: "offline-fusion-session",
      features: {},
    },
    port,
    optIn: true,
  });
  assert.equal(result.status, "NOTRUN");
  assert.ok(
    result.features.every(
      (feature) => feature.status === "NOTRUN" && feature.unsupportedCapability,
    ),
  );
  assert.equal(port.calls.status, 0);
  assert.equal(port.calls.list, 0);
  assert.equal(port.calls.create, 0);
  assert.equal(port.calls.run, 0);
  assert.equal(port.calls.cleanup, 0);
  assert.equal(
    fs.existsSync(path.join(evidenceDir, "dispatch-ledger.json")),
    false,
  );
});

test("OFFLINE unrelated Git candidate cannot inherit historical qualification", (t) => {
  const fixture = qualificationRepository(t);
  const changed: Record<string, unknown> = JSON.parse(
    fs.readFileSync(fixture.manifest, "utf8"),
  );
  changed["candidateBase"] = "b2fb6c0800a9da515d53373512b4f0ed68048b67";
  fs.writeFileSync(fixture.manifest, JSON.stringify(changed));
  assert.throws(
    () => (load(fixture.runner) as QualificationRunner).buildReport(),
    /does not contain/,
  );
});

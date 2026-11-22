const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const core = require("@fmcad/core");
const retirement = require("../packages/core/dist/domain/runtime-retirement.js");
const policy = require("../packages/core/dist/domain/document-conflicts.js");
const hash = (value) => createHash("sha256").update(value).digest("hex");

function fixture(observerState) {
  let count = 0;
  const domain = new core.QueueDomain({
    now: () => 100,
    newId: () => "job-" + ++count,
    hash,
  });
  const request = (requestId) => ({
    kind: "rpc",
    clientId: "original-owner",
    requestId,
    timeoutMs: 1000,
    payload: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "execute_python",
        arguments: { code: "owned original", persistent: false },
      },
    },
    ...(observerState ? {
      kind: "command", buildHash: "original-build", cwd: "/owned-fixture",
      argv: ["cad", "batch", "run"],
      payload: { version: 1, kind: "cad", operation: "batch.run", doc: "Owned", docId: "doc-A",
        data: { runId: requestId, reportPath: "/owned-fixture/report" } },
    } : {}),
  });
  const old = domain.submit(request("original-uncertain"));
  domain.next();
  domain.markDispatch(old.id);
  const waiting = domain.submit({
    ...request("never-started"),
    clientId: "another-owner",
  });
  domain.block(old.id, { code: "ORIGINAL_UNKNOWN_EVIDENCE" });
  let observer;
  if (observerState) {
    const marker = {
      version: 1, kind: "atomic-holder-status", observerJobHash: "",
      targetJobId: old.id, targetRequestId: old.requestId, targetClientId: "original-owner",
      targetJobHash: domain.data.jobs[old.id].hash, targetBuildHash: "original-build",
      observerBuildHash: "observer-build", projectDirectory: "/owned-fixture",
      paused: false, controlGeneration: 0, contextEpoch: 0,
      reportPath: "/owned-fixture/report", reportFingerprint: "a".repeat(64),
      commandId: "fmcad_atomic_" + "b".repeat(32), sessionNonce: "c".repeat(32), docId: "doc-A",
    };
    observer = domain.submit({
      kind: "command", requestId: "original-observer", clientId: "original-owner",
      timeoutMs: 1000, backend: "addin", buildHash: "observer-build",
      argv: ["cad", "batch", "reconcile", "--doc-id", "doc-A"], cwd: "/owned-fixture",
      payload: { version: 1, kind: "cad", operation: "batch.reconcile", doc: "Owned", docId: "doc-A",
        data: { reportPath: marker.reportPath, blockedJobId: old.id,
          commandId: marker.commandId, sessionNonce: marker.sessionNonce } },
    });
    marker.observerJobHash = domain.data.jobs[observer.id].hash;
    domain.armWorkflowObservation(observer.id, marker);
    if (observerState !== "queued") {
      assert.equal(domain.next().id, observer.id);
      domain.markDispatch(observer.id);
      if (observerState === "unknown") domain.block(observer.id, "Owned original read outcome unknown");
      else domain.finish(observer.id, { state: "succeeded" });
    }
  }
  domain.pause(true);
  const frozen = structuredClone(domain.data);
  const marker = {
    rootHead: "a".repeat(64),
    recordDigest: "b".repeat(64),
    layer: "root",
    frozenDigest: hash(JSON.stringify(frozen)),
  };
  const exposure = {
    kind: "runtime_retired",
    key: "root:" + old.id,
    ...marker,
    entryDigest: hash(core.canonical(frozen.jobs[old.id])),
    target: null,
    source: {
      kind: "job",
      jobId: old.id,
      requestId: frozen.jobs[old.id].requestId,
      clientId: frozen.jobs[old.id].clientId,
      jobHash: frozen.jobs[old.id].hash,
      catalogDigest: hash(core.canonical(frozen.jobs[old.id].dispatch)),
    },
  };
  delete exposure.frozenDigest;
  const coverage = {
    marker,
    frozen,
    currentSnapshotDigest: marker.frozenDigest,
    jobs: {
      [old.id]: { original: frozen.jobs[old.id], outcome: "unknown" },
      [waiting.id]: {
        original: frozen.jobs[waiting.id],
        outcome: "not_started",
      },
    },
    exposures: { [exposure.key]: exposure },
  };
  if (observer && observerState !== "terminal") {
    const job = frozen.jobs[observer.id];
    coverage.jobs[observer.id] = { original: job,
      outcome: observerState === "unknown" ? "unknown" : "not_started" };
    if (observerState === "unknown") {
      coverage.exposures["root:" + observer.id] = {
        ...exposure, key: "root:" + observer.id,
        entryDigest: hash(core.canonical(job)),
        source: { kind: "job", jobId: job.id, requestId: job.requestId,
          clientId: job.clientId, jobHash: job.hash,
          catalogDigest: hash(core.canonical(job.physicalDispatches ?? job.dispatch ?? null)) },
      };
    }
  }
  const authority = retirement.createRuntimeRetirementAuthority(() => coverage);
  const project = (value = frozen, cap = authority) =>
    retirement.projectRuntimeRetirement(value, cap, core.canonical, hash, 200);
  return { frozen, marker, old, waiting, observer, coverage, authority, project };
}
for (const state of ["unknown", "terminal", "queued"]) {
  test(`retirement restores a ${state} scoped observer as historical data without rearming it`, () => {
    const f = fixture(state), projected = f.project();
    const restored = new core.QueueDomain({
      snapshot: projected, recover: true, runtimeRetirement: f.authority,
      now: () => 300, newId: () => "never-replayed", hash,
    });
    assert.equal(restored.data.active, null);
    assert.equal(restored.data.blocked, null);
    assert.equal(restored.data.jobs[f.old.id].state, "needs_reconciliation");
    assert.equal(restored.data.jobs[f.observer.id].state,
      state === "unknown" ? "needs_reconciliation" : state === "queued" ? "failed" : "succeeded");
    assert.deepEqual(restored.data.jobs[f.observer.id].workflowObservation,
      f.frozen.jobs[f.observer.id].workflowObservation);
    assert.equal(restored.data.paused, true);
    restored.pause(false);
    assert.equal(restored.next(), null);
    const changed = structuredClone(projected);
    changed.jobs[f.observer.id].workflowObservation.reportPath = "/forged";
    assert.throws(() => new core.QueueDomain({
      snapshot: changed, recover: true, runtimeRetirement: f.authority, hash,
    }));
    assert.throws(() => new core.QueueDomain({ snapshot: projected, recover: true, hash }));
  });
}
test("projection preserves UNKNOWN/identity/evidence and pause, but retires only old execution slots", () => {
  const f = fixture(),
    result = f.project();
  assert.equal(result.jobs[f.old.id].state, "needs_reconciliation");
  assert.deepEqual(result.jobs[f.old.id], f.frozen.jobs[f.old.id]);
  assert.equal(result.jobs[f.waiting.id].state, "failed");
  assert.equal(
    result.jobs[f.waiting.id].details.executionOutcome,
    "not_started",
  );
  assert.equal(result.active, null);
  assert.equal(result.blocked, null);
  assert.equal(result.paused, true);
  assert.deepEqual(result.appliedRuntimeRetirement, f.marker);
  assert.equal(f.frozen.active, f.old.id);
});
test("a JSON lookalike cannot replace the private retirement capability", () => {
  const f = fixture();
  assert.throws(
    () => f.project(f.frozen, JSON.parse(JSON.stringify(f.authority))),
    { code: "RUNTIME_RETIREMENT_AUTHORITY_REQUIRED" },
  );
});
test("changed initial bytes or queue content cannot be silently projected", () => {
  const f = fixture();
  f.coverage.currentSnapshotDigest = "c".repeat(64);
  assert.throws(() => f.project(), { code: "RUNTIME_RETIREMENT_UNAPPLIED" });
  f.coverage.currentSnapshotDigest = f.marker.frozenDigest;
  const changed = structuredClone(f.frozen);
  changed.jobs[f.old.id].requestId = "different-request";
  assert.throws(() => f.project(changed), {
    code: "RUNTIME_RETIREMENT_UNAPPLIED",
  });
});
test("a later UNKNOWN is never detached by applying an old marker again", () => {
  const f = fixture(),
    result = f.project();
  result.jobs["later"] = {
    ...result.jobs[f.old.id],
    id: "later",
    requestId: "new-unknown",
  };
  result.active = "later";
  result.blocked = { id: "later", reason: "new-unknown", at: 300 };
  const repeated = f.project(result);
  assert.deepEqual(repeated, result);
});
test("local/control slots require exact coverage, not merely the same runtime label", () => {
  const f = fixture();
  f.frozen.localUnknown = {
    id: "old-local",
    reason: { measurement: 1e20 },
    at: 100,
  };
  f.marker.frozenDigest = hash(JSON.stringify(f.frozen));
  f.coverage.currentSnapshotDigest = f.marker.frozenDigest;
  assert.throws(() => f.project(), { code: "RUNTIME_RETIREMENT_CHANGED" });
});
test("persisted retirement is never authority to detach an UNKNOWN job", () => {
  const f = fixture(),
    next = f.project();
  assert.throws(
    () =>
      retirement.runtimeRetiredJob(
        next,
        next.jobs[f.old.id],
        undefined,
        core.canonical,
      ),
    { code: "RUNTIME_RETIREMENT_AUTHORITY_REQUIRED" },
  );
  assert.equal(
    retirement.runtimeRetiredJob(
      next,
      next.jobs[f.old.id],
      f.authority,
      core.canonical,
    ),
    true,
  );
  const changed = { ...next.jobs[f.old.id], hash: "later-different-job" };
  assert.equal(
    retirement.runtimeRetiredJob(next, changed, f.authority, core.canonical),
    false,
  );
});
test("coherently changing an exposure cannot replace its private verification", () => {
  const f = fixture(),
    next = f.project();
  next.runtimeRetiredExposures[
    Object.keys(next.runtimeRetiredExposures)[0]
  ].recordDigest = "c".repeat(64);
  assert.throws(
    () =>
      retirement.runtimeRetiredJob(
        next,
        next.jobs[f.old.id],
        f.authority,
        core.canonical,
      ),
    { code: "RUNTIME_RETIREMENT_CHANGED" },
  );
});
test("missing classification or missing UNKNOWN exposure denies first projection", () => {
  for (const kind of ["classification", "exposure"]) {
    const f = fixture();
    if (kind === "classification") delete f.coverage.jobs[f.old.id];
    else f.coverage.exposures = {};
    assert.throws(() => f.project(), { code: "RUNTIME_RETIREMENT_CHANGED" });
  }
});
test("runtime-retired raw exposure allows bounded inspection, not fake per-turn release", () => {
  const f = fixture(),
    next = f.project();
  const conflicts = policy.documentConflicts(
    next,
    { creationId: "doc-A" },
    f.authority,
    core.canonical,
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].fenceKind, "runtime_retired");
  assert.equal(conflicts[0].target, null);
  assert.equal(policy.documentConflictAllowsInspection(conflicts[0]), true);
  assert.equal(policy.documentConflictFence(conflicts[0]), "runtime_retired");
  const { serializeDocumentUnlockStatus } = require("../dist/src/document-unlock-diagnostics.js");
  const actual = serializeDocumentUnlockStatus({
    target: { docId: "doc-A" }, state: "inspection_required",
    executionFence: policy.documentConflictFence(conflicts[0]),
    disclosableBlockers: [{
      jobId: conflicts[0].jobId, scope: "runtime",
      executionFence: policy.documentConflictFence(conflicts[0]),
    }],
  });
  assert.equal(actual.state, "inspection_required");
  assert.equal(actual.executionFence, "runtime_retired");
  assert.equal(actual.blockers[0].executionFence, "runtime_retired");
  assert.notEqual(actual.executionFence, "released");
  const forged = structuredClone(conflicts[0]);
  assert.equal(policy.documentConflictAllowsInspection(forged), false);
  assert.equal(policy.documentConflictFence(forged), "released");
  assert.deepEqual(next.quarantined, undefined);
  assert.equal(
    policy.documentConflictAllowsInspection({ target: null }),
    false,
  );
});
test("conflict policy requires real authority even when runtime JSON is internally consistent", () => {
  const f = fixture(),
    next = f.project();
  assert.throws(
    () =>
      policy.documentConflicts(
        next,
        { creationId: "doc-A" },
        undefined,
        core.canonical,
      ),
    { code: "RUNTIME_RETIREMENT_AUTHORITY_REQUIRED" },
  );
});
test("actual domain restore keeps retired UNKNOWN historical without restoring its active slot", () => {
  const f = fixture(),
    next = f.project();
  const restored = new core.QueueDomain({
    snapshot: next,
    runtimeRetirement: f.authority,
    now: () => 200,
    newId: () => "restored-new-job",
    hash,
  });
  assert.equal(restored.data.jobs[f.old.id].state, "needs_reconciliation");
  assert.equal(restored.data.active, null);
  assert.equal(restored.data.blocked, null);
  assert.equal(restored.data.paused, true);
  assert.throws(
    () =>
      new core.QueueDomain({
        snapshot: next,
        now: () => 200,
        newId: () => "untrusted",
        hash,
      }),
    { code: "RUNTIME_RETIREMENT_AUTHORITY_REQUIRED" },
  );
});
test("actual domain permits only compiler-shaped full inspection through retired raw exposure", () => {
  const f = fixture(),
    next = f.project();
  const restored = new core.QueueDomain({
    snapshot: next,
    runtimeRetirement: f.authority,
    now: () => 200,
    newId: () => "full-read",
    hash,
  });
  restored.assertDocumentProbeAllowed();
  const marker = restored.documentInspectionFence(
    { creationId: "doc-A" },
    "current-generation",
  );
  const request = {
    kind: "command",
    clientId: "successor-owner",
    requestId: "new-full-inspection",
    argv: ["param", "inspect", "--doc-id", "doc-A"],
    cwd: "/owned-fixture",
    timeoutMs: 1000,
    payload: {
      version: 1,
      kind: "cad",
      docId: "doc-A",
      operation: "param.inspect",
      data: { includeModel: true },
    },
  };
  const read = restored.submitDocumentInspection(request, marker);
  assert.equal(read.state, "queued");
  assert.equal(restored.data.paused, true);
  restored.pause(false);
  assert.equal(restored.next().id, read.id);
  assert.equal(restored.data.jobs[f.old.id].state, "needs_reconciliation");
});
test("a later UNKNOWN remains an active blocker after an actual domain restart", () => {
  const f = fixture(),
    next = f.project();
  const later = structuredClone(f.frozen.jobs[f.old.id]);
  later.id = "later-job";
  later.requestId = "later-request";
  later.request.requestId = later.requestId;
  later.hash = hash(core.canonical(later.request));
  next.jobs[later.id] = later;
  next.active = later.id;
  next.blocked = { id: later.id, at: 300, reason: "new-UNKNOWN" };
  const restored = new core.QueueDomain({
    snapshot: next,
    runtimeRetirement: f.authority,
    now: () => 400,
    newId: () => "unused",
    hash,
  });
  assert.equal(restored.data.active, later.id);
  assert.equal(restored.data.blocked.id, later.id);
  assert.equal(restored.data.jobs[f.old.id].state, "needs_reconciliation");
  assert.throws(() => restored.assertDocumentProbeAllowed(), {
    code: "SDK_QUIESCENCE_UNPROVEN",
  });
});
test("a JSON fenceKind field cannot turn a raw quarantine into retirement authority", () => {
  assert.equal(
    policy.documentConflictAllowsInspection({
      target: null,
      fenceKind: "runtime_retired",
    }),
    false,
  );
});
test("a raw original UNKNOWN cannot be narrowed to an asserted document target", () => {
  const f = fixture();
  f.coverage.exposures[Object.keys(f.coverage.exposures)[0]].target = {
    creationId: "asserted-doc-A",
  };
  assert.throws(() => f.project(), { code: "RUNTIME_RETIREMENT_CHANGED" });
});
test("queued work covered by an old reservation stays UNKNOWN with no dispatch catalog", () => {
  const f = fixture();
  const job = f.frozen.jobs[f.old.id];
  job.state = "queued";
  delete job.dispatch;
  delete job.startedAt;
  f.frozen.lease = {
    id: "original-lease",
    clientId: job.clientId,
    epoch: f.frozen.epoch,
    createdAt: 100,
    idleUntil: 500,
    holdUntil: 500,
  };
  f.marker.frozenDigest = hash(JSON.stringify(f.frozen));
  f.coverage.currentSnapshotDigest = f.marker.frozenDigest;
  const exposure = f.coverage.exposures[Object.keys(f.coverage.exposures)[0]];
  exposure.entryDigest = hash(core.canonical(job));
  exposure.source.catalogDigest = hash(core.canonical(null));
  const next = f.project();
  assert.equal(next.jobs[job.id].state, "needs_reconciliation");
  assert.equal(next.lease, null);
  assert.equal(next.active, null);
});

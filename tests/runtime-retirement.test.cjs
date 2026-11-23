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

test("operational conflict checks isolate returned data and still validate live retirement scopes", () => {
  const f = fixture();
  const projected = f.project();
  let allowed = true;
  const authority = retirement.createRuntimeRetirementAuthority(() => {
    if (!allowed) throw Object.assign(new Error("current owner lost"), { code: "OWNER_LOST" });
    return f.coverage;
  });
  const probe = () => policy.documentConflicts(projected, null, authority, core.canonical);
  const first = probe();
  assert.equal(first.length, 1);
  first[0].retirement.source.jobHash = "caller-mutation";
  assert.equal(probe()[0].retirement.source.jobHash, f.frozen.jobs[f.old.id].hash);
  const exposure = Object.values(f.coverage.exposures)[0];
  exposure.target = { creationId: "forged-narrow-scope" };
  assert.throws(probe, { code: "RUNTIME_RETIREMENT_CHANGED" });
  exposure.target = null;
  assert.equal(probe().length, 1);
  allowed = false;
  assert.throws(probe, { code: "OWNER_LOST" });
  assert.equal(f.frozen.jobs[f.old.id].state, "needs_reconciliation");
});

test("full retirement verification still returns isolated complete frozen history", () => {
  const f = fixture();
  f.frozen.jobs["unrelated-completed"] = {
    ...structuredClone(f.frozen.jobs[f.waiting.id]),
    id: "unrelated-completed", state: "succeeded",
  };
  const first = retirement.verifiedRuntimeRetirement(f.authority);
  assert.deepEqual(first.frozen, f.frozen);
  first.frozen.jobs["unrelated-completed"].state = "failed";
  first.jobs[f.old.id].original.requestId = "caller-mutation";
  const second = retirement.verifiedRuntimeRetirement(f.authority);
  assert.equal(second.frozen.jobs["unrelated-completed"].state, "succeeded");
  assert.equal(second.jobs[f.old.id].original.requestId, "original-uncertain");
});

function successorFixture(observerState) {
  const previous = fixture(observerState);
  const current = previous.project();
  const later = new core.QueueDomain({
    now: () => 250, newId: () => "later-unknown", hash,
  });
  const submitted = later.submit({
    kind: "rpc", clientId: "later-owner", requestId: "later-request", timeoutMs: 1000,
    payload: { method: "tools/call", params: {
      name: "execute_python", arguments: { code: "later owned fixture", persistent: false },
    } },
  });
  later.next();
  later.markDispatch(submitted.id);
  later.block(submitted.id, "Later outcome remains unknown");
  const job = structuredClone(later.data.jobs[submitted.id]);
  job.order = Math.max(...Object.values(current.jobs).map(value => value.order)) + 1;
  current.jobs[job.id] = job;
  current.active = later.data.active;
  current.blocked = structuredClone(later.data.blocked);
  const frozen = structuredClone(current);
  const marker = {
    rootHead: "c".repeat(64), recordDigest: "d".repeat(64), layer: "root",
    frozenDigest: hash(JSON.stringify(frozen)),
  };
  const jobs = {}, exposures = {};
  for (const original of Object.values(frozen.jobs)) {
    if (original.state !== "needs_reconciliation") continue;
    jobs[original.id] = { original, outcome: "unknown" };
    const key = "root:" + original.id;
    exposures[key] = {
      kind: "runtime_retired", key, rootHead: marker.rootHead,
      recordDigest: marker.recordDigest, layer: marker.layer,
      entryDigest: hash(core.canonical(original)), target: null,
      source: { kind: "job", jobId: original.id, requestId: original.requestId,
        clientId: original.clientId, jobHash: original.hash,
        catalogDigest: hash(core.canonical(original.physicalDispatches ?? original.dispatch ?? null)) },
    };
  }
  const coverage = { marker, currentSnapshotDigest: marker.frozenDigest, frozen, jobs, exposures };
  const authority = retirement.createRuntimeRetirementAuthority(() => coverage);
  const project = (value = current) =>
    retirement.projectRuntimeRetirement(value, authority, core.canonical, hash, 300);
  return { previous, current, coverage, authority, project, job };
}

test("instance epoch advances over authenticated retired UNKNOWN without settling or replay", () => {
  const f = successorFixture("unknown");
  const domain = new core.QueueDomain({
    snapshot: f.project(), recover: true, runtimeRetirement: f.authority, hash,
    now: () => 400, newId: () => "never-replayed-epoch",
  });
  domain.pause(false);
  const jobs = structuredClone(domain.data.jobs);
  const epoch = domain.data.epoch;
  const transition = domain.advanceInstanceEpoch("owned-new-instance");
  assert.equal(transition.epoch, epoch + 1);
  assert.deepEqual(domain.data.jobs, jobs);
  assert.equal(domain.advanceInstanceEpoch("owned-new-instance").alreadyApplied, true);
  assert.equal(domain.next(), null);
  domain.pause(true);
  assert.throws(() => domain.advanceInstanceEpoch("other-instance"), { code: "MANUAL_PAUSE" });
});

test("retired history does not exempt pending work or a missing UNKNOWN classification from epoch guards", () => {
  const f = successorFixture();
  const create = () => new core.QueueDomain({
    snapshot: f.project(), recover: true, runtimeRetirement: f.authority, hash,
    now: () => 400, newId: () => "fresh-uncovered-work",
  });
  const pending = new core.QueueDomain({
    now: () => 400, newId: () => "fresh-uncovered-work", hash,
  });
  pending.submit({
    kind: "rpc", clientId: "new-owner", requestId: "fresh-pending", timeoutMs: 1000,
    payload: { method: "tools/call", params: {} },
  });
  assert.equal(pending.data.jobs["fresh-uncovered-work"].state, "queued");
  assert.throws(() => pending.advanceInstanceEpoch("pending-instance"), { code: "QUEUE_NOT_QUIESCENT" });
  const missing = create();
  missing.pause(false);
  delete f.coverage.jobs[f.job.id];
  const before = structuredClone(missing.data);
  assert.throws(() => missing.advanceInstanceEpoch("uncovered-instance"), { code: "QUEUE_NOT_QUIESCENT" });
  assert.deepEqual(missing.data, before, "failed transition cannot publish epoch or change UNKNOWN");
});

test("a fresh authenticated root projects the exact previously retired snapshot without settling UNKNOWN", () => {
  const f = successorFixture();
  const projected = f.project();
  assert.deepEqual(projected.appliedRuntimeRetirement, f.coverage.marker);
  assert.deepEqual(projected.runtimeRetiredExposures, f.coverage.exposures);
  assert.deepEqual(projected.jobs, f.current.jobs);
  assert.equal(projected.active, null);
  assert.equal(projected.blocked, null);
  assert.deepEqual(f.project(projected), projected, "same-root restore is idempotent");
  assert.throws(() => f.previous.project(projected), { code: "RUNTIME_RETIREMENT_UNAPPLIED" });
  const restored = new core.QueueDomain({
    snapshot: projected, recover: true, runtimeRetirement: f.authority, hash,
    now: () => 400, newId: () => "never-replayed-successor",
  });
  assert.equal(restored.data.jobs[f.job.id].state, "needs_reconciliation");
  assert.equal(restored.data.jobs[f.previous.old.id].state, "needs_reconciliation");
});

test("a successor root cannot overwrite a changed frozen snapshot or an unbound digest", () => {
  const f = successorFixture();
  const changed = structuredClone(f.current);
  changed.revision++;
  assert.throws(() => f.project(changed), { code: "RUNTIME_RETIREMENT_UNAPPLIED" });
  f.coverage.currentSnapshotDigest = "e".repeat(64);
  assert.throws(() => f.project(), { code: "RUNTIME_RETIREMENT_UNAPPLIED" });
});

test("a successor root must cover later UNKNOWN jobs and their original dispatch", () => {
  const missing = successorFixture();
  delete missing.coverage.jobs[missing.job.id];
  assert.throws(() => missing.project(), { code: "RUNTIME_RETIREMENT_CHANGED" });
  const altered = successorFixture();
  altered.coverage.exposures["root:" + altered.job.id].source.catalogDigest = "e".repeat(64);
  assert.throws(() => altered.project(), { code: "RUNTIME_RETIREMENT_CHANGED" });
});

test("the same root cannot change its marker or retirement exposures", () => {
  const changedMarker = successorFixture();
  changedMarker.coverage.marker.rootHead = changedMarker.current.appliedRuntimeRetirement.rootHead;
  assert.throws(() => changedMarker.project(), { code: "RUNTIME_RETIREMENT_CHANGED" });
  const changedExposures = successorFixture();
  const projected = changedExposures.project();
  projected.runtimeRetiredExposures = {};
  assert.throws(() => changedExposures.project(projected), { code: "RUNTIME_RETIREMENT_CHANGED" });
});

for (const state of ["unknown", "terminal", "queued"]) {
  test(`a successor root preserves ${state} observer history without operational authorization`, () => {
    const f = successorFixture(state);
    const projected = f.project();
    const restored = new core.QueueDomain({
      snapshot: projected, recover: true, runtimeRetirement: f.authority, hash,
      now: () => 400, newId: () => "never-rearmed-observer",
    });
    const observer = f.current.jobs[f.previous.observer.id];
    assert.deepEqual(restored.data.jobs[observer.id], observer);
    assert.equal(restored.submit(observer.request).id, observer.id, "old request stays historical");
    restored.pause(false);
    assert.equal(restored.next(), null, "retired observation cannot acquire another SDK turn");
    const altered = structuredClone(projected);
    altered.jobs[observer.id].workflowObservation.reportPath = "/forged-successor-history";
    assert.throws(() => new core.QueueDomain({
      snapshot: altered, recover: true, runtimeRetirement: f.authority, hash,
      now: () => 400, newId: () => "never-replayed-forgery",
    }));
  });
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

function metadataFixture() {
  const f = fixture();
  let id = 0;
  const domain = new core.QueueDomain({
    snapshot: f.project(), runtimeRetirement: f.authority,
    now: () => 200, newId: () => "metadata-" + ++id, hash,
  });
  domain.pause(false);
  const request = {
    kind: "command", requestId: "metadata-public-request", clientId: "metadata-owner",
    argv: ["doc", "list"], cwd: "/owned-fixture", timeoutMs: 1000,
  };
  const marker = {
    version: 1, requestHash: hash(core.canonical(request)),
    generation: "current-generation", programHash: "a".repeat(64), rpcHash: "b".repeat(64),
  };
  const capability = domain.createDocumentMetadataReadAuthority(() => marker);
  return { f, domain, request, marker, capability };
}
test("private metadata admission preserves UNKNOWN and requires the exact one RPC", () => {
  const { f, domain, request, marker, capability } = metadataFixture();
  const read = domain.submitDocumentMetadataRead(request, capability);
  assert.equal(read.state, "queued");
  assert.equal(domain.next().id, read.id);
  domain.assertDocumentMetadataRead(read.id, marker.programHash, marker.rpcHash);
  assert.throws(() => domain.assertDocumentMetadataRead(read.id, "c".repeat(64), marker.rpcHash),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
  assert.throws(() => domain.assertDocumentMetadataRead(read.id, marker.programHash, "d".repeat(64)),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
  domain.markDispatch(read.id, { rpcCount: 1, completedCount: 0, rpcId: "first-read-rpc" });
  assert.throws(() => domain.assertDocumentMetadataRead(read.id, marker.programHash, marker.rpcHash),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
  domain.assertDocumentMetadataRead(read.id, marker.programHash, marker.rpcHash, "first-read-rpc");
  assert.throws(() => domain.assertDocumentMetadataRead(read.id, marker.programHash, marker.rpcHash, "second-rpc"),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
  assert.deepEqual(domain.data.jobs[f.old.id], f.frozen.jobs[f.old.id]);
});
test("a metadata intent cannot replace its original RPC under unchanged counters", () => {
  const { domain, request, marker, capability } = metadataFixture();
  const read = domain.submitDocumentMetadataRead(request, capability);
  domain.next();
  domain.markDispatch(read.id, { rpcCount: 1, completedCount: 0, rpcId: "original-rpc" });
  const before = structuredClone(domain.data);
  for (const rpcId of ["replacement-rpc", "original-rpc"]) {
    assert.throws(() => domain.markDispatch(read.id, { rpcCount: 1, completedCount: 0, rpcId }),
      { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
    assert.deepEqual(domain.data, before);
  }
  domain.assertDocumentMetadataRead(read.id, marker.programHash, marker.rpcHash, "original-rpc");
  assert.throws(() => domain.assertDocumentMetadataRead(read.id, marker.programHash, marker.rpcHash, "replacement-rpc"),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
  domain.markDispatch(read.id, {
    rpcCount: 1, completedCount: 1, rpcId: "original-rpc", rpcState: "terminal",
  });
  assert.equal(domain.data.jobs[read.id].dispatch.completedCount, 1);
});
test("metadata original RPC identity is not authority from mutable dispatch JSON", () => {
  const { domain, request, marker, capability } = metadataFixture();
  const read = domain.submitDocumentMetadataRead(request, capability);
  domain.next();
  domain.markDispatch(read.id, { rpcCount: 1, completedCount: 0, rpcId: "original-rpc" });
  domain.data.jobs[read.id].dispatch.details.rpcId = "replacement-rpc";
  assert.throws(() => domain.assertDocumentMetadataRead(read.id, marker.programHash, marker.rpcHash, "replacement-rpc"),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
});
test("metadata authority cannot upgrade an existing refused request", () => {
  const { domain, request, marker, capability } = metadataFixture();
  const old = domain.submit(request);
  assert.equal(old.code, "UNKNOWN_SCOPE_UNPROVEN");
  assert.equal(domain.submitDocumentMetadataRead(request, capability).id, old.id);
  assert.equal(domain.hasDocumentMetadataRead(old.id), false);
  assert.throws(() => domain.assertDocumentMetadataRead(old.id, marker.programHash, marker.rpcHash),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
});
test("verifier reentry cannot replace authority of an already admitted metadata read", () => {
  const { domain, request, marker, capability } = metadataFixture();
  let nested;
  const replacement = domain.createDocumentMetadataReadAuthority(() => {
    nested ??= domain.submitDocumentMetadataRead(request, capability);
    return { ...marker, programHash: "f".repeat(64) };
  });
  const result = domain.submitDocumentMetadataRead(request, replacement);
  assert.equal(result.id, nested.id);
  assert.equal(domain.next().id, nested.id);
  domain.assertDocumentMetadataRead(nested.id, marker.programHash, marker.rpcHash);
  assert.throws(() => domain.assertDocumentMetadataRead(nested.id, "f".repeat(64), marker.rpcHash),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
});
test("caller flags or serialized metadata markers do not authorize a read or write", () => {
  for (const argv of [["doc", "list"], ["param", "apply", '{"name":"unsafe","expression":"1mm"}']]) {
    const { domain, request, marker } = metadataFixture();
    const result = domain.submit({
      ...request, argv, readOnly: true, documentMetadataRead: marker,
      payload: { readOnly: true, documentMetadataRead: marker },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.code, "UNKNOWN_SCOPE_UNPROVEN");
    assert.equal(domain.hasDocumentMetadataRead(result.id), false);
  }
});
test("changed metadata proof is refused before scheduling", () => {
  const { domain, request, marker, capability } = metadataFixture();
  const read = domain.submitDocumentMetadataRead(request, capability);
  marker.generation = "replacement-generation";
  assert.equal(domain.next(), null);
  assert.equal(domain.data.jobs[read.id].state, "failed");
});
test("a changed metadata request cannot keep its original compiler authority", () => {
  const { domain, request, capability } = metadataFixture();
  const read = domain.submitDocumentMetadataRead(request, capability);
  domain.data.jobs[read.id].request.argv = ["run", "untrusted.py"];
  assert.equal(domain.next(), null);
  assert.equal(domain.data.jobs[read.id].state, "failed");
});
test("a persisted metadata marker is not interchangeable with its private binding", () => {
  const { domain, request, capability } = metadataFixture();
  const read = domain.submitDocumentMetadataRead(request, capability);
  domain.data.jobs[read.id].documentMetadataRead.rpcHash = "e".repeat(64);
  assert.equal(domain.next(), null);
  assert.equal(domain.data.jobs[read.id].state, "failed");
});
test("metadata proof storage faults stay faults, not ordinary expiration", () => {
  const { domain, request, marker } = metadataFixture();
  let unavailable = false;
  const cap = domain.createDocumentMetadataReadAuthority(() => {
    if (unavailable) throw Object.assign(new Error("owned verifier storage failed"), { code: "EIO" });
    return marker;
  });
  const read = domain.submitDocumentMetadataRead(request, cap);
  unavailable = true;
  assert.throws(() => domain.next(), { code: "EIO" });
  assert.equal(domain.data.jobs[read.id].state, "queued");
  assert.equal(domain.data.active, null);
});
test("metadata authority does not survive JSON restore or raw UNKNOWN", () => {
  const { f, domain, request, capability } = metadataFixture();
  const read = domain.submitDocumentMetadataRead(request, capability);
  const restored = new core.QueueDomain({
    snapshot: structuredClone(domain.data), runtimeRetirement: f.authority, hash,
    now: () => 201, newId: () => "restore-unused",
  });
  assert.equal(restored.hasDocumentMetadataRead(read.id), false);
  assert.equal(restored.next(), null);
  assert.equal(restored.data.jobs[read.id].state, "failed");
  const raw = new core.QueueDomain({
    snapshot: f.frozen, hash, now: () => 201, newId: () => "raw-unused",
  });
  const rawCap = raw.createDocumentMetadataReadAuthority(() => ({
    version: 1, requestHash: hash(core.canonical(request)),
    generation: "unverified", programHash: "a".repeat(64), rpcHash: "b".repeat(64),
  }));
  assert.throws(() => raw.submitDocumentMetadataRead(request, rawCap),
    { code: "DOCUMENT_METADATA_READ_UNPROVEN" });
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

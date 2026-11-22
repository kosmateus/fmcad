const assert = require("node:assert/strict");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const core = require("@fmcad/core");
const retirement = require("../packages/core/dist/domain/runtime-retirement.js");
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Domain admission only: source/native authentication and the actual Python
// guarded write are separate host/live contracts, not simulated successes here.
function fixture() {
  let ids = 0;
  const first = new core.QueueDomain({
    now: () => 100,
    newId: () => "old-job",
    hash,
  });
  first.submit({
    kind: "rpc",
    clientId: "old-owner",
    requestId: "old-request",
    timeoutMs: 1000,
    payload: { method: "tools/call", params: { name: "execute_python" } },
  });
  first.next();
  first.markDispatch("old-job");
  first.block("old-job", { code: "ORIGINAL_UNKNOWN" });
  const frozen = structuredClone(first.data);
  const old = frozen.jobs["old-job"];
  const marker = {
    rootHead: "native-root",
    recordDigest: "a".repeat(64),
    layer: "root",
    frozenDigest: hash(JSON.stringify(frozen)),
  };
  const exposure = {
    kind: "runtime_retired",
    key: "root:old-job",
    rootHead: marker.rootHead,
    recordDigest: marker.recordDigest,
    layer: "root",
    entryDigest: hash(core.canonical(old)),
    target: null,
    source: {
      kind: "job",
      jobId: old.id,
      requestId: old.requestId,
      clientId: old.clientId,
      jobHash: old.hash,
      catalogDigest: hash(core.canonical(old.dispatch)),
    },
  };
  const rootAuthority = retirement.createRuntimeRetirementAuthority(() => ({
    marker,
    frozen,
    currentSnapshotDigest: marker.frozenDigest,
    jobs: { [old.id]: { original: old, outcome: "unknown" } },
    exposures: { [exposure.key]: exposure },
  }));
  const projected = retirement.projectRuntimeRetirement(
    frozen,
    rootAuthority,
    core.canonical,
    hash,
    200,
  );
  const options = {
    now: () => 200,
    newId: () => "new-" + ++ids,
    hash,
    runtimeRetirement: rootAuthority,
  };
  const domain = new core.QueueDomain({ ...options, snapshot: projected });
  const target = { creationId: "doc-A" };
  const observation = {
    version: 1,
    id: "observation-A",
    requestId: "inspect-A",
    actorClientId: "successor",
    target,
    generation: "current-generation",
    scope: "parameters",
    stateDigest: "b".repeat(64),
    readback: {
      reference: "owned:checkpoint",
      sha256: "c".repeat(64),
      probeRequestId: "probe-A",
    },
    blockers: domain.documentConflicts(target).map((item) => ({
      jobId: item.jobId,
      requestId: item.requestId,
      originalHash: item.jobHash,
      catalogDigest: item.catalogDigest,
      barrierRef: item.evidenceReference,
    })),
    priorCheckpointId: null,
    createdAt: 200,
  };
  domain.recordDocumentObservation(observation);
  const acceptance = domain.acceptDocumentObservation({
    observationId: observation.id,
    requestId: "accept-A",
    actorClientId: "successor",
    generation: observation.generation,
    observedStateDigest: observation.stateDigest,
  });
  const request = {
    kind: "command",
    clientId: "successor",
    requestId: "guarded-write",
    argv: ["param", "apply", "--doc-id", "doc-A"],
    cwd: "/owned-fixture",
    timeoutMs: 1000,
    payload: {
      kind: "cad",
      version: 1,
      operation: "param.apply",
      docId: "doc-A",
      data: { parameters: [{ name: "width", expression: "10 mm" }] },
    },
  };
  request.argv = core.catalogPolicyArguments(request.payload);
  const permit = {
    version: 1,
    actorClientId: request.clientId,
    requestHash: hash(core.canonical(request)),
    target,
    generation: observation.generation,
    observationId: observation.id,
    acceptanceId: acceptance.id,
    stateDigest: observation.stateDigest,
    blockersDigest: domain.documentInspectionFence(
      target,
      observation.generation,
    ).blockersDigest,
    sourceHash: "d".repeat(64),
  };
  let authorized = true;
  const authority = domain.createDocumentContinuationAuthority(() => {
    if (!authorized)
      throw Object.assign(new Error("authorization revoked"), {
        code: "NOT_AUTHORIZED",
      });
    return permit;
  });
  return {
    domain,
    options,
    frozen,
    old,
    observation,
    acceptance,
    request,
    permit,
    authority,
    revoke() {
      authorized = false;
    },
  };
}

test("deduplicated requests never rearm an old job after restart", () => {
  const f = fixture();
  const original = f.domain.submitDocumentContinuation(f.request, f.authority);
  const restored = new core.QueueDomain({
    ...f.options,
    snapshot: f.domain.data,
  });
  const freshAuthority = restored.createDocumentContinuationAuthority(
    () => f.permit,
  );
  assert.equal(
    restored.submitDocumentContinuation(f.request, freshAuthority).id,
    original.id,
  );
  assert.equal(restored.next(), null);
  assert.equal(restored.data.jobs[original.id].state, "failed");
});
test("a fresh phased continuation keeps its capability through preparation", () => {
  const f = fixture();
  assert.deepEqual(
    f.request.argv,
    core.catalogPolicyArguments(f.request.payload),
  );
  assert.deepEqual(f.request.argv.slice(0, 3), ["cad", "param", "apply"]);
  f.request.phased = true;
  f.permit.requestHash = hash(core.canonical(f.request));
  const job = f.domain.submitDocumentContinuation(f.request, f.authority);
  assert.equal(job.state, "preparing");
  assert.equal(f.domain.assertDocumentContinuation(job.id, f.permit.sourceHash).acceptanceId, f.acceptance.id);
  assert.equal(f.domain.data.active, null);
  assert.equal(f.domain.data.jobs[job.id].dispatch, undefined);
  f.domain.readyTurn(job.id);
  assert.equal(f.domain.next().id, job.id);
});
for (const change of ["argv", "version"]) {
  test(`continuation refuses contradictory ${change} even with matching request hash`, () => {
    const f = fixture();
    if (change === "argv")
      f.request.argv = ["param", "inspect", "--doc-id", "doc-A"];
    else f.request.payload.version = 2;
    f.permit.requestHash = hash(core.canonical(f.request));
    assert.throws(
      () => f.domain.submitDocumentContinuation(f.request, f.authority),
      { code: "DOCUMENT_CONTINUATION_UNPROVEN" },
    );
  });
}
test("a capacity-refused stale-job cleanup does not revoke the private capability", () => {
  const f = fixture();
  const job = f.domain.submitDocumentContinuation(f.request, f.authority);
  let valid = false;
  const head =
    f.domain.data.documentCheckpoints.heads[
      core.documentTargetKey(f.permit.target)
    ];
  f.domain.data.documentCheckpoints.heads[
    core.documentTargetKey(f.permit.target)
  ] = "new-head";
  f.domain.commit = () => {
    if (!valid)
      throw Object.assign(new Error("capacity"), {
        code: "SNAPSHOT_TOO_LARGE",
      });
  };
  assert.throws(() => f.domain.next(), { code: "SNAPSHOT_TOO_LARGE" });
  valid = true;
  f.domain.data.documentCheckpoints.heads[
    core.documentTargetKey(f.permit.target)
  ] = head;
  assert.equal(f.domain.next().id, job.id);
});
for (const code of [
  "EPOCH_CLIENT_NOT_GRANTED",
  "DOCUMENT_UNLOCK_NOT_AUTHENTICATED",
]) {
  test(`${code} cannot block a different valid continuation`, () => {
    const f = fixture();
    let revoked = false;
    const expired = f.domain.submitDocumentContinuation(
      f.request,
      f.domain.createDocumentContinuationAuthority(() => {
        if (revoked)
          throw Object.assign(new Error("grant revoked"), {
            code,
          });
        return f.permit;
      }),
    );
    const request = { ...f.request, requestId: "valid-next" };
    const permit = { ...f.permit, requestHash: hash(core.canonical(request)) };
    const fresh = f.domain.submitDocumentContinuation(
      request,
      f.domain.createDocumentContinuationAuthority(() => permit),
    );
    revoked = true;
    assert.equal(f.domain.next().id, fresh.id);
    assert.equal(f.domain.data.jobs[expired.id].state, "failed");
  });
}
test("acceptance alone does not bypass UNKNOWN; one exact private guarded write may proceed", () => {
  const f = fixture();
  const ordinary = f.domain.submit({
    ...f.request,
    requestId: "ordinary-write",
  });
  assert.equal(ordinary.state, "failed");
  assert.equal(ordinary.code, "DOCUMENT_UNLOCK_REQUIRED");
  const admitted = f.domain.submitDocumentContinuation(f.request, f.authority);
  assert.equal(admitted.state, "queued");
  assert.equal(f.domain.next().id, admitted.id);
  assert.throws(
    () => f.domain.assertDocumentContinuation(admitted.id, "e".repeat(64)),
    { code: "CHECKPOINT_CHANGED" },
  );
  assert.equal(
    f.domain.assertDocumentContinuation(admitted.id, f.permit.sourceHash)
      .acceptanceId,
    f.acceptance.id,
  );
  f.domain.markDispatch(admitted.id);
  assert.deepEqual(f.domain.data.jobs[f.old.id], f.old);
});
test("a JSON copy of a private authority cannot enqueue a continuation", () => {
  const f = fixture();
  assert.throws(
    () =>
      f.domain.submitDocumentContinuation(
        f.request,
        JSON.parse(JSON.stringify(f.authority)),
      ),
    { code: "DOCUMENT_CONTINUATION_UNPROVEN" },
  );
});
test("queued continuation after restart has no executable authority and is refused, not replayed", () => {
  const f = fixture();
  const admitted = f.domain.submitDocumentContinuation(f.request, f.authority);
  const reopened = new core.QueueDomain({
    ...f.options,
    snapshot: f.domain.data,
  });
  assert.equal(reopened.next(), null);
  assert.equal(reopened.data.jobs[admitted.id].state, "failed");
  assert.equal(reopened.data.jobs[admitted.id].code, "CHECKPOINT_CHANGED");
  assert.equal(reopened.data.jobs[admitted.id].details.mayHaveMutated, false);
  assert.deepEqual(reopened.data.jobs[f.old.id], f.old);
});
test("revoked live authorization cannot grant a queued guarded write", () => {
  const f = fixture();
  const result = f.domain.submitDocumentContinuation(f.request, f.authority);
  f.revoke();
  assert.equal(f.domain.next(), null);
  assert.equal(f.domain.data.active, null);
  assert.equal(f.domain.data.jobs[result.id].state, "failed");
});
test("a newer checkpoint invalidates queued continuation without changing its immutable request", () => {
  const f = fixture();
  const admitted = f.domain.submitDocumentContinuation(f.request, f.authority);
  const next = {
    ...f.observation,
    id: "observation-next",
    requestId: "inspect-next",
    priorCheckpointId: f.acceptance.id,
  };
  f.domain.recordDocumentObservation(next);
  f.domain.acceptDocumentObservation({
    observationId: next.id,
    requestId: "accept-next",
    actorClientId: "successor",
    generation: next.generation,
    observedStateDigest: next.stateDigest,
  });
  assert.equal(f.domain.next(), null);
  assert.equal(f.domain.data.jobs[admitted.id].state, "failed");
  assert.deepEqual(
    f.domain.submitDocumentContinuation(f.request, f.authority),
    f.domain.status(admitted.id),
  );
  assert.deepEqual(f.domain.data.jobs[admitted.id].request, f.request);
});
test("changed actor, target, generation, digest or operation cannot inherit the permit", () => {
  for (const changed of [
    "actor",
    "target",
    "generation",
    "digest",
    "operation",
    "source",
    "acceptance",
    "observation",
    "blockers",
    "request",
    "preview",
    "component",
  ]) {
    const f = fixture();
    if (changed === "actor") f.request.clientId = "foreign";
    if (changed === "target") f.request.payload.docId = "doc-B";
    if (changed === "generation") f.permit.generation = "stale-generation";
    if (changed === "digest") f.permit.stateDigest = "f".repeat(64);
    if (changed === "operation") f.request.payload.operation = "document.close";
    if (changed === "source") f.permit.sourceHash = "not-a-digest";
    if (changed === "acceptance") f.permit.acceptanceId = "missing-acceptance";
    if (changed === "observation")
      f.permit.observationId = "missing-observation";
    if (changed === "blockers") f.permit.blockersDigest = "f".repeat(64);
    if (changed === "request")
      f.request.payload.data.parameters[0].expression = "20 mm";
    if (changed === "preview") f.request.payload.preview = true;
    if (changed === "component")
      f.request.payload.component = "foreign-component";
    if (changed !== "request")
      f.permit.requestHash = hash(core.canonical(f.request));
    assert.throws(
      () => f.domain.submitDocumentContinuation(f.request, f.authority),
      { code: "DOCUMENT_CONTINUATION_UNPROVEN" },
      changed,
    );
    assert.deepEqual(f.domain.data.jobs[f.old.id], f.old);
  }
});
test("public JSON metadata cannot request the private continuation exception", () => {
  const f = fixture();
  const result = f.domain.submit({
    ...f.request,
    documentContinuation: f.permit,
  });
  assert.equal(result.state, "failed");
  assert.equal(f.domain.data.jobs[result.id].documentContinuation, undefined);
  assert.equal(f.domain.next(), null);
});
test("a continuation preserves manual pause and cannot replace a peer lease", () => {
  const f = fixture();
  const result = f.domain.submitDocumentContinuation(f.request, f.authority);
  f.domain.pause(true);
  assert.equal(f.domain.next(), null);
  assert.equal(f.domain.data.paused, true);
  assert.equal(f.domain.data.jobs[result.id].state, "queued");
  f.domain.pause(false);
  f.domain.data.lease = {
    id: "peer-lease",
    clientId: "peer",
    epoch: f.domain.data.epoch,
    createdAt: 200,
    idleUntil: 1000,
    holdUntil: 1000,
  };
  assert.equal(f.domain.next(), null);
  assert.equal(f.domain.data.lease.clientId, "peer");
});
test("mutated original request data cannot reuse an otherwise matching capability", () => {
  const f = fixture();
  const result = f.domain.submitDocumentContinuation(f.request, f.authority);
  f.domain.data.jobs[result.id].request.payload.data.parameters[0].expression =
    "30 mm";
  assert.equal(f.domain.next(), null);
  assert.equal(f.domain.data.jobs[result.id].state, "failed");
  assert.equal(f.domain.data.jobs[result.id].dispatch, undefined);
});
test("a capability from one queue instance cannot authorize an identical second queue", () => {
  const f = fixture();
  const other = new core.QueueDomain({ ...f.options, snapshot: f.domain.data });
  assert.throws(
    () => other.submitDocumentContinuation(f.request, f.authority),
    { code: "DOCUMENT_CONTINUATION_UNPROVEN" },
  );
  assert.equal(other.data.active, null);
});
test("an expired queued capability does not block a newer valid request", () => {
  const f = fixture();
  const expired = f.domain.submitDocumentContinuation(f.request, f.authority);
  const request = { ...f.request, requestId: "fresh-guarded-write" };
  const permit = { ...f.permit, requestHash: hash(core.canonical(request)) };
  const fresh = f.domain.submitDocumentContinuation(
    request,
    f.domain.createDocumentContinuationAuthority(() => permit),
  );
  f.revoke();
  assert.equal(f.domain.next().id, fresh.id);
  assert.equal(f.domain.data.jobs[expired.id].state, "failed");
});
for (const mode of ["resolve", "reject"]) {
  test(`an asynchronously ${mode}d verifier cannot authorize a write or terminate its process`, () => {
    const code = `
const assert = require("node:assert/strict");
const core = require("@fmcad/core");
const retirement = require(${JSON.stringify(path.join(__dirname, "../packages/core/dist/domain/runtime-retirement.js"))});
const hash = (value) => require("node:crypto").createHash("sha256").update(value).digest("hex");
const fixture = ${fixture.toString()};
const f = fixture();
const authority = f.domain.createDocumentContinuationAuthority(() =>
  ${mode === "resolve" ? "Promise.resolve(f.permit)" : 'Promise.reject(new Error("private async verifier failure"))'});
assert.throws(() => f.domain.submitDocumentContinuation(f.request, authority),
  { code: "DOCUMENT_CONTINUATION_UNPROVEN" });
assert.equal(f.domain.data.active, null);
setImmediate(() => {
  assert.deepEqual(f.domain.data.jobs[f.old.id], f.old);
  assert.equal(Object.keys(f.domain.data.jobs).length, 1);
  console.log("REFUSED_NO_CONTINUATION");
});`;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["-e", code], {
      encoding: "utf8",
      cwd: path.join(__dirname, ".."),
      env,
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /REFUSED_NO_CONTINUATION/);
  });
}
test("changing the prepared source after enqueue cannot publish a physical dispatch", () => {
  const f = fixture();
  const admitted = f.domain.submitDocumentContinuation(f.request, f.authority);
  f.permit.sourceHash = "e".repeat(64);
  assert.equal(f.domain.next(), null);
  assert.equal(f.domain.data.jobs[admitted.id].state, "failed");
  assert.equal(f.domain.data.jobs[admitted.id].dispatch, undefined);
});

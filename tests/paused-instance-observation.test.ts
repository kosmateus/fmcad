import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { QueueDomain } from "../packages/core/src/domain/queue";
import {
  canonical,
  hash as canonicalHash,
} from "../packages/core/src/application/cad/json";
import {
  createRuntimeRetirementAuthority,
  projectRuntimeRetirement,
} from "../packages/core/src/domain/runtime-retirement";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function fixture() {
  let id = 0;
  const options = { now: () => 1000, newId: () => `paused-${++id}`, hash };
  const state = new QueueDomain(options);
  const request = {
    kind: "rpc" as const,
    clientId: "owner",
    requestId: "original",
    timeoutMs: 30000,
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  };
  return { state, options, request };
}

test("paused identity observation fences epoch once without changing pause/control/history or admitting work", () => {
  const { state } = fixture();
  state.pause(true, "operator-pause");
  const before = structuredClone(state.data);
  assert.throws(() => state.observePausedInstanceEpoch(""), {
    code: "INVALID_TRANSITION",
  });
  assert.deepEqual(state.data, before);
  const result = state.observePausedInstanceEpoch("cold-instance");
  assert.equal(result.alreadyApplied, false);
  assert.deepEqual(state.data, {
    ...before,
    revision: before.revision + 1,
    epoch: before.epoch + 1,
    lastInstanceTransitionId: "cold-instance",
  });
  assert.equal(state.next(), null);
  const committed = structuredClone(state.data);
  assert.equal(
    state.observePausedInstanceEpoch("cold-instance").alreadyApplied,
    true,
  );
  assert.deepEqual(state.data, committed);
  assert.throws(() => state.advanceInstanceEpoch("ordinary-recovery"), {
    code: "MANUAL_PAUSE",
  });
  state.pause(false, "explicit-owner-resume");
  assert.throws(() => state.observePausedInstanceEpoch("unpaused-misuse"), {
    code: "PAUSED_STARTUP_REQUIRED",
  });
});

test("paused observation refuses active/lease/queued/control uncertainty without changing durable state", () => {
  for (const mode of ["active", "queued", "lease", "control"] as const) {
    const { state, request } = fixture();
    if (mode === "control") state.beginControlProbe("unsettled-control");
    else if (mode === "lease") {
      const id = String(
        state.submit({
          ...request,
          sequence: { action: "begin", mode: "exclusive" },
        })["id"],
      );
      state.next();
      state.finish(id, { state: "succeeded" });
      assert.ok(state.data.lease);
    } else {
      state.submit(request);
      if (mode === "active") state.next();
    }
    state.pause(true, "operator-pause");
    const before = structuredClone(state.data);
    assert.throws(() => state.observePausedInstanceEpoch("cold-instance"), {
      code: "QUEUE_NOT_QUIESCENT",
    });
    assert.deepEqual(state.data, before);
  }
});

test("a restored local UNKNOWN independently prevents paused observation", () => {
  const { state, options, request } = fixture();
  state.submit({ ...request, requestId: "other-active-turn" });
  state.next();
  const id = String(
    state.submit({
      ...request,
      kind: "command",
      phased: true,
      argv: ["fixture"],
      cwd: "/owned-offline-fixture",
    })["id"],
  );
  state.blockLocal(id, "UNVERIFIED_LOCAL_RESULT");
  state.pause(true, "operator-pause");
  // Restore boundary: even a detached local fence must not be ignored simply
  // because no physical active/blocked marker is present.
  const restored = new QueueDomain({
    ...options,
    recover: false,
    snapshot: { ...structuredClone(state.data), active: null, blocked: null },
  });
  const before = structuredClone(restored.data);
  assert.ok(before.localUnknown);
  assert.throws(() => restored.observePausedInstanceEpoch("cold-instance"), {
    code: "QUEUE_NOT_QUIESCENT",
  });
  assert.deepEqual(restored.data, before);
});

test("only verified runtime-retired UNKNOWN permits paused observation and its original job remains exact", () => {
  const { state: original, options, request } = fixture();
  const oldId = String(original.submit(request)["id"]);
  original.next();
  original.markDispatch(oldId);
  original.block(oldId, { code: "PRESERVED_UNKNOWN" });
  original.pause(true, "operator-pause");
  assert.throws(() => original.observePausedInstanceEpoch("cold-instance"), {
    code: "QUEUE_NOT_QUIESCENT",
  });
  const frozen = structuredClone(original.data),
    old = frozen.jobs[oldId]!;
  const marker = {
    rootHead: "a".repeat(64),
    recordDigest: "b".repeat(64),
    layer: "root",
    frozenDigest: hash(JSON.stringify(frozen)),
  };
  const exposure = {
    kind: "runtime_retired" as const,
    key: "root:" + oldId,
    rootHead: marker.rootHead,
    recordDigest: marker.recordDigest,
    layer: marker.layer,
    entryDigest: canonicalHash(old),
    target: null,
    source: {
      kind: "job" as const,
      jobId: oldId,
      requestId: old.requestId,
      clientId: old.clientId,
      jobHash: old.hash,
      catalogDigest: canonicalHash(old.dispatch),
    },
  };
  const retirement = createRuntimeRetirementAuthority(() => ({
    marker,
    frozen,
    currentSnapshotDigest: marker.frozenDigest,
    jobs: { [oldId]: { original: old, outcome: "unknown" } },
    exposures: { [exposure.key]: exposure },
  }));
  const state = new QueueDomain({
    ...options,
    runtimeRetirement: retirement,
    snapshot: projectRuntimeRetirement(
      frozen,
      retirement,
      canonical,
      hash,
      200,
    ),
  });
  const before = structuredClone(state.data);
  state.observePausedInstanceEpoch("cold-instance");
  assert.equal(state.data.paused, true);
  assert.deepEqual(state.data.jobs, before.jobs);
  assert.deepEqual(
    state.data.runtimeRetiredExposures,
    before.runtimeRetiredExposures,
  );
  assert.deepEqual(
    state.data.appliedRuntimeRetirement,
    before.appliedRuntimeRetirement,
  );
  assert.equal(state.data.jobs[oldId]?.state, old.state);
  assert.deepEqual(
    state.data.jobs[oldId],
    old,
    "retirement never settles or rewrites the original UNKNOWN",
  );
  assert.equal(state.next(), null);
});

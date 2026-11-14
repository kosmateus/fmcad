import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type { DeadEpochFixture } from "./fixtures/epoch-fixture-types";
const repository = process.cwd();
const load = createRequire(
  path.join(repository, "tests", "dead-epoch-successor.test.js"),
);

const api = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const lineage = load(
  "../src/queue-epoch-lineage",
) as typeof import("../src/queue-epoch-lineage");
const { openIsolatedEpoch, isolatedEpochDirectory } = load(
  "../src/queue-isolated-epoch",
) as typeof import("../src/queue-isolated-epoch");
const { assertSuccessorApproval, assertCurrentPredecessor } = load(
  "../src/queue-epoch-successor",
) as typeof import("../src/composition/queue-epoch-successor");
const { inspectSuccessor } = load(
  "../src/queue-epoch-successor",
) as typeof import("../src/composition/queue-epoch-successor");

type PublishedBackend = {
  pointer: DeadEpochFixture["pointer"];
  entry: DeadEpochFixture["authorityEntry"];
  identity: DeadEpochFixture["identity"];
  authority: DeadEpochFixture["authority"];
};
function backendFixture(t: TestContext) {
  t.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
  const base = fs.mkdtempSync("/tmp/opencode/backend-successor-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return (
    load("./fixtures/backend-successor.cjs") as (
      base: string,
      repo: string,
    ) => DeadEpochFixture & {
      client: Parameters<typeof inspectSuccessor>[0];
      approvalFile: string;
      headFile: string;
      transition: string;
      receiptFile: string;
      lifecycleFile: string;
      effectiveIdentity: { buildHash: string; configHash: string };
      inverse(): {
        cfg: DeadEpochFixture["cfg"];
        identity: { buildHash: string; configHash: string };
      };
      restoreAfterPublish(published: PublishedBackend): {
        cfg: DeadEpochFixture["cfg"];
        identity: DeadEpochFixture["identity"];
        owner: DeadEpochFixture["previousOwner"];
        audit: string;
        snapshot: DeadEpochFixture["authority"]["predecessor"];
        proof: NonNullable<DeadEpochFixture["authority"]["backendTransition"]>;
        head: Record<string, unknown>;
        transition: string;
      };
      publish(): {
        pointer: DeadEpochFixture["pointer"];
        entry: DeadEpochFixture["authorityEntry"];
        identity: DeadEpochFixture["identity"];
        authority: DeadEpochFixture["authority"];
      };
    }
  )(base, repository);
}

function changeBackendHead(
  f: ReturnType<typeof backendFixture>,
  change: (head: Record<string, unknown>) => void,
) {
  const head: unknown = api.readJson(f.headFile);
  assert.ok(head && typeof head === "object" && !Array.isArray(head));
  change(head as Record<string, unknown>);
  api.durable(f.headFile, head);
  api.durable(path.join(f.transition, "transition.json"), head);
  api.durable(f.approvalFile, {
    ...f.approval,
    physicalBackendHead: lineage.reference(f.headFile),
  });
}

test("FAKE backend succession: verified effective head permits cold inspection while original unknown/history stay immutable", (t) => {
  const f = backendFixture(t);
  const files = [
    path.join(f.dir, "queue-state.json"),
    path.join(f.inspection.pointer.root, "queue-state.json"),
    path.join(f.dir, "instance.json"),
    path.join(f.inspection.pointer.root, "instance.json"),
    path.join(f.dir, "isolated-admission-epoch.json"),
    f.headFile,
  ];
  const before = files.map((file) => fs.readFileSync(file));
  const inspection = inspectSuccessor(
    f.client,
    f.cfg,
    f.approvalFile,
    f.requestId,
  );
  assert.equal(inspection.identity.buildHash, f.inspection.identity.buildHash);
  assert.equal(
    inspection.previousLifecycle.buildHash,
    f.effectiveIdentity.buildHash,
  );
  assert.equal(inspection.previousProcessAlive, false);
  for (const [index, file] of files.entries())
    assert.deepEqual(fs.readFileSync(file), before[index]);
  assert.equal(
    openIsolatedEpoch(f.dir, { recover: false }).lookup(f.priorJob.id)!.state,
    "running",
  );
});

test("FAKE backend succession: published lineage reopens against archived pointer and preserves old SDK/history", (t) => {
  const f = backendFixture(t);
  const protectedFiles = [
    path.join(f.inspection.pointer.root, "instance.json"),
    path.join(f.inspection.pointer.root, "queue-state.json"),
    path.join(f.dir, "instance.json"),
    path.join(f.dir, "queue-state.json"),
    f.headFile,
    f.lifecycleFile,
    f.receiptFile,
  ];
  const before = protectedFiles.map((file) => fs.readFileSync(file));
  const published = f.publish();
  const ancestry = lineage.epochLineage(f.dir, { ...published.pointer });
  assert.equal(
    ancestry[0]!.effectiveIdentity!.buildHash,
    f.effectiveIdentity.buildHash,
  );
  assert.equal(
    ancestry[0]!.effectiveIdentity!.configHash,
    f.effectiveIdentity.configHash,
  );
  assert.deepEqual(ancestry[0]!.effectiveIdentity!.instance, {
    pid: f.inspection.pointer.currentInstance.pid,
    birth: f.inspection.pointer.currentInstance.birth,
    version: f.inspection.pointer.currentInstance.version,
  });
  assert.equal(ancestry[0]!.authority.historicalOutcome, "unknown");
  assert.equal(
    ancestry[0]!.identity["buildHash"],
    f.inspection.identity.buildHash,
  );
  const reopened = openIsolatedEpoch(f.dir, { recover: false });
  assert.equal(reopened.status(f.priorJob.id)["quarantined"], true);
  assert.equal(reopened.status(f.priorJob.id)["state"], "running");
  assert.throws(() => reopened.submit(f.priorJob.request), {
    code: "HISTORICAL_REQUEST_QUARANTINED",
  });
  assert.throws(() => reopened.resolve(f.priorJob.id, { state: "succeeded" }), {
    code: "INSTANCE_HISTORY_QUARANTINED",
  });
  for (const [index, file] of protectedFiles.entries())
    assert.deepEqual(fs.readFileSync(file), before[index]);
  const checked = assertCurrentPredecessor(f.dir, published.entry, {
    allowPublished: true,
  });
  assert.deepEqual(checked.effectiveIdentity, ancestry[0]!.effectiveIdentity);
  fs.appendFileSync(f.lifecycleFile, " ");
  assert.throws(() => lineage.epochLineage(f.dir, { ...published.pointer }), {
    code: "EPOCH_LINEAGE_INVALID",
  });
});

for (const [name, mutate] of [
  [
    "missing explicit approval pin",
    (f) => {
      const approval = { ...f.approval };
      delete approval.physicalBackendHead;
      api.durable(f.approvalFile, approval);
    },
  ],
  [
    "foreign owner",
    (f) => {
      f.client.auth.clientId = "foreign";
    },
  ],
  [
    "changed head",
    (f) => {
      fs.appendFileSync(f.headFile, " ");
    },
  ],
  [
    "changed startup receipt",
    (f) => {
      fs.appendFileSync(f.receiptFile, " ");
    },
  ],
  [
    "changed lifecycle",
    (f) => {
      const value = api.readJson(f.lifecycleFile);
      assert.ok(value && typeof value === "object");
      api.durable(f.lifecycleFile, { ...value, buildHash: "a".repeat(64) });
    },
  ],
  [
    "wrong selected process birth",
    (f) => {
      api.durable(f.approvalFile, {
        ...f.approval,
        expectedProcess: { pid: process.pid, birth: "wrong" },
      });
    },
  ],
  [
    "wrong candidate build",
    (f) => {
      api.durable(f.approvalFile, { ...f.approval, buildHash: "a".repeat(64) });
    },
  ],
  [
    "wrong approved head reference",
    (f) => {
      api.durable(f.approvalFile, {
        ...f.approval,
        physicalBackendHead: lineage.reference(f.lifecycleFile),
      });
    },
  ],
  [
    "self-consistent foreign head owner",
    (f) => {
      changeBackendHead(f, (head) => {
        head["ownerClientId"] = "foreign";
      });
    },
  ],
  [
    "self-consistent foreign head epoch",
    (f) => {
      changeBackendHead(f, (head) => {
        head["epochId"] = "foreign-epoch";
      });
    },
  ],
  [
    "self-consistent omitted root anchor",
    (f) => {
      changeBackendHead(f, (head) => {
        head["predecessor"] = (
          head["predecessor"] as Array<{ path: string }>
        ).filter((ref) => ref.path !== path.join(f.dir, "instance.json"));
      });
    },
  ],
  [
    "self-consistent wrong genesis config",
    (f) => {
      changeBackendHead(f, (head) => {
        const previous = { ...f.cfg, backend: "addin", timeoutMs: 34567 };
        head["previousConfig"] = previous;
        head["previousConfigHash"] = api.brokerConfigHash(previous);
      });
    },
  ],
  [
    "self-consistent missing observation",
    (f) => {
      changeBackendHead(f, (head) => {
        head["observation"] = [];
      });
    },
  ],
  [
    "self-consistent foreign SDK birth",
    (f) => {
      const file = path.join(f.transition, "instance.json");
      const identity = {
        ...f.effectiveIdentity,
        instance: {
          ...f.inspection.pointer.currentInstance,
          birth: "foreign-sdk",
        },
      };
      api.durable(file, identity);
      changeBackendHead(f, (head) => {
        head["identity"] = lineage.reference(file);
      });
    },
  ],
] satisfies ReadonlyArray<
  readonly [string, (f: ReturnType<typeof backendFixture>) => void]
>)
  test(
    "FAKE backend succession refuses " + name + " without any SDK authority",
    (t) => {
      const f = backendFixture(t);
      mutate(f);
      assert.throws(() =>
        inspectSuccessor(f.client, f.cfg, f.approvalFile, f.requestId),
      );
    },
  );

for (const observation of [true, null] as const)
  test(
    "FAKE backend succession: unresolved SDK process proof " +
      observation +
      " cannot authorize preserved unknown",
    (t) => {
      const f = backendFixture(t);
      const inspection = inspectSuccessor(
        f.client,
        f.cfg,
        f.approvalFile,
        f.requestId,
      );
      inspection.previousProcessAlive = observation;
      assert.throws(() => assertSuccessorApproval(inspection, f.approval), {
        code: "EPOCH_SUCCESSOR_FENCE_CHANGED",
      });
      inspection.previousProcessAlive = false;
      inspection.originalProcessAlive = observation;
      assert.throws(() => assertSuccessorApproval(inspection, f.approval), {
        code: "EPOCH_SUCCESSOR_FENCE_CHANGED",
      });
    },
  );

test("FAKE backend succession: removing persisted transition proof cannot turn effective backend into legacy", (t) => {
  const f = backendFixture(t),
    published = f.publish();
  const authority = { ...published.authority };
  delete authority.backendTransition;
  api.durable(published.entry.path, authority);
  assert.throws(
    () =>
      lineage.successionAuthority(
        f.dir,
        lineage.reference(published.entry.path),
      ),
    { code: "EPOCH_LINEAGE_INVALID" },
  );
});

test("FAKE backend succession: inverse transition verifies its entire escrowed predecessor chain", (t) => {
  const f = backendFixture(t),
    inverse = f.inverse();
  const inspection = inspectSuccessor(
    f.client,
    inverse.cfg,
    f.approvalFile,
    f.requestId,
  );
  assert.equal(
    inspection.previousLifecycle.buildHash,
    inverse.identity.buildHash,
  );
  assert.equal(inspection.configHash, f.inspection.identity.configHash);
  fs.appendFileSync(path.join(f.transition, "transition.json"), " ");
  assert.throws(() =>
    inspectSuccessor(f.client, inverse.cfg, f.approvalFile, f.requestId),
  );
});

test("FAKE backend succession: publish/restore/future cold read inherits the complete authenticated backend ancestry", (t) => {
  const f = backendFixture(t),
    published = f.publish(),
    restored = f.restoreAfterPublish(published);
  const verify = () =>
    lineage.successorBackendIdentity(
      f.dir,
      { ...published.pointer },
      restored.snapshot,
      restored.proof,
      restored.owner,
      restored.identity.configHash,
    );
  assert.equal(verify().configHash, f.inspection.identity.configHash);
  assert.equal(verify().buildHash, published.authority.buildHash);
  // New genesis does not treat the previous epoch's head/SDK as active escrow.
  assert.equal(
    fs.existsSync(path.join(restored.transition, "predecessor-head.json")),
    false,
  );
  const qualificationFile = path.join(
    restored.audit,
    "installed-qualification.json",
  );
  fs.copyFileSync(published.authority.qualification.path, qualificationFile);
  const authorityFile = path.join(restored.audit, "authority.json");
  api.durable(authorityFile, {
    ...published.authority,
    requestId: "synthetic-future-cold",
    predecessor: restored.snapshot,
    previousOwner: restored.owner,
    previousBuildHash: published.identity.buildHash,
    configHash: restored.identity.configHash,
    backendTransition: restored.proof,
    qualification: lineage.reference(qualificationFile),
    expectedProcess: { pid: 2147483644, birth: "synthetic-future-sdk" },
  });
  const authorityRef = lineage.reference(authorityFile);
  const future = () => lineage.successionAuthority(f.dir, authorityRef);
  assert.equal(
    future().effectiveIdentity!.configHash,
    restored.identity.configHash,
  );
  assert.equal(future().authority.historicalOutcome, "unknown");
  fs.appendFileSync(f.lifecycleFile, " ");
  assert.throws(verify, { code: "EPOCH_LINEAGE_INVALID" });
  assert.throws(future, { code: "EPOCH_LINEAGE_INVALID" });
});

test("FAKE backend succession: a self-consistent restore cannot omit its inherited authority anchor", (t) => {
  const f = backendFixture(t),
    published = f.publish(),
    restored = f.restoreAfterPublish(published);
  const head = {
    ...restored.head,
    predecessor: (
      restored.head["predecessor"] as Array<{ path: string }>
    ).filter((ref) => ref.path !== published.entry.path),
  };
  const file = path.join(restored.transition, "transition.json");
  api.durable(file, head);
  assert.throws(
    () =>
      lineage.successorBackendIdentity(
        f.dir,
        { ...published.pointer },
        restored.snapshot,
        { ...restored.proof, head: lineage.reference(file) },
        restored.owner,
        restored.identity.configHash,
      ),
    { code: "EPOCH_LINEAGE_INVALID" },
  );
});

test("FAKE backend succession: another cold scope without a current transition verifies inherited configuration origin", (t) => {
  const f = backendFixture(t),
    published = f.publish();
  const audit = path.join(
    f.dir,
    "epoch-successions",
    api.hash("synthetic-no-transition-cold"),
  );
  fs.mkdirSync(audit);
  const snapshot = lineage.predecessorSnapshot(f.dir, audit, true);
  const identity = lineage.successorEpochIdentity(
    f.dir,
    { ...published.pointer },
    snapshot,
  );
  assert.equal(identity.configHash, f.effectiveIdentity.configHash);
  const approval = {
    ...f.approval,
    requestId: "synthetic-no-transition-cold",
    predecessorEpochId: published.pointer.epochId,
    previousBuildHash: identity.buildHash,
    pointerHash: snapshot.pointer.sha256,
    stateHash: snapshot.state.sha256,
    expectedProcess: { pid: 2147483644, birth: "synthetic-future-sdk" },
  };
  delete approval.physicalBackendHead;
  const inspection = {
    ...f.inspection,
    root: f.dir,
    audit,
    requestId: approval.requestId,
    approval,
    snapshot,
    identity,
    configHash: identity.configHash,
    pointer: {
      ...f.inspection.pointer,
      ...published.pointer,
      quarantinedJobIds: f.inspection.pointer.quarantinedJobIds,
    },
    previousLifecycle: {
      ...f.inspection.previousLifecycle,
      buildHash: identity.buildHash,
      configHash: identity.configHash,
    },
    previousProcessAlive: false,
    expectedProcessAlive: true,
  };
  assertSuccessorApproval(inspection, approval);
  const qualificationFile = path.join(audit, "installed-qualification.json");
  fs.copyFileSync(published.authority.qualification.path, qualificationFile);
  const authority = {
    ...published.authority,
    requestId: approval.requestId,
    predecessor: snapshot,
    previousBuildHash: identity.buildHash,
    configHash: identity.configHash,
    expectedProcess: approval.expectedProcess,
    qualification: lineage.reference(qualificationFile),
  };
  delete authority.backendTransition;
  const authorityFile = path.join(audit, "authority.json");
  api.durable(authorityFile, authority);
  const futureRef = lineage.reference(authorityFile);
  assert.equal(
    lineage.successionAuthority(f.dir, futureRef).identity["configHash"],
    identity.configHash,
  );
  inspection.previousProcessAlive = true;
  assert.throws(() => assertSuccessorApproval(inspection, approval), {
    code: "EPOCH_SUCCESSOR_FENCE_CHANGED",
  });
  fs.appendFileSync(f.receiptFile, " ");
  assert.throws(() => lineage.successionAuthority(f.dir, futureRef), {
    code: "EPOCH_LINEAGE_INVALID",
  });
  assert.throws(
    () =>
      lineage.successorEpochIdentity(f.dir, { ...published.pointer }, snapshot),
    { code: "EPOCH_LINEAGE_INVALID" },
  );
});

function fixture(
  t: TestContext,
  options?: { oldProcessAlive?: boolean; inFlight?: boolean },
) {
  // Only spell Windows receipt paths for these synthetic physical ports.
  t.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dead-epoch-successor-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return (
    load("./fixtures/dead-epoch-successor.cjs") as (
      base: string,
      root: string,
      options?: { oldProcessAlive?: boolean; inFlight?: boolean },
    ) => DeadEpochFixture
  )(base, repository, options);
}

test("FAKE metadata: successor preserves original history, retired in-flight work, request IDs and fresh control generations", (t) => {
  const f = fixture(t, { inFlight: true });
  assertSuccessorApproval(f.inspection, f.approval);
  const protectedFiles = [
    f.authority.predecessor.state,
    f.authority.predecessor.identity,
    f.authority.predecessor.rootState,
    f.authority.predecessor.rootIdentity,
    ...f.authority.predecessor.qualification,
  ];
  const before = protectedFiles.map((entry) =>
    api.hash(fs.readFileSync(entry.path)),
  );
  const state = openIsolatedEpoch(f.dir, { recover: false });
  const oldGeneration = state.data.controlGeneration,
    oldContext = state.data.contextEpoch;
  state.installEpoch(f.pointer, f.identity, f.initialization);
  assert.equal(state.epoch!.epochId, f.pointer.epochId);
  assert.equal(state.data.controlGeneration, oldGeneration! + 1);
  assert.equal(state.data.contextEpoch, oldContext! + 1);
  assert.equal(state.summary().historicalUnknownJobCount, 3);
  assert.equal(state.summary().retiredEpochCount, 1);
  assert.equal(state.status(f.priorJob.id)["state"], "running");
  assert.equal(state.status(f.priorJob.id)["quarantined"], true);
  assert.equal(
    state.findAnyRequest(f.clientId, f.priorJob.requestId)!["id"],
    f.priorJob.id,
  );
  assert.throws(
    () =>
      state.submit({ ...f.priorJob.request, requestId: f.priorJob.requestId }),
    { code: "HISTORICAL_REQUEST_QUARANTINED" },
  );
  assert.throws(() => state.cancel(f.priorJob.id, f.clientId), {
    code: "INSTANCE_HISTORY_QUARANTINED",
  });
  assert.throws(() => state.resolve(f.priorJob.id, { state: "succeeded" }), {
    code: "INSTANCE_HISTORY_QUARANTINED",
  });
  assert.equal(isolatedEpochDirectory(f.dir), f.pointer.root);
  const reopened = openIsolatedEpoch(f.dir);
  assert.equal(reopened.lookup(f.priorJob.id)!.state, "running");
  assert.equal(
    reopened.findAnyRequest(f.clientId, f.priorJob.requestId)!["quarantined"],
    true,
  );
  assert.deepEqual(
    protectedFiles.map((entry) => api.hash(fs.readFileSync(entry.path))),
    before,
  );
  assert.equal(lineage.epochControlDirectory(f.dir, reopened.epoch!), f.audit);
  assertCurrentPredecessor(f.dir, f.authorityEntry, { allowPublished: true });
});

for (const [name, mutate] of [
  [
    "foreign owner",
    (value) => {
      value.clientId = "foreign";
    },
  ],
  [
    "revoked owner credential",
    (value) => {
      value.registeredTokenHash = "b".repeat(64);
    },
  ],
  [
    "live old broker",
    (value) => {
      value.previousBrokerAlive = true;
    },
  ],
  [
    "uncertain old process",
    (value) => {
      value.previousProcessAlive = null;
    },
  ],
  [
    "live old process",
    (value) => {
      value.previousProcessAlive = true;
    },
  ],
  [
    "uncertain selected process",
    (value) => {
      value.expectedProcessAlive = null;
    },
  ],
  [
    "pending store write",
    (value) => {
      value.pending = true;
    },
  ],
  [
    "changed current snapshot",
    (value) => {
      value.snapshot.state.sha256 = "a".repeat(64);
    },
  ],
  [
    "unqualified installed build",
    (value) => {
      value.qualification.passed = false;
    },
  ],
  [
    "SDK traffic in qualification",
    (value) => {
      value.qualification.liveSdkRequestsSent = 1;
    },
  ],
  [
    "missing successor read qualification",
    (value) => {
      delete value.qualification.deadEpochSuccessorReadQualified;
    },
  ],
  [
    "missing successor restore qualification",
    (value) => {
      delete value.qualification.deadEpochSuccessorRestoreQualified;
    },
  ],
] satisfies ReadonlyArray<
  readonly [string, (value: DeadEpochFixture["inspection"]) => void]
>)
  test(
    "FAKE metadata: successor rejects " +
      name +
      " before any source or SDK authority",
    (t) => {
      const f = fixture(t),
        value = structuredClone(f.inspection);
      mutate(value);
      assert.throws(() => assertSuccessorApproval(value, f.approval));
    },
  );

test("FAKE metadata: a live predecessor is never superseded despite self-consistent files", (t) => {
  const f = fixture(t, { oldProcessAlive: true });
  const state = openIsolatedEpoch(f.dir, { recover: false });
  assert.throws(
    () => state.installEpoch(f.pointer, f.identity, f.initialization),
    { code: "EPOCH_SUCCESSOR_UNPROVEN" },
  );
  assert.throws(() => assertCurrentPredecessor(f.dir, f.authorityEntry), {
    code: "EPOCH_SUCCESSOR_FENCE_CHANGED",
  });
  assert.equal(state.epoch!.epochId, f.authority.predecessor.epochId);
});

for (const [name, change] of [
  [
    "old state",
    (f) => api.durable(f.authority.predecessor.state.path, { forged: true }),
  ],
  [
    "old grant",
    (f) =>
      api.durable(
        path.join(
          f.authority.predecessor.identity.path,
          "..",
          "access-" + "a".repeat(64) + ".json",
        ),
        { forged: true },
      ),
  ],
  [
    "old qualification",
    (f) =>
      api.durable(f.authority.predecessor.qualification[0]!.path, {
        forged: true,
      }),
  ],
  [
    "installed qualification",
    (f) => api.durable(f.authority.qualification.path, { passed: false }),
  ],
] satisfies ReadonlyArray<readonly [string, (f: DeadEpochFixture) => void]>)
  test(
    "FAKE metadata: changed " + name + " cannot activate a successor",
    (t) => {
      const f = fixture(t);
      change(f);
      assert.throws(() =>
        openIsolatedEpoch(f.dir, { recover: false }).installEpoch(
          f.pointer,
          f.identity,
          f.initialization,
        ),
      );
    },
  );

test("FAKE metadata: publishing the same proven successor again is local and idempotent", (t) => {
  const f = fixture(t),
    state = openIsolatedEpoch(f.dir, { recover: false });
  state.installEpoch(f.pointer, f.identity, f.initialization);
  const before = fs.readFileSync(
    path.join(f.dir, "isolated-admission-epoch.json"),
  );
  state.installEpoch(f.pointer, f.identity, f.initialization);
  assert.deepEqual(
    fs.readFileSync(path.join(f.dir, "isolated-admission-epoch.json")),
    before,
  );
  assert.equal(Object.keys(state.data.jobs).length, 0);
});

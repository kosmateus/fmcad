import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  openBrokerRuntimeAuthority,
  type BrokerRuntimeIdentityReaders,
  type BrokerRuntimeQueue,
} from "../src/queue-runtime-authority";
import type * as P from "../src/queue-broker-ports";
import type * as Epochs from "../src/queue-isolated-epoch";
import type { QueueSnapshot } from "../packages/core/src/domain/queue-model";
import { initialQueueSnapshot } from "../packages/core/src/domain/queue-model";

const runtime =
  process.env["FMCAD_TEST_RUNTIME"] || path.join(process.cwd(), "dist");
const load = createRequire(path.join(runtime, "src/queue-broker.js"));
const instance = load(
  "./queue-instance",
) as BrokerRuntimeIdentityReaders["instance"] & {
  processBirth(): string;
};
const epochs = load("./queue-isolated-epoch") as typeof Epochs;
const build = "a".repeat(64);

async function fixture(
  t: import("node:test").TestContext,
  count = 0,
  owned = true,
) {
  const directory = fs.mkdtempSync("/tmp/opencode/epoch-load-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const seed = epochs.openIsolatedEpoch(directory, { recover: false });
  const admitted = seed.submit({
    kind: "rpc",
    clientId: "metadata-owner",
    requestId: "metadata-seed",
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    timeoutMs: 15000,
  });
  const id = String(admitted["id"]);
  seed.next();
  seed.finish(id, { state: "succeeded" });
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(directory, "queue-state.json"), "utf8"),
  ) as QueueSnapshot;
  const original = snapshot.jobs[id]!;
  for (let i = 0; i < count; i++) {
    const id = `history-${i}`;
    snapshot.jobs[id] = {
      ...original,
      id,
      requestId: id,
      order: i + 10,
      description: "Completed historical metadata. ".repeat(60),
      request: { ...original.request, requestId: id },
    };
  }
  fs.writeFileSync(
    path.join(directory, "queue-state.json"),
    JSON.stringify(snapshot),
    { mode: 0o600 },
  );
  const state = epochs.openIsolatedEpoch(directory, { recover: false });
  const owner: P.Owner = {
    pid: process.pid,
    birth: instance.processBirth(),
    nonce: randomUUID(),
    protocol: 2,
  };
  instance.durable(path.join(directory, "broker.lock"), owner);
  const observed: P.Instance = {
    pid: process.pid,
    birth: owner.birth,
    version: "offline-fixture",
    activeCommand: "SelectCommand",
    documents: [],
  };
  let restoredDomains = 0;
  const readers: BrokerRuntimeIdentityReaders = {
    instance: { ...instance, buildHash: () => build },
    epochs: {
      openIsolatedEpoch(directory, options) {
        restoredDomains++;
        return epochs.openIsolatedEpoch(directory, options) as {
          epoch: P.Epoch | null;
        };
      },
    },
    backend: load("./queue-backend-transition"),
    lineage: load("./queue-epoch-lineage"),
    normalAdmission: load("./dist/node-adapters/broker-ipc/normal-admission"),
    normalRestart: load("./dist/node-adapters/broker-ipc/normal-restart"),
    atomicObservation: load("./atomic-workflow-observation"),
    hasRuntimeRootEvidence: () => false,
  };
  const scope = (
    load(
      "./atomic-workflow-observation",
    ) as import("../src/queue-broker-modules").BrokerModules["./atomic-workflow-observation"]
  ).fastenersScope;
  const authority = await openBrokerRuntimeAuthority(
    {
      directory,
      buildHash: build,
      configHash: build,
      observationScope: scope,
    },
    readers,
  );
  const queue: BrokerRuntimeQueue = {
    epoch: () => state.epoch as P.Epoch | null,
    ...(owned
      ? { readCurrentEpoch: () => state.verifyCurrentEpoch() as P.Epoch | null }
      : {}),
    admissionMode: () => state.admissionMode,
    current: () => state.data as P.Snapshot,
    writerStatus: () => state.writerStatus(),
    assertEpoch: (normal) => state.assertEpoch(normal),
    advanceInstanceEpoch: (id) => state.advanceInstanceEpoch(id),
  };
  authority.bindQueue(queue, { owner });
  await authority.identifyStartup(
    {
      binding: {
        brokerNonce: owner.nonce,
        ownerPid: owner.pid,
        ownerBirth: owner.birth,
        buildHash: build,
        stage: "startup",
      },
      receiptPath: path.join(directory, "startup.receipt.json"),
      diagnosticPath: path.join(directory, "startup.result.json"),
    },
    async () => observed,
  );
  return {
    state,
    authority,
    directory,
    queue,
    restoredDomains: () => restoredDomains,
  };
}

test("legacy authority reauthorizes retained metadata through the owned durable host instead of restoring domains", async (t) => {
  const f = await fixture(t, 17000);
  const original = f.authority.capture();
  const restoredBefore = f.restoredDomains();
  const started = performance.now();
  for (let i = 0; i < 8; i++) f.authority.assertCurrent(original);
  const elapsed = performance.now() - started;
  t.diagnostic(
    `Eight exact legacy reauthorizations / 17000 retained metadata jobs: ${elapsed.toFixed(2)} ms`,
  );
  assert.equal(
    f.restoredDomains(),
    restoredBefore,
    "An already-bound host must verify its owned durable snapshot, not reconstruct queue domains",
  );
});

test("live legacy host reauthorization follows successful commits but refuses valid foreign snapshot bytes", async (t) => {
  const f = await fixture(t);
  const capture = f.authority.capture();
  f.state.pause(true, "owned-pause");
  f.authority.assertCurrent(capture);
  const file = path.join(f.directory, "queue-state.json");
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as QueueSnapshot;
  snapshot.revision++;
  fs.writeFileSync(file, JSON.stringify(snapshot));
  assert.throws(() => f.authority.assertCurrent(capture), {
    code: "CORRUPT_STATE",
  });
});

test("live host refuses unresolved storage and never adopts bytes after a failed commit", async (t) => {
  const f = await fixture(t);
  const capture = f.authority.capture();
  const pending = path.join(f.directory, "queue-state.pending.json");
  fs.writeFileSync(pending, "{}");
  assert.throws(() => f.authority.assertCurrent(capture), {
    code: "STORAGE_UNAVAILABLE",
  });
  assert.throws(() => f.state.pause(true, "faulted-write"), {
    code: "STORAGE_UNAVAILABLE",
  });
  fs.unlinkSync(pending);
  assert.equal(f.state.writerStatus().ready, false);
  assert.throws(() => f.authority.assertCurrent(capture));
});

test("live host still validates original physical catalog files without reconstructing the domain", async (t) => {
  const f = await fixture(t);
  const capture = f.authority.capture();
  const job = Object.values(f.state.data.jobs)[0]!;
  const directory = path.join(f.directory, "jobs", job.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `physical-turn-${build}.json`), "{}");
  assert.throws(() => f.authority.assertCurrent(capture), {
    code: "CORRUPT_STATE",
  });
});

test("live host refuses a queue-directory symlink even when its snapshot bytes match", async (t) => {
  const f = await fixture(t);
  const capture = f.authority.capture();
  const displaced = f.directory + "-displaced";
  fs.renameSync(f.directory, displaced);
  fs.symlinkSync(displaced, f.directory);
  try {
    assert.throws(() => f.authority.assertCurrent(capture), {
      code: "CORRUPT_STATE",
    });
  } finally {
    fs.unlinkSync(f.directory);
    fs.renameSync(displaced, f.directory);
  }
});

test("a newly published foreign epoch cannot authorize a previously bound no-epoch writer", async (t) => {
  const f = await fixture(t);
  const capture = f.authority.capture();
  fs.writeFileSync(
    path.join(f.directory, "isolated-admission-epoch.json"),
    "{}",
  );
  assert.throws(() => f.authority.assertCurrent(capture), {
    code: "EPOCH_PROOF_INVALID",
  });
});

test("older hosts retain the original full restore guard rather than an unchecked epoch fallback", async (t) => {
  const f = await fixture(t, 0, false);
  const capture = f.authority.capture();
  const restoredBefore = f.restoredDomains();
  f.authority.assertCurrent(capture);
  assert.ok(f.restoredDomains() > restoredBefore);
  fs.writeFileSync(path.join(f.directory, "queue-state.pending.json"), "{}");
  assert.throws(() => f.authority.assertCurrent(capture), {
    code: "STORAGE_UNAVAILABLE",
  });
});

const sourceFixture = createRequire(
  path.join(process.cwd(), "tests", "epoch-load-fixture.cjs"),
);
const isolatedFixture = sourceFixture(
  "./fixtures/current-epoch-upgrade.cjs",
) as (
  base: string,
  root: string,
) => { dir: string; pointer: { root: string; epochId: string } };

test("retained isolated epoch reauthorization preserves proof, historical bytes and closed-root guards", async (t) => {
  const base = fs.mkdtempSync("/tmp/opencode/retained-epoch-load-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = isolatedFixture(base, runtime);
  const state = epochs.openIsolatedEpoch(f.dir, { recover: false });
  assert.equal(state.verifyCurrentEpoch()?.epochId, f.pointer.epochId);
  state.assertEpoch();
  fs.writeFileSync(path.join(f.pointer.root, "closed.json"), "{}");
  assert.throws(() => state.assertEpoch(), { code: "EPOCH_CLOSED" });
  fs.unlinkSync(path.join(f.pointer.root, "closed.json"));
  const proof = path.join(
    f.dir,
    "isolated-scratch-qualification",
    "sdk-qualified.json",
  );
  const original = fs.readFileSync(proof);
  fs.writeFileSync(proof, "{}");
  assert.throws(() => state.verifyCurrentEpoch(), {
    code: "EPOCH_PROOF_INVALID",
  });
  fs.writeFileSync(proof, original);
  const historical = path.join(f.dir, "queue-state.json");
  fs.appendFileSync(historical, " ");
  assert.throws(() => state.verifyCurrentEpoch(), { code: "CORRUPT_STATE" });
});

test("retained isolated host refuses changed pointers and current epoch bytes", async (t) => {
  const base = fs.mkdtempSync("/tmp/opencode/changed-epoch-load-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = isolatedFixture(base, runtime);
  const state = epochs.openIsolatedEpoch(f.dir, { recover: false });
  const pointerFile = path.join(f.dir, "isolated-admission-epoch.json");
  const bytes = fs.readFileSync(pointerFile);
  const pointer = JSON.parse(bytes.toString()) as { ownerTokenHash: string };
  pointer.ownerTokenHash = build;
  fs.writeFileSync(pointerFile, JSON.stringify(pointer));
  assert.throws(() => state.verifyCurrentEpoch(), {
    code: "EPOCH_PROOF_INVALID",
  });
  fs.writeFileSync(pointerFile, bytes);
  fs.appendFileSync(path.join(f.pointer.root, "queue-state.json"), " ");
  assert.throws(() => state.verifyCurrentEpoch(), { code: "CORRUPT_STATE" });
});

test("an empty retired epoch remains a checked durable store independently of job lookup", (t) => {
  const base = fs.mkdtempSync("/tmp/opencode/empty-retired-epoch-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  type Host = ReturnType<typeof epochs.openIsolatedEpoch>;
  const makeSuccessor = sourceFixture(
    "./fixtures/dead-epoch-successor.cjs",
  ) as (
    base: string,
    runtime: string,
  ) => {
    dir: string;
    pointer: Parameters<Host["installEpoch"]>[0];
    identity: Parameters<Host["installEpoch"]>[1];
    initialization: Parameters<Host["installEpoch"]>[2];
    authority: { predecessor: { state: P.Reference } };
    authorityEntry: P.Reference;
  };
  const f = makeSuccessor(base, runtime);
  const lineage = load(
    "./queue-epoch-lineage",
  ) as typeof import("../src/queue-epoch-lineage");
  // Seed a valid, empty predecessor before opening/binding it. Refresh its
  // synthetic authority reference rather than mutating an already-bound host.
  const predecessor = f.authority.predecessor.state.path;
  instance.durable(predecessor, initialQueueSnapshot());
  f.authority.predecessor.state = lineage.reference(predecessor);
  instance.durable(f.authorityEntry.path, f.authority);
  f.pointer.succession = lineage.reference(f.authorityEntry.path);
  const state = epochs.openIsolatedEpoch(f.dir, { recover: false });
  assert.equal(Object.keys(state.data.jobs).length, 0);
  state.installEpoch(f.pointer, f.identity, f.initialization);
  assert.equal(state.verifyCurrentEpoch()?.epochId, f.pointer.epochId);
  const pending = path.join(
    path.dirname(predecessor),
    "queue-state.pending.json",
  );
  fs.writeFileSync(pending, "{}");
  assert.throws(() => epochs.openIsolatedEpoch(f.dir, { recover: false }), {
    code: "STORAGE_UNAVAILABLE",
  });
  assert.throws(() => state.verifyCurrentEpoch(), {
    code: "STORAGE_UNAVAILABLE",
  });
  fs.unlinkSync(pending);
  assert.equal(state.verifyCurrentEpoch()?.epochId, f.pointer.epochId);
  fs.appendFileSync(predecessor, " ");
  assert.throws(() => state.verifyCurrentEpoch());
});

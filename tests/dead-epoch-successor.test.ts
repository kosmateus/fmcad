import test from "node:test";
import "./frozen-metadata-profile.test";
import {
  inspectFrozenMetadataWork,
  type FrozenMetadataProfile,
} from "../src/composition/queue-frozen-metadata-profile";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
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
const { inspectSuccessor, bootstrapSuccessor } = load(
  "../src/queue-epoch-successor",
) as typeof import("../src/composition/queue-epoch-successor");

type PublishedBackend = {
  pointer: DeadEpochFixture["pointer"];
  entry: DeadEpochFixture["authorityEntry"];
  identity: DeadEpochFixture["identity"];
  authority: DeadEpochFixture["authority"];
};
function backendFixture(
  t: TestContext,
  effectiveConfig?: Record<string, unknown>,
  sourceConfig?: Record<string, unknown>,
  baseDirectory?: string,
) {
  t.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
  const base =
    baseDirectory || fs.mkdtempSync("/tmp/opencode/backend-successor-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return (
    load("./fixtures/backend-successor.cjs") as (
      base: string,
      repo: string,
      options?: {
        effectiveConfig?: Record<string, unknown> | undefined;
        sourceConfig?: Record<string, unknown> | undefined;
      },
    ) => DeadEpochFixture & {
      client: Parameters<typeof inspectSuccessor>[0];
      approvalFile: string;
      headFile: string;
      transition: string;
      receiptFile: string;
      lifecycleFile: string;
      effectiveIdentity: { buildHash: string; configHash: string };
      qualifiedCreationUpgrade(
        published: PublishedBackend,
        buildHash?: string,
      ): PublishedBackend;
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
  )(base, repository, { effectiveConfig, sourceConfig });
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

function frozenBackendFixture(t: TestContext, baseDirectory?: string) {
  const f = backendFixture(
    t,
    {
      backend: "addin",
      url: "http://127.0.0.1:8765/mcp",
      tool: "execute_python",
    },
    {
      backend: "mcp",
      url: "http://never-send.invalid",
      headers: {},
      tool: "execute_python",
      transport: "node",
      protocolVersion: "2025-06-18",
      timeoutMs: 180000,
      routing: "queue",
      queue: {},
    },
    baseDirectory,
  );
  const previous = openIsolatedEpoch(f.dir, { recover: false });
  previous.submit({
    kind: "rpc",
    clientId: f.clientId,
    requestId: "frozen-peer-request",
    timeoutMs: 1000,
    payload: { jsonrpc: "2.0", id: "frozen-peer", method: "ping" },
  });
  const stateFile = path.join(f.inspection.pointer.root, "queue-state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.jobs[f.priorJob.id].state = "needs_reconciliation";
  state.active = null;
  state.lease = null;
  api.durable(stateFile, state);
  const frozen = inspectFrozenMetadataWork(f.dir, f.inspection.pointer.root);
  const profile: FrozenMetadataProfile = {
    version: 1,
    purpose: "dead-frozen-predecessor-metadata-v1",
    ownerClientId: f.clientId,
    beneficiary: "fresh-metadata-beneficiary",
    metadataRequestId: "fresh-metadata-once",
    previousConfigHash: api.brokerConfigHash(f.cfg),
    successorConfigHash: api.brokerConfigHash(f.cfg),
    sourceCommit: f.approval.sourceCommit,
    buildHash: f.approval.buildHash,
    expectedProcess: f.approval.expectedProcess,
    provisioning: {
      capability: "get_open_document_metadata",
      owner: "fresh-metadata-beneficiary",
      endpoint: "http://127.0.0.1:8765/admission/v1",
      ...f.approval.expectedProcess,
      instance: "fresh-instance",
      epoch: "fresh-runtime",
      source: "a".repeat(40),
      build: "b".repeat(64),
    },
    unresolved: frozen.unresolved,
  };
  const qualification = api.readJson(f.approval.qualification.path) as object;
  api.durable(f.approval.qualification.path, {
    ...qualification,
    frozenPredecessorMetadataQualified: true,
  });
  const snapshot = lineage.predecessorSnapshot(f.dir, f.audit);
  const approval = {
    ...f.approval,
    purpose: profile.purpose,
    frozenMetadata: profile,
    stateHash: snapshot.state.sha256,
    qualification: lineage.reference(f.approval.qualification.path),
  };
  api.durable(f.approvalFile, approval);
  return { ...f, profile, frozen, stateFile };
}

test("FAKE frozen metadata: exact two-store UNKNOWN and queued topology is inspected without dispatch", (t) => {
  const f = frozenBackendFixture(t);
  const { frozen, stateFile } = f;
  const protectedFiles = [
    stateFile,
    path.join(f.dir, "queue-state.json"),
    f.headFile,
  ];
  const before = protectedFiles.map((file) => fs.readFileSync(file));
  const inspected = inspectSuccessor(
    f.client,
    f.cfg,
    f.approvalFile,
    f.requestId,
  );
  assert.equal(inspected.frozenMetadataFacts?.queuedNeverStarted, true);
  assert.deepEqual(
    inspected.frozenMetadataFacts?.unresolved,
    frozen.unresolved,
  );
  assert.throws(
    () =>
      inspectSuccessor(
        f.client,
        { ...f.cfg, timeoutMs: 1 },
        f.approvalFile,
        f.requestId,
      ),
    { code: "FROZEN_METADATA_FENCE_CHANGED" },
  );
  for (const [index, file] of protectedFiles.entries())
    assert.deepEqual(fs.readFileSync(file), before[index]);
});

test("FAKE frozen metadata: public bootstrap refuses missing or foreign private input before any claim", async (t) => {
  const f = frozenBackendFixture(t);
  const names = fs.readdirSync(f.audit).sort();
  const before = names
    .filter((name) => fs.statSync(path.join(f.audit, name)).isFile())
    .map((name) => ({
      name,
      bytes: fs.readFileSync(path.join(f.audit, name)),
    }));
  const base = {
    approval: f.approvalFile,
    requestId: f.requestId,
    preflight: true,
  };
  await assert.rejects(bootstrapSuccessor(f.client, f.cfg, base), {
    code: "FROZEN_METADATA_FENCE_CHANGED",
  });
  await assert.rejects(
    bootstrapSuccessor(f.client, f.cfg, {
      ...base,
      addinMetadataAdmission: {
        ...f.profile.provisioning,
        token: "a".repeat(64),
        owner: "foreign",
      },
    }),
    { code: "FROZEN_METADATA_FENCE_CHANGED" },
  );
  const result = await bootstrapSuccessor(f.client, f.cfg, {
    ...base,
    addinMetadataAdmission: {
      ...f.profile.provisioning,
      token: "a".repeat(64),
    },
  });
  assert.equal("sdkRequestsSent" in result && result.sdkRequestsSent, 0);
  assert.deepEqual(fs.readdirSync(f.audit).sort(), names);
  for (const entry of before)
    assert.deepEqual(
      fs.readFileSync(path.join(f.audit, entry.name)),
      entry.bytes,
    );
  assert.equal(fs.existsSync(path.join(f.audit, "worker-claim.json")), false);
  assert.equal(fs.existsSync(path.join(f.audit, "launch-intent.json")), false);
});

test("FAKE frozen metadata: uncertain launch is observed as pending and never spawned again", async (t) => {
  const f = frozenBackendFixture(t);
  const inspected = inspectSuccessor(
    f.client,
    f.cfg,
    f.approvalFile,
    f.requestId,
  );
  const authority = {
    ...f.authority,
    predecessor: lineage.predecessorSnapshot(f.dir, f.audit, true),
    configHash: api.brokerConfigHash(f.cfg),
    qualification: lineage.reference(f.approval.qualification.path),
    backendTransition: inspected.backendTransition,
    frozenMetadata: f.profile,
  };
  api.durable(f.authorityEntry.path, authority);
  const entry = lineage.reference(f.authorityEntry.path);
  api.durable(
    path.join(f.audit, "intent.json"),
    {
      version: 1,
      requestId: f.requestId,
      clientId: f.clientId,
      ownerTokenHash: api.hash(f.token),
      nonce: f.nonce,
      approval: lineage.reference(f.approvalFile),
      previousOwner: f.previousOwner,
    },
    true,
  );
  const launch = path.join(f.audit, "launch-intent.json");
  api.durable(launch, { nonce: f.nonce, authority: entry }, true);
  const before = fs.readFileSync(launch);
  t.mock.method(childProcess, "spawn", () => {
    assert.fail("An uncertain launch must not spawn another worker");
  });
  const now = Date.now;
  let elapsed = 0;
  t.mock.method(Date, "now", () => now() + (elapsed += 120000));
  const result = await bootstrapSuccessor(f.client, f.cfg, {
    approval: f.approvalFile,
    requestId: f.requestId,
    confirmOwnership: true,
    addinMetadataAdmission: {
      ...f.profile.provisioning,
      token: "private-launch-token-".repeat(4),
    },
  });
  assert.ok("state" in result);
  assert.equal(result.state, "pending");
  assert.equal(result.noReplay, true);
  assert.deepEqual(fs.readFileSync(launch), before);
  assert.equal(fs.existsSync(path.join(f.audit, "worker-claim.json")), false);
  assert.equal(fs.existsSync(path.join(f.audit, "worker.stdout.log")), false);
});

test("FAKE frozen metadata: real worker receives private stdin once while both predecessor stores remain frozen", async (t) => {
  const temporary = fs.mkdtempSync("/tmp/opencode/frozen-worker-");
  const base = path.join(temporary, "state", "fmcad");
  fs.mkdirSync(base, { recursive: true });
  const keys = [
    "HOME",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
  ];
  const env = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = path.join(temporary, key);
  process.env["XDG_STATE_HOME"] = path.join(temporary, "state");
  let worker: { pid: number; birth: string } | undefined;
  let workerExit: Promise<void> | undefined;
  let workerChild: childProcess.ChildProcess | undefined;
  t.after(async () => {
    workerChild?.ref(); // Bootstrap detaches it; cleanup must keep the exit event alive on Node22.
    if (worker && api.priorProcessAlive(worker) === true) {
      assert.equal(
        fs.realpathSync(`/proc/${worker.pid}/cwd`),
        path.join(base, "queue"),
      );
      process.kill(worker.pid, "SIGKILL"); // Only this test's synthetic worker.
    }
    await workerExit;
    for (const [key, value] of env) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const f = frozenBackendFixture(t, base);
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.unlinkSync(f.authorityEntry.path);
  fs.rmSync(path.join(f.audit, "isolated-scratch-qualification"), {
    recursive: true,
    force: true,
  });
  const files = [f.stateFile, path.join(f.dir, "queue-state.json"), f.headFile];
  const before = files.map((file) => fs.readFileSync(file));
  const spawn = childProcess.spawn;
  let launches = 0;
  t.mock.method(
    childProcess,
    "spawn",
    (
      executable: string,
      args: readonly string[],
      options: childProcess.SpawnOptions,
    ) => {
      assert.equal(path.basename(args[0]!), "queue-epoch-successor-worker.js");
      launches++;
      const child = spawn(
        executable,
        ["--require", load.resolve("./fixtures/fake-wsl-preload.cjs"), ...args],
        options,
      );
      workerChild = child;
      assert.ok(child.pid);
      worker = { pid: child.pid, birth: api.processBirth(child.pid) };
      workerExit = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      return child;
    },
  );
  const token = "private-worker-token-".repeat(4);
  const options = {
    approval: f.approvalFile,
    requestId: f.requestId,
    confirmOwnership: true,
    addinMetadataAdmission: { ...f.profile.provisioning, token },
  };
  const results = await Promise.all([
    bootstrapSuccessor(f.client, f.cfg, options),
    bootstrapSuccessor(f.client, f.cfg, options),
  ]);
  for (const result of results)
    assert.equal("sdkRequestsSent" in result && result.sdkRequestsSent, 0);
  assert.equal(launches, 1);
  const connection = load("../src/queue-connection") as {
    request(dir: string, message: Record<string, unknown>): Promise<unknown>;
  };
  await assert.rejects(
    connection.request(f.dir, {
      action: "submit",
      auth: f.client.auth,
      request: {
        kind: "rpc",
        requestId: "foreign-fresh-request",
        timeoutMs: 1000,
        payload: { jsonrpc: "2.0", id: "refused", method: "ping" },
      },
    }),
    // Before a fresh namespace is qualified, the existing lost-epoch guard wins.
    { code: "EPOCH_PROCESS_UNAVAILABLE" },
  );
  for (const [index, file] of files.entries())
    assert.deepEqual(fs.readFileSync(file), before[index]);
  for (const name of fs.readdirSync(f.audit)) {
    const file = path.join(f.audit, name);
    if (fs.statSync(file).isFile())
      assert.equal(fs.readFileSync(file, "utf8").includes(token), false, name);
  }
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

test("a normal read-attempt link cannot authorize an isolated or atomic successor", (t) => {
  const f = backendFixture(t);
  for (const link of [null, false, {}, f.approval.qualification]) {
    const untrusted = JSON.parse(
      JSON.stringify({ ...f.approval, priorNormalCurrentFactsRetry: link }),
    );
    assert.throws(() => assertSuccessorApproval(f.inspection, untrusted), {
      code: "NORMAL_SUCCESSOR_UNPROVEN",
    });
  }
});

test("fresh normal bootstrap keeps preserved creation identity separate from the retired read-worker lifecycle", (t) => {
  const base = fs.mkdtempSync("/tmp/opencode/normal-retry-bootstrap-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = (
    load("./fixtures/dead-epoch-successor.cjs") as (
      base: string,
      repo: string,
    ) => DeadEpochFixture
  )(base, repository);
  assertSuccessorApproval(f.inspection, f.approval);
  const normal = load(
    "../src/dist/composition/queue-normal-cold-successor",
  ) as Record<string, unknown>;
  const original = normal["inspectNormalCurrentFactsRetry"];
  t.after(() => {
    normal["inspectNormalCurrentFactsRetry"] = original;
  });
  const priorFile = path.join(base, "previous-read-authority.json");
  const workerBuild = "e".repeat(64);
  api.durable(priorFile, { buildHash: workerBuild });
  const normalStore = {
    kind: "normal-currentstore-v1",
    jobAuthorization: f.approval.qualification,
    deathProof: f.approval.qualification,
    producerRetirement: f.approval.qualification,
  };
  const approval = JSON.parse(
    JSON.stringify({
      ...f.approval,
      purpose: "dead-normal-currentstore-successor-v1",
      normalCurrentStore: normalStore,
      priorNormalCurrentFactsRetry: f.approval.qualification,
    }),
  );
  normal["inspectNormalCurrentFactsRetry"] = () => ({
    previousAuthority: lineage.reference(priorFile),
    originalNormalStore: normalStore,
    currentOwner: f.previousOwner,
    candidateRoot: f.approval.candidateRoot,
  });
  const inspection = {
    ...f.inspection,
    approval,
    qualification: {
      ...f.inspection.qualification,
      normalCurrentStoreSuccessorQualified: true,
      normalCurrentFactsRetryQualified: true,
    },
    previousLifecycle: {
      ...f.inspection.previousLifecycle,
      buildHash: workerBuild,
    },
  };
  assert.notEqual(workerBuild, inspection.identity.buildHash);
  assertSuccessorApproval(inspection, approval);
  const legacyQualification = JSON.parse(
    JSON.stringify(inspection.qualification),
  );
  delete legacyQualification.normalCurrentFactsRetryQualified;
  assert.throws(
    () =>
      assertSuccessorApproval(
        { ...inspection, qualification: legacyQualification },
        approval,
      ),
    {
      code: "EPOCH_SUCCESSOR_UNQUALIFIED",
    },
  );
  assert.throws(
    () =>
      assertSuccessorApproval(
        { ...inspection, previousLifecycle: f.inspection.previousLifecycle },
        approval,
      ),
    {
      code: "EPOCH_SUCCESSOR_FENCE_CHANGED",
    },
  );
  const wrongOwner = JSON.parse(
    JSON.stringify({
      ...approval,
      previousOwner: { ...approval.previousOwner, nonce: "foreign" },
    }),
  );
  assert.throws(() => assertSuccessorApproval(inspection, wrongOwner), {
    code: "NORMAL_SUCCESSOR_UNPROVEN",
  });
  const wrongScope = JSON.parse(
    JSON.stringify({
      ...approval,
      normalCurrentStore: {
        ...normalStore,
        jobAuthorization: {
          ...normalStore.jobAuthorization,
          sha256: "f".repeat(64),
        },
      },
    }),
  );
  assert.throws(() => assertSuccessorApproval(inspection, wrongScope), {
    code: "NORMAL_SUCCESSOR_UNPROVEN",
  });
  const wrongRuntime = JSON.parse(
    JSON.stringify({
      ...approval,
      candidateRoot: path.join(base, "foreign-runtime"),
    }),
  );
  assert.throws(() => assertSuccessorApproval(inspection, wrongRuntime), {
    code: "NORMAL_SUCCESSOR_UNPROVEN",
  });
});

test("FAKE normal runtime upgrade binds creation to the original authorized normal pair, not the historical quarantine pair", (t) => {
  const f = backendFixture(t);
  const published = f.publish();
  const originalJobs = [...published.pointer.quarantinedJobIds];
  const authorizationFile = path.join(
    f.dir,
    "normal-job-owner-authorization.json",
  );
  api.durable(authorizationFile, {
    kind: "normal-currentstore-job-owner-authorization",
    requestId: published.authority.requestId,
    snapshot: { jobOwnerTokenHash: "a".repeat(64) },
    profile: {
      kind: "normal-currentstore-target-v1",
      epochClientId: published.authority.clientId,
      jobClientId: "normal-job-owner",
      jobId: originalJobs[0],
      rpcId: originalJobs[1],
    },
  });
  published.authority["normalCurrentStore"] = {
    kind: "normal-currentstore-v1",
    jobAuthorization: lineage.reference(authorizationFile),
  };
  api.durable(published.entry.path, published.authority);
  published.entry = lineage.reference(published.entry.path);
  published.pointer.succession = published.entry;
  f.qualifiedCreationUpgrade(published);
  published.pointer.quarantinedJobIds = [randomUUID(), randomUUID()];
  api.durable(
    path.join(f.dir, "isolated-admission-epoch.json"),
    published.pointer,
  );
  const audit = path.join(f.dir, "normal-origin-read");
  fs.mkdirSync(audit);
  const snapshot = lineage.predecessorSnapshot(f.dir, audit, true);
  const verify = () =>
    lineage.successorEpochIdentity(f.dir, { ...published.pointer }, snapshot);
  assert.equal(verify().buildHash, published.identity.buildHash);
  fs.appendFileSync(authorizationFile, " ");
  assert.throws(verify, { code: "EPOCH_LINEAGE_INVALID" });
});

test("FAKE historical runtime upgrade: authenticated creation build and later identity build are distinct without changing SDK/history", (t) => {
  const f = backendFixture(t),
    published = f.qualifiedCreationUpgrade(f.publish());
  assert.notEqual(published.identity.buildHash, published.authority.buildHash);
  const restored = f.restoreAfterPublish(published);
  const before = fs.readFileSync(restored.snapshot.state.path);
  const identity = lineage.successorBackendIdentity(
    f.dir,
    { ...published.pointer },
    restored.snapshot,
    restored.proof,
    restored.owner,
    restored.identity.configHash,
  );
  assert.equal(identity.buildHash, published.identity.buildHash);
  assert.deepEqual(fs.readFileSync(restored.snapshot.state.path), before);
  assert.equal(published.authority.historicalOutcome, "unknown");
});

for (const [name, change, recordName] of [
  [
    "creation build",
    (v) => {
      const binding = v["binding"];
      assert.ok(binding && typeof binding === "object");
      Object.assign(binding, { buildHash: "f".repeat(64) });
    },
    "start.json",
  ],
  [
    "source checker",
    (v) => {
      v["pythonCheck"] = { status: "failed" };
    },
    "start.json",
  ],
  [
    "physical failure",
    (v) => {
      v["outcome"] = "failed";
    },
    "remote",
  ],
  [
    "foreign SDK",
    (v) => {
      const instance = v["instance"];
      assert.ok(instance && typeof instance === "object");
      Object.assign(instance, { birth: "foreign" });
    },
    "remote",
  ],
] satisfies ReadonlyArray<
  readonly [string, (value: Record<string, unknown>) => void, string]
>) {
  test(
    "FAKE historical runtime upgrade refuses altered " +
      name +
      " even with repinned synthetic files",
    (t) => {
      const f = backendFixture(t),
        published = f.qualifiedCreationUpgrade(f.publish());
      const dir = path.dirname(published.pointer.qualificationReceipt.path);
      const file =
        recordName === "remote"
          ? published.pointer.qualificationEvidence.find((ref) =>
              /^remote-/.test(path.basename(ref.path)),
            )!.path
          : path.join(dir, recordName);
      const value: unknown = api.readJson(file);
      assert.ok(value && typeof value === "object" && !Array.isArray(value));
      change(value as Record<string, unknown>);
      api.durable(file, value);
      published.pointer.qualificationEvidence =
        published.pointer.qualificationEvidence.map((ref) =>
          lineage.reference(ref.path),
        );
      api.durable(
        path.join(f.dir, "isolated-admission-epoch.json"),
        published.pointer,
      );
      const restored = f.restoreAfterPublish(published);
      assert.throws(
        () =>
          lineage.successorBackendIdentity(
            f.dir,
            { ...published.pointer },
            restored.snapshot,
            restored.proof,
            restored.owner,
            restored.identity.configHash,
          ),
        { code: "EPOCH_LINEAGE_INVALID" },
      );
    },
  );
}

test("FAKE historical runtime upgrade cannot infer qualified origin from a changed build scalar alone", (t) => {
  const f = backendFixture(t),
    published = f.publish();
  published.identity.buildHash = "e".repeat(64);
  api.durable(
    path.join(published.pointer.root, "instance.json"),
    published.identity,
  );
  const restored = f.restoreAfterPublish(published);
  assert.throws(
    () =>
      lineage.successorBackendIdentity(
        f.dir,
        { ...published.pointer },
        restored.snapshot,
        restored.proof,
        restored.owner,
        restored.identity.configHash,
      ),
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

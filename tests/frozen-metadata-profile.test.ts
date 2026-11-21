import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertFrozenMetadataProfile,
  inspectFrozenMetadataWork,
  assertFrozenMetadataConnection,
  assertFrozenMetadataStartup,
  assertFrozenMetadataRequest,
  type FrozenMetadataProfile,
  type FrozenMetadataFacts,
} from "../src/composition/queue-frozen-metadata-profile";

function fixture() {
  const profile: FrozenMetadataProfile = {
    version: 1,
    purpose: "dead-frozen-predecessor-metadata-v1",
    ownerClientId: "existing-cli-owner",
    beneficiary: "metadata-client",
    metadataRequestId: "fresh-metadata-request",
    previousConfigHash: "a".repeat(64),
    successorConfigHash: "a".repeat(64),
    sourceCommit: "c".repeat(40),
    buildHash: "d".repeat(64),
    expectedProcess: { pid: 100, birth: "new-process" },
    provisioning: {
      capability: "get_open_document_metadata",
      owner: "metadata-client",
      endpoint: "http://127.0.0.1:8765/admission/v1",
      pid: 100,
      birth: "new-process",
      instance: "new-instance",
      epoch: "new-runtime-epoch",
      source: "e".repeat(40),
      build: "f".repeat(64),
    },
    unresolved: [
      {
        store: "root",
        id: "root-unknown",
        state: "needs_reconciliation",
        requestId: "old-root",
        clientId: "old-owner",
        hash: "1".repeat(64),
      },
      {
        store: "epoch",
        id: "export-unknown",
        state: "needs_reconciliation",
        requestId: "old-export",
        clientId: "export-owner",
        hash: "2".repeat(64),
      },
      {
        store: "epoch",
        id: "frozen-queued",
        state: "queued",
        requestId: "old-queued",
        clientId: "queued-owner",
        hash: "3".repeat(64),
      },
    ],
  };
  const facts: FrozenMetadataFacts = {
    ownerClientId: profile.ownerClientId,
    registeredOwnerMatches: true,
    previousConfigHash: profile.previousConfigHash,
    successorConfigHash: profile.successorConfigHash,
    sourceCommit: profile.sourceCommit,
    buildHash: profile.buildHash,
    expectedProcess: profile.expectedProcess,
    previousProcessesDead: true,
    expectedProcessAlive: true,
    producersDead: true,
    queuedNeverStarted: true,
    unresolved: structuredClone(profile.unresolved),
    provisioning: structuredClone(profile.provisioning),
  };
  return { profile, facts };
}

function inspectionFixture(t: { after(fn: () => void): void }) {
  const { profile, facts } = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-worker-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const epoch = path.join(root, "admission-epochs", "fixture");
  fs.mkdirSync(epoch, { recursive: true });
  const ledgers = [root, epoch].map((directory, index) => {
    const file = path.join(directory, "queue-state.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        jobs: Object.fromEntries(
          profile.unresolved
            .filter((row) => row.store === (index === 0 ? "root" : "epoch"))
            .map((row) => [row.id, row]),
        ),
        active: null,
        lease: null,
      }),
    );
    return file;
  });
  function worker(id: string, directory = root, pid = 201) {
    const job = path.join(directory, "jobs", id);
    fs.mkdirSync(job, { recursive: true });
    fs.writeFileSync(
      path.join(job, "worker-start.json"),
      JSON.stringify({
        jobId: id,
        buildHash: "a".repeat(64),
        at: 100,
      }),
    );
    fs.writeFileSync(
      path.join(job, "worker-identity.json"),
      JSON.stringify({
        pid,
        birth: `worker-${pid}`,
      }),
    );
    return job;
  }
  for (const row of profile.unresolved.filter(
    (row) => row.state === "needs_reconciliation",
  ))
    worker(row.id);
  function qualify() {
    const observed = inspectFrozenMetadataWork(root, epoch);
    assertFrozenMetadataProfile(profile, {
      ...facts,
      unresolved: observed.unresolved,
      queuedNeverStarted: observed.queuedNeverStarted,
      // Fixture processes are dead. An empty result must not manufacture proof.
      producersDead: observed.workers.every(() => true),
    });
  }
  return { root, epoch, profile, facts, ledgers, worker, qualify };
}

test("canonical root/jobs traces forbid queued epoch work at preflight and repeated qualification", (t) => {
  const f = inspectionFixture(t);
  f.qualify();
  const before = f.ledgers.map((file) => fs.readFileSync(file));
  f.worker("frozen-queued");
  let launches = 0;
  let sdk = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(
      () => {
        f.qualify();
        launches++;
        sdk++;
      },
      { code: "FROZEN_METADATA_FENCE_CHANGED" },
    );
  }
  assert.equal(launches, 0);
  assert.equal(sdk, 0);
  for (const [index, file] of f.ledgers.entries())
    assert.deepEqual(fs.readFileSync(file), before[index]);
});

test("queued dispatch on the ledger itself forbids qualification without artifact files", (t) => {
  const f = inspectionFixture(t);
  const file = f.ledgers[1]!;
  const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  ledger.jobs["frozen-queued"].dispatch = { rpcCount: 1, completedCount: 0 };
  fs.writeFileSync(file, JSON.stringify(ledger));
  assert.throws(f.qualify, { code: "FROZEN_METADATA_FENCE_CHANGED" });
});

test("UNKNOWN start or dispatch without immutable worker identity never proves producers dead", (t) => {
  for (const id of ["root-unknown", "export-unknown"]) {
    for (const evidence of ["start", "dispatch", "none"]) {
      const f = inspectionFixture(t);
      fs.unlinkSync(path.join(f.root, "jobs", id, "worker-identity.json"));
      if (evidence !== "start")
        fs.unlinkSync(path.join(f.root, "jobs", id, "worker-start.json"));
      if (evidence === "dispatch") {
        const file = f.ledgers[id === "root-unknown" ? 0 : 1]!;
        const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
        ledger.jobs[id].dispatch = { rpcCount: 1, completedCount: 0 };
        fs.writeFileSync(file, JSON.stringify(ledger));
      }
      assert.throws(f.qualify, { code: "FROZEN_METADATA_FENCE_CHANGED" });
    }
  }
});

test("worker evidence must bind to the same job using the actual start/identity schema", (t) => {
  for (const changed of ["start", "identity", "missing-start"] as const) {
    const f = inspectionFixture(t);
    if (changed === "missing-start") {
      fs.unlinkSync(
        path.join(f.root, "jobs", "root-unknown", "worker-start.json"),
      );
      assert.throws(f.qualify, { code: "FROZEN_METADATA_FENCE_CHANGED" });
      continue;
    }
    const file = path.join(
      f.root,
      "jobs",
      "root-unknown",
      `worker-${changed}.json`,
    );
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.jobId = "foreign-job";
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(f.qualify, { code: "FROZEN_METADATA_FENCE_CHANGED" });
  }
});

test("phased worker start accepts only the actual offline_prepare emitter schema", (t) => {
  const f = inspectionFixture(t);
  const file = path.join(f.root, "jobs", "root-unknown", "worker-start.json");
  const start = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...start, phase: "offline_prepare" }),
  );
  assert.doesNotThrow(f.qualify);
  fs.writeFileSync(file, JSON.stringify({ ...start, phase: "unknown-phase" }));
  assert.throws(f.qualify, { code: "FROZEN_METADATA_FENCE_CHANGED" });
});

test("ledger build pin must match worker-start before preflight or repeated claim", (t) => {
  for (const id of ["root-unknown", "export-unknown"]) {
    const f = inspectionFixture(t);
    const file = f.ledgers[id === "root-unknown" ? 0 : 1]!;
    const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
    ledger.jobs[id].request = { kind: "command" };
    fs.writeFileSync(file, JSON.stringify(ledger));
    assert.doesNotThrow(
      f.qualify,
      "historical request without a pin remains supported",
    );
    ledger.jobs[id].request.buildHash = "a".repeat(64);
    fs.writeFileSync(file, JSON.stringify(ledger));
    assert.doesNotThrow(f.qualify);
    // Both values are valid hashes, but they identify different worker builds.
    ledger.jobs[id].request.buildHash = "b".repeat(64);
    fs.writeFileSync(file, JSON.stringify(ledger));
    let claims = 0;
    let sdk = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(
        () => {
          f.qualify();
          claims++;
          sdk++;
        },
        { code: "FROZEN_METADATA_FENCE_CHANGED" },
      );
    }
    assert.equal(claims, 0);
    assert.equal(sdk, 0);
  }
});

test("legacy epoch evidence cannot hide or contradict the canonical job namespace", (t) => {
  const f = inspectionFixture(t);
  f.worker("export-unknown", f.epoch, 202);
  assert.throws(f.qualify, { code: "FROZEN_METADATA_FENCE_CHANGED" });
});

test("legacy queued traces and dangling job-directory symlinks are not absence evidence", (t) => {
  for (const trace of ["legacy", "symlink"] as const) {
    const f = inspectionFixture(t);
    if (trace === "legacy") f.worker("frozen-queued", f.epoch);
    else
      fs.symlinkSync(
        path.join(f.root, "missing"),
        path.join(f.root, "jobs", "frozen-queued"),
      );
    assert.throws(f.qualify, { code: "FROZEN_METADATA_FENCE_CHANGED" });
  }
});

test("v1 preserves the full physical config and rejects even connection-tuning changes", () => {
  const before = {
    backend: "addin",
    url: "http://127.0.0.1:8765/mcp",
    timeoutMs: 180000,
  };
  assert.doesNotThrow(() =>
    assertFrozenMetadataConnection(before, { ...before }),
  );
  assert.throws(
    () =>
      assertFrozenMetadataConnection(before, { ...before, timeoutMs: 60000 }),
    { code: "FROZEN_METADATA_FENCE_CHANGED" },
  );
  const f = fixture();
  f.profile.successorConfigHash = "b".repeat(64);
  f.facts.successorConfigHash = f.profile.successorConfigHash;
  assert.throws(() => assertFrozenMetadataProfile(f.profile, f.facts), {
    code: "FROZEN_METADATA_FENCE_CHANGED",
  });
});

test("private provisioning is required and credential copies are rejected before launch", () => {
  const { profile } = fixture();
  const token = 'private-"escaped-\\-credential-'.repeat(3);
  const dto = { ...profile.provisioning, token };
  const cfg = { backend: "addin" };
  assert.doesNotThrow(() => assertFrozenMetadataStartup(profile, dto, cfg));
  assert.doesNotThrow(() =>
    assertFrozenMetadataStartup(undefined, undefined, cfg),
  );
  for (const run of [
    () => assertFrozenMetadataStartup(profile, undefined, cfg),
    () => assertFrozenMetadataStartup(undefined, dto, cfg),
    () =>
      assertFrozenMetadataStartup(profile, { ...dto, owner: "foreign" }, cfg),
    () =>
      assertFrozenMetadataStartup(profile, dto, {
        ...cfg,
        nested: [{ value: token }],
      }),
    () => assertFrozenMetadataStartup(profile, dto, { ...cfg, [token]: true }),
  ])
    assert.throws(run, { code: "FROZEN_METADATA_FENCE_CHANGED" });
});

test("frozen successor accepts only its exact fresh metadata request, never peer or historical work", () => {
  const { profile } = fixture();
  const request = {
    clientId: profile.beneficiary,
    requestId: profile.metadataRequestId,
    kind: "rpc",
    metadata: true,
  };
  assert.doesNotThrow(() => assertFrozenMetadataRequest(profile, request));
  for (const changed of [
    { ...request, clientId: profile.ownerClientId },
    { ...request, requestId: profile.unresolved[0]!.requestId },
    { ...request, requestId: "other-fresh-request" },
    { ...request, kind: "command" },
    { ...request, metadata: false },
  ])
    assert.throws(() => assertFrozenMetadataRequest(profile, changed), {
      code: "FROZEN_METADATA_FENCE_CHANGED",
    });
  assert.doesNotThrow(() =>
    assertFrozenMetadataRequest(undefined, {
      ...request,
      kind: "command",
      metadata: false,
    }),
  );
});

test("frozen metadata authority admits the exact owner, runtime and two-store frozen topology", () => {
  const { profile, facts } = fixture();
  const before = structuredClone({ profile, facts });
  assert.doesNotThrow(() => assertFrozenMetadataProfile(profile, facts));
  assert.deepEqual({ profile, facts }, before);
});

test("inline proof reference is optional but exact and immutable across profile/facts", () => {
  const { profile, facts } = fixture();
  const ref = { path: "/fixture/inline-proof.json", sha256: "a".repeat(64) };
  profile.inlineObserverProof = ref;
  facts.inlineObserverProof = { ...ref };
  assert.doesNotThrow(() => assertFrozenMetadataProfile(profile, facts));
  facts.inlineObserverProof = { ...ref, sha256: "b".repeat(64) };
  assert.throws(() => assertFrozenMetadataProfile(profile, facts), {
    code: "FROZEN_METADATA_FENCE_CHANGED",
  });
  facts.inlineObserverProof = ref;
  const extraFlag = { ...ref, accepted: true };
  profile.inlineObserverProof = extraFlag;
  assert.throws(() => assertFrozenMetadataProfile(profile, facts), {
    code: "FROZEN_METADATA_FENCE_CHANGED",
  });
});

test("two-store inspection preserves ledgers and distinguishes queue timing from dispatch evidence", (t) => {
  const { profile, root, epoch, ledgers: files, worker } = inspectionFixture(t);
  const before = files.map((file) => fs.readFileSync(file));
  const queued = profile.unresolved.find((row) => row.state === "queued")!;
  const jobDirectory = path.join(root, "jobs", queued.id);
  fs.mkdirSync(jobDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(jobDirectory, "phase-timings.json"),
    JSON.stringify({
      jobId: queued.id,
      jobHash: queued.hash,
      totals: { queueWait: { complete: true } },
      active: { local: null },
    }),
  );
  let observation = inspectFrozenMetadataWork(root, epoch);
  assert.equal(observation.queuedNeverStarted, true);
  assert.equal(observation.unresolved.length, 3);
  assert.deepEqual(observation.workers, [{ pid: 201, birth: "worker-201" }]);
  // A producer/dispatch trace invalidates the "never started" qualification.
  worker(queued.id, root, 202);
  observation = inspectFrozenMetadataWork(root, epoch);
  assert.equal(observation.queuedNeverStarted, false);
  assert.deepEqual(observation.workers, [
    { pid: 201, birth: "worker-201" },
    { pid: 202, birth: "worker-202" },
  ]);
  for (const [index, file] of files.entries())
    assert.deepEqual(fs.readFileSync(file), before[index]);
});

test("frozen metadata authority rejects changed pins, uncertain producers and missing frozen work", () => {
  const changes: ((facts: FrozenMetadataFacts) => void)[] = [
    (f) => {
      f.ownerClientId = "foreign";
    },
    (f) => {
      f.registeredOwnerMatches = false;
    },
    (f) => {
      f.previousConfigHash = "0".repeat(64);
    },
    (f) => {
      f.successorConfigHash = "0".repeat(64);
    },
    (f) => {
      f.buildHash = "0".repeat(64);
    },
    (f) => {
      f.sourceCommit = "0".repeat(40);
    },
    (f) => {
      f.expectedProcess = { ...f.expectedProcess, birth: "foreign" };
    },
    (f) => {
      f.previousProcessesDead = undefined;
    },
    (f) => {
      f.expectedProcessAlive = false;
    },
    (f) => {
      f.producersDead = undefined;
    },
    (f) => {
      f.queuedNeverStarted = false;
    },
    (f) => {
      f.unresolved = f.unresolved.slice(0, -1);
    },
    (f) => {
      f.provisioning = { ...f.provisioning, owner: "foreign" };
    },
  ];
  for (const change of changes) {
    const { profile, facts } = fixture();
    change(facts);
    assert.throws(() => assertFrozenMetadataProfile(profile, facts), {
      code: "FROZEN_METADATA_FENCE_CHANGED",
    });
  }
});

test("metadata authority cannot contain credentials, duplicate work or reuse a historical request", () => {
  const { profile, facts } = fixture();
  const credentialBearing = {
    ...profile,
    provisioning: { ...profile.provisioning, token: "must-never-be-journaled" },
  };
  assert.throws(() => assertFrozenMetadataProfile(credentialBearing, facts), {
    code: "FROZEN_METADATA_FENCE_CHANGED",
  });
  for (const change of [
    (p: FrozenMetadataProfile) => {
      p.unresolved.push({ ...p.unresolved[0]! });
    },
    (p: FrozenMetadataProfile) => {
      p.metadataRequestId = "old-export";
    },
    (p: FrozenMetadataProfile) => {
      p.beneficiary = "foreign-client";
    },
    (p: FrozenMetadataProfile) => {
      p.provisioning = { ...p.provisioning, pid: p.provisioning.pid + 1 };
    },
  ]) {
    const f = fixture();
    change(f.profile);
    assert.throws(() => assertFrozenMetadataProfile(f.profile, f.facts), {
      code: "FROZEN_METADATA_FENCE_CHANGED",
    });
  }
});

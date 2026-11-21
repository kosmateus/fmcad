import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertFrozenMetadataProfile,
  inspectFrozenMetadataWork,
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
    successorConfigHash: "b".repeat(64),
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

test("frozen metadata authority admits the exact owner, runtime and two-store frozen topology", () => {
  const { profile, facts } = fixture();
  const before = structuredClone({ profile, facts });
  assert.doesNotThrow(() => assertFrozenMetadataProfile(profile, facts));
  assert.deepEqual({ profile, facts }, before);
});

test("two-store inspection preserves ledgers and distinguishes queue timing from dispatch evidence", (t) => {
  const { profile } = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-frozen-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const epoch = path.join(root, "admission-epochs", "fixture");
  fs.mkdirSync(epoch, { recursive: true });
  const files = [
    path.join(root, "queue-state.json"),
    path.join(epoch, "queue-state.json"),
  ];
  for (const [index, store] of ["root", "epoch"].entries())
    fs.writeFileSync(
      files[index]!,
      JSON.stringify({
        jobs: Object.fromEntries(
          profile.unresolved
            .filter((row) => row.store === store)
            .map((row) => [row.id, row]),
        ),
        active: null,
        lease: null,
      }),
    );
  const before = files.map((file) => fs.readFileSync(file));
  const queued = profile.unresolved.find((row) => row.state === "queued")!;
  const jobDirectory = path.join(epoch, "jobs", queued.id);
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
  assert.deepEqual(observation.workers, []);
  // A producer/dispatch trace invalidates the "never started" qualification.
  fs.writeFileSync(
    path.join(jobDirectory, "worker-identity.json"),
    JSON.stringify({
      pid: 201,
      birth: "retained-worker",
    }),
  );
  observation = inspectFrozenMetadataWork(root, epoch);
  assert.equal(observation.queuedNeverStarted, false);
  assert.deepEqual(observation.workers, [
    { pid: 201, birth: "retained-worker" },
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

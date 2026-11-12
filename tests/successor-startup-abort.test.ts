import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type { DeadEpochFixture } from "./fixtures/epoch-fixture-types";

const repo = process.cwd();
const load = createRequire(
  path.join(repo, "tests/successor-startup-abort.test.js"),
);
const { abortUnstartedSuccessor } = load(
  "../scripts/abort-unstarted-successor.cjs",
) as typeof import("../scripts/abort-unstarted-successor.cjs");
const api = load("../src/queue-instance") as {
  hash(value: string | Uint8Array): string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  processBirth(): string;
  priorProcessAlive(value: unknown): boolean | null;
};
const reference = (file: string) => ({
  path: file,
  sha256: api.hash(fs.readFileSync(file)),
});

function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(repo, ".successor-abort-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = (
    load("./fixtures/dead-epoch-successor.cjs") as (
      base: string,
      repo: string,
    ) => DeadEpochFixture
  )(base, repo);
  fs.rmSync(path.join(f.audit, "isolated-scratch-qualification"), {
    recursive: true,
  }); // Only this synthetic prospective SDK proof.
  const approvalFile = path.join(base, "approval.json");
  api.durable(approvalFile, f.approval, true);
  const intent = {
    version: 1,
    requestId: f.requestId,
    clientId: f.clientId,
    ownerTokenHash: api.hash(f.token),
    nonce: f.nonce,
    approval: reference(approvalFile),
    previousOwner: f.previousOwner,
  };
  api.durable(path.join(f.audit, "intent.json"), intent, true);
  api.durable(
    path.join(f.audit, "launch-intent.json"),
    { nonce: f.nonce, authority: f.authorityEntry },
    true,
  );
  api.durable(path.join(f.audit, "retired-owner.json"), f.previousOwner, true);
  const guard = {
    kind: "dead-epoch-successor",
    nonce: f.nonce,
    audit: f.audit,
    clientId: f.clientId,
  };
  for (const name of ["recovery.lock", "atomic-migration.lock"])
    api.durable(path.join(f.dir, name), guard, true);
  api.durable(
    path.join(f.dir, "active-epoch-succession.json"),
    { version: 1, authority: f.authorityEntry },
    true,
  );
  fs.unlinkSync(path.join(f.dir, "broker.lock")); // Synthetic terminal startup already released its own marker.
  const worker = {
    pid: 2147483644,
    birth: "dead:rejected-worker",
    nonce: f.nonce,
  };
  api.durable(path.join(f.audit, "worker-claim.json"), worker, true);
  api.durable(
    path.join(f.audit, "worker-error.json"),
    { nonce: f.nonce, code: "INSTANCE_CHANGED" },
    true,
  );
  const nonce = randomUUID(),
    lifecycleFile = path.join(f.dir, "broker-lifecycle-" + nonce + ".json");
  const receipt = path.join(f.dir, "broker-startup-" + nonce + ".receipt.json");
  const lifecycle = {
    owner: { ...worker, nonce, protocol: 2 },
    stage: "rejected",
    safeToRecover: true,
    code: "INSTANCE_CHANGED",
    buildHash: f.authority.buildHash,
    configHash: f.authority.configHash,
    receipt,
    binding: {
      brokerNonce: nonce,
      ownerPid: worker.pid,
      ownerBirth: worker.birth,
      buildHash: f.authority.buildHash,
      stage: "startup",
    },
  };
  api.durable(lifecycleFile, lifecycle, true);
  const client = {
    dir: f.dir,
    auth: { clientId: f.clientId, clientToken: f.token },
  };
  return {
    ...f,
    client,
    base,
    approvalFile,
    lifecycle,
    lifecycleFile,
    receipt,
    worker,
    guard,
  };
}

test("FAKE metadata: preflight and owner SDK0 abort preserve predecessor/unknown and retain the rejected attempt", (t) => {
  const f = fixture(t);
  const protectedFiles = [
    f.authority.predecessor.pointer.path,
    f.authority.predecessor.state.path,
    f.authority.predecessor.identity.path,
    f.authority.predecessor.rootState.path,
    f.authority.predecessor.rootIdentity.path,
    path.join(f.audit, "authority.json"),
    path.join(f.audit, "worker-error.json"),
  ];
  const before = protectedFiles.map((file) => fs.readFileSync(file));
  const preflight = abortUnstartedSuccessor(f.client, f.approvalFile, false);
  assert.ok("ready" in preflight);
  assert.equal(preflight["ready"], true);
  assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
  const complete = abortUnstartedSuccessor(f.client, f.approvalFile, true);
  assert.equal(complete["status"], "aborted");
  assert.equal(complete["sdkRequestsSent"], 0);
  assert.equal(complete["historicalOutcome"], "unknown");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8")),
    f.previousOwner,
  );
  for (const name of [
    "recovery.lock",
    "atomic-migration.lock",
    "active-epoch-succession.json",
  ])
    assert.equal(fs.existsSync(path.join(f.dir, name)), false);
  for (const [i, file] of protectedFiles.entries())
    assert.deepEqual(fs.readFileSync(file), before[i]);
  // A later owner does not let an observation of the original receipt change global state.
  api.durable(path.join(f.dir, "broker.lock"), { later: "owner" });
  assert.deepEqual(
    abortUnstartedSuccessor(f.client, f.approvalFile, true),
    complete,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8")),
    { later: "owner" },
  );
});

test("FAKE metadata: the selected process may have exited after rejected SDK0 startup", (t) => {
  const f = fixture(t);
  const original = api.priorProcessAlive;
  t.mock.method(api, "priorProcessAlive", (value: unknown) =>
    JSON.stringify(value) === JSON.stringify(f.authority.expectedProcess)
      ? false
      : original(value),
  );
  assert.equal(
    abortUnstartedSuccessor(f.client, f.approvalFile, true)["status"],
    "aborted",
  );
});

test("FAKE metadata: interrupted guard release resumes only the original abort", (t) => {
  const f = fixture(t);
  const unlink = fs.unlinkSync;
  const interruption = t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    unlink(file);
    if (file === path.join(f.dir, "atomic-migration.lock"))
      throw new Error("Synthetic interruption after first guard release");
  });
  assert.throws(
    () => abortUnstartedSuccessor(f.client, f.approvalFile, true),
    /Synthetic interruption/,
  );
  interruption.mock.restore();
  assert.equal(fs.existsSync(path.join(f.dir, "atomic-migration.lock")), false);
  assert.equal(fs.existsSync(path.join(f.dir, "recovery.lock")), true);
  assert.equal(
    abortUnstartedSuccessor(f.client, f.approvalFile, true)["status"],
    "aborted",
  );
});

test("FAKE metadata: relocated approval must retain exactly the approved bytes", (t) => {
  const f = fixture(t);
  const copy = path.join(f.base, "relocated-approval.json");
  fs.copyFileSync(f.approvalFile, copy);
  assert.equal(
    abortUnstartedSuccessor(f.client, copy, true)["status"],
    "aborted",
  );
});

for (const reason of [
  "owner",
  "approval",
  "worker",
  "lifecycle",
  "probe",
  "ready",
  "sdk",
  "guard",
  "pointer",
  "marker",
  "authority",
]) {
  test("FAKE metadata: abort refuses " + reason + " evidence", (t) => {
    const f = fixture(t);
    if (reason === "owner") f.client.auth.clientToken = "b".repeat(64);
    if (reason === "authority") {
      api.durable(path.join(f.audit, "authority.json"), {
        ...f.authority,
        expectedProcess: { pid: 2147483643, birth: "different" },
      });
      const entry = reference(path.join(f.audit, "authority.json"));
      api.durable(path.join(f.dir, "active-epoch-succession.json"), {
        version: 1,
        authority: entry,
      });
      api.durable(path.join(f.audit, "launch-intent.json"), {
        nonce: f.nonce,
        authority: entry,
      });
    }
    if (reason === "approval") fs.appendFileSync(f.approvalFile, " ");
    if (reason === "worker")
      api.durable(path.join(f.audit, "worker-claim.json"), {
        pid: process.pid,
        birth: api.processBirth(),
        nonce: f.nonce,
      });
    if (reason === "lifecycle")
      api.durable(f.lifecycleFile, { ...f.lifecycle, safeToRecover: false });
    if (reason === "probe") api.durable(f.receipt, { terminal: true });
    if (reason === "ready")
      api.durable(path.join(f.audit, "worker-ready.json"), { synthetic: true });
    if (reason === "sdk")
      fs.mkdirSync(path.join(f.audit, "dead-epoch-current-observation"));
    if (reason === "guard")
      api.durable(path.join(f.dir, "recovery.lock"), { other: "owner" });
    if (reason === "pointer")
      api.durable(path.join(f.dir, "isolated-admission-epoch.json"), {
        changed: true,
      });
    if (reason === "marker")
      api.durable(path.join(f.dir, "broker.lock"), {
        pid: process.pid,
        birth: api.processBirth(),
      });
    assert.throws(() =>
      abortUnstartedSuccessor(f.client, f.approvalFile, true),
    );
    assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
    assert.equal(
      fs.existsSync(path.join(f.dir, "atomic-migration.lock")),
      true,
    );
  });
}

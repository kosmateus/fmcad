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
const { abortUnstartedSuccessor, retireMetadataWorker } = load(
  "../scripts/abort-unstarted-successor.cjs",
) as typeof import("../scripts/abort-unstarted-successor.cjs");
const { inspectSuccessor } = load(
  "../src/queue-epoch-successor",
) as typeof import("../src/composition/queue-epoch-successor");
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

function readyFixture(t: TestContext) {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.audit, "worker-error.json"));
  const owner = f.lifecycle.owner;
  api.durable(f.lifecycleFile, {
    owner,
    stage: "ready",
    buildHash: f.authority.buildHash,
    configHash: f.authority.configHash,
  });
  api.durable(path.join(f.audit, "worker-ready.json"), {
    nonce: f.nonce,
    owner,
    buildHash: f.authority.buildHash,
    sdkRequestsSent: 0,
  });
  api.durable(path.join(f.audit, "complete.json"), {
    version: 1,
    kind: "dead-epoch-successor-metadata-ready",
    requestId: f.requestId,
    authority: f.authorityEntry,
    owner,
    buildHash: f.authority.buildHash,
    sourceCommit: f.authority.sourceCommit,
    sdkRequestsSent: 0,
    historicalOutcome: "unknown",
    modelingAdmission: "blocked-until-current-facts-and-proven-new-scratch",
  });
  for (const name of ["recovery.lock", "atomic-migration.lock"]) {
    fs.renameSync(
      path.join(f.dir, name),
      path.join(f.audit, "released-" + name + ".json"),
    );
  }
  const observation = path.join(f.audit, "dead-epoch-current-observation");
  fs.mkdirSync(observation);
  const key = {
    jobId: f.inspection.pointer.quarantinedJobIds[0],
    observationJobId: f.inspection.pointer.quarantinedJobIds[1],
    requestId: f.requestId + ":observe",
    clientId: f.clientId,
  };
  api.durable(path.join(observation, "intent.json"), {
    version: 1,
    key,
    binding: {
      purpose: "atomic-recovery-audit-v1",
      clientId: f.clientId,
      expectedProcess: f.authority.expectedProcess,
      successorAuthorityHash: f.authorityEntry.sha256,
    },
    sourceSha256: "a".repeat(64),
    sourceArtifactHash: "b".repeat(64),
  });
  api.durable(path.join(observation, "result.json"), {
    kind: "dead-epoch-current-observation",
    ...key,
    status: "failed",
    code: "AUDIT_REQUEST_INVALID",
    sdkRequestsSent: 0,
    nativeOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
  });
  return { ...f, owner, observation };
}

function retirementFixture(t: TestContext) {
  const f = readyFixture(t);
  let alive = true,
    signals = 0,
    fusionReads = 0;
  const original = api.priorProcessAlive;
  t.mock.method(api, "priorProcessAlive", (value: unknown) => {
    if (
      value &&
      typeof value === "object" &&
      "pid" in value &&
      "birth" in value &&
      value.pid === f.worker.pid &&
      value.birth === f.worker.birth
    )
      return alive;
    return original(value);
  });
  api.durable(path.join(f.dir, "broker.lock"), f.owner);
  const exe = path.join(f.base, "synthetic-node-executable");
  fs.writeFileSync(exe, "fake process port ONLY; never executed");
  const process = {
    pid: f.owner.pid,
    birth: f.owner.birth,
    exe,
    exeSha256: reference(exe).sha256,
    cmdline: [
      exe,
      f.approval.candidateRoot + "/src/queue-epoch-successor-worker.js",
    ],
    childrenByTask: {},
    socketRows: [],
  };
  const osFile = path.join(f.base, "os-after.json");
  api.durable(osFile, process);
  const fusion = {
    ...f.authority.expectedProcess,
    version: "synthetic-version",
  };
  const proof = {
    kind: "metadata-worker-retirement-proof-v1",
    qualified: true,
    proofGaps: [],
    sourceCommit: f.authority.sourceCommit,
    buildHash: f.authority.buildHash,
    runtimeRoot: f.approval.candidateRoot,
    worker: f.owner,
    workerClaimNonce: f.nonce,
    requestId: f.requestId,
    epochId: f.approval.predecessorEpochId,
    fusion,
    protectedFiles: [
      reference(path.join(f.dir, "broker.lock")),
      reference(path.join(f.observation, "result.json")),
      reference(f.authority.predecessor.rootState.path),
    ],
    sourceFiles: [reference(exe)],
    evidenceFiles: [reference(osFile)],
  };
  const proofFile = path.join(f.base, "independent-proof.json");
  api.durable(proofFile, proof);
  const control = {
    instanceId: f.owner.nonce,
    buildHash: proof.buildHash,
    activeOperations: 0,
    activeIds: [],
    unresolved: true,
    phase: "RECOVERY_BLOCKED",
  };
  const status = {
    buildHash: proof.buildHash,
    sourceCommit: proof.sourceCommit,
    admissionEpoch: proof.epochId,
    held: "Qualified isolated scratch process is unavailable; metadata only, no SDK or replacement authority",
    stopping: false,
    deadEpochSuccessor: {
      requestId: f.requestId,
      currentFactsAvailable: false,
      expectedProcess: f.authority.expectedProcess,
    },
    features: {
      auditFactsCapture: false,
      atomicRecoveryProcessLossAudit: false,
    },
  };
  const client = {
    ...f.client,
    async call(action: string) {
      return structuredClone(action === "queue-summary" ? status : control);
    },
  };
  const ports: NonNullable<Parameters<typeof retireMetadataWorker>[4]> = {
    certify() {
      /* Fake source certification for protocol tests, not a production qualification. */
    },
    process(_owner, _runtime, _refs, apply) {
      if (apply) {
        signals++;
        alive = false;
      }
      return { process, retired: apply };
    },
    fusion() {
      fusionReads++;
      return { ...fusion, hasExited: false, responding: true };
    },
  };
  return {
    ...f,
    client,
    proof,
    proofFile,
    ports,
    process,
    status,
    control,
    counts: () => ({ signals, fusionReads }),
    setAlive(value: boolean) {
      alive = value;
    },
  };
}

test("FAKE retirement protocol: preview has no effect, explicit effect appends before/after, restoration retains original unknown", async (t) => {
  const f = retirementFixture(t);
  const before = fs.readFileSync(f.authority.predecessor.rootState.path);
  const preview = await retireMetadataWorker(
    f.client,
    f.approvalFile,
    f.proofFile,
    false,
    f.ports,
  );
  assert.ok("retirementPerformed" in preview);
  assert.equal(preview["retirementPerformed"], false);
  assert.equal(f.counts().signals, 0);
  const result = await retireMetadataWorker(
    f.client,
    f.approvalFile,
    f.proofFile,
    true,
    f.ports,
  );
  assert.equal(result["retired"], true);
  assert.equal(result["gracefulClose"], false);
  assert.equal(f.counts().signals, 1);
  assert.ok(f.counts().fusionReads >= 4);
  assert.deepEqual(
    await retireMetadataWorker(
      f.client,
      f.approvalFile,
      f.proofFile,
      true,
      f.ports,
    ),
    result,
  );
  assert.equal(f.counts().signals, 1);
  const aborted = abortUnstartedSuccessor(f.client, f.approvalFile, true);
  assert.equal(aborted["status"], "aborted");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8")),
    f.previousOwner,
  );
  assert.deepEqual(
    fs.readFileSync(f.authority.predecessor.rootState.path),
    before,
  );
});

for (const reason of [
  "proof-gap",
  "source-certification",
  "pid-birth",
  "active-operation",
  "current-facts",
  "fusion-before",
  "source-drift",
  "late-status",
]) {
  test(
    "FAKE retirement protocol refuses " + reason + " before any signal",
    async (t) => {
      const f = retirementFixture(t);
      if (reason === "proof-gap")
        api.durable(f.proofFile, { ...f.proof, proofGaps: ["unproven port"] });
      if (reason === "source-certification")
        f.ports.certify = () => {
          throw new Error("Unknown runtime closure");
        };
      if (reason === "pid-birth") f.process.birth = "different";
      if (reason === "active-operation") f.control.activeOperations = 1;
      if (reason === "current-facts")
        f.status.deadEpochSuccessor.currentFactsAvailable = true;
      if (reason === "fusion-before")
        f.ports.fusion = () => ({ ...f.proof.fusion, birth: "different" });
      if (reason === "source-drift")
        fs.appendFileSync(f.process.exe, "changed");
      if (reason === "late-status") {
        const call = f.client.call;
        let count = 0;
        f.client.call = async (action) => {
          if (++count > 2) f.control.activeOperations = 1;
          return call(action);
        };
      }
      await assert.rejects(
        retireMetadataWorker(
          f.client,
          f.approvalFile,
          f.proofFile,
          true,
          f.ports,
        ),
      );
      assert.equal(f.counts().signals, 0);
    },
  );
}

test("FAKE retirement protocol: an interrupted signal is never replayed and failed Fusion post-proof remains pending", async (t) => {
  const f = retirementFixture(t),
    process = f.ports.process;
  f.ports.process = (...args) => {
    const result = process(...args);
    if (args[3]) throw new Error("Unknown signal response after effect");
    return result;
  };
  await assert.rejects(
    retireMetadataWorker(f.client, f.approvalFile, f.proofFile, true, f.ports),
    /Unknown signal/,
  );
  assert.equal(f.counts().signals, 1);
  f.ports.fusion = () => {
    throw new Error("Fresh Fusion OS unavailable");
  };
  await assert.rejects(
    retireMetadataWorker(f.client, f.approvalFile, f.proofFile, true, f.ports),
    /Fusion OS unavailable/,
  );
  assert.equal(
    fs.existsSync(
      path.join(f.audit, "abort-unstarted", "retirement-after.json"),
    ),
    false,
  );
  assert.equal(f.counts().signals, 1);
  f.setAlive(true);
  await assert.rejects(
    retireMetadataWorker(f.client, f.approvalFile, f.proofFile, true, f.ports),
    /never repeat a signal/,
  );
  assert.equal(f.counts().signals, 1);
});

test("FAKE metadata-ready: terminal observation rejection SDK0 permits explicit retirement without rewriting ready/history", (t) => {
  const f = readyFixture(t);
  const names = [
    "authority.json",
    "worker-ready.json",
    "complete.json",
    "dead-epoch-current-observation/intent.json",
    "dead-epoch-current-observation/result.json",
  ];
  const before = names.map((name) => fs.readFileSync(path.join(f.audit, name)));
  const preview = abortUnstartedSuccessor(f.client, f.approvalFile, false);
  assert.ok("reason" in preview);
  assert.equal(
    preview["reason"],
    "metadata-ready-observation-rejected-before-sdk",
  );
  const result = abortUnstartedSuccessor(f.client, f.approvalFile, true);
  assert.equal(result["status"], "aborted");
  assert.ok("reason" in result);
  assert.equal(
    result["reason"],
    "metadata-ready-observation-rejected-before-sdk",
  );
  for (const [i, name] of names.entries())
    assert.deepEqual(fs.readFileSync(path.join(f.audit, name)), before[i]);
  assert.deepEqual(
    abortUnstartedSuccessor(f.client, f.approvalFile, true),
    result,
  );
});

test("FAKE metadata-ready: preview identifies the live exact owner but apply cannot signal or retire it", (t) => {
  const f = readyFixture(t),
    original = api.priorProcessAlive;
  t.mock.method(api, "priorProcessAlive", (value: unknown) =>
    JSON.stringify(value) === JSON.stringify(f.worker) ? true : original(value),
  );
  api.durable(path.join(f.dir, "broker.lock"), f.owner);
  const preview = abortUnstartedSuccessor(f.client, f.approvalFile, false);
  assert.ok("requiresWorkerRetirement" in preview);
  assert.equal(preview["requiresWorkerRetirement"], true);
  assert.ok("applyReady" in preview);
  assert.equal(preview["applyReady"], false);
  assert.throws(
    () => abortUnstartedSuccessor(f.client, f.approvalFile, true),
    /proven dead/,
  );
  assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
});

test("FAKE metadata-ready: a new owner-approved successor must link the exact retired attempt and retain its result", (t) => {
  t.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
  const f = readyFixture(t);
  abortUnstartedSuccessor(f.client, f.approvalFile, true);
  api.durable(
    path.join(f.dir, "broker-lifecycle-" + f.previousOwner.nonce + ".json"),
    f.inspection.previousLifecycle,
  );
  const requestId = "new-qualified-attempt-" + randomUUID();
  const approvalFile = path.join(f.base, "new-approval.json");
  const approval = {
    ...f.approval,
    requestId,
    priorAbortedSuccessor: reference(
      path.join(f.audit, "abort-unstarted", "complete.json"),
    ),
  };
  const before = fs.readFileSync(path.join(f.observation, "result.json"));
  api.durable(approvalFile, approval);
  assert.equal(
    inspectSuccessor(f.client, f.cfg, approvalFile, requestId).requestId,
    requestId,
  );
  const missing = { ...approval };
  delete (missing as Partial<typeof approval>).priorAbortedSuccessor;
  api.durable(approvalFile, missing);
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, approvalFile, requestId),
    { code: "EPOCH_SUCCESSOR_ABORT_REQUIRED" },
  );
  api.durable(approvalFile, {
    ...approval,
    priorAbortedSuccessor: {
      ...approval.priorAbortedSuccessor,
      sha256: "0".repeat(64),
    },
  });
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, approvalFile, requestId),
    { code: "EPOCH_SUCCESSOR_ABORT_INVALID" },
  );
  api.durable(approvalFile, approval);
  fs.appendFileSync(path.join(f.observation, "result.json"), " ");
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, approvalFile, requestId),
    { code: "EPOCH_SUCCESSOR_ABORT_INVALID" },
  );
  assert.deepEqual(
    fs
      .readFileSync(path.join(f.observation, "result.json"))
      .subarray(0, before.length),
    before,
  );
});

for (const reason of [
  "sdk-sent",
  "missing-result",
  "unknown-result",
  "start",
  "wire",
  "remote",
  "facts",
  "scratch",
  "pending",
  "guard",
  "marker",
  "owner",
  "ready-build",
  "complete-source",
  "binding",
  "released-guard",
]) {
  test("FAKE metadata-ready: retirement refuses " + reason, (t) => {
    const f = readyFixture(t);
    const resultFile = path.join(f.observation, "result.json");
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<
      string,
      unknown
    >;
    if (reason === "sdk-sent")
      api.durable(resultFile, { ...result, sdkRequestsSent: 1 });
    if (reason === "missing-result") fs.unlinkSync(resultFile);
    if (reason === "unknown-result")
      api.durable(resultFile, { ...result, status: "unknown" });
    if (["start", "wire", "remote"].includes(reason))
      api.durable(path.join(f.observation, reason + ".json"), {});
    if (reason === "facts")
      api.durable(path.join(f.audit, "observed-current.json"), {});
    if (reason === "scratch")
      fs.mkdirSync(path.join(f.audit, "isolated-scratch-qualification"));
    if (reason === "pending")
      api.durable(path.join(f.dir, "queue-state.pending.json"), {});
    if (reason === "guard")
      api.durable(path.join(f.dir, "recovery.lock"), f.guard);
    if (reason === "marker")
      api.durable(path.join(f.dir, "broker.lock"), f.owner);
    if (reason === "owner") f.client.auth.clientToken = "foreign";
    if (reason === "ready-build")
      api.durable(path.join(f.audit, "worker-ready.json"), {
        nonce: f.nonce,
        owner: f.owner,
        buildHash: "foreign",
        sdkRequestsSent: 0,
      });
    if (reason === "complete-source") {
      const file = path.join(f.audit, "complete.json");
      api.durable(file, {
        ...JSON.parse(fs.readFileSync(file, "utf8")),
        sourceCommit: "foreign",
      });
    }
    if (reason === "binding") {
      const file = path.join(f.observation, "intent.json");
      api.durable(file, {
        ...JSON.parse(fs.readFileSync(file, "utf8")),
        binding: {},
      });
    }
    if (reason === "released-guard")
      api.durable(path.join(f.audit, "released-recovery.lock.json"), {});
    assert.throws(() =>
      abortUnstartedSuccessor(f.client, f.approvalFile, true),
    );
    assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
  });
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

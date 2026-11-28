import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  createBrokerRecovery,
  type RecoveryDispatch,
  type RecoveryFence,
  type RecoveryJob,
  type RecoveryProbe,
  type RecoveryProbeStage,
  type RecoveryReceipt,
} from "../packages/core/src/application/broker-recovery";
import { createBrokerRecoveryEvidence } from "../packages/node-adapters/src/execution/broker-recovery-evidence";

const reconcileHash = (jobId: string, rpcId: string) =>
  createHash("sha256").update(`reconcile:${jobId}:${rpcId}`).digest("hex");

function fixture(rpcCount = 1) {
  const instance = {
    pid: 34,
    birth: "fixture:incarnation",
    version: "fixture:version",
    activeCommand: "SelectCommand",
  };
  const buildHash = "pinned-build";
  const job: RecoveryJob = {
    id: "original-job",
    requestId: "original-request",
    hash: "accepted-input-identity",
    clientId: "original-owner",
    request: { buildHash, isolatedEpoch: "isolated" },
    state: "needs_reconciliation",
    dispatch: { dispatchCount: 1, rpcCount, completedCount: 0, updatedAt: 1 },
  };
  const fence: RecoveryFence = {
    jobId: job.id,
    requestId: job.requestId,
    clientId: job.clientId,
    jobHash: job.hash,
    state: job.state,
    rpcCount,
    brokerInstanceId: "current-broker",
    instance,
    buildHash,
    executableBuildHash: buildHash,
    epochId: "isolated",
    receiptEpoch: "isolated",
    revision: 41,
    generation: 20,
    contextEpoch: 15,
    blockedJobId: job.id,
    activeJobId: null,
  };
  const rpc: RecoveryDispatch = {
    binding: {
      jobId: job.id,
      rpcId: "original-sdk-call",
      requestHash: "original-payload",
      sourceHash: "original-source",
      isolatedEpoch: "isolated",
      buildHash,
    },
    instance,
    method: "tools/call",
    receipt: "/fixture/original-receipt",
    terminal: false,
  };
  const probeId = randomUUID();
  const probe: RecoveryProbe = {
    binding: {
      jobId: job.id,
      rpcId: probeId,
      requestHash: reconcileHash(job.id, probeId),
      buildHash,
    },
    instance,
    receipt: "/fixture/probe-receipt",
  };
  const rpcReceipt: RecoveryReceipt = {
    ...rpc.binding,
    instance,
    terminal: true,
    outcome: "succeeded",
  };
  const probeReceipt: RecoveryReceipt = {
    ...probe.binding,
    instance,
    terminal: true,
    outcome: "succeeded",
  };
  const files = new Map<string, RecoveryReceipt>();
  const probes = new Map<RecoveryProbeStage, RecoveryProbe>();
  const live = {
    fence: structuredClone(fence),
    record: rpcCount ? [rpc] : [],
    reads: [] as string[],
    validResponse: true,
    context: "closed" as "absent" | "pending" | "closed",
    changeFenceOnRead: false,
    workerIdentity: null as unknown,
    processBirth: (): string =>
      assert.fail("No original worker identity in this fixture"),
    nativeDeclared: false,
  };
  const evidence = createBrokerRecoveryEvidence(
    {
      readRpcRecords: () => live.record,
      findRemoteReceipt(record) {
        const file = record.receipt!;
        live.reads.push(file);
        if (live.changeFenceOnRead)
          live.fence = { ...live.fence, revision: live.fence.revision + 1 };
        return files.get(file) ?? null;
      },
      readProbeIntent: (_job, stage) => probes.get(stage) ?? null,
      readCompletedPreflight: () => null,
      readAdapterOutcome: () => null,
      readOutcome: () => null,
      readWorkerResult: () => null,
      readWorkerStart: () => null,
      readWorkerIdentity: () => live.workerIdentity,
    },
    {
      readFence: () => live.fence,
      workerContext: () => live.context,
      processBirth: () => live.processBirth(),
      workflowNonterminal: () => false,
      nativeReceipts: {
        start: () => (live.nativeDeclared ? {} : null),
        completion: () => null,
      },
      validateTerminalResponse() {
        if (!live.validResponse)
          throw Object.assign(new Error("Unexpected original wire reply ID"), {
            code: "UNKNOWN_RPC",
          });
      },
    },
  );
  const recovery = createBrokerRecovery(evidence);
  return {
    job,
    fence,
    live,
    files,
    probes,
    rpc,
    rpcReceipt,
    probe,
    probeReceipt,
    recovery,
  };
}

function waitingFor(
  decision: { kind: string; code?: string; observation?: unknown },
  code: string,
) {
  assert.equal(decision.kind, "waitingForEvidence");
  assert.equal(decision.code, code);
  assert.equal(decision.observation, undefined);
}

test("only matching original completion and a completed existing probe settle the held job", () => {
  const f = fixture();
  f.probes.set("reconcile", f.probe);
  f.files.set(f.probe.receipt!, f.probeReceipt);
  const before = structuredClone(f.live.fence);
  waitingFor(f.recovery.reconcile(f.job, f.fence), "RECEIPT_UNAVAILABLE");
  assert.deepEqual(f.live.reads, [f.rpc.receipt]);
  assert.deepEqual(f.live.fence, before);

  f.files.set(f.rpc.receipt!, f.rpcReceipt);
  const result = f.recovery.reconcile(f.job, f.fence);
  assert.equal(result.kind, "settled");
  assert.ok(result.dispatched);
  assert.deepEqual(result.records, [f.rpc]);
  assert.deepEqual(result.receipts, [f.rpcReceipt]);
  assert.deepEqual(result.observation, f.probeReceipt.instance);
  assert.equal(f.files.size, 2);
  assert.equal(f.job.state, "needs_reconciliation");
  assert.deepEqual(f.live.fence, before);
});

test("a pending, foreign or busy recovery probe never authorizes another observation", () => {
  const f = fixture();
  f.files.set(f.rpc.receipt!, f.rpcReceipt);
  f.probes.set("reconcile", f.probe);
  waitingFor(f.recovery.reconcile(f.job, f.fence), "RECEIPT_UNAVAILABLE");
  f.files.set(f.probe.receipt!, { ...f.probeReceipt, rpcId: "another-probe" });
  waitingFor(f.recovery.reconcile(f.job, f.fence), "RECEIPT_MISMATCH");
  f.files.set(f.probe.receipt!, {
    ...f.probeReceipt,
    outcome: "failed",
    instance: { ...f.probeReceipt.instance, activeCommand: "NativeCommand" },
  });
  waitingFor(f.recovery.reconcile(f.job, f.fence), "NATIVE_RECEIPT_REQUIRED");
  const failed = { ...f.probeReceipt, outcome: "failed" };
  f.files.set(f.probe.receipt!, failed);
  const result = f.recovery.reconcile(f.job, f.fence);
  assert.equal(result.kind, "waitingForEvidence");
  assert.equal(result.code, "OBSERVATION_REQUIRED");
  assert.deepEqual(result.observation, { priorFailed: f.probe });
  assert.deepEqual(f.files.get(f.probe.receipt!), failed);

  // An older attempt may still publish under its original exact name. Such a
  // receipt does not count as evidence for the new, now-owned probe intent.
  const newProbeId = randomUUID();
  f.probes.set("reconcile", {
    ...f.probe,
    binding: {
      ...f.probe.binding,
      rpcId: newProbeId,
      requestHash: reconcileHash(f.job.id, newProbeId),
    },
    receipt: "/fixture/new-probe-receipt",
  });
  f.files.set(f.probe.receipt!, f.probeReceipt);
  waitingFor(f.recovery.reconcile(f.job, f.fence), "RECEIPT_UNAVAILABLE");
});

test("matching files cannot turn a different stage hash into recovery probe evidence", () => {
  const f = fixture();
  f.files.set(f.rpc.receipt!, f.rpcReceipt);
  const requestHash = "foreign-stage-request-hash";
  f.probes.set("reconcile", {
    ...f.probe,
    binding: { ...f.probe.binding, requestHash },
  });
  f.files.set(f.probe.receipt!, { ...f.probeReceipt, requestHash });
  waitingFor(f.recovery.reconcile(f.job, f.fence), "RECEIPT_MISMATCH");
});

test("a native declaration without a terminal lifecycle receipt retains the hold", () => {
  const f = fixture();
  f.live.nativeDeclared = true;
  f.files.set(f.rpc.receipt!, f.rpcReceipt);
  f.files.set(f.probe.receipt!, f.probeReceipt);
  f.probes.set("reconcile", f.probe);
  waitingFor(f.recovery.reconcile(f.job, f.fence), "NATIVE_WORKFLOW_PENDING");
});

test("a malformed stored birth cannot prove the worker gone", () => {
  const f = fixture();
  f.live.context = "absent";
  f.live.workerIdentity = { pid: process.pid };
  f.live.processBirth = () => `${randomUUID()}:1234`;
  f.files.set(f.rpc.receipt!, f.rpcReceipt);
  waitingFor(
    f.recovery.reconcile(f.job, f.fence),
    "WORKER_IDENTITY_UNAVAILABLE",
  );
});

test("unreadable birth data is not evidence that a live PID disappeared", () => {
  const f = fixture();
  f.live.context = "absent";
  f.files.set(f.rpc.receipt!, f.rpcReceipt);
  f.live.workerIdentity = { pid: process.pid, birth: `${randomUUID()}:1234` };
  f.live.processBirth = () => {
    throw Object.assign(new Error("Boot identity unavailable"), {
      code: "ENOENT",
    });
  };
  waitingFor(
    f.recovery.reconcile(f.job, f.fence),
    "WORKER_IDENTITY_UNAVAILABLE",
  );
  // The missing birth observation is usable only if the kernel proves that the
  // PID really no longer exists. A high positive PID is outside Linux pid_max.
  f.live.workerIdentity = { pid: 0x7fffffff, birth: `${randomUUID()}:1234` };
  const result = f.recovery.reconcile(f.job, f.fence);
  assert.equal(result.kind, "waitingForEvidence");
  assert.equal(result.code, "OBSERVATION_REQUIRED");
});

test("source, build, process and epoch mismatches are not evidence of the original dispatch", () => {
  const f = fixture();
  f.probes.set("reconcile", f.probe);
  f.files.set(f.probe.receipt!, f.probeReceipt);
  for (const mismatch of [
    { ...f.rpcReceipt, jobId: "foreign-job" },
    { ...f.rpcReceipt, requestHash: "foreign-payload" },
    { ...f.rpcReceipt, buildHash: "foreign-build" },
    { ...f.rpcReceipt, sourceHash: "foreign-source" },
    { ...f.rpcReceipt, isolatedEpoch: "foreign-epoch" },
    {
      ...f.rpcReceipt,
      instance: { ...f.rpcReceipt.instance, birth: "reused-pid" },
    },
  ]) {
    f.files.set(f.rpc.receipt!, mismatch);
    waitingFor(f.recovery.reconcile(f.job, f.fence), "RECEIPT_MISMATCH");
  }
});

test("an owner mismatch or a late callback cannot use a previously valid receipt", () => {
  const f = fixture();
  f.files.set(f.rpc.receipt!, f.rpcReceipt);
  f.probes.set("reconcile", f.probe);
  f.files.set(f.probe.receipt!, f.probeReceipt);
  waitingFor(
    f.recovery.reconcile({ ...f.job, clientId: "foreign-owner" }, f.fence),
    "STATE_CONFLICT",
  );
  assert.deepEqual(f.live.reads, []);
  assert.equal(f.recovery.reconcile(f.job, f.fence).kind, "settled");
  f.live.fence = {
    ...f.live.fence,
    contextEpoch: f.live.fence.contextEpoch + 1,
  };
  assert.throws(() => f.recovery.assertCurrentFence(f.fence), {
    code: "STATE_CONFLICT",
  });
  f.live.fence = structuredClone(f.fence);
  f.live.changeFenceOnRead = true;
  waitingFor(f.recovery.reconcile(f.job, f.fence), "STATE_CONFLICT");
});

test("a postflight local fence observes only terminal journals and never treats a raw reply as SDK completion", () => {
  const f = fixture();
  const job = { ...f.job, state: "running" };
  const fence = {
    ...f.fence,
    state: job.state,
    activeJobId: job.id,
    blockedJobId: null,
    executableBuildHash: "changed-after-original-sdk-turn",
  };
  f.live.fence = structuredClone(fence);
  f.files.set(f.rpc.receipt!, f.rpcReceipt);
  waitingFor(
    f.recovery.verifyCompletedDispatch(job, fence),
    "RECEIPT_UNAVAILABLE",
  );
  // The terminal journal can retain the exact receipt if the duplicate file
  // is absent. A mismatched original wire reply still cannot settle it.
  f.live.record = [{ ...f.rpc, terminal: true, remoteReceipt: f.rpcReceipt }];
  f.files.delete(f.rpc.receipt!);
  f.live.validResponse = false;
  waitingFor(f.recovery.verifyCompletedDispatch(job, fence), "UNKNOWN_RPC");
  f.live.validResponse = true;
  assert.deepEqual(f.recovery.verifyCompletedDispatch(job, fence), {
    kind: "settled",
  });
  f.files.set(f.rpc.receipt!, {
    ...f.rpcReceipt,
    sourceHash: "foreign-source",
  });
  waitingFor(
    f.recovery.verifyCompletedDispatch(job, fence),
    "RECEIPT_MISMATCH",
  );
  assert.equal(f.probes.size, 0);
});

test("an undispatched job settles without a new observation only when the worker has stopped", () => {
  const f = fixture(0);
  f.live.context = "pending";
  waitingFor(f.recovery.reconcile(f.job, f.fence), "WORKER_PENDING");
  f.live.context = "closed";
  assert.deepEqual(f.recovery.reconcile(f.job, f.fence), {
    kind: "settled",
    dispatched: false,
    preflight: null,
  });
  assert.deepEqual(f.live.reads, []);
});

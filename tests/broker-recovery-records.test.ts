import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  createBrokerRecovery,
  type RecoveryFence,
  type RecoveryJob,
} from "../packages/core/src/application/broker-recovery";
import { createBrokerRecoveryEvidence } from "../packages/node-adapters/src/execution/broker-recovery-evidence";
import {
  createBrokerRecords,
  type RemoteReceipt,
  type RpcRecord,
} from "../packages/node-adapters/src/persistence/broker-records";

const load = createRequire(
  path.join(process.cwd(), "tests/broker-recovery-records.test.js"),
);
const { matching } = load("../src/queue-broker") as Pick<
  typeof import("../src/queue-broker"),
  "matching"
>;

test("recovery reads exact durable names, not a response or a different receipt", (t) => {
  const dir = fs.mkdtempSync("/tmp/opencode/broker-recovery-records-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const instance = {
    pid: 341,
    birth: "fixture:birth",
    version: "fixture:version",
    activeCommand: "SelectCommand",
  };
  const buildHash = "fixture-source-build";
  const job: RecoveryJob = {
    id: randomUUID(),
    clientId: "owner",
    requestId: randomUUID(),
    hash: "fixture-source-input",
    request: { buildHash },
    state: "needs_reconciliation",
    dispatch: {
      rpcCount: 1,
      completedCount: 0,
      dispatchCount: 1,
      updatedAt: 1,
    },
  };
  const jobDir = path.join(dir, "jobs", job.id);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const fixtureWrite = (file: string, value: object) =>
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const originalRpc = randomUUID();
  const rpcFile = path.join(jobDir, `rpc-${originalRpc}.json`);
  const remoteFile = path.join(jobDir, `remote-${originalRpc}.json`);
  const binding = {
    jobId: job.id,
    rpcId: originalRpc,
    buildHash,
    requestHash: "exact-product-request",
    sourceHash: "exact-product-source",
  };
  const wireRequest = {
    jsonrpc: "2.0",
    id: `fmcad:${originalRpc}`,
    method: "tools/call",
  };
  const response = {
    status: 200,
    raw: JSON.stringify({ jsonrpc: "2.0", id: wireRequest.id, result: {} }),
  };
  const rpc: RpcRecord = {
    binding,
    instance,
    method: wireRequest.method,
    request: { ...wireRequest, id: "caller-id" },
    wireRequest,
    receipt: remoteFile,
    terminal: false,
  };
  const originalReceipt: RemoteReceipt = {
    ...binding,
    instance,
    terminal: true,
    outcome: "succeeded",
  };
  const probeRpc = randomUUID();
  const probeReceiptFile = path.join(
    jobDir,
    `reconcile-${probeRpc}.receipt.json`,
  );
  const probeBinding = {
    jobId: job.id,
    rpcId: probeRpc,
    requestHash: createHash("sha256")
      .update(`reconcile:${job.id}:${probeRpc}`)
      .digest("hex"),
    buildHash,
  };
  fixtureWrite(path.join(jobDir, "reconcile-probe.json"), {
    binding: probeBinding,
    instance,
    receipt: probeReceiptFile,
  });
  fixtureWrite(probeReceiptFile, {
    ...probeBinding,
    instance,
    terminal: true,
    outcome: "succeeded",
  });
  fixtureWrite(rpcFile, rpc);
  fixtureWrite(path.join(jobDir, `received-response-${originalRpc}.json`), {
    version: 1,
    kind: "owned-rpc-received-response-v1",
    binding,
    wireId: wireRequest.id,
    response,
  });
  const fence: RecoveryFence = {
    jobId: job.id,
    clientId: job.clientId,
    requestId: job.requestId,
    jobHash: job.hash,
    state: job.state,
    rpcCount: 1,
    brokerInstanceId: randomUUID(),
    instance,
    buildHash,
    executableBuildHash: buildHash,
    epochId: null,
    receiptEpoch: undefined,
    revision: 0,
    generation: 0,
    contextEpoch: 0,
    activeJobId: job.id,
    blockedJobId: job.id,
  };
  const recovery = createBrokerRecovery(
    createBrokerRecoveryEvidence(createBrokerRecords(dir).evidence, {
      readFence: () => structuredClone(fence),
      workerContext: () => "closed",
      processBirth: () =>
        assert.fail("Recovery must not inspect a closed worker"),
      workflowNonterminal: () => false,
      nativeReceipts: {
        start: () => null,
        completion: () => null,
      },
      validateTerminalResponse: (record) =>
        matching({ _parse: JSON.parse }, record.response, record.wireRequest!),
    }),
  );

  const filesBefore = fs.readdirSync(jobDir);
  const pending = recovery.reconcile(job, fence);
  assert.equal(pending.kind, "waitingForEvidence");
  assert.equal(pending.code, "RECEIPT_UNAVAILABLE");
  assert.equal(pending.observation, undefined);
  assert.deepEqual(fs.readdirSync(jobDir), filesBefore);

  fixtureWrite(rpcFile, {
    ...rpc,
    terminal: true,
    response,
    remoteReceipt: originalReceipt,
  });
  assert.equal(recovery.reconcile(job, fence).kind, "settled");
  fs.writeFileSync(remoteFile, "{malformed", { mode: 0o600 });
  const malformed = recovery.reconcile(job, fence);
  assert.equal(malformed.kind, "waitingForEvidence");
  assert.equal(malformed.code, "RECEIPT_UNAVAILABLE");
  fixtureWrite(remoteFile, {
    ...originalReceipt,
    sourceHash: "foreign-source",
  });
  const mismatched = recovery.reconcile(job, fence);
  assert.equal(mismatched.kind, "waitingForEvidence");
  assert.equal(mismatched.code, "RECEIPT_MISMATCH");
});

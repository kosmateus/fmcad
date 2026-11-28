import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
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
const { matching, serve, brokerConfigHash } = load(
  "../src/queue-broker",
) as Pick<
  typeof import("../src/queue-broker"),
  "matching" | "serve" | "brokerConfigHash"
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

test(
  "a late recovery probe cannot settle after the durable instance fence changes",
  { timeout: 15_000 },
  async (t) => {
    const { QueueState } = load(
      "../src/queue-state",
    ) as typeof import("../src/queue-state");
    const { request } = load(
      "../src/queue-connection",
    ) as typeof import("../src/entrypoints/queue-connection");
    const { buildHash, durable } = load("../src/queue-instance") as ReturnType<
      typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
    >;
    const { runBoundInstanceProbe } = load(
      "./fixtures/bound-instance-probe.cjs",
    ) as {
      runBoundInstanceProbe(
        script: string,
        identity: import("../src/queue-broker-ports").Instance,
      ): { text: string };
    };

    const dir = fs.mkdtempSync("/tmp/opencode/recovery-fence-");
    const barrier = new EventEmitter();
    const fixture: { broker?: Awaited<ReturnType<typeof serve>> } = {};
    t.after(async () => {
      barrier.emit("release");
      try {
        await fixture.broker?.close();
      } finally {
        fs.rmSync(dir, { force: true, recursive: true });
      }
    });
    const cfg = { backend: "addin", timeoutMs: 1000 };
    const instance = {
      pid: 341,
      birth: "fixture:original",
      version: "fixture:version",
      activeCommand: "SelectCommand",
      documents: [],
    };
    const build = buildHash();
    const auth = { clientId: randomUUID(), clientToken: randomUUID() };
    const state = new QueueState(dir);
    const jobId = state.submit({
      kind: "command",
      requestId: randomUUID(),
      clientId: auth.clientId,
      timeoutMs: 1000,
      argv: ["run", "never-replay.py"],
      cwd: dir,
    })["id"];
    assert.ok(typeof jobId === "string");
    const rpcId = randomUUID();
    state.next();
    state.markDispatch(jobId, { rpcId, rpcCount: 1, completedCount: 1 });
    state.block(jobId, "INSTANCE_UNAVAILABLE");
    const jobDir = path.join(dir, "jobs", jobId);
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    const binding = {
      jobId,
      rpcId,
      requestHash: "original-fixture",
      buildHash: build,
    };
    const receipt = path.join(jobDir, `remote-${rpcId}.json`);
    const journal = path.join(jobDir, `rpc-${rpcId}.json`);
    const settled = {
      ...binding,
      instance,
      terminal: true,
      outcome: "succeeded",
    };
    const replyId = `fmcad:${rpcId}`;
    durable(receipt, settled);
    durable(journal, {
      binding,
      instance,
      method: "tools/call",
      terminal: true,
      request: { jsonrpc: "2.0", method: "tools/call", id: 1 },
      wireRequest: { jsonrpc: "2.0", method: "tools/call", id: replyId },
      response: {
        status: 200,
        raw: JSON.stringify({ jsonrpc: "2.0", id: replyId, result: {} }),
      },
      receipt,
      remoteReceipt: settled,
    });
    durable(path.join(jobDir, "worker-result.json"), {
      jobId,
      code: 0,
      terminal: true,
    });
    const identityFile = path.join(dir, "instance.json");
    const originalIdentity = {
      configHash: brokerConfigHash(cfg),
      buildHash: build,
      instance,
    };
    durable(identityFile, originalIdentity);
    const originals = [journal, receipt].map((file) => fs.readFileSync(file));

    let sendAttempts = 0;
    const unexpected = () =>
      assert.fail("The original product must never be sent again");
    fixture.broker = await serve(cfg, {
      dir,
      confirmOwnership: true,
      nativePath: (file) => file,
      createBackend: () => ({
        server: cfg,
        _parse: JSON.parse,
        _post: unexpected,
        _openSession: unexpected,
        listTools: unexpected,
        executeUiGuardedScript: unexpected,
        async callTool({ object }) {
          assert.equal(
            ++sendAttempts,
            1,
            "count every send before proof or deduplication",
          );
          const script = object?.script;
          assert.ok(typeof script === "string");
          const release = once(barrier, "release");
          barrier.emit("sent");
          await release;
          return {
            failed: false,
            text: runBoundInstanceProbe(script, instance).text,
          };
        },
      }),
    });
    await request(dir, { action: "register", ...auth });
    const reconcile = () => request(dir, { action: "reconcile", auth, jobId });
    const sent = once(barrier, "sent");
    const firstAttempt = reconcile();
    const rejected = assert.rejects(firstAttempt, { code: "STATE_CONFLICT" });
    try {
      await Promise.race([
        sent,
        rejected.then(() =>
          assert.fail("Fixture fence changed before the recovery send"),
        ),
      ]);
      durable(identityFile, {
        ...originalIdentity,
        instance: { ...instance, birth: "fixture:replacement" },
      });
      barrier.emit("release");
      await rejected;
      const current = await request(dir, { action: "status", jobId, auth });
      assert.partialDeepStrictEqual(current, { state: "needs_reconciliation" });
      assert.equal(fs.existsSync(path.join(jobDir, "outcome.json")), false);
      assert.equal(
        fs.existsSync(path.join(jobDir, "reconcile-postflight.json")),
        false,
      );
      assert.deepEqual(
        [journal, receipt].map((file) => fs.readFileSync(file)),
        originals,
      );
    } finally {
      barrier.emit("release");
      durable(identityFile, originalIdentity);
    }

    const secondAttempt = await reconcile();
    assert.partialDeepStrictEqual(secondAttempt, { state: "succeeded" });
    assert.equal(
      sendAttempts,
      1,
      "the existing bound probe receipt was reused",
    );
  },
);

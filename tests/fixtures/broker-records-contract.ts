import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import type * as Records from "../../packages/node-adapters/src/persistence/broker-records.js";

const load = createRequire(
  path.join(process.cwd(), "tests", "fixtures", "broker-records-contract.ts"),
);
const { createBrokerRecords } = load(
  "../../src/dist/node-adapters/persistence/broker-records",
) as typeof Records;

const jobId = "job-1",
  rpcId = "rpc-1";
const binding = {
  jobId,
  rpcId,
  requestHash: "request-hash",
  buildHash: "build-hash",
  sourceHash: "source-hash",
};
const instance = {
  pid: 12,
  birth: "start-time",
  version: "build",
  activeCommand: "",
};
const wireRequest = { jsonrpc: "2.0", method: "tools/call", id: "fmcad:rpc-1" };
const response = {
  status: 200,
  raw: '{"jsonrpc":"2.0","id":"fmcad:rpc-1","result":{"text":"Łódź"}}',
};

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-records-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "jobs", jobId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (name: string) => path.join(dir, name);
  const bytes = (name: string) => fs.readFileSync(file(name), "utf8");
  const store = createBrokerRecords(root);
  const intent = {
    binding,
    instance,
    request: { ...wireRequest, id: 1 },
    wireRequest,
    terminal: false,
    method: wireRequest.method,
    receipt: file(`remote-${rpcId}.json`),
    dispatchIndex: 1,
  };
  return { root, dir, file, bytes, store, intent };
}

test("broker records preserve legacy request and probe bytes, and starts are create-once", (t) => {
  const f = fixture(t);
  const intent = {
    id: jobId,
    request: {
      clientId: "client-1",
      requestId: "request-1",
      kind: "command" as const,
      timeoutMs: 1000,
    },
    buildHash: binding.buildHash,
    properties: {},
    deadline: 1234,
  };
  assert.equal(f.store.createIntent(jobId, intent), f.file("request.json"));
  assert.equal(f.bytes("request.json"), JSON.stringify(intent));
  assert.throws(
    () =>
      f.store.createIntent(jobId, {
        ...intent,
        request: { ...intent.request, clientId: "another-client" },
      }),
    { code: "EEXIST" },
  );
  assert.equal(f.bytes("request.json"), JSON.stringify(intent));

  const preflight = {
    version: 2,
    jobId,
    buildHash: binding.buildHash,
    instance,
    at: 10,
    binding,
    receipt: f.file(`preflight-${rpcId}.receipt.json`),
  };
  const observed = {
    version: 2,
    jobId,
    buildHash: binding.buildHash,
    completed: true,
    instance,
    idle: true,
    requiresIdle: true,
  };
  assert.throws(
    () => f.store.recordProbeTerminal(jobId, "preflight", observed),
    {
      code: "RECEIPT_UNAVAILABLE",
    },
  );
  assert.equal(
    f.store.createProbeIntent(jobId, "preflight", preflight),
    f.file("preflight-start.json"),
  );
  assert.equal(f.bytes("preflight-start.json"), JSON.stringify(preflight));
  assert.throws(
    () => f.store.createProbeIntent(jobId, "preflight", preflight),
    { code: "EEXIST" },
  );
  assert.equal(f.store.evidence.readCompletedPreflight(jobId), null);
  f.store.recordProbeTerminal(jobId, "preflight", observed);
  assert.equal(f.bytes("preflight.json"), JSON.stringify(observed));
  assert.throws(
    () => f.store.recordProbeTerminal(jobId, "preflight", observed),
    { code: "EEXIST" },
  );
  const read = createBrokerRecords(f.root).evidence;
  assert.deepEqual(read.readProbeIntent(jobId, "preflight"), preflight);
  assert.deepEqual(read.readCompletedPreflight(jobId), observed);
  assert.equal(read.readProbeIntent(jobId, "postflight"), null);
});

test("retained transport response is not terminal proof; only the original remote receipt settles the journal", (t) => {
  const f = fixture(t);
  const { store, intent } = f;
  const journal = f.store.createRpcIntent(jobId, intent);
  assert.equal(journal, f.file(`rpc-${rpcId}.json`));
  assert.equal(fs.readFileSync(journal, "utf8"), JSON.stringify(intent));
  assert.throws(() => store.createRpcIntent(jobId, intent), { code: "EEXIST" });

  const received = {
    version: 1 as const,
    kind: "owned-rpc-received-response-v1" as const,
    binding,
    wireId: wireRequest.id,
    response,
  };
  assert.throws(
    () =>
      store.recordReceivedResponse(jobId, {
        ...received,
        wireId: "another-client's-rpc",
      }),
    {
      code: "RECEIPT_MISMATCH",
    },
  );
  store.recordReceivedResponse(jobId, received);
  assert.throws(() => store.recordReceivedResponse(jobId, received), {
    code: "EEXIST",
  });
  assert.equal(
    f.bytes(`received-response-${rpcId}.json`),
    JSON.stringify(received),
  );

  const remoteReceipt = {
    ...binding,
    terminal: true,
    outcome: "succeeded",
    instance,
  };
  const final = {
    ...intent,
    terminal: true,
    failed: false,
    nonterminal: true,
    response,
    remoteReceipt,
  };
  assert.equal(store.evidence.findRemoteReceipt(intent), null);
  assert.throws(() => store.recordRpcTerminal(jobId, final), {
    code: "RECEIPT_UNAVAILABLE",
  });
  fs.writeFileSync(
    intent.receipt,
    JSON.stringify({ ...remoteReceipt, requestHash: "other-request" }),
  );
  assert.throws(() => store.recordRpcTerminal(jobId, final), {
    code: "RECEIPT_MISMATCH",
  });
  assert.equal(fs.readFileSync(journal, "utf8"), JSON.stringify(intent));

  fs.writeFileSync(intent.receipt, JSON.stringify(remoteReceipt) + "\n");
  assert.throws(
    () =>
      store.recordRpcTerminal(jobId, {
        ...final,
        request: {
          id: intent.request.id,
          method: intent.request.method,
          jsonrpc: intent.request.jsonrpc,
        },
      }),
    { code: "RECEIPT_MISMATCH" },
  );
  assert.throws(
    () =>
      store.recordRpcTerminal(jobId, {
        ...final,
        request: { ...intent.request, id: 2 },
      }),
    {
      code: "RECEIPT_MISMATCH",
    },
  );
  store.recordRpcTerminal(jobId, final);
  assert.throws(() => store.recordRpcTerminal(jobId, final), {
    code: "RECEIPT_MISMATCH",
  });
  assert.equal(fs.readFileSync(journal, "utf8"), JSON.stringify(final));
  const completion = { ...final, nativeCompletion: { status: "done" } };
  store.recordRpcNativeCompletion(jobId, completion);
  assert.throws(
    () =>
      store.recordRpcNativeCompletion(jobId, {
        ...completion,
        nativeCompletion: { status: "changed" },
      }),
    { code: "RECEIPT_MISMATCH" },
  );

  const reopened = createBrokerRecords(f.root).evidence;
  assert.deepEqual(reopened.readReceivedResponse(jobId, rpcId), received);
  assert.deepEqual(reopened.readRpcRecords(jobId), [completion]);
  assert.deepEqual(reopened.readRemoteReceipt(intent), remoteReceipt);
  assert.equal(
    fs.readFileSync(intent.receipt, "utf8"),
    JSON.stringify(remoteReceipt) + "\n",
  );
  assert.equal(fs.readFileSync(journal, "utf8"), JSON.stringify(completion));
});

test("an ordinary terminal RPC must match the retained HTTP status and exact raw bytes", (t) => {
  const f = fixture(t);
  const { receipt: _receipt, ...intent } = f.intent;
  const journal = f.store.createRpcIntent(jobId, intent);
  const final = { ...intent, terminal: true, response };
  f.store.recordReceivedResponse(jobId, {
    version: 1,
    kind: "owned-rpc-received-response-v1",
    binding,
    wireId: wireRequest.id,
    response,
  });
  for (const other of [
    {
      ...response,
      raw: '{"jsonrpc":"2.0","id":"fmcad:rpc-1","error":{"message":"wrong evidence"}}',
    },
    { ...response, status: 202 },
    { ...response, raw: `${response.raw}\n` },
  ]) {
    assert.throws(
      () => f.store.recordRpcTerminal(jobId, { ...final, response: other }),
      { code: "RECEIPT_MISMATCH" },
    );
    assert.equal(fs.readFileSync(journal, "utf8"), JSON.stringify(intent));
  }
  f.store.recordRpcTerminal(jobId, final);
  assert.equal(fs.readFileSync(journal, "utf8"), JSON.stringify(final));
});

test("an atomic observation may store only its sanitized response and original remote receipt", (t) => {
  const f = fixture(t);
  const intent = {
    ...f.intent,
    binding: { ...binding, observationKind: "atomic_holder_status" },
    receipt: f.file(`atomic-observation-${rpcId}.receipt.json`),
  };
  const journal = f.store.createRpcIntent(jobId, intent);
  const remoteReceipt = {
    ...intent.binding,
    terminal: true,
    outcome: "succeeded",
    instance,
  };
  const final = { ...intent, terminal: true, response, remoteReceipt };
  assert.throws(() => f.store.recordRpcTerminal(jobId, final), {
    code: "RECEIPT_UNAVAILABLE",
  });
  fs.writeFileSync(intent.receipt, JSON.stringify(remoteReceipt));
  f.store.recordRpcTerminal(jobId, final);
  assert.equal(f.store.evidence.readReceivedResponse(jobId, rpcId), null);
  assert.equal(fs.readFileSync(journal, "utf8"), JSON.stringify(final));
});

test("the evidence reader rejects swapped journals and receipts without rewriting them", (t) => {
  const f = fixture(t);
  const swapped = f.file("rpc-wrong-id.json");
  fs.writeFileSync(swapped, JSON.stringify(f.intent));
  fs.writeFileSync(f.file("rpc-result.json"), "not an RPC journal");
  assert.throws(() => f.store.evidence.readRpcRecords(jobId), {
    code: "RECEIPT_MISMATCH",
  });
  const other = f.file("remote-foreign.json");
  const bytes = JSON.stringify({
    ...binding,
    instance,
    terminal: true,
    outcome: "succeeded",
  });
  fs.writeFileSync(other, bytes);
  assert.throws(
    () => f.store.evidence.readRemoteReceipt({ ...f.intent, receipt: other }),
    {
      code: "RECEIPT_MISMATCH",
    },
  );
  fs.symlinkSync(other, f.intent.receipt);
  assert.throws(() => f.store.evidence.readRemoteReceipt(f.intent), {
    code: "RECEIPT_UNAVAILABLE",
  });
  assert.throws(() => f.store.evidence.findRemoteReceipt(f.intent), {
    code: "RECEIPT_UNAVAILABLE",
  });
  fs.writeFileSync(f.file("worker-result.json"), "{");
  assert.throws(() => f.store.evidence.readWorkerResult(jobId), SyntaxError);
  assert.equal(fs.readFileSync(other, "utf8"), bytes);
  assert.equal(fs.readFileSync(swapped, "utf8"), JSON.stringify(f.intent));
});

test("a failed intent directory sync is never a send permit and visible evidence is not overwritten", (t) => {
  const f = fixture(t);
  const io = {
    ...fs,
    fsyncSync(fd: number) {
      if (fs.fstatSync(fd).isDirectory())
        throw Object.assign(new Error("injected directory fsync failure"), {
          code: "EIO",
        });
      fs.fsyncSync(fd);
    },
  };
  const faulted = createBrokerRecords(f.root, io);
  assert.throws(() => faulted.createRpcIntent(jobId, f.intent), {
    code: "EIO",
  });
  const reopened = createBrokerRecords(f.root);
  assert.deepEqual(reopened.evidence.readRpcRecords(jobId), [f.intent]);
  assert.throws(() => reopened.createRpcIntent(jobId, f.intent), {
    code: "EEXIST",
  });
  assert.equal(f.bytes(`rpc-${rpcId}.json`), JSON.stringify(f.intent));
});

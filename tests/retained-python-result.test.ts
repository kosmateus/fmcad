import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  decodeBoundPublicPythonResponse,
  responseForCaller,
} from "../src/composition/queue-public-python-result";
import type { RecordEvidence, RemoteReceipt } from "../src/queue-broker-ports";

function fixture() {
  const code = "print('zażółć')";
  const request = {
    jsonrpc: "2.0",
    id: "caller",
    method: "tools/call",
    params: { name: "execute_python", arguments: { code, persistent: false } },
  };
  const binding = {
    jobId: "original-job",
    rpcId: "original-rpc",
    requestHash: "a".repeat(64),
    buildHash: "b".repeat(64),
    sourceHash: createHash("sha256").update(code).digest("hex"),
    publicPythonResultSchema: "fmcad-public-python-result-v1",
  };
  const instance = {
    pid: 123,
    birth: "original-birth",
    version: "original-version",
  };
  const record: RecordEvidence = {
    binding,
    instance,
    method: "tools/call",
    terminal: false,
  };
  const value = { success: true, stdout: "zażółć\n", stderr: "" };
  const receipt: RemoteReceipt = {
    ...binding,
    terminal: true,
    outcome: "succeeded",
    instance: { ...instance },
    publicPythonResult: { schema: binding.publicPythonResultSchema, value },
  };
  const reply = {
    jsonrpc: "2.0",
    id: "original-wire",
    result: {
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            message: JSON.stringify(value),
          }),
        },
      ],
    },
  };
  const response = { status: 200, raw: JSON.stringify(reply) };
  return { record, receipt, request, response, reply, value };
}

test("retained native result validates its entire bound evidence and adapts only the caller copy", () => {
  const f = fixture();
  const before = structuredClone(f);
  const response = decodeBoundPublicPythonResponse(
    f.record,
    f.receipt,
    f.request,
    f.response,
    f.reply,
  );
  assert.deepEqual(JSON.parse(response.raw), {
    jsonrpc: "2.0",
    id: "caller",
    result: {
      isError: false,
      content: [{ type: "text", text: JSON.stringify(f.value) }],
    },
  });
  assert.deepEqual(f, before);
});

const changes: Array<
  [string, (f: ReturnType<typeof fixture>) => void, string]
> = [
  [
    "missing bound result",
    (f) => {
      delete f.receipt["publicPythonResult"];
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "partial bound result",
    (f) => {
      f.receipt["publicPythonResult"] = {
        schema: "fmcad-public-python-result-v1",
        value: { success: true, stdout: "x" },
      };
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "wrong schema",
    (f) => {
      f.receipt["publicPythonResult"] = { schema: "other", value: f.value };
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "wrong source",
    (f) => {
      f.request.params.arguments.code = "print('other')";
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "wrong PID",
    (f) => {
      f.receipt.instance.pid++;
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "wrong birth",
    (f) => {
      f.receipt.instance.birth = "foreign";
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "wrong version",
    (f) => {
      f.receipt.instance.version = "foreign";
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "wrong input binding",
    (f) => {
      f.receipt.requestHash = "c".repeat(64);
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "nonterminal",
    (f) => {
      f.receipt.terminal = false;
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "failed",
    (f) => {
      f.receipt.outcome = "failed";
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "unexpected receipt data",
    (f) => {
      f.receipt["unexpected"] = true;
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "wire conflict",
    (f) => {
      f.reply.result.content[0]!.text = JSON.stringify({
        success: true,
        message: JSON.stringify({ ...f.value, stdout: "forged" }),
      });
    },
    "RECEIPT_MISMATCH",
  ],
  [
    "malformed wire",
    (f) => {
      f.reply.result.content[0]!.text = "{";
    },
    "UNKNOWN_RPC",
  ],
  [
    "error response",
    (f) => {
      f.reply.result.isError = true;
    },
    "RECEIPT_MISMATCH",
  ],
];
for (const [name, change, code] of changes) {
  test(`retained native result refuses ${name} without altering original evidence`, () => {
    const f = fixture();
    change(f);
    const before = structuredClone(f);
    assert.throws(
      () =>
        decodeBoundPublicPythonResponse(
          f.record,
          f.receipt,
          f.request,
          f.response,
          f.reply,
        ),
      { code },
    );
    assert.deepEqual(f, before);
  });
}

test("ordinary non-native replies retain their result and original wire remains untouched", () => {
  const request = {
    jsonrpc: "2.0",
    id: "caller",
    method: "tools/call",
    params: { name: "execute_python" },
  };
  const reply = {
    jsonrpc: "2.0",
    id: "wire",
    result: { content: [{ type: "text", text: "ordinary" }] },
  };
  const response = { status: 200, raw: JSON.stringify(reply) };
  const before = structuredClone({ response, reply });
  assert.deepEqual(
    JSON.parse(responseForCaller(response, request, reply).raw),
    { ...reply, id: "caller" },
  );
  assert.deepEqual({ response, reply }, before);
});

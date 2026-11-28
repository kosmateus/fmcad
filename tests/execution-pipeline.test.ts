import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type {
  DispatchPorts,
  WorkerBackend,
  WorkerResult,
  WorkerRequest,
} from "../packages/core/src";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
const sourceDirectory = nodePath.join(process.cwd(), "tests");
const load = createRequire(
  nodePath.join(sourceDirectory, "execution-pipeline.test.js"),
);
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

test("the offline broker retains dispatch errors without replay or foreign access", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-force-exit",
      "--test-reporter=tap",
      nodePath.join(process.cwd(), "tests/fixtures/dispatch-failure.cjs"),
    ],
    { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /# tests 6\b/);
  assert.match(child.stdout, /# pass 6\b/);
  assert.match(child.stdout, /# fail 0\b/);
  assert.match(child.stdout, /# skipped 0\b/);
});

test("worker snapshot fences attest only durable authenticated state", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      nodePath.join(process.cwd(), "tests/fixtures/worker-snapshot-fence.cjs"),
    ],
    { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /# tests 1\b/);
  assert.match(child.stdout, /# pass 1\b/);
  assert.match(child.stdout, /# skipped 0\b/);
});

const {
  dispatchPrepared,
  completeSdkTurn,
  executionFailed,
  reconciledExecution,
  executeWorker,
} = load("../packages/core/dist") as typeof import("../packages/core/src");
const { runWorker } = load(
  "../packages/node-adapters/dist/execution/worker",
) as typeof import("../packages/node-adapters/src/execution/worker");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("read and mutation use prepared/check/admission/send/settle ports without CLI or retry", async () => {
  for (const operation of ["document.status", "model.create_box"]) {
    const trace: string[] = [];
    const result = await dispatchPrepared({
      prepare() {
        trace.push("prepare");
        return { operation, bytes: "checked bytes" };
      },
      check(prepared) {
        assert.equal(prepared.bytes, "checked bytes");
        trace.push("check");
      },
      admit(send) {
        trace.push("grant");
        return send();
      },
      fence() {
        trace.push("fence");
        queueMicrotask(() => trace.push("microtask"));
      },
      async send(prepared) {
        trace.push("send");
        return prepared.operation;
      },
      settle(_, reply) {
        trace.push("settle");
        return reply;
      },
      unknown() {
        assert.fail("known execution");
      },
    });
    assert.equal(result, operation);
    assert.deepEqual(trace, [
      "prepare",
      "check",
      "grant",
      "fence",
      "send",
      "microtask",
      "settle",
    ]);
  }
});

test("checker refusal is before admission and an actual-send fence rejects paused/reset stale work", async () => {
  let admitted = 0,
    submitted = 0,
    unknown = 0;
  const refusals: string[] = [];
  const paused = deferred();
  let generation = 0;
  const ports: DispatchPorts<{ generation: number }, boolean, boolean> = {
    prepare: () => ({ generation }),
    check() {},
    async admit(send) {
      admitted++;
      await paused.promise;
      return send();
    },
    fence(prepared) {
      if (prepared.generation !== generation)
        throw new Error("DOCUMENT_CHANGED");
    },
    async send() {
      submitted++;
      return true;
    },
    settle: (_, reply) => reply,
    unknown() {
      unknown++;
    },
    notSubmitted(error) {
      assert.ok(error instanceof Error);
      refusals.push(error.message);
    },
  };
  await assert.rejects(
    dispatchPrepared({
      ...ports,
      check() {
        throw new Error("CHECK_FAILED");
      },
    }),
    /CHECK_FAILED/,
  );
  assert.equal(admitted, 0);
  const pending = dispatchPrepared(ports);
  await Promise.resolve();
  await Promise.resolve();
  generation++;
  paused.resolve();
  await assert.rejects(pending, /DOCUMENT_CHANGED/);
  assert.equal(submitted, 0);
  assert.equal(unknown, 0);
  assert.deepEqual(refusals, ["CHECK_FAILED", "DOCUMENT_CHANGED"]);
});

test("lost reply or settle evidence is unknown and never retries the physical send", async () => {
  for (const failAt of ["send", "settle"]) {
    let submitted = 0,
      unknown = 0;
    await assert.rejects(
      dispatchPrepared({
        prepare: () => 1,
        check() {},
        admit: (send) => send(),
        fence() {},
        async send() {
          submitted++;
          if (failAt === "send") throw new Error("ACK_LOST");
          return 1;
        },
        settle() {
          throw new Error("RECEIPT_MISSING");
        },
        unknown() {
          unknown++;
        },
      }),
    );
    assert.equal(submitted, 1);
    assert.equal(unknown, 1);
  }
});

test("native settle and postflight precede release; slow local finalize does not retain SDK ownership", async () => {
  const native = deferred(),
    postflight = deferred(),
    finalize = deferred();
  const trace: string[] = [];
  const pending = completeSdkTurn({
    async settle() {
      await native.promise;
      trace.push("native-ended");
      return { mayHaveMutated: true };
    },
    async postflight() {
      trace.push("postflight-start");
      await postflight.promise;
      trace.push("postflight-end");
    },
    release() {
      trace.push("release");
    },
    async finalize(result) {
      trace.push("finalize");
      await finalize.promise;
      return result;
    },
  });
  await Promise.resolve();
  assert.deepEqual(trace, []);
  native.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(trace, ["native-ended", "postflight-start"]);
  postflight.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(trace, [
    "native-ended",
    "postflight-start",
    "postflight-end",
    "release",
    "finalize",
  ]);
  finalize.resolve();
  assert.deepEqual(await pending, { mayHaveMutated: true });
});

test("positive synchronous transport cannot overwrite failed native execution", () => {
  assert.equal(
    executionFailed({ receiptOutcome: "succeeded", nativeOutcome: "failed" }),
    true,
  );
  assert.equal(
    reconciledExecution({
      outputAvailable: true,
      adapterUnknown: false,
      receipts: [{ outcome: "succeeded" }],
      records: [{ failed: false }],
      nativeEnds: [{ outcome: "failed" }],
    }),
    "failed",
  );
});

test("typed worker service can issue multiple turns and persists nonterminal outcomes before terminal publication", async () => {
  const records: WorkerResult[] = [],
    calls: unknown[] = [];
  const backend: WorkerBackend = {
    async listTools() {
      assert.fail("No listing");
    },
    async executeUiGuardedScript() {
      assert.fail("No UI dispatch");
    },
    async callTool(value: unknown) {
      calls.push(value);
      return value;
    },
  };
  const envelope = {
    id: "job",
    deadline: 1,
    buildHash: "build",
    request: { cwd: "/project", argv: [] },
  };
  assert.equal(
    await executeWorker(envelope, {
      verify() {},
      backend,
      async execute(request, port, onOutcome) {
        assert.equal(request, envelope.request);
        onOutcome({ pending: true });
        await port.callTool({ readOnly: true });
        await port.callTool({ mutation: true });
        onOutcome({ pending: false });
        return 0;
      },
      nonterminal: (value) =>
        !!(value as { pending?: unknown } | null | undefined)?.pending,
      persist: (value) => records.push(value),
    }),
    0,
  );
  assert.deepEqual(calls, [{ readOnly: true }, { mutation: true }]);
  assert.deepEqual(
    records.map((value) => [value.terminal, value.nonterminal]),
    [
      [false, true],
      [false, false],
      [true, false],
    ],
  );
});

test("node worker rejects an invalid build/capability before calling its typed service", async () => {
  let executed = false;
  const envelope = {
    id: "job",
    deadline: 1,
    buildHash: "original",
    request: { cwd: "/project", argv: [] },
  };
  await assert.rejects(
    runWorker(envelope, {
      jobId: "job",
      token: "token",
      buildHash: () => "changed",
      configuration: { timeoutMs: 100 },
      request() {
        assert.fail("must not send");
      },
      async execute() {
        executed = true;
        return 0;
      },
      persist() {
        assert.fail("must not publish");
      },
      nonterminal: () => false,
    }),
    { code: "BUILD_CHANGED" },
  );
  assert.equal(executed, false);
});

test("broker CAD input planning retains file pins while projecting canonical worker metadata", (t) => {
  const fs = load("node:fs") as typeof import("node:fs"),
    path = load("node:path") as typeof import("node:path");
  const { createHash } = load("node:crypto") as typeof import("node:crypto");
  const dir = fs.mkdtempSync(
    path.join(
      (load("node:os") as typeof import("node:os")).tmpdir(),
      "execution-input-",
    ),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "input.json");
  fs.writeFileSync(file, "{}");
  const original: WorkerRequest = {
    argv: ["cad", "entity", "list", "--doc", "Model", "--file", "input.json"],
    cwd: dir,
    inputFiles: [
      { path: file, sha256: createHash("sha256").update("{}").digest("hex") },
    ],
  };
  const { prepareRequest } = load(
    "../src/composition/execution-request",
  ) as typeof import("../src/composition/execution-request");
  const prepared = prepareRequest({ request: original });
  assert.equal(required(prepared.payload)["kind"], "cad-command");
  assert.equal(prepared.argv.includes("--file"), false);
  assert.deepEqual(prepared.inputFiles, original.inputFiles);
  assert.equal(original.payload, undefined);
  assert.equal(original.argv.includes("--file"), true);
  fs.writeFileSync(file, '{"different":true}');
  assert.throws(() => prepareRequest({ request: original }), {
    code: "INPUT_CHANGED",
  });
});

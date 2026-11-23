import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { QueueRequest } from "@fmcad/core";
import type { ParamCheckpointGuardV1 } from "../packages/node-adapters/src/python/cad-script.js";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "dist/src/queue-broker.js"));
const { createBrokerSourceCompiler } = load(
  "./broker-source-compiler",
) as typeof import("../src/broker-source-compiler");
const { compileDocumentContinuationPrograms } = load(
  "./document-continuation-broker",
) as typeof import("../src/document-continuation-broker");
const { prepareCadScript } = load(
  "./dist/composition/cad",
) as typeof import("../src/composition/cad");
const { cadWorkerPolicyArguments, decodeCadWorkerInvocation } = load(
  "./dist/core/application/cad/worker-command",
) as typeof import("../packages/core/src/application/cad/worker-command");

const checkpoint: ParamCheckpointGuardV1 = {
  schema: "fmcad.param-checkpoint-v1",
  document: {
    identity: {
      creationId: "creation-A",
      name: "Owned A",
      fileId: "file-A",
      version: 2,
      isSaved: true,
      isModified: false,
    },
    fingerprint: "a".repeat(64),
  },
  parameters: [],
};
function data() {
  return {
    parameters: [{ name: "length", expression: "12 mm", unit: "mm" }],
  };
}
function context() {
  return {
    doc: "Owned A",
    docId: "creation-A",
    docFileId: "file-A",
    preview: false,
  };
}
function request(): QueueRequest {
  const payload = {
    kind: "cad",
    version: 1,
    operation: "param.apply",
    doc: "Owned A",
    docId: "creation-A",
    docFileId: "file-A",
    data: data(),
  };
  return {
    requestId: "new-write-A",
    clientId: "owner-A",
    ownerToken: "b".repeat(64),
    kind: "command",
    cwd: root,
    timeoutMs: 15000,
    phased: true,
    buildHash: "c".repeat(64),
    payload,
    argv: cadWorkerPolicyArguments(decodeCadWorkerInvocation(payload)),
  };
}

test("CAD compiler preserves the complete prepared artifact", async (t) => {
  const compiler = createBrokerSourceCompiler({ concurrency: 1 });
  t.after(() => compiler.close());

  const expected = prepareCadScript(
    "param.apply",
    data(),
    context(),
    undefined,
    checkpoint,
  );
  const actual = await compiler.cad(
    "param.apply",
    data(),
    context(),
    checkpoint,
  );

  assert.deepEqual(actual, expected);
  assert.equal(actual.script, expected.script);
  assert.equal(actual.sha256, expected.sha256);
  assert.equal(actual.artifactHash, expected.artifactHash);
  assert.deepEqual(actual.units, expected.units);
  assert.deepEqual(actual.sourceMap, expected.sourceMap);
  assert.deepEqual(actual, JSON.parse(JSON.stringify(actual)));
});

test("continuation compiler preserves both programs and their bindings", async (t) => {
  const compiler = createBrokerSourceCompiler({ concurrency: 1 });
  t.after(() => compiler.close());
  const input = request();
  const guard = structuredClone(checkpoint);

  const actual = await compiler.continuation(input, guard);
  const expected = compileDocumentContinuationPrograms(input, guard);

  assert.deepEqual(actual, expected);
  assert.equal(actual.ordinary.script, expected.ordinary.script);
  assert.equal(actual.guarded.script, expected.guarded.script);
  assert.equal(actual.ordinary.sourceHash, expected.ordinary.sourceHash);
  assert.equal(actual.guarded.sourceHash, expected.guarded.sourceHash);
  assert.deepEqual(actual.ordinary.manifest, expected.ordinary.manifest);
  assert.deepEqual(actual.guarded.manifest, expected.guarded.manifest);
});

test("main-loop timer runs before a real continuation compilation completes", async (t) => {
  const compiler = createBrokerSourceCompiler({ concurrency: 1 });
  t.after(() => compiler.close());
  let timerFired = false;
  const timer = new Promise<"timer">((resolve) =>
    setTimeout(() => {
      timerFired = true;
      resolve("timer");
    }, 0),
  );
  const compilation = compiler.continuation(request(), checkpoint);
  const first = await Promise.race([
    compilation.then(() => "compiled" as const),
    timer,
  ]);

  assert.equal(first, "timer");
  assert.equal(timerFired, true);
  assert.deepEqual(
    await compilation,
    compileDocumentContinuationPrograms(request(), checkpoint),
  );
});

test("compiler failures cross the worker boundary without worker stacks", async (t) => {
  const compiler = createBrokerSourceCompiler({ concurrency: 1 });
  t.after(() => compiler.close());

  await assert.rejects(
    compiler.cad("not-a-real-operation", {}, context()),
    (error: unknown) =>
      error instanceof Error &&
      error.message.length > 0 &&
      !error.stack?.includes("broker-source-compiler-worker"),
  );
});

test("concurrency is bounded and close drains active work only", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Linux /proc exposes the active worker-thread count");
    return;
  }
  const compiler = createBrokerSourceCompiler({ concurrency: 2 });
  t.after(() => compiler.close());
  const taskDirectory = `/proc/${process.pid}/task`;
  const baseline = fs.readdirSync(taskDirectory).length;
  const tasks = Array.from({ length: 3 }, () =>
    compiler.cad("param.apply", data(), context(), checkpoint),
  );
  const settled = Promise.allSettled(tasks);
  let peak = 0;
  for (let attempt = 0; attempt < 1000 && peak < 2; attempt++) {
    peak = Math.max(peak, fs.readdirSync(taskDirectory).length - baseline);
    if (peak < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(peak, 2);
  const closing = compiler.close();
  assert.equal(compiler.close(), closing);
  let closeResolved = false;
  void closing.then(() => {
    closeResolved = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeResolved, false);
  const results = await settled;
  await closing;
  assert.equal(closeResolved, true);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    2,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  for (const result of results) {
    if (result.status === "rejected")
      assert.equal(result.reason.code, "SOURCE_COMPILER_CLOSED");
  }
  assert.throws(() => createBrokerSourceCompiler({ concurrency: 0 }), {
    code: "INVALID_SOURCE_COMPILER_CONCURRENCY",
  });
  await assert.rejects(compiler.cad("param.apply", data(), context()), {
    code: "SOURCE_COMPILER_CLOSED",
  });
});

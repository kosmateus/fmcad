"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const {
  prepareCamera,
  runCamera,
} = require("../scripts/integration/swarm-camera.cjs");
const pin = require("./fixtures/swarm-camera-document.json");
const digest = (s) => createHash("sha256").update(s).digest("hex");
const runPython = (source) =>
  execFileSync(
    "python3",
    ["-I", "-S", "-B", join(__dirname, "fixtures/swarm-camera-python.py")],
    { input: source, encoding: "utf8" },
  );

test("fresh pinned raw requests use source definitions, without a legacy broker envelope", () => {
  const saved = { ...pin, fileId: "file-from-test", version: 1 };
  const a = prepareCamera(saved),
    b = prepareCamera(saved);
  assert.notEqual(a.requestId, b.requestId);
  assert.deepEqual(a.document, saved);
  assert.equal(a.code, b.code);
  assert.deepEqual(Object.keys(a).sort(), ["code", "document", "requestId"]);
  assert.doesNotMatch(
    a.code,
    /_qr_native|swarmSourceHash|_camera_matching_names|<fmcad-queue>/,
  );
  assert.throws(() => prepareCamera({ ...pin, version: 1 }), /pin/);
});

test("camera reads and token alias continuations execute through the public host", async () => {
  const ids = new Set();
  const dispatch = async (request) => {
    assert.ok(!ids.has(request.requestId));
    ids.add(request.requestId);
    return {
      requestId: request.requestId,
      sourceHash: digest(request.code),
      state: "succeeded",
      result: { stdout: runPython(request.code) },
    };
  };
  const plain = await runCamera(pin, undefined, dispatch);
  assert.equal(ids.size, 1);
  assert.deepEqual(plain.result.state.extents, [20, 10]);
  assert.equal(plain.result.state.document.creationId, pin.creationId);
  assert.deepEqual(await runCamera(pin, "alias", dispatch), plain);
  assert.equal(ids.size, 3);
});

test("unknown outcomes and mismatched source identities do not start another stage", async () => {
  for (const change of [
    { state: "needs_reconciliation" },
    { sourceHash: "wrong" },
    { requestId: "foreign" },
  ]) {
    let calls = 0;
    await assert.rejects(
      runCamera(pin, "alias", async (request) => {
        calls++;
        return {
          requestId: request.requestId,
          sourceHash: digest(request.code),
          state: "succeeded",
          result: { stdout: "" },
          ...change,
        };
      }),
      /do not resubmit/,
    );
    assert.equal(calls, 1);
  }
});

// Optional cross-repository integration: require the real built swarm checkout.
if (process.env.SWARM_OFFLINE_ROOT)
  test("swarm contract, strict admission and pinned wrapper accept every emitted camera stage", async () => {
    const root = process.env.SWARM_OFFLINE_ROOT;
    const { decodeExecuteRequest } = require(join(root, "dist/contracts"));
    const { preparePinnedPython } = require(join(root, "dist/runtime/python"));
    const admission = require(join(root, "dist/python")).createPythonAdmission({
      typingRoot: join(root, "runtime/python/typing"),
      pythonPlatform: "Windows",
    });
    const dispatch = async (input) => {
      const request = decodeExecuteRequest(input);
      const wrap = preparePinnedPython(request.code, request.document);
      const cert = await admission.check(admission.prepare(wrap.code));
      cert.fence(wrap.code);
      const stdout = runPython(wrap.code);
      return {
        requestId: request.requestId,
        sourceHash: wrap.sourceHash,
        state: "succeeded",
        result: { stdout },
      };
    };
    const p = { ...pin, fileId: "file-from-test", version: 1 };
    const plain = await runCamera(p, undefined, dispatch);
    assert.deepEqual(plain.result.state.extents, [20, 10]);
    assert.deepEqual(await runCamera(p, "alias", dispatch), plain);
  });

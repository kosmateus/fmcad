"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const stages = require("../src/composition/stage-dependencies");
const cad = require("../src/cad-service");
const worker = require("../src/dist/composition/execution-worker");

test("ordinary worker commands do not read a concurrently changing stage-owner snapshot", async (t) => {
  const blocked = new Error("Queue state has an unresolved durability marker");
  const stageRead = t.mock.method(
    stages,
    "createAuthenticatedStageDependencies",
    async () => {
      throw blocked;
    },
  );
  const execute = t.mock.method(
    cad,
    "execute",
    async (_request, _backend, _outcome, _io, internal) => {
      assert.equal(internal.stageDependencies, null);
      return 0;
    },
  );
  const verified = {
    jobId: "owned",
    brokerDirectory: "/unused",
    buildHash: "build",
  };
  const ordinary = [
    {
      kind: "run",
      request: { name: "owned.py", identity: { docId: "owned-document" } },
    },
    { kind: "cad", operation: "document.status" },
    { kind: "cad-command", invocation: { operation: "shape.box" } },
  ];
  for (const payload of ordinary) {
    assert.equal(
      await worker.execute(
        { cwd: "/unused", argv: [], payload },
        {},
        () => {},
        verified,
      ),
      0,
    );
  }
  assert.equal(stageRead.mock.callCount(), 0);
  assert.equal(execute.mock.callCount(), ordinary.length);

  // Stage consumers still fail before execution; a pending snapshot is never ignored.
  for (const payload of [
    { kind: "run", request: { helperVersion: "cad-v1" } },
    ...["document.save.once", "batch.run", "definition.instantiate"].flatMap(
      (operation) => [
        { kind: "cad", operation },
        { kind: "cad-command", invocation: { operation } },
      ],
    ),
  ]) {
    await assert.rejects(
      worker.execute(
        { cwd: "/unused", argv: [], payload },
        {},
        () => {},
        verified,
      ),
      blocked,
    );
  }
  assert.equal(stageRead.mock.callCount(), 7);
  assert.equal(execute.mock.callCount(), ordinary.length);
});

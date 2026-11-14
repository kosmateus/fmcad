import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { WorkerBackend } from "../packages/core/src";
import nodePath from "node:path";
const sourceDirectory = nodePath.join(process.cwd(), "tests");
const load = createRequire(
  nodePath.join(sourceDirectory, "execution-worker-stages.test.js"),
);
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

const stages = load(
  "../src/composition/stage-dependencies",
) as typeof import("../src/composition/stage-dependencies");
const cad = load(
  "../src/cad-service",
) as typeof import("../src/composition/cad-service");
const worker = load(
  "../src/dist/composition/execution-worker",
) as typeof import("../src/composition/execution-worker");

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
    async (...[, , , , internal]: Parameters<typeof cad.execute>) => {
      assert.equal(required(internal).stageDependencies, null);
      return 0;
    },
  );
  const backend: WorkerBackend = {
    async callTool() {
      assert.fail("No actual SDK call");
    },
    async listTools() {
      assert.fail("No tool listing");
    },
    async executeUiGuardedScript() {
      assert.fail("No UI dispatch");
    },
  };
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
        backend,
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
        backend,
        () => {},
        verified,
      ),
      blocked,
    );
  }
  assert.equal(stageRead.mock.callCount(), 7);
  assert.equal(execute.mock.callCount(), ordinary.length);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import vm from "node:vm";
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

test("helper stage validation loads the staged service from the host runtime layout", async () => {
  const root = process.cwd();
  const filename = nodePath.join(root, "src/composition/stage-dependencies.js");
  const source = fs.readFileSync(
    nodePath.join(root, "src/dist/composition/stage-dependencies.js"),
    "utf8",
  );
  const load = createRequire(filename);
  const module = {
    exports: {} as {
      createAuthenticatedStageDependencies(input: unknown): Promise<unknown>;
    },
  };
  const evaluate = vm.runInThisContext(
    "(function(require,module,exports,__filename,__dirname){\n" +
      source +
      "\nreadCommittedQueueSnapshot = async () => ({jobs:{owned:{id:'owned',request:{payload:{kind:'run',request:{helperVersion:'cad-v1'}}}}}});\n})",
    { filename },
  );
  evaluate(load, module, module.exports, filename, nodePath.dirname(filename));
  await assert.rejects(
    module.exports.createAuthenticatedStageDependencies({
      brokerDirectory: root,
      jobId: "owned",
    }),
    (error: Error & { code?: string }) => {
      assert.notEqual(error.code, "MODULE_NOT_FOUND");
      assert.match(error.message, /run|invocation|version|script|request/i);
      return true;
    },
  );
});

test("ordinary worker commands do not read a concurrently changing stage-owner snapshot", async (t) => {
  const blocked = new Error(
    "Broker refused the queue snapshot durability fence",
  );
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

  // Stage consumers fail before execution when the broker refuses its snapshot fence.
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

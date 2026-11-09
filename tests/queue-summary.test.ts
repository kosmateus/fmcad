import { createRequire } from "node:module";
const load = createRequire(
  path.join(process.cwd(), "tests", "queue-summary.test.js"),
);

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Explicit fake physical backends require only synthetic WSL path spelling.
test.beforeEach((t) =>
  (t as test.TestContext).after(
    (load("./fixtures/fake-wsl-platform.cjs") as () => () => void)(),
  ),
);
const { QueueState } = load(
  "../src/queue-state",
) as typeof import("../src/queue-state");
const { serve } = load(
  "../src/queue-broker",
) as typeof import("../src/queue-broker");
const { request: wireRequest } = load(
  "../src/queue-connection",
) as typeof import("../src/entrypoints/queue-connection");
const request = <T = unknown>(dir: string, message: Record<string, unknown>) =>
  wireRequest(dir, message) as Promise<T>;

const config = {
  backend: "addin",
  url: "http://127.0.0.1:8765/mcp",
  headers: {},
  timeoutMs: 1000,
  tool: "execute_python",
  transport: "node",
  protocolVersion: "2025-06-18",
  routing: "queue",
  queue: { autoStart: true },
  controlCenter: { port: 4748 },
};

test("queue summary and owned request lookup do not serialize retained job history", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-queue-summary-"));
  let broker: Awaited<ReturnType<typeof serve>> | undefined = undefined;

  const seed = new QueueState(dir);
  let targetId: string | undefined;
  for (let i = 0; i < 32; i++) {
    const owner = i === 31 ? "owner-a" : "history-owner";
    const requestId = i === 31 ? "target-request" : `history-${i}`;
    const job = seed.submit({
      kind: "command",
      requestId,
      clientId: owner,
      timeoutMs: 1000,
      argv: ["doc", "list"],
      cwd: dir,
    });
    assert.equal(typeof job["id"], "string");
    const id = job["id"] as string;
    if (i === 31) targetId = id;
    seed.next();
    seed.markDispatch(id, { rpcCount: 1, completedCount: 1 });
    seed.finish(id, {
      state: "succeeded",
      code: i === 31 ? "EXECUTION_COMPLETE" : "OPERATOR_RECEIPT_RECONCILED",
      executionOutcome: i === 31 ? "succeeded" : "completed",
      userScriptSubmitted: true,
      mayHaveMutated: true,
    });
  }

  const originalStatus = QueueState.prototype.status;
  QueueState.prototype.status = function (jobId) {
    assert.notEqual(
      jobId,
      undefined,
      "summary and lookup may only project individual jobs",
    );
    return originalStatus.call(this, jobId);
  };

  const physical = {
    server: { timeoutMs: 1000 },
    _post() {
      throw new Error("No physical command expected");
    },
    _parse: JSON.parse,
    async callTool() {
      return {
        failed: false,
        text:
          "FMCAD_QUEUE_INSTANCE " +
          JSON.stringify({
            pid: 99,
            birth: "test:99",
            version: "test-version",
            activeCommand: "SelectCommand",
            documents: [],
          }),
      };
    },
  };
  t.after(async () => {
    try {
      await broker?.close();
    } finally {
      QueueState.prototype.status = originalStatus;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  broker = await serve(config, {
    dir,
    confirmOwnership: true,
    createBackend: () =>
      physical as unknown as import("../src/queue-broker-ports").Client,
  });

  const auth = { clientId: "owner-a", clientToken: "owner-a-token" };
  await request(dir, { action: "register", ...auth });
  await request(dir, {
    action: "register",
    clientId: "owner-b",
    clientToken: "owner-b-token",
  });

  const summary = await request<{
    jobCount: number;
    nonterminalJobCount: number;
    stateCounts: { succeeded: number };
    control: { phase: string };
  }>(dir, { action: "queue-summary", auth });
  assert.equal(summary.jobCount, 32);
  assert.equal(summary.nonterminalJobCount, 0);
  assert.equal(summary.stateCounts.succeeded, 32);
  assert.equal(summary.control.phase, "RUNNING");
  assert.equal(Object.hasOwn(summary, "jobs"), false);

  const found = await request<{
    job: { id: string; clientId: string } | null;
    buildHash: string;
  }>(dir, { action: "find-request", requestId: "target-request", auth });
  assert.ok(found.job);
  assert.equal(found.job.id, targetId);
  assert.equal(found.job.clientId, "owner-a");
  assert.equal(found.buildHash, broker.buildHash);
  assert.equal(
    (
      await request<{
        job: { id: string; clientId: string } | null;
        buildHash: string;
      }>(dir, {
        action: "find-request",
        requestId: "target-request",
        auth: { clientId: "owner-b", clientToken: "owner-b-token" },
      })
    ).job,
    null,
  );
  assert.equal(
    (
      await request<{
        job: { id: string; clientId: string } | null;
        buildHash: string;
      }>(dir, { action: "find-request", requestId: "missing", auth })
    ).job,
    null,
  );
});

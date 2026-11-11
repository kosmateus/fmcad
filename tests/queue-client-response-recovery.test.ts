import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

interface RecoveryClient {
  readonly auth: { readonly clientId: string };
  call(action: string, values: Record<string, unknown>): Promise<unknown>;
}
interface RecoveryModule {
  readResult(
    client: RecoveryClient,
    action: string,
    values: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  submitWithRecovery(
    client: RecoveryClient,
    request: Record<string, unknown>,
    refresh?: () => Promise<unknown>,
  ): Promise<unknown>;
}
const runtime = path.resolve(
  process.env["FMCAD_TEST_RUNTIME"] || path.join(__dirname, "../.."),
);
const runtimeRequire = createRequire(path.join(runtime, "src/queue-client.js"));
const recovery = runtimeRequire(
  "./dist/node-adapters/broker-ipc/response-recovery",
) as RecoveryModule;
const { requestIdentity } = runtimeRequire(
  "./dist/core/domain/queue-request-identity",
) as {
  requestIdentity(value: Record<string, unknown>): Record<string, unknown>;
};
const { epochStartupPinned } = runtimeRequire(
  "./dist/node-adapters/broker-ipc/normal-admission",
) as {
  epochStartupPinned(
    state: {
      epoch: unknown;
      admissionMode: string;
      data: {
        active?: unknown;
        blocked?: unknown;
        lease?: unknown;
        localUnknown?: unknown;
        controlBlocked?: unknown;
        jobs: Readonly<Record<string, { state: string }>>;
      };
      assertEpoch(normal: boolean): void;
    },
    previousBuild: unknown,
    currentBuild: string,
  ): boolean;
};
const lost = (): Error =>
  Object.assign(new Error("Injected lost response"), {
    code: "QUEUE_IPC_RESPONSE_LOST",
  });
const client = (call: RecoveryClient["call"]): RecoveryClient => ({
  auth: { clientId: "owned" },
  call,
});
const submit = (queue: RecoveryClient): Promise<unknown> =>
  recovery.submitWithRecovery(
    queue,
    { kind: "rpc", requestId: "stable" },
    async () => assert.fail("No build refresh after lost ACK"),
  );

test("autostart compatibility retains missing-broker classifier", () => {
  const { missing } = runtimeRequire("./queue-autostart") as {
    missing(error: unknown): boolean;
  };
  assert.equal(missing({ code: "ENOENT" }), true);
  assert.equal(missing({ code: "ECONNREFUSED" }), true);
  assert.equal(missing({ code: "QUEUE_IPC_RESPONSE_LOST" }), false);
});
test("released normal-mode runtime updates select existing startup only after exact epoch proof", () => {
  let proofs = 0;
  const state = {
    epoch: {},
    admissionMode: "normal-multidocument",
    data: { jobs: {} },
    assertEpoch(normal: boolean) {
      assert.equal(normal, true);
      proofs++;
    },
  };
  assert.equal(epochStartupPinned(state, "old", "new"), false);
  assert.equal(proofs, 1);
  assert.equal(epochStartupPinned(state, "old", "old"), true);
  assert.equal(
    epochStartupPinned(
      { ...state, admissionMode: "isolated-one-anchor" },
      "old",
      "new",
    ),
    true,
  );
  assert.equal(epochStartupPinned(state, undefined, "new"), true);
  assert.throws(
    () =>
      epochStartupPinned(
        {
          ...state,
          assertEpoch() {
            throw new Error("unproven close");
          },
        },
        "old",
        "new",
      ),
    /unproven close/,
  );
  for (const data of [
    { active: "live", jobs: {} },
    { blocked: {}, jobs: {} },
    { localUnknown: {}, jobs: {} },
    { controlBlocked: {}, jobs: {} },
    { lease: {}, jobs: {} },
    { jobs: { uncertain: { state: "needs_reconciliation" } } },
  ]) {
    assert.throws(() => epochStartupPinned({ ...state, data }, "old", "new"), {
      code: "EPOCH_BUSY",
    });
  }
});
test("lost ACK recovers original job without another mutation", async () => {
  let mutations = 0;
  const job = {
    id: "one",
    requestId: "stable",
    clientId: "owned",
    state: "succeeded",
  };
  const queue = client(async (action, values) => {
    if (action === "submit") {
      mutations++;
      throw lost();
    }
    assert.equal(action, "find-request");
    assert.equal(values["requestId"], "stable");
    return { job, requestMatched: true };
  });
  assert.deepEqual(await submit(queue), job);
  assert.equal(mutations, 1);
});
test("lost result is read again; domain unknown remains unchanged", async () => {
  let reads = 0;
  const result = {
    job: { id: "one", state: "succeeded" },
    slenderness: { status: "unknown" },
  };
  const queue = client(async (action) => {
    assert.equal(action, "result");
    if (++reads === 1) throw lost();
    return result;
  });
  assert.equal(
    await recovery.readResult(queue, "result", { jobId: "one" }),
    result,
  );
  assert.equal(reads, 2);
});
test("persistent loss is bounded and retains job identity", async () => {
  let reads = 0;
  await assert.rejects(
    recovery.readResult(
      client(async () => {
        reads++;
        throw lost();
      }),
      "result",
      { jobId: "one" },
    ),
    { code: "QUEUE_IPC_RESPONSE_LOST", jobId: "one" },
  );
  assert.equal(reads, 3);
});
test("missing request, older broker and foreign owner never authorize replay", async () => {
  for (const found of [
    { job: null },
    { job: { id: "old", requestId: "stable", clientId: "owned" } },
    {
      job: { id: "foreign", requestId: "stable", clientId: "other" },
      requestMatched: true,
    },
  ]) {
    let mutations = 0;
    await assert.rejects(
      submit(
        client(async (action) => {
          if (action === "submit") {
            mutations++;
            throw lost();
          }
          return found;
        }),
      ),
      (error) => {
        assert.ok(error instanceof Error);
        const rejection = error as Error & {
          code?: string;
          requestId?: string;
          notStarted?: boolean;
        };
        assert.equal(
          rejection.code,
          found.job?.clientId === "other"
            ? "NOT_OWNER"
            : "QUEUE_IPC_RESPONSE_LOST",
        );
        assert.equal(rejection.requestId, "stable");
        if (found.job === null) assert.notEqual(rejection.notStarted, true);
        return true;
      },
    );
    assert.equal(mutations, 1);
  }
});
test("typed rejection and abort are not retried", async () => {
  for (const code of ["NOT_OWNER", "WAIT_ABORTED", "QUEUE_ERROR"]) {
    let reads = 0;
    await assert.rejects(
      recovery.readResult(
        client(async () => {
          reads++;
          throw Object.assign(new Error(code), { code });
        }),
        "result",
        { jobId: "one" },
      ),
      { code },
    );
    assert.equal(reads, 1);
  }
});
test("immutable-input conflict is diagnosed after a lost ACK, never hidden as successful recovery or replay", async () => {
  let submits = 0;
  const queue = client(async (action) => {
    if (action === "submit") {
      submits++;
      throw lost();
    }
    throw Object.assign(
      new Error("Original request has different immutable input"),
      { code: "REQUEST_CONFLICT" },
    );
  });
  await assert.rejects(submit(queue), {
    code: "REQUEST_CONFLICT",
    requestId: "stable",
  });
  assert.equal(submits, 1);
});
test("typed public admission does not autostart or refresh a changed build", async () => {
  let submits = 0;
  const queue = client(async () => {
    submits++;
    throw Object.assign(new Error("changed"), {
      code: "BUILD_CHANGED",
      notStarted: true,
    });
  });
  await assert.rejects(
    recovery.submitWithRecovery(queue, { requestId: "stable" }),
    { code: "BUILD_CHANGED", notStarted: true },
  );
  assert.equal(submits, 1);
});
test("unknown execution is preserved as evidence, never promoted to success", async () => {
  const unknown = {
    job: { id: "one", state: "needs_reconciliation" },
    execution: { executionOutcome: "unknown" },
  };
  assert.equal(
    await recovery.readResult(
      client(async () => unknown),
      "result",
      { jobId: "one" },
    ),
    unknown,
  );
});
test("identity retains execution input and strips only broker-authored fields", () => {
  const input = {
    kind: "command",
    requestId: "id",
    argv: ["run", "a.py"],
    cwd: "/owned",
    timeoutMs: 1000,
    inputFiles: [{ path: "/owned/a.py", sha256: "a".repeat(64) }],
    buildHash: "original",
  };
  assert.deepEqual(
    requestIdentity({
      ...input,
      clientId: "owned",
      ownerToken: "secret",
      phased: true,
      description: "note",
      isolatedEpoch: "epoch",
    }),
    input,
  );
  assert.notDeepEqual(
    requestIdentity({ ...input, argv: ["run", "other.py"] }),
    input,
  );
  assert.notDeepEqual(requestIdentity({ ...input, buildHash: "other" }), input);
});
test("real IPC EOF after admission recovers durable original result with one submit", async () => {
  const { request, queueSocket } = runtimeRequire("./queue-connection") as {
    request(dir: string, message: Record<string, unknown>): Promise<unknown>;
    queueSocket(dir: string): string;
  };
  const directory = fs.mkdtempSync(path.join(tmpdir(), "fmcad-ack-"));
  let mutations = 0,
    resultReads = 0;
  const job = {
    id: "one",
    requestId: "stable",
    clientId: "owned",
    state: "succeeded",
  };
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const message: unknown = JSON.parse(buffer);
      assert.ok(message && typeof message === "object" && "action" in message);
      if (message.action === "submit") {
        mutations++;
        socket.end();
        return;
      }
      if (message.action === "result" && ++resultReads === 1) {
        socket.end();
        return;
      }
      socket.end(
        JSON.stringify({
          ok: true,
          result: {
            job,
            ...(message.action === "find-request"
              ? { requestMatched: true }
              : {}),
          },
        }) + "\n",
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(queueSocket(directory), resolve),
  );
  try {
    const queue = client((action, values) =>
      request(directory, { action, ...values }),
    );
    assert.deepEqual(await submit(queue), job);
    assert.deepEqual(
      await recovery.readResult(queue, "result", { jobId: "one" }),
      { job },
    );
    assert.equal(mutations, 1);
    assert.equal(resultReads, 2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

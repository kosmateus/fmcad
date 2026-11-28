import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { createHash } from "node:crypto";
import { at, record, text, number } from "./integration/offline-cli";
const runtimeRequire = createRequire(
  process.cwd() + "/tests/console-pause.test.js",
);
const { decodeNativeProgram, nativeReceipts } = runtimeRequire(
  "./fixtures/native-source-envelope.cjs",
) as {
  decodeNativeProgram(source: string): string;
  nativeReceipts(
    source: string,
    root: string,
    instance: Record<string, unknown>,
  ): Array<{ file: string; value: Record<string, unknown> }>;
};
const releasedProof = runtimeRequire(
  "./fixtures/physical-turn-fixture.cjs",
) as (
  binding: Readonly<import("../src/queue-broker-ports").PhysicalTurnBinding>,
) => import("../src/queue-broker-ports").PhysicalTurnQuiescence;
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
let restorePlatform: (() => void) | undefined;
test.beforeEach(() => {
  restorePlatform = (
    runtimeRequire("./fixtures/fake-wsl-platform.cjs") as () => () => void
  )();
});
test.afterEach(() => {
  restorePlatform?.();
});
const { QueueState } = runtimeRequire("../src/queue-state") as {
  QueueState: new (
    dir: string,
    options?: { now?: () => number },
  ) => import("../packages/core/src/domain/queue").QueueDomain;
};
const { QueueGate } = runtimeRequire(
  "../src/queue-gate",
) as typeof import("../packages/node-adapters/src/execution/gate");
const { PauseBudget } = runtimeRequire(
  "../src/pause-budget",
) as typeof import("../packages/node-adapters/src/execution/pause-budget");
const { acceptedWorkerRequest, queueSocket } = runtimeRequire(
  "../src/queue-connection",
) as typeof import("../src/entrypoints/queue-connection");
function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 0;
  const state = new QueueState(dir, { now: () => time });
  return {
    dir,
    state,
    gate: new QueueGate(state, "instance"),
    advance: (ms: number) => {
      time += ms;
    },
    submit: (id: string, queueTimeoutMs = 30000) =>
      state.submit({
        requestId: id,
        clientId: "a",
        kind: "rpc",
        payload: {},
        timeoutMs: 1000,
        queueTimeoutMs,
      }),
  };
}
test("physical admission vs pause, drain, idempotency, conflict, durable intent and unknown", async (t) => {
  const { gate, state, dir } = setup(t);
  let finish: (() => void) | undefined,
    sends = 0;
  const first = gate.run(() => {
    sends++;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  await gate.control(true, { requestId: "pause", expectedGeneration: 0 });
  assert.equal(gate.snapshot().phase, "PAUSING");
  const second = gate.run(async () => {
    sends++;
  });
  assert.equal(sends, 1);
  present(finish)();
  await first;
  assert.equal(gate.snapshot().phase, "PAUSED");
  assert.equal(new QueueState(dir).data.paused, true);
  assert.equal(
    (await gate.control(true, { requestId: "pause" })).generation,
    1,
  );
  await assert.rejects(gate.control(false, { expectedGeneration: 0 }), {
    code: "STATE_CONFLICT",
  });
  await gate.control(false, { expectedGeneration: 1 }, async () => {});
  await second;
  assert.equal(sends, 2);
  state._commit((d) => {
    d.controlBlocked = true;
    return null;
  });
  assert.equal(gate.snapshot().phase, "RECOVERY_BLOCKED");
  await assert.rejects(
    gate.run(async () => {
      sends++;
    }),
    { code: "RECONCILIATION_REQUIRED" },
  );
});
test("queue budgets: 30-8=22 seconds, arrival in pause, two pauses and restore", (t) => {
  const { state, dir, advance, submit } = setup(t);
  const a = submit("a");
  advance(8000);
  state.pause(true);
  advance(300000);
  const b = submit("b");
  advance(100000);
  assert.equal(state.next(), null);
  state.pause(false);
  assert.equal(
    number(state.status(text(a["id"]))["queueDeadline"]) - state._time(),
    22000,
  );
  assert.equal(
    number(state.status(text(b["id"]))["queueDeadline"]) - state._time(),
    30000,
  );
  advance(2000);
  state.pause(true);
  advance(600000);
  const restored = new QueueState(dir, { now: () => state._time() });
  assert.equal(restored.data.paused, true);
  restored.pause(false);
  assert.equal(
    number(restored.status(text(a["id"]))["queueDeadline"]) - state._time(),
    20000,
  );
  assert.equal(
    number(restored.status(text(b["id"]))["queueDeadline"]) - state._time(),
    28000,
  );
});
test("monotonic budget ignores stale callbacks, freezes only waiting and never restores full time", () => {
  let time = 0,
    expired = 0;
  const callbacks: (() => void)[] = [];
  const budget = new PauseBudget(30000, () => expired++, {
    now: () => time,
    schedule: (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancel() {},
  });
  time += 8000;
  budget.freeze();
  time += 300000;
  present(callbacks[0])();
  assert.equal(expired, 0);
  assert.equal(budget.remaining(), 22000);
  budget.resume();
  time += 2000;
  budget.freeze();
  time += 900000;
  budget.resume();
  assert.equal(budget.remaining(), 20000);
  present(callbacks[1])();
  assert.equal(expired, 0);
  time += 20000;
  present(callbacks[2])();
  assert.equal(expired, 1);
});
test("actual controlled worker client stays pending during pause, with live heartbeat and one dispatch", async (t) => {
  const { dir } = setup(t);
  let heartbeat = 0,
    dispatches = 0,
    held: net.Socket | undefined;
  const server = net.createServer((socket) =>
    socket.once("data", (data) => {
      const message = JSON.parse(String(data));
      if (message.action === "worker-status") {
        heartbeat++;
        socket.end(
          JSON.stringify({ ok: true, result: { waitingForPause: true } }) +
            "\n",
        );
      } else {
        dispatches++;
        held = socket;
      }
    }),
  );
  await new Promise<void>((resolve) =>
    server.listen(queueSocket(dir), resolve),
  );
  t.after(() => server.close());
  let done = false;
  const pending = acceptedWorkerRequest(
    dir,
    { action: "backend", jobId: "job", workerToken: "token" },
    { pollMs: 5 },
  ).then((value) => {
    done = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(done, false);
  assert.ok(heartbeat > 1);
  assert.equal(dispatches, 1);
  present(held).end(JSON.stringify({ ok: true, result: "completed" }) + "\n");
  assert.equal(await pending, "completed");
});

test("real broker control drains a physical RPC, keeps queued work and resumes through bound readiness receipts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-"));
  const { serve } = runtimeRequire(
    "../src/queue-broker",
  ) as typeof import("../src/queue-broker");
  const { request } = runtimeRequire(
    "../src/queue-connection",
  ) as typeof import("../src/entrypoints/queue-connection");
  const { buildHash } = runtimeRequire("../src/queue-instance") as {
    buildHash(): string;
  };
  const currentBuildHash = buildHash();
  const documentName = "PublicBox",
    creationId = "public-box-creation";
  const identity: {
    pid: number;
    birth: string;
    version: string;
    activeCommand: string;
    documents: [];
    documentState: {
      status: string;
      fingerprint?: string;
      state?: { identity?: { name?: string; creationId?: string } };
    };
  } = {
    pid: 91,
    birth: "fake:91",
    version: "fake",
    activeCommand: "SelectCommand",
    documents: [],
    documentState: { status: "unavailable" },
  };
  let finishPing: (() => void) | undefined,
    armedPing: "first" | "second" | "third" | undefined,
    sent = 0,
    productScripts = 0,
    boundProbeReceipts = 0;
  const pingIds: unknown[] = [];
  const releasedTurns = new Set<string>();
  const { createBrokerTransport } = runtimeRequire(
    "../src/dist/fusion-transport/broker",
  ) as typeof import("../packages/node-adapters/src/fusion-transport/broker");
  const physical = createBrokerTransport(
    {
      url: "http://queue.invalid",
      tool: "fusion_mcp_execute",
      timeoutMs: 30000,
    },
    {
      version: "fixture",
      requestTimeout: (server) => present(server.timeoutMs),
      bridgeSource: () => assert.fail("MCP does not use a bridge"),
    },
  );
  physical._post = async function (value) {
    const payload = record(value);
    if (payload["method"] === "initialize")
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload["id"],
          result: { protocolVersion: at(payload, "params", "protocolVersion") },
        }),
      };
    if (payload["method"] === "notifications/initialized")
      return { status: 202, raw: "" };
    if (payload["method"] === "ping" && armedPing) {
      const requestId = armedPing;
      armedPing = undefined;
      pingIds.push(payload["id"]);
      sent++;
      if (requestId === "first")
        await new Promise<void>((resolve) => {
          finishPing = resolve;
        });
    }
    const script =
      payload["method"] === "tools/call"
        ? at(payload, "params", "arguments", "code")
        : undefined;
    const decodedScript =
      typeof script === "string" ? decodeNativeProgram(script) : "";
    const wrappedSource = decodedScript.match(
      /exec\(compile\(("(?:\\.|[^"\\])*")/,
    );
    const probeSource = wrappedSource
      ? (JSON.parse(wrappedSource[1]!) as string)
      : decodedScript;
    let observed = identity;
    if (probeSource.includes("FMCAD_QUEUE_INSTANCE")) {
      const match = probeSource.match(
        /_qi_json\.loads\(\s*("(?:\\.|[^"\\])*")\s*\)/,
      );
      if (probeSource.includes("_value['documentState']"))
        assert.ok(
          match,
          "preflight must retain its requested document selector",
        );
      const selector = match
        ? (JSON.parse(JSON.parse(match[1]!) as string) as {
            name?: string;
            creationId?: string;
            fileId?: string;
          })
        : undefined;
      if (selector) {
        const exactTarget =
          selector.name === documentName &&
          (selector.creationId === undefined ||
            selector.creationId === creationId) &&
          selector.fileId === undefined;
        observed = exactTarget
          ? {
              ...identity,
              documentState: {
                status: "complete",
                fingerprint: "public-box-state-1",
                state: { identity: { name: documentName, creationId } },
              },
            }
          : { ...identity, documentState: { status: "unavailable" } };
      }
    }
    if (
      typeof script === "string" &&
      !decodedScript.includes("FMCAD_QUEUE_INSTANCE")
    )
      productScripts++;
    const receipts =
      typeof script === "string" ? nativeReceipts(script, dir, observed) : [];
    for (const receipt of receipts) {
      fs.mkdirSync(path.dirname(receipt.file), { recursive: true });
      fs.writeFileSync(receipt.file, JSON.stringify(receipt.value));
      if (receipt.value["probeObservation"] !== undefined) boundProbeReceipts++;
    }
    const boundProbe = receipts.some(
      (receipt) => receipt.value["probeObservation"] !== undefined,
    );
    const output = boundProbe
      ? {
          success: true,
          stdout: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(observed),
          stderr: "",
        }
      : decodedScript.includes("_document_status_minimal")
        ? {
            success: true,
            stdout:
              "FMCAD_RESULT " +
              JSON.stringify({
                success: true,
                result: {
                  status: "complete",
                  name: documentName,
                  creationId,
                },
              }),
            stderr: "",
          }
        : { success: true, stdout: "", stderr: "" };
    return {
      status: 200,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: payload["id"],
        result: boundProbe
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(output),
                },
              ],
              structuredContent: output,
            }
          : typeof script === "string"
            ? {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(output),
                  },
                ],
                structuredContent: output,
              }
            : {},
      }),
    };
  };
  const broker = await serve(
    { backend: "addin", timeoutMs: 30000 },
    {
      dir,
      confirmOwnership: true,
      createBackend: () =>
        physical as unknown as import("../src/queue-broker-ports").Client,
      nativePath: (file) => file,
      pollMs: 5,
      bindPhysicalTurn(request) {
        return {
          version: 1,
          generation: {
            instance: "fixture-instance",
            epoch: "fixture-epoch",
          },
          grantDigest: createHash("sha256")
            .update("console-pause-physical-grant")
            .digest("hex"),
          physicalRuntime: {
            pid: identity.pid,
            birth: identity.birth,
            version: identity.version,
            source: "fixture-source",
            build: "fixture-build",
          },
          turnId: request.physicalRequestId,
          target: JSON.stringify(request.documentSelector ?? null),
        };
      },
      async withPhysicalTurn(binding, send) {
        try {
          return await send();
        } finally {
          releasedTurns.add(binding.turnId);
        }
      },
      async physicalTurnQuiescence(binding) {
        return releasedTurns.has(binding.turnId)
          ? releasedProof(binding)
          : { state: "unknown", binding };
      },
    },
  );
  const auth = { clientId: "control-test", clientToken: "private-control" };
  t.after(async () => {
    finishPing?.();
    try {
      for (let i = 0; i < 100; i++) {
        const control = record(
          await request(dir, { action: "control-status", auth }),
        );
        if (control["phase"] === "PAUSED") {
          await request(dir, {
            action: "resume",
            auth,
            control: {
              requestId: "cleanup-resume",
              expectedGeneration: control["generation"],
              instanceId: control["instanceId"],
            },
          });
          break;
        }
        if (control["phase"] !== "PAUSING") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      try {
        await broker.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  assert.ok(
    boundProbeReceipts > 0,
    "readiness must consume a source-bound Fusion instance receipt",
  );
  await request(dir, { action: "register", ...auth });
  const call = async (action: string, rest = {}) =>
    record(await request(dir, { action, auth, ...rest }));
  // The fake-clock queue-budget tests above assert pause freezing exactly.
  // Leave room here for the original active RPC's post-resume settlement.
  const submit = (requestId: string) =>
    call("submit", {
      request: {
        kind: "rpc",
        requestId,
        timeoutMs: 30000,
        queueTimeoutMs: 5000,
        backend: "addin",
        buildHash: currentBuildHash,
        payload: { jsonrpc: "2.0", id: requestId, method: "ping" },
      },
    });
  const { prepareRequest } = runtimeRequire(
    "../src/dist/composition/execution-request",
  ) as {
    prepareRequest(job: {
      request: Record<string, unknown>;
    }): Record<string, unknown>;
  };
  const submitCommand = (requestId: string, argv: string[]) =>
    call("submit", {
      request: prepareRequest({
        request: {
          kind: "command",
          requestId,
          timeoutMs: 30000,
          backend: "addin",
          buildHash: currentBuildHash,
          inputFiles: [],
          argv,
          cwd: dir,
        },
      }),
    });
  armedPing = "first";
  const first = await submit("first");
  for (let i = 0; !finishPing && i < 1000; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    finishPing,
    JSON.stringify({
      first: await call("result", { jobId: first["id"] }),
      pingIds,
    }),
  );
  const before = await call("control-status");
  const paused = await call("pause", {
    control: {
      requestId: "pause",
      instanceId: before["instanceId"],
      expectedGeneration: before["generation"],
    },
  });
  assert.equal(paused["phase"], "PAUSING");
  const second = await submit("second");
  finishPing();
  for (
    let i = 0;
    (await call("control-status"))["phase"] !== "PAUSED" && i < 100;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(
    record((await call("result", { jobId: second["id"] }))["job"])["state"],
    "queued",
  );
  assert.equal(sent, 1);
  const statusRead = await submitCommand("pinned-status-after-resume", [
    "doc",
    "status",
    "--doc",
    documentName,
    "--doc-id",
    creationId,
  ]);
  const foreignStatusRead = await submitCommand(
    "foreign-status-after-resume",
    ["doc", "status", "--doc", documentName, "--doc-id", "foreign-creation"],
  );
  const unpinnedStatusRead = await submitCommand("unpinned-status-after-resume", [
    "doc",
    "status",
    "--doc",
    documentName,
  ]);
  const staleMutation = await submitCommand("stale-mutation-after-resume", [
    "shape",
    "box",
    "--doc",
    documentName,
    "--doc-id",
    creationId,
    "--data",
    JSON.stringify({
      name: "ResumeGuardBox",
      width: "40 mm",
      depth: "20 mm",
      height: "10 mm",
    }),
  ]);
  const current = await call("control-status");
  assert.equal(current["phase"], "PAUSED");
  armedPing = "second";
  await call("resume", {
    control: {
      requestId: "resume",
      expectedGeneration: current["generation"],
      instanceId: current["instanceId"],
    },
  });
  for (let i = 0; i < 2000; i++) {
    const result = await call("result", { jobId: second["id"] });
    if (record(result["job"])["state"] === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    record((await call("result", { jobId: first["id"] }))["job"])["state"],
    "succeeded",
  );
  assert.equal(
    record((await call("result", { jobId: second["id"] }))["job"])["state"],
    "succeeded",
  );
  const pendingJobs = [
    statusRead,
    foreignStatusRead,
    unpinnedStatusRead,
    staleMutation,
  ];
  for (let i = 0; i < 2000; i++) {
    const results = await Promise.all(
      pendingJobs.map((pending) => call("result", { jobId: pending["id"] })),
    );
    if (
      results.every((result) =>
        ["succeeded", "failed"].includes(text(at(result, "job", "state"))),
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const statusResult = await call("result", { jobId: statusRead["id"] });
  const queueStatus = await call("status");
  assert.equal(
    text(at(statusResult, "job", "state")),
    "succeeded",
    JSON.stringify({
      statusResult,
      quarantined: queueStatus["quarantined"],
      jobs: Object.values(record(queueStatus["jobs"])).map((job) => ({
        id: record(job)["id"],
        state: record(job)["state"],
        code: record(job)["code"],
        requestId: record(job)["requestId"],
      })),
      boundProbeReceipts,
      productScripts,
    }),
  );
  assert.match(text(at(statusResult, "stdout")), /"status":"complete"/);
  assert.match(text(at(statusResult, "stdout")), /"name":"PublicBox"/);
  assert.match(
    text(at(statusResult, "stdout")),
    /"creationId":"public-box-creation"/,
  );
  for (const rejectedJob of [
    foreignStatusRead,
    unpinnedStatusRead,
    staleMutation,
  ]) {
    const result = await call("result", { jobId: rejectedJob["id"] });
    assert.equal(
      text(at(result, "job", "state")),
      "failed",
      JSON.stringify(result),
    );
    assert.equal(
      at(result, "job", "operationResult", "executionOutcome"),
      "not_started",
    );
  }
  armedPing = "third";
  const third = await submit("third");
  for (let i = 0; !finishPing && i < 1000; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(finishPing, JSON.stringify(await call("result", { jobId: third["id"] })));
  const beforeStalePause = await call("control-status");
  const stalePause = await call("pause", {
    control: {
      requestId: "pause-before-stale-context",
      instanceId: beforeStalePause["instanceId"],
      expectedGeneration: beforeStalePause["generation"],
    },
  });
  assert.equal(stalePause["phase"], "PAUSING");
  const stale = await submitCommand("stale-context", [
    "stats",
    "--doc",
    "OldModel",
  ]);
  finishPing();
  for (
    let i = 0;
    (await call("control-status"))["phase"] !== "PAUSED" && i < 100;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  const beforeStaleResume = await call("control-status");
  assert.equal(beforeStaleResume["phase"], "PAUSED");
  await call("resume", {
    control: {
      requestId: "resume-after-status",
      expectedGeneration: beforeStaleResume["generation"],
      instanceId: beforeStaleResume["instanceId"],
    },
  });
  for (let i = 0; i < 2000; i++) {
    if (
      record((await call("result", { jobId: stale["id"] }))["job"])["state"] ===
      "failed"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const rejected = await call("result", { jobId: stale["id"] });
  assert.equal(record(rejected["job"])["state"], "failed");
  assert.equal(
    record((await call("result", { jobId: third["id"] }))["job"])["state"],
    "succeeded",
  );
  // Static admission is now covered by the real strict inspection gate. This
  // scenario must reach the stale-document guard after resume, never pass merely
  // because a generated program fails to typecheck before that guard is exercised.
  // Resume may invalidate preparation first (DOCUMENT_CHANGED); if preparation
  // finishes afterward, the fresh probe reports the explicitly unavailable target.
  // Both are document fences. Checker failures are no longer accepted here.
  assert.ok(
    ["DOCUMENT_CHANGED", "DOCUMENT_STATE_UNAVAILABLE"].includes(
      text(at(rejected, "job", "code")),
    ),
    JSON.stringify(rejected),
  );
  assert.equal(
    at(rejected, "job", "operationResult", "executionOutcome"),
    "not_started",
  );
  assert.equal(
    productScripts,
    1,
    "Only the exact read-only pinned status may run after resume",
  );
  assert.equal(sent, 3);
});

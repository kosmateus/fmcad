import Module from "node:module";
import { createHash } from "node:crypto";
type ResetApi = typeof import("../src/fusion-reset");
type ExecPort = (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => string;
// These ports deliberately feed malformed persisted records into validators.
// The fixture shape is not a claim of a fully initialized operational client.
type ResetValidationPort = Pick<
  ResetApi,
  "parse" | "isOwnedFixture" | "validateProcess"
> & {
  validateQueue(input: unknown): void;
  planDocuments(input: unknown): ReturnType<ResetApi["planDocuments"]>;
  pythonInventoryCode(
    input: unknown[],
    closeIds: string[],
    pid: number,
  ): string;
  readFusionProcess(
    pid: number,
    exec?: ExecPort,
  ): ReturnType<ResetApi["readFusionProcess"]>;
  validateResetRecovery(
    ...input: unknown[]
  ): ReturnType<ResetApi["validateResetRecovery"]>;
  releaseResetPause(...input: unknown[]): void;
  restoreBroker(
    client: { call(action: string): Promise<unknown> },
    config: unknown,
    marker: unknown,
  ): Promise<unknown>;
  stopBroker(
    client: { dir: string; call(action: string): Promise<unknown> },
    marker: unknown,
    status: unknown,
  ): Promise<unknown>;
};
interface StatusFixture {
  active: unknown;
  blocked: unknown;
  held: unknown;
  lease: unknown;
  stopping: boolean;
  control: {
    unresolved: boolean;
    activeOperations: number;
    phase: string;
    gateClosed: boolean;
  };
  jobs: Record<string, { state: string }>;
}
interface Job {
  id: string;
  state: string;
  dispatch?: { rpcCount: number };
}
import { createRequire } from "node:module";
const root = process.cwd();
const load = createRequire(path.join(root, "tests", "fusion-reset.test.js"));

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
test.beforeEach((t) =>
  (t as test.TestContext).after(
    (load("./fixtures/fake-wsl-platform.cjs") as () => () => void)(),
  ),
);
const {
  parse,
  validateQueue,
  isOwnedFixture,
  planDocuments,
  pythonInventoryCode,
  readFusionProcess,
  validateProcess,
  validateResetRecovery,
  releaseResetPause,
} = load("../src/fusion-reset") as ResetValidationPort;
const { processBirth, durable } = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { QueueState } = load(
  "../src/queue-state",
) as typeof import("../src/queue-state");
const { assertResetAccess } = load(
  "../src/queue-autostart",
) as typeof import("../src/entrypoints/queue-autostart");
const { assertResetSubmissionOpen, serve } = load(
  "../src/queue-broker",
) as typeof import("../src/queue-broker");
const { request: wireRequest } = load(
  "../src/queue-connection",
) as typeof import("../src/entrypoints/queue-connection");
const request = <T = unknown>(dir: string, message: Record<string, unknown>) =>
  wireRequest(dir, message) as Promise<T>;

const clean = (
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  saved: false,
  modified: false,
  bodies: 0,
  sketches: 0,
  occurrences: 0,
  timeline: 0,
  userParameters: 0,
  ...extra,
});

test("Fusion reset requires an explicit force confirmation", () => {
  assert.deepEqual(parse(["--force"]), { force: true });
  for (const args of [[], ["--dry-run"], ["--force", "--force"]]) {
    assert.throws(() => parse(args), { code: "USAGE" });
  }
});

test("Fusion reset rejects active, unresolved, non-running and started queue work", () => {
  const status: StatusFixture = {
    active: null,
    blocked: null,
    held: null,
    lease: null,
    stopping: false,
    control: {
      unresolved: false,
      activeOperations: 0,
      phase: "RUNNING",
      gateClosed: false,
    },
    jobs: {},
  };
  assert.doesNotThrow(() => validateQueue(status));
  const mutations: Array<(s: StatusFixture) => void> = [
    (s) => {
      s.active = "job";
    },
    (s) => {
      s.blocked = { id: "job" };
    },
    (s) => {
      s.held = "unknown";
    },
    (s) => {
      s.control.unresolved = true;
    },
    (s) => {
      s.control.activeOperations = 1;
    },
    (s) => {
      s.control.phase = "PAUSED";
    },
    (s) => {
      s.jobs["queued"] = { state: "queued" };
    },
    (s) => {
      s.jobs["started"] = { state: "running" };
    },
  ];
  for (const mutation of mutations) {
    const bad = structuredClone(status);
    mutation(bad);
    assert.throws(() => validateQueue(bad), { code: "QUEUE_BUSY" });
  }
});

test("only exact FMCAD fixture names are eligible for discard", () => {
  for (const name of [
    "FMCAD_CAD_TEST_2026-10-21T20_50_19_332Z",
    "FMCAD_DEFINITIONS_7552dc72_6215_437c_8362_6eafee37ede3",
    "FMCAD_GEO_35592d79_58e2_4b02_9589_1cc4815826f3",
    "FMCAD_EXT_9c0ca19e_8ce7_48c3_b704_8dae5e8408f1",
    "FMCAD_STYLE_50830709_6751_4c3b_8683_33903fe0db85",
  ])
    assert.equal(isOwnedFixture(name), true, name);
  for (const name of [
    "FMCAD_project",
    "legacy-fixture-1-20261022T015108-b9f159591e",
    "legacy-fixture-1-final",
    "MyDesign",
    "Bez nazwy",
  ]) {
    assert.equal(isOwnedFixture(name), false, name);
  }
});

test("document plan preserves saved clean deliverables and the empty untitled document", () => {
  const result = planDocuments([
    clean("blank", "Bez nazwy"),
    clean("fixture", "FMCAD_CAD_TEST_2026-10-21T20_50_19_332Z", {
      modified: true,
      sketches: 2,
    }),
    clean("saved", "Saved model v1", {
      saved: true,
      fileId: "urn:adsk:lineage:saved",
    }),
  ]);
  assert.deepEqual(result.closeIds, ["fixture"]);
  assert.deepEqual(result.savedIds, ["saved"]);
});

test("unknown or modified saved documents block reset before any close", () => {
  assert.throws(
    () =>
      planDocuments([clean("user", "MyDesign", { modified: true, bodies: 1 })]),
    { code: "UNSAVED_WORK" },
  );
  assert.throws(
    () =>
      planDocuments([
        clean("saved", "Design", {
          saved: true,
          modified: true,
          fileId: "urn:saved",
        }),
      ]),
    { code: "UNSAVED_WORK" },
  );
  assert.throws(
    () => planDocuments([clean("not-empty", "Bez nazwy", { sketches: 1 })]),
    { code: "UNSAVED_WORK" },
  );
  assert.throws(
    () => planDocuments([clean("saved-without-id", "Design", { saved: true })]),
    { code: "UNSAVED_WORK" },
  );
});

test("fixture closure source pins the complete preflight document inventory and protects saved file IDs", () => {
  const code = pythonInventoryCode(
    [
      {
        id: "fixture",
        name: "FMCAD_CAD_TEST_2026-10-21T20_50_19_332Z",
        saved: false,
      },
    ],
    ["fixture"],
    24820,
  );
  assert.match(code, /_os\.getpid\(\) != _expected\['expectedPid'\]/);
  assert.match(code, /_before != _expected\['expected'\]/);
  assert.match(code, /_doc\.close\(False\)/);
  assert.match(code, /_saved_before != _saved_after/);
});

test("Fusion process inspection requires exact PID, birth, single-instance path and Autodesk installation", () => {
  const process = {
    pid: 24820,
    birth: "134370677767249688",
    path: "C:\\Users\\kamil\\AppData\\Local\\Autodesk\\webdeploy\\production\\abc123\\Fusion360.exe",
    responding: false,
    fusionCount: 1,
  };
  const output = JSON.stringify(process);
  const exec: ExecPort = (file, _args, options) => {
    assert.equal(file, "powershell.exe");
    assert.equal(options["encoding"], "utf8");
    return output;
  };
  assert.deepEqual(readFusionProcess(24820, exec), process);
  assert.equal(
    validateProcess({ pid: 24820, birth: process.birth }, process),
    process,
  );
  assert.throws(
    () => validateProcess({ pid: 24820, birth: "different" }, process),
    { code: "PROCESS_IDENTITY_MISMATCH" },
  );
  assert.throws(
    () =>
      validateProcess(
        { pid: 24820, birth: process.birth },
        { ...process, fusionCount: 2 },
      ),
    { code: "PROCESS_IDENTITY_MISMATCH" },
  );
  assert.equal(
    readFusionProcess(24820, () => "absent"),
    null,
  );
});

test("reset marker fences autostart, broker startup and new queue submissions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-fusion-reset-"));
  try {
    assert.doesNotThrow(() => assertResetSubmissionOpen(dir));
    const marker = {
      protocol: 1,
      nonce: "reset-nonce",
      pid: process.pid,
      birth: processBirth(),
    };
    durable(path.join(dir, "fusion-reset.lock"), marker, true);
    assert.throws(() => assertResetAccess(dir), {
      code: "FUSION_RESET_IN_PROGRESS",
    });
    assert.throws(() => assertResetAccess(dir, "other-nonce"), {
      code: "FUSION_RESET_IN_PROGRESS",
    });
    assert.doesNotThrow(() => assertResetAccess(dir, marker.nonce));
    assert.throws(() => assertResetSubmissionOpen(dir), {
      code: "FUSION_RESET_IN_PROGRESS",
    });
    await assert.rejects(
      serve({} as import("../src/queue-broker-ports").Config, {
        confirmOwnership: true,
        dir,
        createBackend: () => {
          throw Error("Reset must refuse before backend creation");
        },
      }),
      { code: "FUSION_RESET_IN_PROGRESS" },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "reset marker added after admission blocks physical dispatch without changing open dispatch",
  { timeout: 10000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-reset-dispatch-"));
    const instance = {
      pid: 99,
      birth: "mock:99",
      version: "mock",
      activeCommand: null,
      documents: [],
    };
    let holdNextPreflight = false;
    let preflightStartedResolve!: () => void, releasePreflight!: () => void;
    const preflightStarted = new Promise<void>((resolve) => {
      preflightStartedResolve = resolve;
    });
    const waitBeforePreflightReturns = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let pingDispatches = 0;
    const physical = {
      server: { timeoutMs: 2000 },
      _parse: JSON.parse,
      async _post(payload: import("../src/queue-broker-ports").Rpc) {
        if (payload.method === "ping") pingDispatches++;
        return {
          status: 200,
          raw: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }),
        };
      },
      async callTool(value: import("../src/queue-broker-ports").ToolArguments) {
        const script = value.object?.script || "";
        if (
          holdNextPreflight &&
          script.includes("_qr_binding_value = _qr_cast(object, _qr_json.loads")
        ) {
          holdNextPreflight = false;
          preflightStartedResolve();
          await waitBeforePreflightReturns;
        }
        return {
          failed: false,
          text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
        };
      },
    };
    let broker: Awaited<ReturnType<typeof serve>> | undefined = undefined;
    t.after(async () => {
      releasePreflight();
      if (broker) await broker.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    broker = await serve(
      { backend: "mcp", timeoutMs: 2000 },
      {
        dir,
        confirmOwnership: true,
        createBackend: () =>
          physical as unknown as import("../src/queue-broker-ports").Client,
        pollMs: 5,
      },
    );
    const auth = {
      clientId: "reset-dispatch-test",
      clientToken: "private-reset-dispatch",
    };
    await request(dir, { action: "register", ...auth });
    const call = <T = unknown>(
      action: string,
      rest: Record<string, unknown> = {},
    ) => request<T>(dir, { action, auth, ...rest });
    async function submitPing(requestId: string) {
      return call<Job>("submit", {
        request: {
          kind: "rpc",
          requestId,
          timeoutMs: 2000,
          payload: { jsonrpc: "2.0", id: requestId, method: "ping" },
        },
      });
    }
    async function waitForResult(jobId: string) {
      for (let i = 0; i < 200; i++) {
        const result = await call<{ job: Job }>("result", { jobId });
        if (
          ["succeeded", "failed", "needs_reconciliation"].includes(
            result.job.state,
          )
        )
          return result;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.fail("Controlled RPC did not finish");
    }

    const open = await submitPing(randomUUID());
    assert.equal((await waitForResult(open.id)).job.state, "succeeded");
    assert.equal(
      pingDispatches,
      1,
      "A normal queued RPC still reaches the physical backend",
    );

    holdNextPreflight = true;
    const fenced = await submitPing(randomUUID());
    await preflightStarted;
    durable(
      path.join(dir, "fusion-reset.lock"),
      { protocol: 1, nonce: "test-reset" },
      true,
    );
    releasePreflight();
    const rejected = await waitForResult(fenced.id);
    assert.equal(rejected.job.state, "failed");
    assert.equal(
      rejected.job.dispatch?.rpcCount || 0,
      0,
      "The reset fence rejects before a dispatch is recorded",
    );
    assert.equal(
      pingDispatches,
      1,
      "No physical post occurs after the reset marker appears",
    );
  },
);

test("interrupted reset recovery requires a dead owner, stopped broker, idle paused queue and new Fusion identity", () => {
  const marker = {
    protocol: 1,
    resetPause: { requestId: "owned", instanceId: "old", generation: 1 },
    at: new Date().toISOString(),
    fusion: {
      pid: 10,
      birth: "old-birth",
      path: "C:\\Autodesk\\webdeploy\\production\\old\\Fusion360.exe",
    },
  };
  const state = {
    paused: true,
    pauseStartedAt: Date.now(),
    active: null,
    blocked: null,
    controlBlocked: null,
    localUnknown: null,
    lease: null,
    controlGeneration: 1,
    controlRequests: { owned: { paused: true, generation: 1 } },
    jobs: { prior: { state: "succeeded" } },
  };
  const previous = { pid: 10, birth: "old-birth" };
  const replacement = {
    pid: 11,
    birth: "new-birth",
    path: "C:\\Autodesk\\webdeploy\\production\\new\\Fusion360.exe",
    responding: true,
    fusionCount: 1,
  };
  assert.equal(
    validateResetRecovery(marker, state, previous, false, false, replacement),
    replacement,
  );
  assert.throws(
    () =>
      validateResetRecovery(
        { ...marker, resetPause: true },
        state,
        previous,
        false,
        false,
        replacement,
      ),
    { code: "RESET_PAUSE_UNOWNED" },
  );
  assert.throws(
    () =>
      validateResetRecovery(
        marker,
        { ...state, controlGeneration: 2 },
        previous,
        false,
        false,
        replacement,
      ),
    { code: "RESET_PAUSE_UNOWNED" },
  );
  assert.throws(
    () =>
      validateResetRecovery(marker, state, previous, true, false, replacement),
    { code: "FUSION_RESET_IN_PROGRESS" },
  );
  assert.throws(
    () =>
      validateResetRecovery(marker, state, previous, false, true, replacement),
    { code: "RESET_RECOVERY_BUSY" },
  );
  assert.throws(
    () =>
      validateResetRecovery(
        marker,
        { ...state, paused: false },
        previous,
        false,
        false,
        replacement,
      ),
    { code: "RESET_RECOVERY_BUSY" },
  );
  assert.throws(
    () =>
      validateResetRecovery(
        marker,
        { ...state, jobs: { pending: { state: "queued" } } },
        previous,
        false,
        false,
        replacement,
      ),
    { code: "RESET_RECOVERY_BUSY" },
  );
  assert.throws(
    () =>
      validateResetRecovery(marker, state, previous, false, false, {
        ...replacement,
        birth: "old-birth",
      }),
    { code: "FUSION_UNAVAILABLE" },
  );
});

test("reset recovery unpauses only its own empty durable queue before starting the replacement broker", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-fusion-reset-pause-"),
  );
  const markerFile = path.join(dir, "fusion-reset.lock");
  const marker = {
    protocol: 1,
    nonce: "reset",
    resetPause: { requestId: "owned", instanceId: "old", generation: 1 },
    phase: "prepared",
    at: new Date().toISOString(),
  };
  try {
    const state = new QueueState(dir);
    state.pause(true, "owned");
    durable(markerFile, marker, true);
    releaseResetPause(dir, markerFile, marker);
    assert.equal(new QueueState(dir).data.paused, false);
    assert.equal(new QueueState(dir).data.active, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("typed physical reset preserves historical refusal and recovery contracts", async (t) => {
  const filename = load.resolve("../src/fusion-reset");
  const source = fs.readFileSync(
    path.join(root, "tests/fixtures/history/fusion-reset-bab4c10.js.txt"),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "f0b1cdafee667690f13feba7c116cca4705db39925610fc0d7f04b1f344fc9ce",
  );
  const retained = new Module(filename) as Module & {
    _compile(source: string, filename: string): void;
  };
  retained.filename = filename;
  retained.paths = createRequire(filename).resolve.paths("fixture") ?? [];
  retained._compile(source, filename);
  const before = retained.exports as ResetValidationPort,
    after = load("../src/fusion-reset") as ResetValidationPort;
  const outcome = (callback: () => unknown) => {
    try {
      return { value: callback() };
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      return { code: e.code, message: e.message };
    }
  };
  for (const args of [[], ["--force"], ["--force", "--force"], ["--dry-run"]]) {
    assert.deepEqual(
      outcome(() => after.parse(args)),
      outcome(() => before.parse(args)),
    );
  }
  const documents = [
    clean("new", "Bez nazwy"),
    clean("saved", "Part", { saved: true, fileId: "owned-file" }),
    clean("test", "FMCAD_CAD_TEST_2026-01-02T03_04_05_006Z"),
  ];
  for (const rows of [
    documents,
    [...documents, clean("foreign", "Personal work")],
    [
      clean("saved", "Part", {
        saved: true,
        modified: true,
        fileId: "owned-file",
      }),
    ],
    null,
    [{}],
  ]) {
    assert.deepEqual(
      outcome(() => after.planDocuments(rows)),
      outcome(() => before.planDocuments(rows)),
    );
  }
  assert.equal(
    after.pythonInventoryCode(documents, ["test"], 123),
    before.pythonInventoryCode(documents, ["test"], 123),
  );
  const physical = {
    pid: 123,
    birth: "123456",
    path: "C:\\Users\\test\\Autodesk\\webdeploy\\production\\abc\\Fusion360.exe",
    responding: true,
    fusionCount: 1,
  };
  for (const output of [
    JSON.stringify(physical),
    "absent",
    "{broken",
    JSON.stringify({ pid: 124 }),
  ]) {
    const commands: Parameters<ExecPort>[] = [];
    const exec: ExecPort = (...args) => {
      commands.push(args);
      return output;
    };
    const previous = outcome(() => before.readFusionProcess(123, exec));
    const current = outcome(() => after.readFusionProcess(123, exec));
    assert.deepEqual(current, previous);
    assert.deepEqual(commands[1], commands[0]);
  }
  for (const api of [before, after]) {
    const calls: string[] = [];
    const client = {
      call: async (action: string) => {
        calls.push(action);
        return { retained: true };
      },
    };
    assert.deepEqual(
      await api.restoreBroker(client, {}, { resetPause: null }),
      { retained: true },
    );
    assert.deepEqual(
      calls,
      ["status"],
      "An unowned pause grants no resume or restart authority",
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-paired-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(dir, "broker.lock"),
      JSON.stringify({ pid: 123, birth: "birth", nonce: "old" }),
    );
    const marker = { buildHash: "build", resetPause: null };
    const rejection = Object.assign(new Error("CAS lost"), {
      code: "STATE_CONFLICT",
    });
    const rejecting = {
      dir,
      call: async (action: string) => {
        calls.push(action);
        throw rejection;
      },
    };
    await assert.rejects(
      api.stopBroker(rejecting, marker, {
        buildHash: "build",
        control: { instanceId: "old", generation: 1 },
      }),
      (error: unknown) => error === rejection,
    );
    assert.equal(
      marker.resetPause,
      null,
      "A rejected pause must not manufacture a reset-owned receipt",
    );
  }
});

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import type { PhasedWorkerOptions } from "../packages/node-adapters/src/execution/phased-workers";

const load = createRequire(path.join(process.cwd(), "tests/lifecycle.test.js"));
const { PhasedWorkers } = load(
  "../packages/node-adapters/dist/execution/phased-workers",
) as typeof import("../packages/node-adapters/src/execution/phased-workers");
type Workers = InstanceType<typeof PhasedWorkers>;
type Record = Workers["workers"] extends Map<string, infer R> ? R : never;
const { QueueState } = load("../src/queue-state.js") as {
  QueueState: new (directory: string) => PhasedWorkerOptions["state"] & {
    file: string;
    submit(request: unknown): Record["job"];
  };
};

test("real broker, worker and heartbeat drain late local preparation without SDK", () => {
  const result = spawnSync(
    process.execPath,
    ["tests/fixtures/phased-lifecycle-broker.cjs"],
    {
      encoding: "utf8",
      timeout: 12000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS real broker/);
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("worker lifecycle deadlock")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function fixture(t: TestContext, overrides: Partial<PhasedWorkerOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phased-lifecycle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new QueueState(dir);
  const request = {
    requestId: "accepted-request",
    clientId: "owner",
    kind: "command",
    phased: true,
    cwd: dir,
    argv: ["run", "fixture.py"],
    timeoutMs: 5000,
  };
  const job = state.submit(request);
  const faults: unknown[] = [];
  let spawns = 0;
  const options: PhasedWorkerOptions = {
    preparationConcurrency: 1,
    dir,
    state,
    cfg: {},
    codeHash: "fixture",
    properties: () => ({}),
    prepareRequest: (job) => job.request,
    onUnknown: () => assert.fail("unsent work must not become SDK UNKNOWN"),
    onFault: (error) => {
      faults.push(error);
    },
    entrypoint: "unused",
    spawnWorker: () => {
      spawns++;
      throw new Error("unexpected spawn");
    },
    durable: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
    readResult: () => null,
    processBirth: () => "unused",
    workflowNonterminal: () => false,
    responsePath: (_dir, job, name) => path.join(dir, "jobs", job.id, name),
    ...overrides,
  };
  const workers = new PhasedWorkers(options);
  return { dir, state, job, options, workers, faults, spawns: () => spawns };
}

test("close rejects a pending local preparation before a late checker can queue an SDK turn", async (t) => {
  const entered = barrier(),
    release = barrier(),
    closed = barrier();
  let turns = 0;
  const f = fixture(t, {
    async checkSdkRequest() {
      entered.resolve();
      await release.promise;
    },
  });
  fs.mkdirSync(path.join(f.dir, "jobs", f.job.id), { recursive: true });
  const ready = f.options.state.readyTurn.bind(f.options.state);
  f.options.state.readyTurn = (id) => {
    turns++;
    return ready(id);
  };
  const record: Record = {
    job: f.job,
    token: "token",
    pending: null,
    localRemaining: 5000,
    localStarted: performance.now(),
    timer: null,
    closed: closed.promise,
    resolveClosed: closed.resolve,
  };
  f.workers.workers.set(f.job.id, record);
  t.after(() => clearTimeout(record.timer ?? undefined));
  const pending = f.workers.enqueue({
    jobId: f.job.id,
    workerToken: "token",
    method: "callTool",
    args: [],
  });
  // Rejection models the worker receiving the IPC error and exiting.
  const exited = pending.catch((error: unknown) => {
    f.workers.finish(record, 1, path.join(f.dir, "jobs", f.job.id));
    closed.resolve();
    throw error;
  });
  const rejected = assert.rejects(exited, {
    code: "BROKER_STOPPING",
    notStarted: true,
  });
  await entered.promise;
  const closing = f.workers.close();
  release.resolve();
  await bounded(closing);
  await rejected;
  assert.equal(turns, 0);
  assert.equal(record.pending, null);
  assert.equal(f.workers.workers.size, 0);
  assert.equal(f.state.status(f.job.id).code, "BROKER_STOPPING");
});

for (const mode of ["durable-request", "stderr-open"] as const) {
  test(`startup ${mode} failure releases slot, closed and stdout without losing admission`, async (t) => {
    const f = fixture(t);
    const directory = path.join(f.dir, "jobs", f.job.id);
    fs.mkdirSync(directory, { recursive: true });
    // A directory at stderr's path forces real openSync to fail after stdout.
    if (mode === "stderr-open")
      fs.mkdirSync(path.join(directory, "stderr.txt"));
    if (mode === "durable-request") {
      const durable = f.options.durable;
      f.options.durable = (file, value, exclusive) => {
        durable(file, value, exclusive);
        if (file.endsWith("/request.json"))
          throw Object.assign(new Error("ambiguous fsync failure"), {
            code: "EIO",
          });
      };
    }
    const before = new Set(fs.readdirSync("/proc/self/fd"));
    let record: Record | undefined;
    const set = f.workers.workers.set.bind(f.workers.workers);
    f.workers.workers.set = (id, value) => {
      record = value;
      return set(id, value);
    };
    assert.doesNotThrow(() => f.workers.start(f.job));
    assert.ok(record);
    await bounded(record.closed);
    await bounded(f.workers.close());
    assert.equal(f.spawns(), 0);
    assert.equal(f.workers.workers.size, 0);
    assert.equal(f.workers.backlog.size, 0);
    assert.deepEqual(new Set(fs.readdirSync("/proc/self/fd")), before);
    assert.equal(f.state.status(f.job.id).state, "failed");
    const persisted = JSON.parse(fs.readFileSync(f.state.file, "utf8")) as {
      jobs: { [id: string]: { requestId: string; state: string } };
    };
    assert.equal(persisted.jobs[f.job.id]?.requestId, "accepted-request");
    assert.equal(persisted.jobs[f.job.id]?.state, "failed");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, "request.json"), "utf8"))
        .id,
      f.job.id,
    );
    assert.equal(
      fs.existsSync(path.join(directory, "worker-start.json")),
      false,
    );
    assert.equal(f.faults.length, mode === "durable-request" ? 1 : 0);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(directory, "outcome.json"), "utf8"))
        .executionOutcome,
      "not_started",
    );
  });
}

test("uncertain request and outcome writes retain admission and evidence while reporting a storage fault", async (t) => {
  const f = fixture(t);
  const durable = f.options.durable;
  f.options.durable = (file, value, exclusive) => {
    durable(file, value, exclusive);
    throw Object.assign(new Error("fsync outcome unknown"), { code: "EIO" });
  };
  let record: Record | undefined;
  const set = f.workers.workers.set.bind(f.workers.workers);
  f.workers.workers.set = (id, value) => {
    record = value;
    return set(id, value);
  };
  f.workers.start(f.job);
  assert.ok(record);
  await bounded(record.closed);
  await bounded(f.workers.close());
  assert.equal(f.workers.workers.size, 0);
  assert.equal(f.spawns(), 0);
  assert.equal(f.faults.length, 2);
  // No false terminal commit after a failed outcome fsync.
  assert.equal(f.state.status(f.job.id).state, "preparing");
  assert.equal(f.state.status(f.job.id).requestId, "accepted-request");
  const directory = path.join(f.dir, "jobs", f.job.id);
  for (const name of ["request.json", "outcome.json"])
    assert.ok(fs.statSync(path.join(directory, name)).size > 0);
});

test("close never rejects or arms a timeout for an already sent SDK turn", async (t) => {
  const f = fixture(t);
  const closed = barrier();
  let rejected = 0;
  const record: Record = {
    job: f.job,
    token: "token",
    pending: {
      message: {
        jobId: f.job.id,
        workerToken: "token",
        method: "callTool",
        args: [],
      },
      resolve() {},
      reject() {
        rejected++;
      },
    },
    localRemaining: 1,
    localStarted: performance.now(),
    timer: null,
    closed: closed.promise,
    resolveClosed: closed.resolve,
  };
  f.options.state.status = () => ({ ...f.job, state: "running" });
  f.workers.workers.set(f.job.id, record);
  let finished = false;
  const closing = f.workers.close().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finished, false);
  assert.equal(rejected, 0);
  assert.equal(record.timer, null);
  assert.ok(record.pending);
  f.workers.workers.delete(f.job.id);
  closed.resolve();
  await bounded(closing);
});

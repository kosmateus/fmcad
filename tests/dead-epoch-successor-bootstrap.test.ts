import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess, { type SpawnOptions } from "node:child_process";
import type { Process } from "../src/composition/queue-epoch-successor-types";
import os from "node:os";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type { DeadEpochFixture } from "./fixtures/epoch-fixture-types";
const repository = process.cwd();
const load = createRequire(
  path.join(repository, "tests", "dead-epoch-successor-bootstrap.test.js"),
);

const api = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { reference } = load(
  "../src/queue-epoch-lineage",
) as typeof import("../src/queue-epoch-lineage");
// Only explicitly synthetic metadata workers receive the offline path adapter.
// Keep this scoped through launch: compiled imports read the live spawn property.

const physicalSpawn = childProcess.spawn;
test.beforeEach((context) => {
  const t = context as TestContext;
  t.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
  t.mock.method(
    childProcess,
    "spawn",
    (executable: string, args: readonly string[], options: SpawnOptions) => {
      assert.equal(path.basename(args[0]!), "queue-epoch-successor-worker.js");
      return physicalSpawn(
        executable,
        ["--require", load.resolve("./fixtures/fake-wsl-preload.cjs"), ...args],
        options,
      );
    },
  );
});
const { bootstrapSuccessor, inspectSuccessor } = load(
  "../src/queue-epoch-successor",
) as typeof import("../src/composition/queue-epoch-successor");

function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "successor-bootstrap-"));
  const keys = [
    "HOME",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
  ];
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  for (const key of keys) process.env[key] = path.join(base, key.toLowerCase());
  let worker: Process | undefined, workerRoot: string | undefined;
  t.after(async () => {
    try {
      if (worker && api.priorProcessAlive(worker) === true) {
        // Only our synthetic metadata-only worker, never a live Fusion broker.
        assert.equal(
          fs.realpathSync("/proc/" + worker.pid + "/cwd"),
          workerRoot,
        );
        process.kill(worker.pid, "SIGKILL");
        const end = Date.now() + 5000;
        while (api.priorProcessAlive(worker) === true && Date.now() < end)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(api.priorProcessAlive(worker), false);
      }
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  const stateRoot = path.join(process.env["XDG_STATE_HOME"]!, "fmcad");
  fs.mkdirSync(stateRoot, { recursive: true });
  const f = (
    load("./fixtures/dead-epoch-successor.cjs") as (
      base: string,
      root: string,
      options?: { oldProcessAlive?: boolean; inFlight?: boolean },
    ) => DeadEpochFixture
  )(stateRoot, repository, { inFlight: true });
  fs.rmSync(path.join(f.audit, "isolated-scratch-qualification"), {
    recursive: true,
    force: true,
  }); // Prospective synthetic proof only.
  fs.unlinkSync(f.authorityEntry.path); // Bootstrap must itself authenticate and publish authority.
  api.durable(
    path.join(f.dir, "broker-lifecycle-" + f.previousOwner.nonce + ".json"),
    f.inspection.previousLifecycle,
    true,
  );
  const approvalFile = path.join(base, "approval.json");
  api.durable(approvalFile, f.approval, true);
  const client = {
    dir: f.dir,
    auth: { clientId: f.clientId, clientToken: f.token },
  };
  return {
    ...f,
    client,
    approvalFile,
    setWorker: (value: Process) => {
      worker = value;
      workerRoot = f.dir;
    },
  };
}

test("FAKE host/process metadata: a released normal epoch keeps authenticated dead-successor startup metadata-only", async (t) => {
  const f = fixture(t);
  const { openIsolatedEpoch } = load(
    "../src/queue-isolated-epoch",
  ) as typeof import("../src/queue-isolated-epoch");
  const state = openIsolatedEpoch(f.dir, { recover: false });
  state.finish(f.priorJob.id, {
    state: "failed",
    code: "MODULE_NOT_FOUND",
    executionOutcome: "not_started",
    mayHaveMutated: false,
    sdkSettled: true,
  });
  state.pause(true, "synthetic-normal-cold-stop");
  const pointer = state.epoch;
  assert.ok(pointer);
  pointer.restoreActiveCreationId = null;
  const pointerFile = path.join(f.dir, "isolated-admission-epoch.json");
  api.durable(pointerFile, pointer);
  const closed = (
    load(
      "./fixtures/closed-scratch-artifacts.cjs",
    ) as typeof import("./fixtures/closed-scratch-artifacts.cjs")
  )(f.dir, pointer, repository, "normal-multidocument");
  // Replace only the prospective archive from this newly created synthetic fixture.
  fs.unlinkSync(path.join(f.audit, "predecessor-pointer.json"));
  f.approval.pointerHash = api.hash(fs.readFileSync(pointerFile));
  f.approval.stateHash = reference(
    path.join(pointer.root, "queue-state.json"),
  ).sha256;
  api.durable(f.approvalFile, f.approval);
  const protectedFiles = [
    pointerFile,
    path.join(pointer.root, "queue-state.json"),
    path.join(pointer.root, "instance.json"),
    closed.path,
    path.join(f.dir, "queue-state.json"),
  ];
  const before = protectedFiles.map((file) => fs.readFileSync(file));
  const complete = await bootstrapSuccessor(f.client, f.cfg, {
    approval: f.approvalFile,
    requestId: f.requestId,
    confirmOwnership: true,
  });
  assert.ok("owner" in complete);
  f.setWorker(complete.owner);
  assert.equal(complete.kind, "dead-epoch-successor-metadata-ready");
  assert.equal(complete.sdkRequestsSent, 0);
  for (const [index, file] of protectedFiles.entries())
    assert.deepEqual(fs.readFileSync(file), before[index]);
  const lifecycle = api.readJson(
    path.join(f.dir, "broker-lifecycle-" + complete.owner.nonce + ".json"),
  );
  assert.ok(lifecycle && typeof lifecycle === "object");
  assert.equal(
    "receipt" in lifecycle && fs.existsSync(String(lifecycle.receipt)),
    false,
  );
});

test(
  "FAKE host/process metadata: preflight is file-only; startup creates one metadata worker and retains all original epochs",
  {},
  async (t) => {
    const f = fixture(t);
    const protectedFiles = [
      path.join(f.dir, "isolated-admission-epoch.json"),
      f.authority.predecessor.state.path,
      f.authority.predecessor.identity.path,
      f.authority.predecessor.rootState.path,
      f.authority.predecessor.rootIdentity.path,
      path.join(f.dir, "clients.json"),
    ];
    const before = protectedFiles.map((file) =>
      api.hash(fs.readFileSync(file)),
    );
    const preflight = await bootstrapSuccessor(f.client, f.cfg, {
      approval: f.approvalFile,
      requestId: f.requestId,
      preflight: true,
    });
    assert.ok("ready" in preflight);
    assert.equal(preflight.ready, true);
    assert.equal(preflight.sdkRequestsSent, 0);
    assert.equal(fs.existsSync(path.join(f.audit, "intent.json")), false);
    const complete = await bootstrapSuccessor(f.client, f.cfg, {
      approval: f.approvalFile,
      requestId: f.requestId,
      confirmOwnership: true,
    }).catch((error) => {
      const stderr = path.join(f.audit, "worker.stderr.log");
      const detail = fs.existsSync(stderr)
        ? fs.readFileSync(stderr, "utf8").slice(-4000)
        : "No worker stderr";
      throw new Error(error.message + ": " + detail);
    });
    assert.ok("owner" in complete);
    f.setWorker(complete.owner);
    assert.equal(complete.kind, "dead-epoch-successor-metadata-ready");
    assert.equal(complete.sdkRequestsSent, 0);
    assert.equal(api.priorProcessAlive(complete.owner), true);
    assert.equal(fs.existsSync(path.join(f.dir, "recovery.lock")), false);
    assert.equal(
      fs.existsSync(path.join(f.dir, "atomic-migration.lock")),
      false,
    );
    const request = (
      load(
        "../src/queue-connection",
      ) as typeof import("../src/entrypoints/queue-connection")
    ).request;
    await request(f.dir, {
      action: "register",
      clientId: f.clientId,
      clientToken: f.token,
    });
    const call = (action: string, rest: Record<string, unknown> = {}) =>
      request(f.dir, { action, auth: f.client.auth, ...rest });
    const status = (await call("queue-summary")) as {
      features: { deadEpochSuccessor: boolean };
      deadEpochSuccessor: { predecessorEpochId: string };
      isolatedScratchScope: { admission: string };
      held: string;
      buildHash: string;
      control: { instanceId: string; generation: number; contextEpoch: number };
    };
    assert.equal(status.features.deadEpochSuccessor, true);
    assert.equal(
      status.deadEpochSuccessor.predecessorEpochId,
      f.authority.predecessor.epochId,
    );
    assert.equal(
      status.isolatedScratchScope.admission,
      "blocked-process-unavailable",
    );
    assert.match(status.held, /metadata only/);
    await assert.rejects(call("submit", { request: {} }), {
      code: "EPOCH_PROCESS_UNAVAILABLE",
    });
    await assert.rejects(call("resume"), { code: "EPOCH_PROCESS_UNAVAILABLE" });
    await assert.rejects(
      call("create-isolated-scratch", {
        jobId: f.pointer.quarantinedJobIds[0],
        observationJobId: f.pointer.quarantinedJobIds[1],
        requestId: f.requestId + ":create",
        control: {
          buildHash: status.buildHash,
          instanceId: status.control.instanceId,
          generation: status.control.generation,
          contextEpoch: status.control.contextEpoch,
        },
      }),
      { code: "EPOCH_AUDIT_REQUIRED" },
    );
    assert.equal(
      fs.existsSync(
        path.join(f.audit, "dead-epoch-current-observation/start.json"),
      ),
      false,
    );
    const duplicate = await bootstrapSuccessor(f.client, f.cfg, {
      approval: f.approvalFile,
      requestId: f.requestId,
      confirmOwnership: true,
    });
    assert.deepEqual(duplicate, complete);
    assert.deepEqual(
      protectedFiles.map((file) => api.hash(fs.readFileSync(file))),
      before,
    );
  },
);

test("FAKE host/process metadata: foreign recovery guard and an unconsumed successor refuse a new bootstrap", (t) => {
  const f = fixture(t);
  api.durable(
    path.join(f.dir, "recovery.lock"),
    { kind: "foreign", nonce: "other" },
    true,
  );
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, f.approvalFile, f.requestId),
    { code: "EPOCH_SUCCESSOR_BUSY" },
  );
  fs.unlinkSync(path.join(f.dir, "recovery.lock")); // Synthetic fixture only.
  api.durable(
    path.join(f.dir, "active-epoch-succession.json"),
    {
      version: 1,
      authority: {
        path: path.join(
          f.dir,
          "epoch-successions",
          "f".repeat(64),
          "authority.json",
        ),
        sha256: "a".repeat(64),
      },
    },
    true,
  );
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, f.approvalFile, f.requestId),
    { code: "EPOCH_SUCCESSOR_PENDING" },
  );
});

test("FAKE host/process metadata: a preserved launch intent is observed without spawning again", async (t) => {
  const f = fixture(t);
  const snapshot = (
    load(
      "../src/queue-epoch-lineage",
    ) as typeof import("../src/queue-epoch-lineage")
  ).predecessorSnapshot(f.dir, f.audit, true);
  api.durable(
    f.authorityEntry.path,
    { ...f.authority, predecessor: snapshot },
    true,
  );
  const authority = reference(f.authorityEntry.path);
  api.durable(
    path.join(f.audit, "intent.json"),
    {
      version: 1,
      requestId: f.requestId,
      clientId: f.clientId,
      ownerTokenHash: api.hash(f.token),
      nonce: f.nonce,
      approval: reference(f.approvalFile),
      previousOwner: f.previousOwner,
    },
    true,
  );
  api.durable(
    path.join(f.audit, "launch-intent.json"),
    { nonce: f.nonce, authority },
    true,
  );
  const now = Date.now;
  let elapsed = 0;
  Date.now = () => now() + (elapsed += 120000); // Avoid waiting for an intentionally absent fake worker.
  try {
    const result = await bootstrapSuccessor(f.client, f.cfg, {
      approval: f.approvalFile,
      requestId: f.requestId,
      confirmOwnership: true,
    });
    assert.ok("state" in result);
    assert.equal(result.state, "pending");
    assert.equal(result.noReplay, true);
  } finally {
    Date.now = now;
  }
  assert.equal(fs.existsSync(path.join(f.audit, "worker-claim.json")), false);
  assert.equal(fs.existsSync(path.join(f.audit, "worker.stdout.log")), false);
});

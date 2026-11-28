import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(path.join(process.cwd(), "package.json"));
const history = load(
  "./packages/node-adapters/dist/persistence/project-history/sqlite",
) as typeof import("../packages/node-adapters/src/persistence/project-history/sqlite");
const registryApi = load(
  "./packages/node-adapters/dist/persistence/project-history/registry",
) as typeof import("../packages/node-adapters/src/persistence/project-history/registry");
const activity = load(
  "./packages/node-adapters/dist/control-center/project-activity",
) as typeof import("../packages/node-adapters/src/control-center/project-activity");
const revisions = load(
  "./packages/node-adapters/dist/control-center/revisions",
) as typeof import("../packages/node-adapters/src/control-center/revisions");
const identity = load(
  "./packages/node-adapters/dist/telemetry/client-presence",
) as typeof import("../packages/node-adapters/src/telemetry/client-presence");
const actions = load(
  "./packages/control-center/dist/server/project-actions",
) as typeof import("../packages/control-center/src/server/project-actions");
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-fresh-activity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    queue = path.join(root, "queue"),
    openCode = path.join(root, "presence");
  for (const directory of [project, queue, openCode]) fs.mkdirSync(directory);
  const registry = registryApi.openProjectRegistry({
    filePath: path.join(root, "registry.json"),
  });
  const store = history.registerProjectHistoryStore(registry, {
    projectId: "project",
    projectRoot: project,
  });
  t.after(() => store.close());
  const owner = {
    ...identity.currentProcessIdentity(process.pid),
    nonce: "activity-owner",
  };
  assert.equal(typeof owner.birth, "string");
  const saved = {
    version: 1,
    paused: false,
    revision: 0,
    epoch: 0,
    blocked: null,
    active: null,
    lease: null,
    jobs: {},
  };
  const control = {
    protocol: 1,
    instanceId: owner.nonce,
    generation: 0,
    contextEpoch: 0,
    buildHash: "a".repeat(64),
    gateClosed: false,
    owner,
    activeOperations: 0,
    activeIds: [],
    held: false,
    unresolved: false,
    phase: "RUNNING",
    at: 1,
    projectActivityFence: {
      version: 1,
      queueAdmission: "project-history",
      registryPath: registry.readonlyPath,
    },
  };
  const write = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(queue, name), JSON.stringify(data));
  write("broker.lock", owner);
  write("queue-state.json", saved);
  write("console-state.json", control);
  const reader = activity.createProjectActivityReader({
    registry,
    queueDirectory: queue,
    openCodePresenceDirectory: openCode,
    projectRevision: revisions.consoleProjectRevision,
  });
  const read = () =>
    store.withActivityFence((fence) =>
      reader("project", { snapshot: fence.snapshot(), history: store }),
    );
  const archive = () => {
    const handler = actions.createProjectActions({
      registry,
      openHistory: (entry) =>
        history.openRegisteredProjectHistoryStore(registry, {
          projectId: entry.projectId,
          projectRoot: entry.path,
        }),
      readFreshState: reader,
      projectRevision: revisions.consoleProjectRevision,
      publishProjectChange: () => {},
      authorizeProjectWrite: () => true,
    });
    return handler.execute(
      { subject: "owner", projectIds: ["project"], globalRead: true },
      {
        version: 1,
        action: "archive",
        projectId: "project",
        expectedRevision: revisions.consoleProjectRevision(store.snapshot()),
      },
    );
  };
  const proof = {
    version: 1,
    projectId: "project",
    databaseId: store.databaseId,
    projectRoot: project,
  };
  const client = (extra: Record<string, unknown> = {}) => {
    const dir = path.join(project, ".cad", "telemetry", "clients");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "a".repeat(64) + ".json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        project,
        instanceId: "client",
        ...owner,
        activityFence: proof,
        closed: false,
        observedAt: 1,
        ...extra,
      }),
    );
    return file;
  };
  return {
    root,
    project,
    queue,
    openCode,
    registry,
    store,
    owner,
    saved,
    control,
    write,
    read,
    archive,
    proof,
    client,
  };
}
test("fresh fenced observation archives an idle live broker and atomically updates both lifecycles", (t) => {
  const f = fixture(t);
  const state = f.read();
  assert.equal(state.queue.state, "idle");
  assert.equal(state.activityFence.presenceWriters, "project-history");
  assert.equal(
    state.sources.queue.observedAtMs,
    state.capturedAtMs,
    "old event-driven diagnostics do not masquerade as a heartbeat; current fenced read has its own time",
  );
  const result = f.archive();
  assert.equal(result.state, "ok", JSON.stringify(result));
  assert.equal(f.registry.lookup("project")!.monitoring, false);
  assert.equal(f.store.snapshot().lifecycle.monitoring, false);
});
test("archive rejects live and unknown presence, accepts only fenced closed or confirmed dead writers", (t) => {
  const f = fixture(t);
  f.client();
  assert.equal(f.archive().state, "blocked");
  f.client({ closed: true, activityFence: null });
  assert.equal(
    f.archive().state,
    "unavailable",
    "a closed legacy process may publish again without the fence",
  );
  f.client({ closed: true, birth: null });
  assert.equal(
    f.archive().state,
    "blocked",
    "a closed marker cannot replace missing process identity",
  );
  f.client({ closed: true });
  assert.equal(
    f.archive().state,
    "ok",
    "the fenced writer closed permanently before the lifecycle CAS",
  );
});
test("unknown identity, foreign database proof and symlinked presence never qualify archival", (t) => {
  const f = fixture(t);
  const file = f.client({ birth: null });
  assert.equal(f.archive().state, "blocked");
  f.client({ activityFence: { ...f.proof, databaseId: "foreign" } });
  assert.equal(f.archive().state, "unavailable");
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(f.queue, "console-state.json"), file);
  assert.throws(f.read);
  assert.equal(f.archive().state, "unavailable");
  assert.equal(f.store.snapshot().lifecycle.monitoring, true);
});
test("archival refuses mismatched broker ownership, capability, incomplete and unresolved durable state", (t) => {
  const f = fixture(t);
  for (const patch of [
    { owner: { ...f.owner, nonce: "other" } },
    { owner: { ...f.owner, birth: "other" } },
    {
      projectActivityFence: {
        ...f.control.projectActivityFence,
        registryPath: "/other",
      },
    },
    { instanceId: "other" },
    { buildHash: "unknown" },
    { contextEpoch: 1 },
    { generation: "0" },
    { activeOperations: 1, activeIds: [] },
  ]) {
    f.write("console-state.json", { ...f.control, ...patch });
    assert.equal(f.archive().state, "unavailable", JSON.stringify(patch));
  }
  f.write("console-state.json", f.control);
  for (const marker of [
    "queue-state.pending.json",
    "isolated-admission-epoch.json",
    "active-epoch-succession.json",
  ]) {
    f.write(marker, f.saved);
    assert.equal(f.archive().state, "unavailable", marker);
    fs.unlinkSync(path.join(f.queue, marker));
  }
  for (const patch of [
    { active: "unknown" },
    { localUnknown: { id: "unknown" } },
    { lease: { id: "lease" } },
    {
      jobs: {
        uncertain: {
          id: "uncertain",
          state: "needs_reconciliation",
          request: { cwd: f.project },
        },
      },
    },
  ]) {
    f.write("queue-state.json", { ...f.saved, ...patch });
    assert.equal(f.archive().state, "blocked", JSON.stringify(patch));
  }
  assert.equal(f.registry.lookup("project")!.monitoring, true);
});
test("canonical OpenCode project routing and legacy direct processes participate in the archive guard", (t) => {
  const f = fixture(t),
    child = path.join(f.project, "nested");
  fs.mkdirSync(child);
  const file = path.join(f.openCode, "1-abcdef.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      ...f.owner,
      activityFences: [f.proof],
      sessions: [
        {
          id: "session",
          project: "display-only",
          projectDirectory: child,
          status: "ended",
        },
      ],
    }),
  );
  assert.equal(
    f.archive().state,
    "blocked",
    "a live ended UI session does not terminate its presence writer",
  );
  fs.unlinkSync(file);
  const direct = path.join(f.project, ".cad", "telemetry", "direct");
  fs.mkdirSync(direct, { recursive: true });
  fs.writeFileSync(
    path.join(direct, "legacy.json"),
    JSON.stringify({
      version: 1,
      id: "direct",
      project: f.project,
      ...f.owner,
      operations: [],
    }),
  );
  assert.equal(f.archive().state, "unavailable");
});
test("freshness is checked after the synchronous observation rather than before it", (t) => {
  const f = fixture(t);
  let now = Date.now();
  const handler = actions.createProjectActions({
    registry: f.registry,
    openHistory: (entry) =>
      history.openRegisteredProjectHistoryStore(f.registry, {
        projectId: entry.projectId,
        projectRoot: entry.path,
      }),
    readFreshState: (id, context) => {
      const value = activity.createProjectActivityReader({
        registry: f.registry,
        queueDirectory: f.queue,
        openCodePresenceDirectory: f.openCode,
        projectRevision: revisions.consoleProjectRevision,
      })(id, context);
      now += 16000;
      return value;
    },
    projectRevision: revisions.consoleProjectRevision,
    publishProjectChange: () => {},
    authorizeProjectWrite: () => true,
    now: () => now,
  });
  const result = handler.execute(
    { subject: "owner", projectIds: ["project"], globalRead: true },
    {
      version: 1,
      action: "archive",
      projectId: "project",
      expectedRevision: revisions.consoleProjectRevision(f.store.snapshot()),
    },
  );
  assert.equal(result.state, "stale");
  assert.equal(f.store.snapshot().lifecycle.monitoring, true);
});

test(
  "archive and competing admission processes fail closed without deadlock or replay",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    const children: ChildProcess[] = [];
    t.after(() => {
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGKILL");
    });
    const run = (label: string) => {
      const ready = path.join(f.root, label + ".ready");
      const effect = path.join(f.root, label + ".effect");
      const result = path.join(f.root, label + ".result");
      const child = spawn(
        process.execPath,
        [
          path.join(
            process.cwd(),
            "tests/fixtures/project-activity-competing.cjs",
          ),
          process.cwd(),
          f.registry.readonlyPath,
          f.project,
          ready,
          effect,
          result,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      children.push(child);
      const exited = once(child, "exit");
      return { child, exited, ready, effect, result };
    };
    let contender: ReturnType<typeof run> | undefined;
    const reader = activity.createProjectActivityReader({
      registry: f.registry,
      queueDirectory: f.queue,
      openCodePresenceDirectory: f.openCode,
      projectRevision: revisions.consoleProjectRevision,
    });
    const handler = actions.createProjectActions({
      registry: f.registry,
      openHistory: (entry) =>
        history.openRegisteredProjectHistoryStore(f.registry, {
          projectId: entry.projectId,
          projectRoot: entry.path,
        }),
      readFreshState: (id, context) => {
        if (!contender) {
          contender = run("competing");
          const deadline = Date.now() + 4000;
          const wait = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(contender.ready) && Date.now() < deadline)
            Atomics.wait(wait, 0, 0, 5);
          assert.equal(
            fs.existsSync(contender.ready),
            true,
            "the child owns the actual registration fence before requesting SQLite",
          );
          assert.equal(
            fs.existsSync(contender.effect),
            false,
            "no admission effect escapes the held archive fence",
          );
        }
        return reader(id, context);
      },
      projectRevision: revisions.consoleProjectRevision,
      publishProjectChange: () => {},
      authorizeProjectWrite: () => true,
    });
    const response = handler.execute(
      { subject: "owner", projectIds: ["project"], globalRead: true },
      {
        version: 1,
        action: "archive",
        projectId: "project",
        expectedRevision: revisions.consoleProjectRevision(f.store.snapshot()),
      },
    );
    assert.equal(response.state, "unavailable");
    assert.equal(
      response.code,
      "LIFECYCLE_UPDATE_INCOMPLETE",
      "the registry lock fails promptly instead of deadlocking against SQLite",
    );
    assert.ok(contender);
    assert.deepEqual(await contender.exited, [0, null]);
    assert.deepEqual(JSON.parse(fs.readFileSync(contender.result, "utf8")), {
      state: "admitted",
    });
    assert.equal(fs.readFileSync(contender.effect, "utf8"), "admitted");
    assert.equal(f.registry.lookup("project")!.monitoring, true);
    assert.equal(f.store.snapshot().lifecycle.monitoring, true);
    assert.equal(
      f.archive().state,
      "ok",
      "a new user archive decision can succeed after contention ends",
    );
    const after = run("after-archive");
    assert.deepEqual(await after.exited, [0, null]);
    assert.deepEqual(JSON.parse(fs.readFileSync(after.result, "utf8")), {
      state: "blocked",
      code: "PROJECT_ACTIVITY_BLOCKED",
    });
    assert.equal(
      fs.existsSync(after.effect),
      false,
      "a later admission cannot resurrect archived monitoring",
    );
  },
);

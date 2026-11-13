import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { ProjectActivityProof } from "../packages/node-adapters/src/persistence/project-history/activity";
const root = process.cwd(),
  load = createRequire(path.join(root, "package.json"));
const history = load(
  "./packages/node-adapters/dist/persistence/project-history/sqlite",
) as typeof import("../packages/node-adapters/src/persistence/project-history/sqlite");
const registries = load(
  "./packages/node-adapters/dist/persistence/project-history/registry",
) as typeof import("../packages/node-adapters/src/persistence/project-history/registry");
const activity = load(
  "./packages/node-adapters/dist/persistence/project-history/activity",
) as typeof import("../packages/node-adapters/src/persistence/project-history/activity");
function fixture(t: test.TestContext, useDefault = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-fence-"));
  const previous = process.env["XDG_DATA_HOME"];
  if (useDefault) process.env["XDG_DATA_HOME"] = path.join(dir, "user");
  t.after(() => {
    if (useDefault) {
      if (previous === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const registry = registries.openProjectRegistry(
    useDefault ? {} : { filePath: path.join(dir, "registry.json") },
  );
  const project = path.join(dir, "project");
  fs.mkdirSync(path.join(project, ".cad"), { recursive: true });
  const store = history.registerProjectHistoryStore(registry, {
    projectId: "owned",
    projectRoot: project,
  });
  t.after(() => store.close());
  return { dir, registry, project, store };
}
test("activity and archival share the actual SQLite writer transaction", (t) => {
  const f = fixture(t);
  const other = history.openRegisteredProjectHistoryStore(f.registry, {
    projectId: "owned",
    projectRoot: f.project,
    busyTimeoutMs: 0,
  });
  t.after(() => other.close());
  let effects = 0;
  activity.withProjectActivityFence(
    f.project,
    (proof) => {
      assert.deepEqual(proof, {
        version: 1,
        projectId: "owned",
        databaseId: f.store.databaseId,
        projectRoot: f.project,
      });
      assert.throws(
        () =>
          other.setLifecycle({
            monitoring: false,
            archivedAtMs: 1,
            updatedAtMs: 1,
          }),
        { code: "HISTORY_DB_BUSY" },
      );
      effects++;
    },
    { registry: f.registry },
  );
  assert.equal(effects, 1);
  other.setLifecycle({ monitoring: false, archivedAtMs: 1, updatedAtMs: 1 });
  assert.throws(
    () =>
      activity.withProjectActivityFence(
        f.project,
        () => {
          effects++;
        },
        { registry: f.registry },
      ),
    { code: "PROJECT_ACTIVITY_BLOCKED", notStarted: true },
  );
  assert.equal(effects, 1);
  activity.withProjectActivityFence(
    f.project,
    () => {
      effects++;
    },
    { registry: f.registry, closingPresence: true },
  );
  assert.equal(
    effects,
    2,
    "only closing a presence record can finish after archival",
  );
});
test("enrollment cannot race the legacy path or swap a registered database", (t) => {
  const f = fixture(t),
    unregistered = path.join(f.dir, "new");
  fs.mkdirSync(unregistered);
  activity.withProjectActivityFence(
    unregistered,
    (proof) => {
      assert.equal(proof, null);
      assert.throws(
        () =>
          f.registry.register({
            projectId: "racing",
            projectPath: unregistered,
            databaseId: "synthetic",
            monitoring: true,
            archivedAtMs: null,
            nowMs: 1,
          }),
        { code: "REGISTRY_BUSY" },
      );
    },
    { registry: f.registry },
  );
  assert.equal(f.registry.lookup("racing"), null);
  fs.renameSync(
    history.projectHistoryDatabasePath(f.project),
    history.projectHistoryDatabasePath(f.project) + ".retained",
  );
  let effects = 0;
  assert.throws(() =>
    activity.withProjectActivityFence(
      f.project,
      () => {
        effects++;
      },
      { registry: f.registry },
    ),
  );
  assert.equal(effects, 0);
});
test("multiple project presence publication is all-or-nothing and rejects archived scope", (t) => {
  const f = fixture(t),
    second = path.join(f.dir, "second");
  fs.mkdirSync(second);
  const store = history.registerProjectHistoryStore(f.registry, {
    projectId: "second",
    projectRoot: second,
  });
  t.after(() => store.close());
  store.setLifecycle({ monitoring: false, archivedAtMs: 1, updatedAtMs: 1 });
  let effects = 0;
  assert.throws(
    () =>
      activity.withProjectActivitiesFence(
        [second, f.project],
        () => {
          effects++;
        },
        { registry: f.registry },
      ),
    { code: "PROJECT_ACTIVITY_BLOCKED" },
  );
  assert.equal(effects, 0);
  assert.equal(f.store.snapshot().lifecycle.monitoring, true);
});

test("registered heartbeat publication uses the canonical project even below a nested .cad directory", (t) => {
  const f = fixture(t, true);
  const nested = path.join(f.project, "nested");
  fs.mkdirSync(path.join(nested, ".cad"), { recursive: true });
  const core = load("./packages/core/dist") as typeof import("@fmcad/core");
  const presence = load(
    "./packages/node-adapters/dist/telemetry/client-presence",
  ) as typeof import("../packages/node-adapters/src/telemetry/client-presence");
  const adapter = presence.createClientPresenceAdapter(core);
  const handle = adapter.startClientPresence("nested-client", nested);
  try {
    assert.equal(
      path.dirname(handle.file),
      path.join(f.project, ".cad/telemetry/clients"),
    );
    const initial = fs.readFileSync(handle.file);
    const value = JSON.parse(initial.toString("utf8")) as {
      project: string;
      activityFence: ProjectActivityProof;
    };
    assert.equal(value.project, f.project);
    assert.deepEqual(value.activityFence, {
      version: 1,
      projectId: "owned",
      databaseId: f.store.databaseId,
      projectRoot: f.project,
    });
    f.store.setLifecycle({
      monitoring: false,
      archivedAtMs: 1,
      updatedAtMs: 1,
    });
    handle.publish();
    assert.deepEqual(
      fs.readFileSync(handle.file),
      initial,
      "archival cannot be undone by a heartbeat",
    );
    handle.dispose();
    assert.equal(
      (JSON.parse(fs.readFileSync(handle.file, "utf8")) as { closed: boolean })
        .closed,
      true,
    );
  } finally {
    handle.dispose();
  }
});
test("the production broker refuses new archived-project jobs and preserves original receipt lookup", async (t) => {
  const f = fixture(t, true),
    queue = path.join(f.dir, "queue");
  const brokerApi = load("./src/queue-broker") as {
    serve(
      config: unknown,
      options: unknown,
    ): Promise<{ close(): Promise<void>; status(): unknown }>;
  };
  const ipc = load("./src/queue-connection") as {
    request(dir: string, message: unknown): Promise<Record<string, unknown>>;
  };
  let calls = 0;
  const instance = {
    pid: 99,
    birth: "synthetic:99",
    version: "fixture",
    activeCommand: "SelectCommand",
    documents: [],
    documentState: { status: "metadata-only" },
  };
  const physical = {
    server: { timeoutMs: 1000 },
    _parse: JSON.parse,
    async _post(payload: { id: unknown }) {
      calls++;
      return {
        status: 200,
        raw: JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }),
      };
    },
    async callTool() {
      return {
        failed: false,
        text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
      };
    },
  };
  const broker = await brokerApi.serve(
    { backend: "addin", timeoutMs: 1000 },
    {
      dir: queue,
      confirmOwnership: true,
      createBackend: () => physical,
      nativePath: (file: string) => file,
      pollMs: 5,
    },
  );
  try {
    const auth = { clientId: "owner", clientToken: "token" };
    await ipc.request(queue, { action: "register", ...auth });
    const request = {
      kind: "rpc",
      requestId: "original",
      cwd: f.project,
      timeoutMs: 1000,
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    };
    const registryLock = f.registry.readonlyPath + ".lock";
    fs.writeFileSync(
      registryLock,
      JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }),
      { flag: "wx", mode: 0o600 },
    );
    const admitting = ipc
      .request(queue, { action: "submit", auth, request })
      .then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error: error as unknown }),
      );
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await ipc.request(queue, { action: "control-status", auth });
    assert.equal(
      calls,
      0,
      "A contended pre-admission fence must not dispatch SDK work",
    );
    assert.equal(
      fs.existsSync(registryLock),
      true,
      "The broker must not reclaim the writer lock",
    );
    fs.unlinkSync(registryLock);
    const admission = await admitting;
    if (admission.error) throw admission.error;
    const first = admission.value;
    assert.ok(first);
    let settled = false;
    for (let index = 0; index < 200; index++) {
      const result = await ipc.request(queue, {
        action: "result",
        auth,
        jobId: first["id"],
      });
      const job = result["job"];
      if (
        job &&
        typeof job === "object" &&
        "state" in job &&
        job.state === "succeeded"
      ) {
        settled = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settled, true);
    const { createProjectActivityReader } = load(
      "./packages/node-adapters/dist/control-center/project-activity",
    ) as typeof import("../packages/node-adapters/src/control-center/project-activity");
    const { consoleProjectRevision } = load(
      "./packages/node-adapters/dist/control-center/revisions",
    ) as typeof import("../packages/node-adapters/src/control-center/revisions");
    const { createProjectActions } = load(
      "./packages/control-center/dist/server/project-actions",
    ) as typeof import("../packages/control-center/src/server/project-actions");
    const readFreshState = createProjectActivityReader({
      registry: f.registry,
      queueDirectory: queue,
      openCodePresenceDirectory: path.join(f.dir, "presence"),
      projectRevision: consoleProjectRevision,
    });
    f.store.withActivityFence((fence) =>
      readFreshState("owned", {
        snapshot: fence.snapshot(),
        history: f.store,
      }),
    );
    const archive = createProjectActions({
      registry: f.registry,
      openHistory: (entry) =>
        history.openRegisteredProjectHistoryStore(f.registry, {
          projectId: entry.projectId,
          projectRoot: entry.path,
        }),
      readFreshState,
      projectRevision: consoleProjectRevision,
      publishProjectChange: () => {},
      authorizeProjectWrite: (principal, projectId) =>
        principal.projectIds.includes(projectId),
    });
    const archived = archive.execute(
      { subject: "owner", projectIds: ["owned"], globalRead: true },
      {
        version: 1,
        action: "archive",
        projectId: "owned",
        expectedRevision: consoleProjectRevision(f.store.snapshot()),
      },
    );
    assert.equal(archived.state, "ok", JSON.stringify(archived));
    assert.equal(f.registry.lookup("owned")!.monitoring, false);
    assert.equal(f.store.snapshot().lifecycle.monitoring, false);
    const before = calls;
    const observed = await ipc.request(queue, {
      action: "submit",
      auth,
      request,
    });
    assert.equal(observed["id"], first["id"]);
    await assert.rejects(
      ipc.request(queue, {
        action: "submit",
        auth,
        request: { ...request, requestId: "forbidden-new" },
      }),
      { code: "PROJECT_ACTIVITY_BLOCKED" },
    );
    assert.equal(
      calls,
      before,
      "no repeated or newly rejected physical operation",
    );
  } finally {
    await broker.close();
  }
});

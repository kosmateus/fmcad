"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../packages/core/dist/index.js");
const {
  CONSOLE_QUERY_CONTRACT_VERSION,
} = require("../packages/control-center/dist/contracts/index.js");
const {
  createConsoleQueryApi,
} = require("../packages/control-center/dist/server/query-api.js");
const {
  createConsoleQueryNodeAdapter,
} = require("../packages/node-adapters/dist/control-center/read-port.js");
const {
  describeOwnedResult,
} = require("../packages/node-adapters/dist/persistence/owned-results.js");
const {
  openRegisteredProjectHistoryStore,
  openProjectRegistry,
  registerProjectHistoryStore,
} = require("../packages/node-adapters/dist/persistence/project-history/index.js");
const {
  retainAdmission,
} = require("../packages/node-adapters/dist/persistence/accepted-inputs.js");
const {
  createProjectHistoryTelemetryRuntime,
} = require("../packages/node-adapters/dist/persistence/project-history/telemetry-runtime.js");

const READ_AT = 1_800_000_000_000;

function emptyTelemetry(request, projectIds) {
  const projectId =
    request.scope.kind === "project" ? request.scope.projectId : null;
  const sourceId = `queue-read:${projectId ?? "global"}`;
  return core.collectConsoleTelemetry({
    projectId,
    sourceId,
    readAtMs: READ_AT,
    jobs: [],
    jobsComplete: true,
    jobsScope: projectId ? "project" : "broker",
    registeredProjectIds: projectIds,
    registeredProjectsComplete: true,
    jobSource: {
      sourceId,
      epoch: "queue-read-epoch",
      sequence: 1,
      revision: null,
      observedAtMs: READ_AT,
      transport: null,
      freshness: "available",
    },
    presenceSources: null,
    presenceComplete: { clients: "missing", openCode: "missing" },
    timingSamples: [],
    timingAvailability: "available",
    timingWindowMs: 60_000,
    timingScope: projectId ? "project" : "broker",
    executions: [],
    executionsAvailability: "available",
  });
}

function fixture(t, projectNames = ["project-one"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-history-runtime-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const queueDirectory = path.join(root, "queue");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.mkdirSync(queueDirectory, { recursive: true, mode: 0o700 });
  const projects = new Map(
    projectNames.map((projectId, index) => [
      projectId,
      path.join(root, "projects", String(index + 1)),
    ]),
  );
  for (const projectRoot of projects.values())
    fs.mkdirSync(path.join(projectRoot, ".cad"), {
      recursive: true,
      mode: 0o700,
    });
  const registry = openProjectRegistry({
    filePath: path.join(data, "projects.json"),
    now: () => READ_AT,
  });
  for (const [projectId, projectRoot] of projects) {
    const store = registerProjectHistoryStore(registry, {
      projectId,
      projectRoot,
      initialMonitoring: true,
      now: () => READ_AT,
    });
    store.close();
  }

  const nodes = [];
  const createNode = () => {
    const node = createConsoleQueryNodeAdapter({
      registry,
      telemetry: {
        read: (request) => emptyTelemetry(request, [...projects.keys()]),
      },
      queueDirectory,
    });
    nodes.push(node);
    return node;
  };
  const node = createNode();
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close().catch(() => {});
    for (const instance of nodes) instance.close();
    registry.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    data,
    queueDirectory,
    projects,
    registry,
    node,
    createNode,
    runtimes,
    createApi: () =>
      createConsoleQueryApi(node.readPort, { now: () => READ_AT }),
    runtime(projectId, sourceId, options = {}) {
      const runtime = createProjectHistoryTelemetryRuntime({
        projectId,
        sourceId,
        queueDirectory,
        registry,
        eventSink: node.eventSink,
        recordGap: (boundProjectId, gap) => node.recordGap(boundProjectId, gap),
        now: () => READ_AT,
        ...options,
      });
      runtimes.push(runtime);
      return runtime;
    },
  };
}

function job(projectId, id, clientId, requestId) {
  return {
    id,
    clientId,
    requestId,
    projectId,
    turnId: null,
    sessionId: `session-${projectId}`,
    documentId: `document-${projectId}`,
    documentFileId: `file-${projectId}`,
    purpose: "retained history fixture",
    state: "succeeded",
    transport: "mcp",
    agentId: null,
    agent: null,
    model: null,
    role: null,
    physicalTurns: 1,
    physicalTurnOrdinal: 1,
  };
}

function addAdmission(f, projectId, currentJob) {
  retainAdmission(f.queueDirectory, {
    clientId: currentJob.clientId,
    requestId: currentJob.requestId,
    cwd: f.projects.get(projectId),
    payload: { operation: "fixture-owned-output" },
  });
}

function queryRequest(snapshot, projectId) {
  return {
    version: CONSOLE_QUERY_CONTRACT_VERSION,
    scope: { kind: "project", projectId },
    collection: "tasks",
    snapshotToken: snapshot.snapshotToken,
    sort: [{ field: "id", direction: "asc" }],
    limit: 20,
  };
}

test("production history runtime defers owned-result events into shared SQLite and query read port", async (t) => {
  const f = fixture(t, ["project-one", "project-two"]);
  const first = job("project-one", "job-one", "mcp-client-one", "request-one");
  const second = job("project-two", "job-two", "mcp-client-two", "request-two");
  for (const [projectId, currentJob, content] of [
    ["project-one", first, "project-one stdout\n"],
    ["project-two", second, "project-two stdout\n"],
  ]) {
    addAdmission(f, projectId, currentJob);
    const resultDirectory = path.join(
      f.projects.get(projectId),
      ".cad",
      "results",
      currentJob.id,
    );
    fs.mkdirSync(resultDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(resultDirectory, "stdout.txt"), content);
  }

  let persistedCalls = 0;
  const runtimePorts = {
    eventSink: {
      append(event) {
        persistedCalls++;
        return f.node.eventSink.append(event);
      },
    },
    recordGap: f.node.recordGap.bind(f.node),
  };
  const runtimes = [
    f.runtime("project-one", "mcp-source:project-one", runtimePorts),
    f.runtime("project-two", "mcp-source:project-two", runtimePorts),
  ];

  const published = [];
  for (const [index, [projectId, currentJob]] of [
    ["project-one", first],
    ["project-two", second],
  ].entries()) {
    const reference = describeOwnedResult(
      f.queueDirectory,
      { id: currentJob.id, request: { cwd: f.projects.get(projectId) } },
      "stdout.txt",
    ).artifact;
    published.push(
      runtimes[index].source.publishOwnedResult({
        job: currentJob,
        reference,
        observedAtMs: READ_AT,
      }),
    );
  }
  assert.deepEqual(
    published.map((item) => item.status),
    ["queued", "queued"],
  );
  assert.equal(
    persistedCalls,
    0,
    "SQLite writes must run after publish returns",
  );
  await Promise.all(runtimes.map((runtime) => runtime.flush()));
  assert.equal(persistedCalls, 2);
  const diagnosticStore = openRegisteredProjectHistoryStore(f.registry, {
    projectId: "project-one",
    projectRoot: f.projects.get("project-one"),
    readOnly: true,
  });
  const diagnosticSnapshot = diagnosticStore.readSnapshot();
  assert.equal(diagnosticSnapshot.events.length, 1);
  assert.equal(diagnosticSnapshot.jobs.length, 1);
  assert.equal(diagnosticSnapshot.jobs[0].state, "succeeded");
  diagnosticStore.close();

  const api = f.createApi();
  const principals = [
    { subject: "one", projectIds: ["project-one"], globalRead: false },
    { subject: "two", projectIds: ["project-two"], globalRead: false },
  ];
  for (const [index, projectId] of ["project-one", "project-two"].entries()) {
    const snapshot = await api.snapshot(
      { kind: "project", projectId },
      principals[index],
    );
    assert.equal("state" in snapshot, false, JSON.stringify(snapshot));
    const page = await api.query(
      queryRequest(snapshot, projectId),
      principals[index],
    );
    assert.deepEqual(
      page.rows.map((row) => row.id),
      [index === 0 ? first.id : second.id],
      JSON.stringify({ snapshot, page }),
    );
    const output = page.rows[0].artifacts.stdout;
    assert.equal(output.state, "available");
    const detail = await api.detail(
      {
        version: CONSOLE_QUERY_CONTRACT_VERSION,
        scope: { kind: "project", projectId },
        taskId: page.rows[0].id,
        artifactId: output.artifactId,
        kind: "stdout",
        snapshotToken: snapshot.snapshotToken,
        offset: 0,
        length: 128,
      },
      principals[index],
    );
    assert.equal(detail.state, "available");
    assert.equal(
      detail.content,
      index === 0 ? "project-one stdout\n" : "project-two stdout\n",
    );
  }

  await Promise.all(runtimes.map((runtime) => runtime.close()));
  assert.equal(runtimes[0].source.publishJob(first).status, "dropped");

  f.node.close();
  const reopened = f.createNode();
  const reopenedApi = createConsoleQueryApi(reopened.readPort, {
    now: () => READ_AT,
  });
  const reopenedSnapshot = await reopenedApi.snapshot(
    { kind: "project", projectId: "project-one" },
    principals[0],
  );
  const reopenedPage = await reopenedApi.query(
    queryRequest(reopenedSnapshot, "project-one"),
    principals[0],
  );
  assert.deepEqual(
    reopenedPage.rows.map((row) => row.id),
    [first.id],
  );
  reopened.close();
});

test("history runtime records source overflow and rejected unadmitted jobs as partial SQLite gaps", async (t) => {
  const f = fixture(t);
  const errors = [];
  const runtime = f.runtime("project-one", "mcp-source:project-one", {
    maxPendingEvents: 1,
    onError: (error) => errors.push(error.code),
  });
  const accepted = job(
    "project-one",
    "accepted-job",
    "mcp-client",
    "request-accepted",
  );
  const overflowed = job(
    "project-one",
    "overflow-job",
    "mcp-client",
    "request-overflow",
  );
  const unadmitted = job(
    "project-one",
    "unadmitted-job",
    "mcp-client",
    "request-unadmitted",
  );
  addAdmission(f, "project-one", accepted);
  addAdmission(f, "project-one", overflowed);

  assert.equal(
    runtime.source.publishJob(accepted, { projectId: "project-one" }).status,
    "queued",
  );
  assert.equal(
    runtime.source.publishJob(overflowed, { projectId: "project-one" }).status,
    "dropped",
  );
  await runtime.flush();

  assert.equal(
    runtime.source.publishJob(unadmitted, { projectId: "project-one" }).status,
    "queued",
  );
  await runtime.flush();
  assert.ok(errors.includes("HISTORY_TELEMETRY_ADMISSION_MISSING"));

  const snapshot = await f.node.readPort.readSnapshot({
    kind: "project",
    projectId: "project-one",
  });
  assert.equal(snapshot.collections.tasks.length, 1);
  assert.equal(snapshot.collections.tasks[0].id, accepted.id);
  assert.equal(snapshot.sources.tasks.state, "partial");
  assert.equal(
    snapshot.sources.tasks.reason,
    "Retained history has source gaps or incomplete availability.",
  );
  const retained = f.registry.lookup("project-one");
  const store = openRegisteredProjectHistoryStore(f.registry, {
    projectId: retained.projectId,
    projectRoot: retained.path,
    readOnly: true,
  });
  const status = store
    .snapshot()
    .sources.find((source) => source.sourceId === runtime.source.sourceId);
  assert.ok(
    status.gaps.some((gap) => gap.reason === "TELEMETRY_EVENT_QUEUE_FULL"),
  );
  assert.ok(
    status.gaps.some((gap) => gap.reason === "TELEMETRY_SINK_APPEND_FAILED"),
  );
  store.close();
  await runtime.close();

  const sinkFailureJob = job(
    "project-one",
    "sink-failure-job",
    "mcp-client",
    "request-sink-failure",
  );
  addAdmission(f, "project-one", sinkFailureJob);
  const sinkFailure = f.runtime("project-one", "mcp-source:failed-sink", {
    eventSink: {
      async append() {
        throw Object.assign(new Error("private storage path"), {
          code: "HISTORY_STORAGE_UNAVAILABLE",
        });
      },
    },
    onError: (error) => errors.push(error.code),
  });
  assert.equal(
    sinkFailure.source.publishJob(sinkFailureJob, {
      projectId: "project-one",
    }).status,
    "queued",
  );
  await sinkFailure.close();
  assert.ok(errors.includes("HISTORY_STORAGE_UNAVAILABLE"));
  const afterSinkFailure = openRegisteredProjectHistoryStore(f.registry, {
    projectId: "project-one",
    projectRoot: f.projects.get("project-one"),
    readOnly: true,
  });
  const failureStatus = afterSinkFailure
    .snapshot()
    .sources.find((source) => source.sourceId === "mcp-source:failed-sink");
  assert.equal(failureStatus.gaps[0].reason, "TELEMETRY_SINK_APPEND_FAILED");
  afterSinkFailure.close();
});

test("history producer drains close once and rejects cross-project events", async (t) => {
  const f = fixture(t, ["project-one", "project-two"]);
  const errors = [];
  const runtime = f.runtime("project-one", "mcp-source:close", {
    onError: (error) => errors.push(error.code),
  });
  const accepted = job("project-one", "close-job", "client", "close-request");
  addAdmission(f, "project-one", accepted);
  runtime.source.publishJob(accepted, { projectId: "project-one" });
  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  assert.equal(runtime.source.publishJob(accepted).status, "dropped");
  await closing;
  const snapshot = await f.node.readPort.readSnapshot({
    kind: "project",
    projectId: "project-one",
  });
  assert.equal(snapshot.collections.tasks.length, 1);
  const foreign = f.runtime("project-one", "mcp-source:foreign", {
    onError: (error) => errors.push(error.code),
  });
  foreign.source.publishJob(
    { ...accepted, projectId: "project-two" },
    { projectId: "project-two" },
  );
  await foreign.close();
  assert.ok(errors.includes("HISTORY_TELEMETRY_SOURCE_MISMATCH"));
  const second = await f.node.readPort.readSnapshot({
    kind: "project",
    projectId: "project-two",
  });
  assert.equal(second.collections.tasks.length, 0);
});

test("history producer refuses a registry binding changed before its deferred write", async (t) => {
  const f = fixture(t);
  const errors = [];
  const runtime = f.runtime("project-one", "mcp-source:changed", {
    onError: (error) => errors.push(error.code),
  });
  const accepted = job(
    "project-one",
    "changed-job",
    "client",
    "changed-request",
  );
  addAdmission(f, "project-one", accepted);
  runtime.source.publishJob(accepted, { projectId: "project-one" });
  const original = f.registry.lookup("project-one");
  f.registry.lookup = () => ({ ...original, databaseId: "replaced-database" });
  await assert.rejects(runtime.close(), {
    code: "HISTORY_TELEMETRY_GAP_PERSIST_FAILED",
  });
  assert.ok(errors.includes("HISTORY_PROJECT_BINDING_CHANGED"));
});

test("installed producer composition persists registered jobs and refuses identity fallback", async (t) => {
  const {
    createMcpStdioTelemetry,
  } = require("../dist/src/dist/composition/control-center.js");
  const f = fixture(t, ["project-one", "project-two"]);
  const errors = [];
  const producer = createMcpStdioTelemetry({
    clientId: "root-client",
    instanceId: "root-instance",
    queueDirectory: f.queueDirectory,
    registry: { filePath: f.registry.readonlyPath },
    onError: (code) => errors.push(code),
  });
  t.after(() => producer.close());
  const first = job("project-one", "root-job", "root-client", "root-request");
  addAdmission(f, "project-one", first);
  producer.publishJob(first);
  producer.publishJob({
    ...first,
    id: "foreign-job",
    projectId: "unregistered",
    request: { cwd: f.projects.get("project-one") },
  });
  const closing = producer.close();
  assert.equal(producer.close(), closing);
  producer.publishJob({ ...first, id: "late-job" });
  await closing;
  assert.deepEqual(errors, ["HISTORY_TELEMETRY_PROJECT_REQUIRED"]);
  const snapshot = await f.node.readPort.readSnapshot({
    kind: "project",
    projectId: "project-one",
  });
  assert.deepEqual(
    snapshot.collections.tasks.map((task) => task.id),
    ["root-job"],
  );
  const other = await f.node.readPort.readSnapshot({
    kind: "project",
    projectId: "project-two",
  });
  assert.equal(other.collections.tasks.length, 0);
});

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");

const {
  createBrokerControlPort,
} = require("../src/dist/node-adapters/broker-ipc/control");
const {
  createCollector,
} = require("../packages/node-adapters/dist/console/system-data");
const {
  createControlCenterSystemControls,
  createSystemControlRuntime,
} = require("../packages/node-adapters/dist/control-center/system-controls");
const {
  createSystemControls,
  createSystemControlsRoute,
} = require("../packages/control-center/dist/server/system-controls");
const {
  createControlCenterHttpServer,
} = require("../packages/control-center/dist/server/http");
const {
  composeControlCenterService,
} = require("../packages/control-center/dist/server/composition");
const {
  CONTROL_CENTER_PROTOCOL_VERSION,
} = require("../packages/control-center/dist/server/protocol");
const {
  SystemControlsClient,
  createSystemControlCommand,
  renderSystemControls,
  renderSystemControlConfirmation,
  renderSystemControlReceipt,
} = require("../packages/control-center/dist/web/system-controls");
const {
  SYSTEM_CONTROLS_API_VERSION,
} = require("../packages/control-center/dist/contracts/system-controls");
const { request } = require("../src/queue-connection");
const { durable, readJson } = require("../src/queue-instance");
const { createServices } = require("../src/console-services");
const {
  createControlCenterSystemControlsRuntime,
} = require("../src/control-center-system-controls.cjs");

const auth = {
  clientId: "system-control-owner",
  clientToken: "private-offline",
};
const principal = {
  subject: auth.clientId,
  projectIds: ["fixture-project"],
  globalRead: true,
};
const globalScope = { kind: "global" };
const projectScope = { kind: "project", projectId: "fixture-project" };

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-system-controls-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const queue = path.join(root, "queue");
  const xdg = path.join(root, "xdg");
  for (const directory of [
    home,
    project,
    path.join(project, ".cad"),
    queue,
    path.join(xdg, "config"),
    path.join(xdg, "data"),
    path.join(xdg, "cache"),
    path.join(xdg, "state"),
  ])
    fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, project, queue, xdg };
}

async function startLifecycleProcess(
  t,
  dirs,
  {
    paused = false,
    unknown = false,
    activeCount = 0,
    buildHash,
    clientToken,
  } = {},
) {
  const args = [
    dirs.queue,
    ...(paused ? ["--paused"] : []),
    ...(unknown ? ["--unknown"] : []),
    ...(activeCount ? [`--active-count=${activeCount}`] : []),
    ...(buildHash ? [`--build-hash=${buildHash}`] : []),
  ];
  const child = fork(
    path.join(__dirname, "fixtures/lifecycle-process.cjs"),
    args,
    {
      env: {
        ...process.env,
        HOME: dirs.home,
        XDG_CONFIG_HOME: path.join(dirs.xdg, "config"),
        XDG_DATA_HOME: path.join(dirs.xdg, "data"),
        XDG_CACHE_HOME: path.join(dirs.xdg, "cache"),
        XDG_STATE_HOME: path.join(dirs.xdg, "state"),
        ...(clientToken ? { FMCAD_FIXTURE_CLIENT_TOKEN: clientToken } : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (bytes) => (stderr += bytes));
  const ready = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => {
      throw new Error(
        stderr || "Offline lifecycle fixture exited before ready",
      );
    }),
  ]);
  assert.equal(ready[0].ready, true);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });
  return child;
}

async function startLifecycle(t, options = {}) {
  const dirs = sandbox(t);
  const child = await startLifecycleProcess(t, dirs, options);
  return { ...dirs, child };
}

async function startProductionQueueClient(t, dirs) {
  const child = fork(
    path.join(__dirname, "fixtures/system-controls-production-http.cjs"),
    ["control-center-system-test"],
    {
      env: {
        ...process.env,
        HOME: dirs.home,
        XDG_CONFIG_HOME: path.join(dirs.xdg, "config"),
        XDG_DATA_HOME: path.join(dirs.xdg, "data"),
        XDG_CACHE_HOME: path.join(dirs.xdg, "cache"),
        XDG_STATE_HOME: path.join(dirs.xdg, "state"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (bytes) => (stderr += bytes));
  const exitPromise = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exitPromise;
    }
  });
  const ready = await Promise.race([
    once(child, "message"),
    exitPromise.then(() => {
      throw new Error(stderr || "Production QueueClient fixture exited early");
    }),
  ]);
  assert.equal(ready[0].ready, true);
  const relative = path.relative(dirs.root, ready[0].queueDirectory);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );
  return {
    child,
    queue: ready[0].queueDirectory,
    auth: ready[0].auth,
    exitPromise,
  };
}

function receiptReader(queue) {
  return async ({ requestId, principal: caller }) => {
    if (caller.subject !== auth.clientId) return null;
    const digest = crypto.createHash("sha256").update(requestId).digest("hex");
    const file = path.join(queue, `lifecycle-control-${digest}.json`);
    try {
      const record = readJson(file);
      if (record.binding?.clientId !== caller.subject) return null;
      return record;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
}

function hasUnresolvedControl(queue) {
  let names;
  try {
    names = fs
      .readdirSync(queue)
      .filter((name) => /^lifecycle-control-[a-f0-9]{64}\.json$/.test(name));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (names.length > 10_000)
    throw Object.assign(new Error("Receipt directory exceeds its scan bound"), {
      code: "RECEIPT_SCAN_LIMIT",
    });
  return names.some((name) => {
    const receipt = readJson(path.join(queue, name), 64 * 1024);
    return receipt.status !== "completed";
  });
}

function createIpc(queue, { dropAckAction = null } = {}) {
  const calls = [];
  let dropped = false;
  const client = {
    call(action, values) {
      calls.push(action);
      return request(
        queue,
        {
          action,
          auth,
          ...(values || {}),
          ...(action === dropAckAction && !dropped
            ? { dropAck: (dropped = true) }
            : {}),
        },
        { timeoutMs: 1500 },
      );
    },
  };
  return { client, calls };
}

function createApplication(
  queue,
  ipc,
  {
    receipt = receiptReader(queue),
    unresolved = () => hasUnresolvedControl(queue),
  } = {},
) {
  return createSystemControls({
    control: createBrokerControlPort(ipc.client),
    readReceipt: receipt,
    hasUnresolvedControl: unresolved,
    authorize(caller, scope) {
      return (
        caller.subject === auth.clientId &&
        (scope.kind === "global" || scope.projectId === "fixture-project")
      );
    },
  });
}

async function freeHttpPort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function openHttp(
  t,
  application,
  {
    dropPostAck = false,
    projectActions,
    systemControls,
    resolvePrincipal = () => principal,
  } = {},
) {
  const port = await freeHttpPort();
  const controlsRoute =
    systemControls ??
    (application ? createSystemControlsRoute(application) : undefined);
  const server = createControlCenterHttpServer({
    identity: {
      port,
      buildIdentity: "fixture-http-build",
      protocolVersion: CONTROL_CENTER_PROTOCOL_VERSION,
      pid: process.pid,
      processBirth: "fixture-http-process",
      instanceNonce: crypto.randomBytes(32).toString("hex"),
      probeSecret: crypto.randomBytes(32).toString("hex"),
    },
    query: {
      async snapshot() {
        throw new Error(
          "query routes are not used in this system-control test",
        );
      },
      async query() {
        throw new Error(
          "query routes are not used in this system-control test",
        );
      },
      async export() {
        throw new Error(
          "query routes are not used in this system-control test",
        );
      },
      async detail() {
        throw new Error(
          "query routes are not used in this system-control test",
        );
      },
      subscribe() {
        return () => {};
      },
    },
    resolvePrincipal,
    assets: [
      {
        path: "/index.html",
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><title>fixture</title>",
      },
    ],
    ...(controlsRoute ? { systemControls: controlsRoute } : {}),
    ...(projectActions ? { projectActions } : {}),
  });
  await server.start();
  t.after(() => server.close());
  const origin = `http://localhost:${port}`;
  let storedCookie = "";
  let postCount = 0;
  let dropped = false;
  const fetcher = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (storedCookie) headers.set("cookie", storedCookie);
    if (init.method === "POST") {
      if (!headers.has("origin")) headers.set("origin", origin);
      postCount++;
    }
    const response = await fetch(input, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) storedCookie = setCookie.split(";", 1)[0];
    if (dropPostAck && init.method === "POST" && !dropped) {
      dropped = true;
      await response.arrayBuffer();
      throw new TypeError(
        "Fixture lost the HTTP acknowledgement after dispatch",
      );
    }
    return response;
  };
  const landing = await fetcher(origin);
  await landing.arrayBuffer();
  assert.equal(landing.status, 200);
  return {
    origin,
    fetcher,
    get postCount() {
      return postCount;
    },
  };
}

function translations(key, params = {}) {
  const values = {
    "system.controls.title": "Shared broker control",
    "system.controls.scope.project": `This is global control for the one shared broker; it affects every project, including ${params.projectName}.`,
    "system.controls.scope.managedOnly":
      "Pausing stops new fmcad-managed requests only. It does not stop Fusion or unrelated applications.",
    "system.controls.status.label": "Broker status",
    "system.controls.phase.running": "Accepting managed requests",
    "system.controls.phase.paused": "Paused. New managed requests are held.",
    "system.controls.phase.pausing":
      "Pausing; active managed requests may still be running.",
    "system.controls.phase.draining": `Draining; waiting for ${params.activeOperations} active managed requests.`,
    "system.controls.phase.stopped": "Stopped",
    "system.controls.phase.unknown": "Broker state is unknown",
    "system.controls.phase.recoveryBlocked":
      "Unresolved broker work requires reconciliation; controls are disabled.",
    "system.controls.phase.offline":
      "Broker is offline; current state is unavailable.",
    "system.controls.action.pause": "Stop accepting requests",
    "system.controls.action.drain": "Pause and drain active requests",
    "system.controls.action.resume": "Resume accepting requests",
    "system.controls.action.start": "Start broker",
    "system.controls.action.refresh": "Refresh broker status",
    "system.controls.action.reconcile": "Check original request",
    "system.controls.action.pending": "Waiting for broker confirmation",
    "system.controls.action.confirmed": `Broker confirmed ${params.phase}.`,
    "system.controls.action.unknown":
      "Outcome unknown. Checking the original receipt; the action will not be sent again.",
    "system.controls.action.receiptPending":
      "The original request is pending. Checking its receipt; no second action will be sent.",
    "system.controls.safety.noReplay":
      "Do not repeat an action while its receipt is pending or unknown.",
    "system.controls.error.unauthorized":
      "You are not authorized to control the shared broker.",
    "system.controls.error.unsupported": `${params.action} is not supported by this broker.`,
    "system.controls.error.offline":
      "The broker is offline. No action was confirmed.",
    "system.controls.error.generationConflict":
      "Broker state changed after it was read; no action was applied.",
    "system.controls.error.instanceChanged":
      "The broker instance changed. Refresh status before acting.",
    "system.controls.error.reconciliationRequired":
      "The broker has unresolved work. Resume and start are disabled until it is reconciled.",
    "system.controls.error.capabilityUnavailable": `This control is unavailable: ${params.reason}.`,
    "system.controls.error.storageUnavailable":
      "Persistent browser storage is unavailable. Controls are disabled to prevent replay.",
    "system.controls.accessible.status": "Shared broker control status.",
    "system.controls.accessible.globalScope":
      "Applies globally to managed requests from all projects.",
    "system.controls.accessible.pending":
      "Waiting for authoritative broker receipt.",
    "system.controls.accessible.action": `${params.action} shared broker.`,
    "system.controls.accessible.disabled": `${params.action} unavailable: ${params.reason}.`,
    "system.controls.confirm.cancel": "Cancel",
  };
  return values[key] ?? key;
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("System control API reads real broker capabilities and makes project scope explicitly global", async (t) => {
  const fixture = await startLifecycle(t);
  const ipc = createIpc(fixture.queue);
  const api = createApplication(fixture.queue, ipc);
  const status = await api.status(projectScope, principal);
  assert.equal(status.state, "available");
  assert.equal(status.effectiveScope.kind, "global");
  assert.equal(status.snapshot.phase, "RUNNING");
  assert.equal(status.capabilities.pause, true);
  assert.equal(status.capabilities.drain, true);
  assert.equal(status.capabilities.resume, false);
  assert.equal(status.capabilities.start, false);
  assert.equal(ipc.calls.filter((call) => call === "pause").length, 0);
  const attemptedStart = await api.execute(
    {
      version: SYSTEM_CONTROLS_API_VERSION,
      scope: projectScope,
      action: "start",
      requestId: "start-while-running",
      instanceId: status.snapshot.instanceId,
      expectedGeneration: status.snapshot.generation,
    },
    principal,
  );
  assert.equal(attemptedStart.state, "conflict");
  assert.equal(ipc.calls.includes("start"), false);

  const html = renderSystemControls(
    status,
    projectScope,
    translations,
    "Fixture Project",
  );
  assert.match(html, /affects every project, including Fixture Project/);
  assert.match(html, /Applies globally to managed requests from all projects/);
  assert.match(html, /does not stop Fusion or unrelated applications/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-system-control-action="pause"[^>]*aria-label=/);
  assert.deepEqual(
    createSystemControlCommand(status, projectScope, "pause", "fenced-request"),
    {
      version: 1,
      scope: projectScope,
      action: "pause",
      requestId: "fenced-request",
      instanceId: status.snapshot.instanceId,
      expectedGeneration: status.snapshot.generation,
    },
  );
  const storageUnavailable = renderSystemControls(
    status,
    projectScope,
    translations,
    "Fixture Project",
    undefined,
    null,
    false,
  );
  assert.match(storageUnavailable, /Persistent browser storage is unavailable/);
  assert.equal(
    (
      storageUnavailable.match(
        /data-system-control-action="[a-z]+"[^>]* disabled>/g,
      ) || []
    ).length,
    4,
  );
  assert.match(
    renderSystemControlConfirmation("resume", "Fixture Project", translations),
    /data-system-control-confirm-action="resume"/,
  );
  assert.match(
    renderSystemControlReceipt(
      {
        version: SYSTEM_CONTROLS_API_VERSION,
        requestedScope: projectScope,
        effectiveScope: globalScope,
        requestId: "fixture-request",
        action: "resume",
        instanceId: "fixture-instance",
        expectedGeneration: 0,
        state: "unknown",
        snapshot: null,
      },
      translations,
    ),
    /the action will not be sent again/i,
  );
  let requests = 0;
  const noStorage = new SystemControlsClient(
    "http://localhost:4748",
    async () => {
      requests++;
      throw new Error("must not send");
    },
    null,
  );
  assert.equal(noStorage.canMutate(), false);
  await assert.rejects(
    noStorage.execute(
      createSystemControlCommand(status, projectScope, "pause", "no-storage"),
    ),
    { code: "PENDING_STORAGE_UNAVAILABLE" },
  );
  assert.equal(requests, 0);
});

test("default System controls composition is passive until an explicit HTTP request", async () => {
  const runtime = createControlCenterSystemControlsRuntime(
    { routing: "queue", queue: { autoStart: false } },
    () => ["fixture-project"],
  );
  assert.equal(typeof runtime.handle, "function");
  runtime.close();
  assert.throws(
    () =>
      createControlCenterSystemControlsRuntime(
        { routing: "direct", queue: { autoStart: true } },
        () => ["fixture-project"],
      ),
    { code: "UNSUPPORTED_ROUTING" },
  );
});

test("real HTTP route enforces session/CSRF and a lost lifecycle ACK reconciles without a second action", async (t) => {
  const fixture = await startLifecycle(t);
  const ipc = createIpc(fixture.queue, { dropAckAction: "pause" });
  const api = createApplication(fixture.queue, ipc);
  const httpFixture = await openHttp(t, api, { dropPostAck: true });
  const unauthorized = await fetch(
    `${httpFixture.origin}/api/v1/console/system-controls?scope=global`,
  );
  assert.equal(unauthorized.status, 401);

  const browser = new SystemControlsClient(
    httpFixture.origin,
    httpFixture.fetcher,
    memoryStorage(),
  );
  const status = await browser.status(globalScope);
  assert.equal(browser.canMutate(), true);
  const command = {
    version: SYSTEM_CONTROLS_API_VERSION,
    scope: globalScope,
    action: "pause",
    requestId: crypto.randomUUID(),
    instanceId: status.snapshot.instanceId,
    expectedGeneration: status.snapshot.generation,
  };
  const result = await browser.execute(command);
  assert.equal(result.state, "confirmed");
  assert.equal(result.snapshot.phase, "PAUSED");
  assert.equal(ipc.calls.filter((call) => call === "pause").length, 1);
  assert.equal(httpFixture.postCount, 1);
  assert.equal((await browser.status(globalScope)).capabilities.resume, true);

  const duplicate = await browser.execute(command);
  assert.equal(duplicate.state, "confirmed");
  assert.equal(
    httpFixture.postCount,
    1,
    "the browser reconciles a reused request ID with GET only",
  );
  assert.equal(ipc.calls.filter((call) => call === "pause").length, 1);
});

test("installed composition joins production HTTP, Node lifecycle IPC and durable receipts", async (t) => {
  const fixture = await startLifecycle(t);
  const ipc = createIpc(fixture.queue);
  const queueClient = {
    ...ipc.client,
    dir: fixture.queue,
    auth,
    async register() {},
    dispose() {},
  };
  const runtime = createControlCenterSystemControls({
    client: queueClient,
    buildHash: () => "fake-build",
    authorize: (caller, scope) =>
      caller.globalRead &&
      (scope.kind === "global" || scope.projectId === "fixture-project"),
  });
  const composition = composeControlCenterService({
    readPort: null,
    resolvePrincipal: () => principal,
    subscribeRevisions: () => () => {},
    systemControls: runtime.handle,
    close: runtime.close,
  });
  t.after(() => composition.close());
  const httpFixture = await openHttp(t, null, {
    systemControls: composition.systemControls,
    resolvePrincipal: composition.resolvePrincipal,
  });
  const browser = new SystemControlsClient(
    httpFixture.origin,
    httpFixture.fetcher,
    memoryStorage(),
  );
  const status = await browser.status(globalScope);
  const command = createSystemControlCommand(
    status,
    globalScope,
    "pause",
    "installed-route-pause",
  );
  const receipt = await browser.execute(command);
  assert.equal(receipt.state, "confirmed");
  assert.equal(receipt.snapshot.phase, "PAUSED");
  assert.equal(ipc.calls.filter((action) => action === "pause").length, 1);
  assert.equal(httpFixture.postCount, 1);
  assert.equal((await browser.receipt(command)).state, "confirmed");
});

test("default QueueClient production HTTP uses authenticated lifecycle IPC and the broker receipt store", async (t) => {
  const dirs = sandbox(t);
  const queueClient = await startProductionQueueClient(t, dirs);
  const queueDirs = { ...dirs, queue: queueClient.queue };
  await startLifecycleProcess(t, queueDirs, {
    clientToken: queueClient.auth.clientToken,
    buildHash: "a".repeat(64),
  });
  const port = await freeHttpPort();
  const resultPromise = once(queueClient.child, "message");
  queueClient.child.send({ action: "run", port });
  const [message] = await resultPromise;
  await queueClient.exitPromise;
  if (message.error)
    assert.fail(
      `${message.error.code}: ${message.error.message}; status=${JSON.stringify(message.error.status)}`,
    );
  assert.equal(message.result.state, "confirmed");
  assert.equal(message.result.phase, "PAUSED");
  assert.equal(message.result.clientId, queueClient.auth.clientId);
  const digest = crypto
    .createHash("sha256")
    .update(message.result.requestId)
    .digest("hex");
  const saved = readJson(
    path.join(queueClient.queue, `lifecycle-control-${digest}.json`),
  );
  assert.equal(saved.status, "completed");
  assert.equal(saved.binding.action, "pause");
  assert.equal(saved.binding.instanceId, message.result.instanceId);
  assert.equal(saved.binding.clientId, queueClient.auth.clientId);
});

test("two same-origin tabs share the pending intent and do not post a second global action", async (t) => {
  const fixture = await startLifecycle(t);
  const ipc = createIpc(fixture.queue);
  const api = createApplication(fixture.queue, ipc);
  const httpFixture = await openHttp(t, api);
  const sharedStorage = memoryStorage();
  const firstTab = new SystemControlsClient(
    httpFixture.origin,
    httpFixture.fetcher,
    sharedStorage,
  );
  const secondTab = new SystemControlsClient(
    httpFixture.origin,
    httpFixture.fetcher,
    sharedStorage,
  );
  const [first, second] = await Promise.all([
    firstTab.status(globalScope),
    secondTab.status(globalScope),
  ]);
  assert.equal(first.snapshot.generation, second.snapshot.generation);
  const makeCommand = (snapshot, action) => ({
    version: SYSTEM_CONTROLS_API_VERSION,
    scope: globalScope,
    action,
    requestId: crypto.randomUUID(),
    instanceId: snapshot.instanceId,
    expectedGeneration: snapshot.generation,
  });
  const results = await Promise.allSettled([
    firstTab.execute(makeCommand(first.snapshot, "pause")),
    secondTab.execute(makeCommand(second.snapshot, "drain")),
  ]);
  assert.equal(
    results.filter((value) => value.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((value) => value.status === "rejected").length,
    1,
  );
  const rejected = results.find((value) => value.status === "rejected");
  assert.equal(rejected.reason.code, "CONTROL_RECEIPT_PENDING");
  assert.equal(httpFixture.postCount, 1);
  assert.equal((await firstTab.status(globalScope)).snapshot.generation, 1);
});

test("server generation fencing rejects distinct concurrent request IDs", async (t) => {
  const fixture = await startLifecycle(t);
  const ipc = createIpc(fixture.queue);
  const api = createApplication(fixture.queue, ipc);
  const status = await api.status(globalScope, principal);
  const makeCommand = (action) => ({
    version: SYSTEM_CONTROLS_API_VERSION,
    scope: globalScope,
    action,
    requestId: crypto.randomUUID(),
    instanceId: status.snapshot.instanceId,
    expectedGeneration: status.snapshot.generation,
  });
  const results = await Promise.all([
    api.execute(makeCommand("pause"), principal),
    api.execute(makeCommand("drain"), principal),
  ]);
  assert.equal(
    results.filter(
      (value) => value.state === "confirmed" || value.state === "accepted",
    ).length,
    1,
  );
  assert.equal(results.filter((value) => value.state === "conflict").length, 1);
  assert.equal(
    ipc.calls.filter((call) => call === "pause" || call === "drain").length,
    2,
    "two distinct intents reach the lifecycle once each; its generation fence rejects one",
  );
});

test("a foreign pause is observed but opening another tab never resumes it", async (t) => {
  const fixture = await startLifecycle(t);
  const foreignFence = await request(fixture.queue, {
    action: "control-status",
    auth: { ...auth, clientId: "foreign-client" },
  });
  await request(fixture.queue, {
    action: "pause",
    auth: { ...auth, clientId: "foreign-client" },
    control: {
      requestId: "foreign-pause",
      instanceId: foreignFence.instanceId,
      expectedGeneration: foreignFence.generation,
    },
  });
  const ipc = createIpc(fixture.queue);
  const api = createApplication(fixture.queue, ipc);
  const status = await api.status(projectScope, principal);
  assert.equal(status.snapshot.phase, "PAUSED");
  assert.equal(
    status.capabilities.resume,
    true,
    "resume remains an explicit, fenced user action",
  );
  assert.deepEqual(ipc.calls, ["control-status"]);
});

test("unknown resume stays held and is never replayed", async (t) => {
  const fixture = await startLifecycle(t, { paused: true, unknown: true });
  const ipc = createIpc(fixture.queue);
  const api = createApplication(fixture.queue, ipc);
  const httpFixture = await openHttp(t, api);
  const browserStorage = memoryStorage();
  const browser = new SystemControlsClient(
    httpFixture.origin,
    httpFixture.fetcher,
    browserStorage,
  );
  const status = await browser.status(globalScope);
  const command = {
    version: SYSTEM_CONTROLS_API_VERSION,
    scope: globalScope,
    action: "resume",
    requestId: crypto.randomUUID(),
    instanceId: status.snapshot.instanceId,
    expectedGeneration: status.snapshot.generation,
  };
  const result = await browser.execute(command);
  assert.equal(result.state, "unknown");
  assert.equal(browser.canMutate(), false);
  assert.equal(ipc.calls.filter((call) => call === "resume").length, 1);
  assert.equal(readJson(path.join(fixture.queue, "counts.json")).probes, 1);
  const held = await browser.status(globalScope);
  assert.equal(held.snapshot.unresolved, true);
  assert.equal(held.capabilities.resume, false);
  assert.equal(held.capabilities.start, false);
  const duplicate = await browser.execute(command);
  assert.equal(duplicate.state, "unknown");
  assert.equal(ipc.calls.filter((call) => call === "resume").length, 1);
  const reloadedTab = new SystemControlsClient(
    httpFixture.origin,
    httpFixture.fetcher,
    browserStorage,
  );
  const afterReload = await reloadedTab.execute(command);
  assert.equal(afterReload.state, "unknown");
  assert.equal(reloadedTab.canMutate(), false);
  assert.equal(
    httpFixture.postCount,
    1,
    "a reloaded client reconciles the persisted intent with GET only",
  );
});

test("a durable pending receipt disables new control intents across browser sessions", async (t) => {
  const fixture = await startLifecycle(t);
  const requestId = "pending-from-another-session";
  const digest = crypto.createHash("sha256").update(requestId).digest("hex");
  durable(
    path.join(fixture.queue, `lifecycle-control-${digest}.json`),
    {
      binding: {
        action: "pause",
        clientId: "other-authenticated-client",
        requestId,
        instanceId: "earlier-instance",
        expectedGeneration: 0,
        buildHash: "fixture-build",
      },
      status: "prepared",
    },
    true,
  );
  const ipc = createIpc(fixture.queue);
  const runtime = createSystemControlRuntime({
    client: {
      ...ipc.client,
      dir: fixture.queue,
      auth,
      async register() {},
      dispose() {},
    },
    buildHash: () => "fake-build",
  });
  t.after(() => runtime.close());
  const api = createSystemControls({
    control: runtime.control,
    readReceipt: (input) => runtime.readReceipt(input),
    hasUnresolvedControl: () => runtime.hasUnresolvedControl(),
    authorize: (caller, scope) =>
      caller.globalRead &&
      (scope.kind === "global" || scope.projectId === "fixture-project"),
  });
  const status = await api.status(globalScope, principal);
  assert.equal(status.state, "available");
  assert.equal(status.reason, "CONTROL_RECEIPT_PENDING");
  assert.equal(status.capabilities.pause, false);
  const result = await api.execute(
    {
      version: SYSTEM_CONTROLS_API_VERSION,
      scope: globalScope,
      action: "pause",
      requestId: "new-session-action",
      instanceId: status.snapshot.instanceId,
      expectedGeneration: status.snapshot.generation,
    },
    principal,
  );
  assert.equal(result.state, "conflict");
  assert.equal(result.code, "CONTROL_RECEIPT_PENDING");
  assert.equal(ipc.calls.includes("pause"), false);
});

test("drain reports many active managed operations instead of reporting zero or per-project sums", async (t) => {
  const fixture = await startLifecycle(t, { activeCount: 128 });
  const ipc = createIpc(fixture.queue);
  const api = createApplication(fixture.queue, ipc);
  const status = await api.status(projectScope, principal);
  assert.equal(status.effectiveScope.kind, "global");
  assert.equal(status.snapshot.activeOperations, 128);
  const receipt = await api.execute(
    {
      version: SYSTEM_CONTROLS_API_VERSION,
      scope: projectScope,
      action: "drain",
      requestId: "drain-five-workers",
      instanceId: status.snapshot.instanceId,
      expectedGeneration: status.snapshot.generation,
    },
    principal,
  );
  assert.equal(receipt.state, "accepted");
  assert.equal(receipt.snapshot.activeOperations, 128);
  assert.equal(receipt.snapshot.phase, "PAUSING");
  const after = await api.status(projectScope, principal);
  const html = renderSystemControls(
    after,
    projectScope,
    translations,
    "Fixture Project",
  );
  assert.match(html, /Draining; waiting for 128 active managed requests/);
  assert.equal(after.snapshot.activeOperations, 128);
  await request(fixture.queue, {
    action: "fixture-finish-workers",
    auth,
  });
  const reconciled = await api.receipt(
    projectScope,
    principal,
    receipt.requestId,
    {
      action: "drain",
      instanceId: receipt.instanceId,
      expectedGeneration: receipt.expectedGeneration,
    },
  );
  assert.equal(reconciled.state, "confirmed");
  assert.equal(reconciled.snapshot.phase, "PAUSED");
  assert.equal(reconciled.snapshot.activeOperations, 0);
});

test("start is exposed only for a real STOPPED snapshot and confirms the new paused instance", async () => {
  const stopped = {
    protocol: 1,
    instanceId: "stopped-instance",
    generation: 7,
    phase: "STOPPED",
    buildHash: "offline-build",
    activeOperations: 0,
    unresolved: false,
    gateClosed: true,
    capabilities: { start: true },
  };
  const started = {
    ...stopped,
    instanceId: "started-instance",
    generation: 0,
    phase: "PAUSED",
    capabilities: { pause: true, drain: true, resume: true, start: false },
  };
  let running = false;
  const records = new Map();
  const client = {
    async call() {
      throw Object.assign(new Error("not running"), {
        code: "QUEUE_NOT_RUNNING",
      });
    },
  };
  const port = createBrokerControlPort(client, {
    stopped: async () => (running ? started : stopped),
    start: async (fence) => {
      assert.equal(running, false);
      assert.equal(fence.instanceId, stopped.instanceId);
      assert.equal(fence.expectedGeneration, stopped.generation);
      running = true;
      records.set(fence.requestId, {
        binding: { ...fence, action: "start" },
        status: "completed",
        result: { requestId: fence.requestId, control: started },
      });
      return { requestId: fence.requestId, control: started };
    },
  });
  const api = createSystemControls({
    control: port,
    readReceipt: async ({ requestId, principal: caller }) =>
      caller.subject === principal.subject
        ? (records.get(requestId) ?? null)
        : null,
    hasUnresolvedControl: async () => false,
    authorize: () => true,
  });
  const status = await api.status(globalScope, principal);
  assert.equal(status.state, "available");
  assert.equal(status.snapshot.phase, "STOPPED");
  assert.equal(status.capabilities.start, true);
  const result = await api.execute(
    {
      version: SYSTEM_CONTROLS_API_VERSION,
      scope: globalScope,
      action: "start",
      requestId: "start-once",
      instanceId: stopped.instanceId,
      expectedGeneration: stopped.generation,
    },
    principal,
  );
  assert.equal(result.state, "confirmed");
  assert.equal(result.snapshot.instanceId, started.instanceId);
  assert.equal(result.snapshot.phase, "PAUSED");
  assert.equal(running, true);

  const unsupported = createSystemControls({
    control: createBrokerControlPort(client, {
      stopped: async () => ({ ...stopped, capabilities: { start: true } }),
    }),
    readReceipt: async () => null,
    hasUnresolvedControl: async () => false,
    authorize: () => true,
  });
  const unavailable = await unsupported.status(globalScope, principal);
  assert.equal(unavailable.capabilities.start, false);
});

test("production HTTP starts only a clean STOPPED fixture through the existing start-paused service", async (t) => {
  const dirs = sandbox(t);
  const buildHash = "a".repeat(64);
  let brokerRunning = false;
  let starts = 0;
  const client = {
    dir: dirs.queue,
    auth,
    async register() {
      if (!brokerRunning)
        throw Object.assign(new Error("broker offline"), {
          code: "QUEUE_NOT_RUNNING",
        });
    },
    call(action, values) {
      if (!brokerRunning)
        throw Object.assign(new Error("broker offline"), {
          code: "QUEUE_NOT_RUNNING",
        });
      return request(dirs.queue, { action, auth, ...(values || {}) });
    },
    dispose() {},
  };
  const legacyControl = {
    client,
    current: null,
    async read() {
      this.current = await client.call("control-status");
      return this.current;
    },
  };
  const startService = createServices({
    cfg: {
      routing: "queue",
      queue: { autoStart: false, autoRecover: false, startupTimeoutMs: 5_000 },
    },
    control: legacyControl,
    async ensureBroker(config) {
      assert.equal(config.queue.startPaused, true);
      assert.equal(config.queue.exclusiveStart, true);
      starts++;
      await startLifecycleProcess(t, dirs, { paused: true, buildHash });
      brokerRunning = true;
    },
  });
  const runtime = createControlCenterSystemControls({
    client,
    buildHash: () => buildHash,
    startStopped: () => startService.start(),
    authorize: (caller, scope) =>
      caller.globalRead &&
      (scope.kind === "global" || scope.projectId === "fixture-project"),
  });
  t.after(() => runtime.close());
  const httpFixture = await openHttp(t, null, {
    systemControls: runtime.handle,
  });
  const browser = new SystemControlsClient(
    httpFixture.origin,
    httpFixture.fetcher,
    memoryStorage(),
  );
  const stopped = await browser.status(globalScope);
  assert.equal(stopped.state, "available");
  assert.equal(stopped.snapshot.phase, "STOPPED");
  assert.equal(stopped.capabilities.start, true);
  const command = createSystemControlCommand(
    stopped,
    globalScope,
    "start",
    "durable-start-once",
  );
  const result = await browser.execute(command);
  assert.equal(result.state, "confirmed");
  assert.equal(result.snapshot.phase, "PAUSED");
  assert.notEqual(result.snapshot.instanceId, stopped.snapshot.instanceId);
  assert.equal(starts, 1);
  assert.equal(httpFixture.postCount, 1);

  const duplicate = await browser.execute(command);
  assert.equal(duplicate.state, "confirmed");
  assert.equal(
    starts,
    1,
    "durable start receipt prevents a second start callback",
  );
  assert.equal((await browser.receipt(command)).state, "confirmed");
  const anotherTab = new SystemControlsClient(
    httpFixture.origin,
    httpFixture.fetcher,
    memoryStorage(),
  );
  assert.equal((await anotherTab.execute(command)).state, "confirmed");
  assert.equal(
    starts,
    1,
    "a server-side durable receipt makes duplicate delivery idempotent",
  );
  const running = await browser.status(globalScope);
  assert.equal(running.snapshot.phase, "PAUSED");
  assert.equal(running.capabilities.start, false);
  assert.equal(running.capabilities.resume, true);
});

test("production STOPPED observation disables start for queued retained work", async (t) => {
  const dirs = sandbox(t);
  durable(
    path.join(dirs.queue, "queue-state.json"),
    {
      version: 1,
      paused: true,
      revision: 3,
      epoch: 1,
      blocked: null,
      active: null,
      lease: null,
      jobs: { retained: { state: "queued" } },
      lastClient: null,
      controlGeneration: 2,
      contextEpoch: 1,
    },
    true,
  );
  let startCalls = 0;
  const runtime = createSystemControlRuntime({
    client: {
      dir: dirs.queue,
      auth,
      async register() {
        throw Object.assign(new Error("offline"), {
          code: "QUEUE_NOT_RUNNING",
        });
      },
      async call() {
        throw Object.assign(new Error("offline"), {
          code: "QUEUE_NOT_RUNNING",
        });
      },
      dispose() {},
    },
    buildHash: () => "a".repeat(64),
    async startStopped() {
      startCalls++;
      throw new Error("must not start queued work");
    },
  });
  t.after(() => runtime.close());
  const api = createSystemControls({
    control: runtime.control,
    readReceipt: (input) => runtime.readReceipt(input),
    hasUnresolvedControl: () => runtime.hasUnresolvedControl(),
    authorize: () => true,
  });
  const status = await api.status(globalScope, principal);
  assert.equal(status.state, "available");
  assert.equal(status.snapshot.phase, "STOPPED");
  assert.equal(status.snapshot.unresolved, true);
  assert.equal(status.capabilities.start, false);
  const result = await api.execute(
    {
      version: SYSTEM_CONTROLS_API_VERSION,
      scope: globalScope,
      action: "start",
      requestId: "blocked-start",
      instanceId: status.snapshot.instanceId,
      expectedGeneration: status.snapshot.generation,
    },
    principal,
  );
  assert.equal(result.state, "conflict");
  assert.equal(result.code, "RECONCILIATION_REQUIRED");
  assert.equal(startCalls, 0);
});

test("offline status and first host CPU observation remain unknown, not zero", async (t) => {
  const api = createSystemControls({
    control: {
      async read() {
        throw Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
      },
      async execute() {
        throw new Error("offline");
      },
    },
    readReceipt: async () => null,
    hasUnresolvedControl: async () => false,
    authorize: () => true,
  });
  const status = await api.status(globalScope, principal);
  assert.equal(status.state, "unavailable");
  assert.equal(status.snapshot, null);
  assert.deepEqual(status.capabilities, {
    pause: false,
    drain: false,
    resume: false,
    start: false,
  });
  const html = renderSystemControls(status, globalScope, translations);
  assert.match(html, /Broker is offline/);
  assert.equal(
    (html.match(/data-system-control-action="[a-z]+"[^>]* disabled>/g) || [])
      .length,
    4,
  );

  const hostOs = {
    ...os,
    platform: () => "win32",
    hostname: () => "offline-fixture",
    cpus: () => [{ times: { user: 10, nice: 0, sys: 5, idle: 85, irq: 0 } }],
    totalmem: () => 100,
    freemem: () => 50,
    uptime: () => 20,
    loadavg: () => [0, 0, 0],
  };
  const collector = createCollector({ os: hostOs, now: () => 1_000 });
  const first = collector.read();
  assert.equal(first.host.cpuPercent, null);
  assert.equal(
    first.host.processCount,
    null,
    "unsupported host process count remains unknown",
  );
  assert.equal(first.readAt, 1_000);
});

test("HTTP POST is rejected by the session CSRF gate before the route can dispatch", async (t) => {
  const fixture = await startLifecycle(t);
  const ipc = createIpc(fixture.queue);
  const application = createApplication(fixture.queue, ipc);
  const httpFixture = await openHttp(t, application);
  const session = await httpFixture.fetcher(
    `${httpFixture.origin}/api/v1/console/session`,
  );
  const csrfToken = (await session.json()).csrfToken;
  const response = await httpFixture.fetcher(
    `${httpFixture.origin}/api/v1/console/system-controls`,
    {
      method: "POST",
      headers: {
        origin: "http://attacker.invalid",
        "content-type": "application/json",
        "x-fmcad-csrf": csrfToken,
      },
      body: JSON.stringify({}),
    },
  );
  assert.equal(response.status, 403);
  assert.equal(httpFixture.postCount, 1);
  assert.equal(ipc.calls.includes("pause"), false);
});

test("production HTTP routes project actions through the approved injected handler after CSRF", async (t) => {
  const fixture = await startLifecycle(t);
  const ipc = createIpc(fixture.queue);
  const api = createApplication(fixture.queue, ipc);
  const received = [];
  const composition = composeControlCenterService({
    readPort: null,
    resolvePrincipal: () => principal,
    projectActions: async (caller, body) => {
      received.push({ caller, body });
      return {
        version: 1,
        state: "ok",
        code: "PROJECT_ARCHIVED",
        projectId: "fixture-project",
      };
    },
  });
  t.after(() => composition.close());
  const httpFixture = await openHttp(t, api, {
    projectActions: composition.projectActions,
    resolvePrincipal: composition.resolvePrincipal,
  });
  const sessionResponse = await httpFixture.fetcher(
    `${httpFixture.origin}/api/v1/console/session`,
  );
  const { csrfToken } = await sessionResponse.json();
  const payload = {
    version: 1,
    action: "archive",
    projectId: "fixture-project",
    expectedRevision: { epoch: "fixture-revision", revision: 4 },
  };
  const response = await httpFixture.fetcher(
    `${httpFixture.origin}/api/v1/console/project-actions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fmcad-csrf": csrfToken,
      },
      body: JSON.stringify(payload),
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, "PROJECT_ARCHIVED");
  assert.equal(received.length, 1);
  assert.equal(received[0].caller.subject, principal.subject);
  assert.deepEqual(received[0].body, payload);
});

test("production HTTP reports missing System and project action ports as unavailable", async (t) => {
  const httpFixture = await openHttp(t, null);
  const browser = new SystemControlsClient(
    httpFixture.origin,
    httpFixture.fetcher,
    memoryStorage(),
  );
  await assert.rejects(browser.status(globalScope), {
    code: "SYSTEM_CONTROLS_UNAVAILABLE",
    status: 503,
  });
  const session = await httpFixture.fetcher(
    `${httpFixture.origin}/api/v1/console/session`,
  );
  const { csrfToken } = await session.json();
  const projectAction = await httpFixture.fetcher(
    `${httpFixture.origin}/api/v1/console/project-actions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fmcad-csrf": csrfToken,
      },
      body: JSON.stringify({ version: 1, action: "archive" }),
    },
  );
  assert.equal(projectAction.status, 503);
  assert.equal(
    (await projectAction.json()).code,
    "PROJECT_ACTIONS_UNAVAILABLE",
  );
});

test("project control scope cannot be used by a principal lacking that project", async (t) => {
  const fixture = await startLifecycle(t);
  const api = createApplication(fixture.queue, createIpc(fixture.queue));
  await assert.rejects(
    api.status({ kind: "project", projectId: "foreign-project" }, principal),
    { code: "CONTROL_FORBIDDEN" },
  );
});

import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type {
  ConsoleQueryPrincipal,
  ConsoleQueryHandler,
  ConsoleQueryRequest,
  ConsoleQueryRecord,
  ConsoleRevision,
} from "../packages/control-center/dist/contracts/query.js";
import type {
  ProjectActionRequest,
  ProjectActionResponse,
  AgentsProjectsLocaleText,
  AgentsProjectsQueryPort,
} from "../packages/control-center/dist/web/agents-projects.js";
import type {
  ProjectActionFreshState,
  ProjectActionsExecutor,
} from "../packages/control-center/dist/server/project-actions.js";
import type { ProjectHistorySnapshot } from "../packages/core/dist/domain/project-history.js";
import type { ProjectHistoryStore } from "../packages/core/dist/ports/project-history.js";
import type {
  ConsoleQueryClient as ConsoleQueryClientType,
  FetchLike,
} from "../packages/control-center/dist/web/api.js";
import {
  FIXTURE_NOW,
  fixturePrincipal,
  freshState,
  openHistory,
  projectRevision,
  registeredProject,
  setupProjects,
  type FreshStateProvider,
  type ProjectFixture,
} from "./control-center-test-support.js";

const repositoryRoot = process.cwd();
const loadModule = <T>(relativePath: string): T =>
  require(path.join(repositoryRoot, relativePath)) as T;
const projectActions = loadModule<
  typeof import("../packages/control-center/dist/server/project-actions.js")
>("packages/control-center/dist/server/project-actions.js");
const { createControlCenterHttpServer } = loadModule<
  typeof import("../packages/control-center/dist/server/http.js")
>("packages/control-center/dist/server/http.js");
const { ConsoleQueryClient } = loadModule<
  typeof import("../packages/control-center/dist/web/api.js")
>("packages/control-center/dist/web/api.js");
const { PROJECT_ACTIONS_ROUTE } = loadModule<
  typeof import("../packages/control-center/dist/contracts/project-actions.js")
>("packages/control-center/dist/contracts/project-actions.js");
const agentsProjects = loadModule<
  typeof import("../packages/control-center/dist/web/agents-projects.js")
>("packages/control-center/dist/web/agents-projects.js");

function createActions(
  fixture: ProjectFixture,
  readFreshState?: FreshStateProvider,
): ReturnType<typeof projectActions.createProjectActions> {
  const reads = new Map<string, number>();
  const currentReader: FreshStateProvider =
    readFreshState ??
    ((projectId) =>
      freshState(
        fixture.registry,
        projectId,
        projectRevision(fixture.registry, projectId),
      ));
  return projectActions.createProjectActions({
    registry: fixture.registry,
    openHistory: (entry) => openHistory(fixture.registry, entry),
    readFreshState: (projectId) => {
      const count = (reads.get(projectId) ?? 0) + 1;
      reads.set(projectId, count);
      return currentReader(projectId, count);
    },
    projectRevision: projectRevisionFromSnapshot,
    publishProjectChange: () => {},
    authorizeProjectWrite: (
      principal: ConsoleQueryPrincipal,
      projectId: string,
    ) => principal.projectIds.includes(projectId),
    now: () => FIXTURE_NOW,
  });
}

function projectRevisionFromSnapshot(
  snapshot: ProjectHistorySnapshot,
): ConsoleRevision {
  return loadModule<
    typeof import("../packages/node-adapters/dist/control-center/revisions.js")
  >(
    "packages/node-adapters/dist/control-center/revisions.js",
  ).consoleProjectRevision(snapshot);
}

function setProjectAliasRequest(
  projectId: string,
  expectedRevision: ConsoleRevision,
  alias: string,
): ProjectActionRequest {
  return {
    version: 1,
    action: "set-alias",
    projectId,
    expectedRevision,
    alias,
  };
}

function setAgentAliasRequest(
  projectId: string,
  expectedRevision: ConsoleRevision,
  identity: {
    readonly kind: "agent" | "client" | "session";
    readonly id: string;
  },
  alias: string,
): ProjectActionRequest {
  return {
    version: 1,
    action: "set-agent-alias",
    projectId,
    expectedRevision,
    identity,
    alias,
  };
}

function resetAgentAliasRequest(
  projectId: string,
  expectedRevision: ConsoleRevision,
  identity: {
    readonly kind: "agent" | "client" | "session";
    readonly id: string;
  },
): ProjectActionRequest {
  return {
    version: 1,
    action: "reset-agent-alias",
    projectId,
    expectedRevision,
    identity,
  };
}

function archiveRequest(
  projectId: string,
  expectedRevision: ConsoleRevision,
): ProjectActionRequest {
  return { version: 1, action: "archive", projectId, expectedRevision };
}

function restoreRequest(
  projectId: string,
  expectedRevision: ConsoleRevision,
): ProjectActionRequest {
  return { version: 1, action: "restore", projectId, expectedRevision };
}

function revisionOfResponse(response: ProjectActionResponse): ConsoleRevision {
  if (response.revision === null)
    throw new Error(`Action response ${response.code} omitted its revision`);
  return response.revision;
}

function reopenHistory(
  fixture: ProjectFixture,
  projectId: string,
): ProjectHistoryStore {
  return openHistory(
    fixture.registry,
    registeredProject(fixture.registry, projectId),
    { readOnly: true },
  );
}

function execute(
  actions: ReturnType<typeof projectActions.createProjectActions>,
  request: ProjectActionRequest,
  principal: ConsoleQueryPrincipal = fixturePrincipal,
): ProjectActionResponse {
  return actions.execute(principal, request);
}

async function unusedHttpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Loopback port allocation did not return a TCP address");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startActionHttp(
  testContext: TestContext,
  fixture: ProjectFixture,
  actions: ProjectActionsExecutor | null,
): Promise<string> {
  const port = await unusedHttpPort();
  const server = createControlCenterHttpServer({
    identity: {
      port,
      buildIdentity: "d".repeat(64),
      protocolVersion: 1,
      pid: process.pid,
      processBirth: "project-actions-test",
      instanceNonce: "e".repeat(64),
      probeSecret: "f".repeat(64),
    },
    query: unavailableQueryHandler,
    resolvePrincipal(session) {
      return {
        subject: session.subject,
        projectIds: fixture.registry
          .read()
          .projects.map((project) => project.projectId),
        globalRead: false,
      };
    },
    assets: [
      {
        path: "/index.html",
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html><body></body></html>",
      },
    ],
    projectActions: actions,
  });
  await server.start();
  testContext.after(() => server.close());
  return `http://localhost:${port}`;
}

const unavailableQueryHandler: ConsoleQueryHandler = {
  async snapshot() {
    throw new Error("Query route is not used by this HTTP action fixture");
  },
  async query() {
    throw new Error("Query route is not used by this HTTP action fixture");
  },
  async export() {
    throw new Error("Query route is not used by this HTTP action fixture");
  },
  async detail() {
    throw new Error("Query route is not used by this HTTP action fixture");
  },
  subscribe() {
    return null;
  },
};

async function actionClient(origin: string): Promise<ConsoleQueryClientType> {
  const home = await fetch(`${origin}/`);
  assert.equal(home.status, 200);
  const cookieHeader = home.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookieHeader)
    throw new Error("Control Center did not issue a session cookie");
  let cookie = cookieHeader;
  const fetcher: FetchLike = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cookie", cookie);
    if (init.method?.toUpperCase() === "POST") headers.set("Origin", origin);
    const response = await fetch(input, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0] ?? cookie;
    return response;
  };
  return new ConsoleQueryClient(origin, fetcher);
}

async function readObjectResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object HTTP response");
  return value as Record<string, unknown>;
}

test("project and agent aliases are durable display labels with exact identity and CAS", (t) => {
  const fixture = setupProjects(t, ["project-a", "project-b", "__proto__"]);
  const actions = createActions(fixture);
  const originalA = projectRevision(fixture.registry, "project-a");
  const originalB = projectRevision(fixture.registry, "project-b");
  const prototypeRevision = projectRevision(fixture.registry, "__proto__");

  const projectLabel = execute(
    actions,
    setProjectAliasRequest("project-a", originalA, "Assembly Alpha"),
  );
  assert.equal(projectLabel.state, "ok");
  assert.deepEqual(projectLabel.revision, {
    epoch: originalA.epoch,
    revision: originalA.revision + 1,
  });
  assert.deepEqual(projectRevision(fixture.registry, "project-b"), originalB);

  const agentLabel = execute(
    actions,
    setAgentAliasRequest(
      "project-a",
      revisionOfResponse(projectLabel),
      {
        kind: "agent",
        id: "agent:project-a",
      },
      "Research agent",
    ),
  );
  assert.equal(agentLabel.state, "ok");
  assert.equal(agentLabel.identity?.id, "agent:project-a");

  const resetAgent = execute(
    actions,
    resetAgentAliasRequest("project-a", revisionOfResponse(agentLabel), {
      kind: "agent",
      id: "agent:project-a",
    }),
  );
  assert.equal(resetAgent.state, "ok");
  assert.equal(resetAgent.alias, null);

  const prototypeLabel = execute(
    actions,
    setProjectAliasRequest("__proto__", prototypeRevision, "__proto__"),
  );
  assert.equal(prototypeLabel.state, "ok");
  assert.equal(prototypeLabel.projectId, "__proto__");
  const stale = execute(
    actions,
    setProjectAliasRequest("project-a", originalA, "stale write"),
  );
  assert.equal(stale.state, "stale");

  const history = reopenHistory(fixture, "project-a");
  try {
    assert.deepEqual(history.snapshot(FIXTURE_NOW).aliases, ["Assembly Alpha"]);
    assert.deepEqual(history.snapshot(FIXTURE_NOW).agentAliases, []);
  } finally {
    history.close();
  }
  t.diagnostic("Alias writes changed only project-local display metadata.");
});

test("archive rejects incomplete, stale, queued, active and unfenced sources", (t) => {
  const fixture = setupProjects(t, ["project-a"]);
  const revision = projectRevision(fixture.registry, "project-a");
  const base = freshState(fixture.registry, "project-a", revision);
  const cases: readonly {
    readonly name: string;
    readonly state: ProjectActionFreshState;
    readonly expected: "blocked" | "stale" | "unavailable";
  }[] = [
    {
      name: "stale queue source",
      state: freshState(fixture.registry, "project-a", revision, {
        sources: {
          queue: {
            ...base.sources.queue,
            state: "stale",
            observedAtMs: FIXTURE_NOW - 20_000,
          },
        },
      }),
      expected: "stale",
    },
    {
      name: "incomplete presence source",
      state: freshState(fixture.registry, "project-a", revision, {
        sources: {
          presence: {
            ...base.sources.presence,
            state: "partial",
            complete: false,
          },
        },
      }),
      expected: "blocked",
    },
    {
      name: "queued task",
      state: freshState(fixture.registry, "project-a", revision, {
        tasks: [
          {
            projectId: "project-a",
            id: "late-task",
            state: "queued",
            phase: "queued",
            mayHaveMutated: false,
          },
        ],
      }),
      expected: "blocked",
    },
    {
      name: "active presence",
      state: freshState(fixture.registry, "project-a", revision, {
        presence: [
          {
            projectId: "project-a",
            id: "agent:project-a",
            presence: "active",
            observedAtMs: FIXTURE_NOW,
          },
        ],
      }),
      expected: "blocked",
    },
    {
      name: "unmanaged presence writer",
      state: freshState(fixture.registry, "project-a", revision, {
        activityFence: { presenceWriters: "unknown" },
      }),
      expected: "unavailable",
    },
  ];

  for (const item of cases) {
    const result = execute(
      createActions(fixture, () => item.state),
      archiveRequest("project-a", revision),
    );
    assert.equal(result.state, item.expected, item.name);
    assert.equal(fixture.registry.lookup("project-a")?.monitoring, true);
  }
});

test("safe archive preserves the database, queue and results; restore starts no work", (t) => {
  const fixture = setupProjects(t, ["project-a"]);
  const actions = createActions(fixture);
  const project = fixture.projects.get("project-a");
  assert.ok(project);
  const outputBefore = fs.readFileSync(project.outputPath, "utf8");
  const queueBefore = fs.readFileSync(project.queueStatePath, "utf8");
  const initialRevision = projectRevision(fixture.registry, "project-a");

  const archived = execute(
    actions,
    archiveRequest("project-a", initialRevision),
  );
  assert.equal(archived.state, "ok");
  assert.equal(archived.monitoring, false);
  assert.ok(archived.archivedAtMs !== null);
  assert.equal(fixture.registry.lookup("project-a")?.monitoring, false);

  const readOnlyAlias = execute(
    actions,
    setProjectAliasRequest(
      "project-a",
      revisionOfResponse(archived),
      "must not write while archived",
    ),
  );
  assert.equal(readOnlyAlias.state, "blocked");

  const restored = execute(
    actions,
    restoreRequest("project-a", revisionOfResponse(archived)),
  );
  assert.equal(restored.state, "ok");
  assert.equal(restored.monitoring, true);
  assert.equal(restored.archivedAtMs, null);
  assert.equal(fs.readFileSync(project.outputPath, "utf8"), outputBefore);
  assert.equal(fs.readFileSync(project.queueStatePath, "utf8"), queueBefore);

  const history = reopenHistory(fixture, "project-a");
  try {
    assert.equal(history.snapshot(FIXTURE_NOW).eventCount, 1);
    assert.equal(history.snapshot(FIXTURE_NOW).lifecycle.monitoring, true);
  } finally {
    history.close();
  }
});

test("archive refuses a stale dialog and activity changing between authoritative reads", (t) => {
  const fixture = setupProjects(t, ["project-a"]);
  const revision = projectRevision(fixture.registry, "project-a");
  const current = freshState(fixture.registry, "project-a", revision);
  let reads = 0;
  const actions = createActions(fixture, (_projectId, readCount) => {
    reads = readCount;
    return readCount === 1
      ? current
      : freshState(fixture.registry, "project-a", revision, {
          tasks: [
            {
              projectId: "project-a",
              id: "new-job",
              state: "queued",
              phase: "queued",
              mayHaveMutated: false,
            },
          ],
        });
  });
  const raced = execute(actions, archiveRequest("project-a", revision));
  assert.equal(reads, 2);
  assert.equal(raced.state, "stale");
  assert.equal(raced.code, "ACTIVITY_CHANGED_DURING_ARCHIVE");
  assert.equal(fixture.registry.lookup("project-a")?.monitoring, true);

  const staleDialog = execute(
    createActions(fixture),
    archiveRequest("project-a", {
      ...revision,
      revision: revision.revision + 1,
    }),
  );
  assert.equal(staleDialog.state, "stale");
});

test("missing project database fails closed without recreating it", (t) => {
  const fixture = setupProjects(t, ["project-a"]);
  const project = registeredProject(fixture.registry, "project-a");
  const revision = projectRevision(fixture.registry, "project-a");
  const databasePath = path.join(
    project.path,
    ".cad",
    "control-center",
    "control-center.sqlite",
  );
  fs.unlinkSync(databasePath);

  const result = execute(
    createActions(fixture),
    archiveRequest("project-a", revision),
  );
  assert.equal(result.state, "unavailable");
  assert.equal(fixture.registry.lookup("project-a")?.monitoring, true);
  assert.equal(fs.existsSync(databasePath), false);
});

test("real Control Center HTTP route runs guarded alias, archive and restore actions", async (t) => {
  const fixture = setupProjects(t, ["project-a"]);
  const actions = createActions(fixture);
  const origin = await startActionHttp(t, fixture, actions.execute);
  const client = await actionClient(origin);
  const expectedRevision = projectRevision(fixture.registry, "project-a");

  const labeled = await client.projectAction({
    version: 1,
    action: "set-alias",
    projectId: "project-a",
    expectedRevision,
    alias: "HTTP Assembly",
  });
  assert.equal(PROJECT_ACTIONS_ROUTE, "/api/v1/console/project-actions");
  assert.equal(labeled.state, "ok");
  const archived = await client.projectAction({
    version: 1,
    action: "archive",
    projectId: "project-a",
    expectedRevision: revisionOfResponse(labeled),
  });
  assert.equal(archived.state, "ok");
  assert.equal(archived.monitoring, false);
  const restored = await client.projectAction({
    version: 1,
    action: "restore",
    projectId: "project-a",
    expectedRevision: revisionOfResponse(archived),
  });
  assert.equal(restored.state, "ok");
  assert.equal(restored.monitoring, true);

  const history = openHistory(
    fixture.registry,
    registeredProject(fixture.registry, "project-a"),
    { readOnly: true },
  );
  try {
    assert.deepEqual(history.snapshot(FIXTURE_NOW).aliases, ["HTTP Assembly"]);
    assert.equal(history.snapshot(FIXTURE_NOW).lifecycle.monitoring, true);
  } finally {
    history.close();
  }
});

test("project action HTTP route rejects invalid CSRF and unavailable backend", async (t) => {
  const fixture = setupProjects(t, ["project-a"]);
  const origin = await startActionHttp(t, fixture, null);
  const home = await fetch(`${origin}/`);
  const cookie = home.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Control Center did not issue a session cookie");
  const session = await fetch(`${origin}/api/v1/console/session`, {
    headers: { Cookie: cookie },
  });
  const sessionPayload = await readObjectResponse(session);
  const csrfToken = sessionPayload["csrfToken"];
  if (typeof csrfToken !== "string")
    throw new Error("Control Center did not issue a CSRF token");
  const requestBody = JSON.stringify({
    version: 1,
    action: "archive",
    projectId: "project-a",
    expectedRevision: projectRevision(fixture.registry, "project-a"),
  });

  const invalidCsrf = await fetch(`${origin}${PROJECT_ACTIONS_ROUTE}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: requestBody,
  });
  assert.equal(invalidCsrf.status, 403);
  assert.equal(
    (await readObjectResponse(invalidCsrf))["code"],
    "CSRF_REJECTED",
  );

  const noBackend = await fetch(`${origin}${PROJECT_ACTIONS_ROUTE}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "X-Fmcad-CSRF": csrfToken,
      "Content-Type": "application/json",
    },
    body: requestBody,
  });
  assert.equal(noBackend.status, 503);
  assert.equal(
    (await readObjectResponse(noBackend))["code"],
    "PROJECT_ACTIONS_UNAVAILABLE",
  );
});

test("agents/projects feature emits exact scoped requests and renders lifecycle-aware controls", async () => {
  const revision: ConsoleRevision = { epoch: "ui-project-epoch", revision: 3 };
  const project = {
    id: "project-a",
    name: "Assembly Alpha",
    projectId: "project-a",
    monitoring: true,
    archivedAtMs: null,
  };
  const calls: ProjectActionRequest[] = [];
  const query: AgentsProjectsQueryPort = {
    async snapshot(scope) {
      return {
        version: 1,
        revision,
        capturedAt: FIXTURE_NOW,
        scope,
        snapshotToken: "project-a-snapshot",
        sources: {},
      };
    },
    async query<Row extends ConsoleQueryRecord = ConsoleQueryRecord>(
      request: ConsoleQueryRequest,
    ) {
      return {
        version: 1,
        revision,
        capturedAt: FIXTURE_NOW,
        scope: request.scope,
        collection: request.collection,
        source: {
          state: "available",
          source: "fixture-query",
          observedAt: FIXTURE_NOW,
        },
        snapshotToken: request.snapshotToken,
        offset: request.offset ?? 0,
        limit: request.limit ?? 200,
        rows: [],
        total: 0,
        facets: {},
        aggregates: {},
      };
    },
    async detail(request) {
      return {
        version: 1,
        revision,
        state: "missing",
        artifactId: request.artifactId,
        kind: request.kind,
        content: null,
        offset: request.offset ?? 0,
        length: 0,
        totalLength: null,
      };
    },
  };
  const localeText: AgentsProjectsLocaleText = {
    t: (key) => agentsProjects.AGENTS_PROJECTS_MESSAGES[key],
    formatNumber: (value) => String(value),
    formatDate: (value) => new Date(value).toISOString(),
    formatDuration: (value) => `${value} ms`,
    subscribe: () => () => {},
  };
  const feature = agentsProjects.createAgentsProjectsFeature({
    query,
    actions: {
      async execute(request) {
        calls.push(request);
        return {
          version: 1,
          state: "ok",
          code: "PROJECT_ALIAS_UPDATED",
          projectId: request.projectId,
          revision,
          monitoring: true,
          archivedAtMs: null,
          alias: request.action === "set-alias" ? request.alias : null,
          reasons: [],
        };
      },
    },
    localeText,
    storage: null,
  });

  await feature.setProjectAlias("project-a", "Renamed assembly", revision);
  await feature.archiveProject("project-a", revision);
  assert.deepEqual(calls, [
    {
      version: 1,
      action: "set-alias",
      projectId: "project-a",
      alias: "Renamed assembly",
      expectedRevision: revision,
    },
    {
      version: 1,
      action: "archive",
      projectId: "project-a",
      expectedRevision: revision,
    },
  ]);

  const html = agentsProjects.renderProjectList({
    rows: [project],
    filter: "all",
    search: "",
    favorites: new Set(["project-a"]),
    revisions: new Map([["project-a", revision]]),
    localeText,
  });
  assert.match(html, /data-action="project-alias-save"/u);
  assert.match(html, /data-action="project-archive-open"/u);
  assert.match(html, /aria-pressed="true"/u);
});

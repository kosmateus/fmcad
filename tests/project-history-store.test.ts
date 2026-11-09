import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { ProjectHistoryProjectLifecycle } from "../packages/core/dist/domain/project-history.js";
import type { ProjectHistoryRevision } from "../packages/core/dist/domain/project-history.js";
import type {
  ProjectHistoryAgentAliasIdentity,
  ProjectHistoryStore,
} from "../packages/core/dist/ports/project-history.js";
import type { OpenProjectHistoryOptions } from "../packages/node-adapters/dist/persistence/project-history/sqlite.js";
import {
  FIXTURE_NOW,
  openHistory,
  registeredProject,
  setupProjects,
} from "./control-center-test-support.js";

const load = createRequire(__filename);
const repositoryRoot = process.cwd();
const historyAdapters = load(
  path.join(
    repositoryRoot,
    "packages/node-adapters/dist/persistence/project-history/index.js",
  ),
) as typeof import("../packages/node-adapters/dist/persistence/project-history/index.js");

function lifecycle(
  monitoring: boolean,
  archivedAtMs: number | null,
  updatedAtMs = FIXTURE_NOW,
): ProjectHistoryProjectLifecycle {
  return { monitoring, archivedAtMs, updatedAtMs };
}

function revisionAfter(store: ProjectHistoryStore): ProjectHistoryRevision {
  return store.snapshot(FIXTURE_NOW).revision;
}

test("project and exact-identity labels use one SQLite revision and remain project-local", (t) => {
  const fixture = setupProjects(t);
  const projectA = registeredProject(fixture.registry, "project-a");
  const projectB = registeredProject(fixture.registry, "project-b");
  const storeA = openHistory(fixture.registry, projectA);
  const storeB = openHistory(fixture.registry, projectB);
  t.after(() => {
    storeA.close();
    storeB.close();
  });

  const initial = storeA.snapshot(FIXTURE_NOW);
  const projectLabel = storeA.setProjectAlias(
    "Assembly Alpha",
    initial.revision,
    FIXTURE_NOW,
  );
  const agentIdentity: ProjectHistoryAgentAliasIdentity = {
    kind: "agent",
    id: "agent:project-a",
  };
  const agentLabel = storeA.setAgentAlias(
    agentIdentity,
    "Research agent",
    projectLabel.revision,
    FIXTURE_NOW,
  );

  assert.deepEqual(projectLabel.aliases, ["Assembly Alpha"]);
  assert.deepEqual(agentLabel.agentAliases, [
    { ...agentIdentity, alias: "Research agent", updatedAtMs: FIXTURE_NOW },
  ]);
  assert.equal(agentLabel.revision.revision, initial.revision.revision + 2);
  assert.deepEqual(storeB.snapshot(FIXTURE_NOW).aliases, [
    "Original project-b",
  ]);
  assert.deepEqual(storeB.snapshot(FIXTURE_NOW).agentAliases, []);
  assert.throws(
    () => storeA.setProjectAlias("Stale label", initial.revision, FIXTURE_NOW),
    { code: "HISTORY_REVISION_CONFLICT" },
  );
  assert.throws(
    () =>
      storeA.setAgentAlias(
        { kind: "client", id: "client-a" },
        "Stale label",
        projectLabel.revision,
        FIXTURE_NOW,
      ),
    { code: "HISTORY_REVISION_CONFLICT" },
  );
});

test("retained file records stay bound to their exact project and executed job", (t) => {
  const fixture = setupProjects(t, ["project-a", "project-b"]);
  const projectA = registeredProject(fixture.registry, "project-a");
  const projectB = registeredProject(fixture.registry, "project-b");
  const historyA = openHistory(fixture.registry, projectA, { readOnly: true });
  const historyB = openHistory(fixture.registry, projectB, { readOnly: true });
  t.after(() => {
    historyA.close();
    historyB.close();
  });

  const file = historyA.readSnapshot().fileReferences[0];
  assert.ok(file);
  assert.equal(file.jobId, "task-project-a");
  assert.equal(file.path, fixture.projects.get("project-a")?.outputPath);
  assert.equal(file.fileId, "output-file-project-a");
  assert.equal(file.artifactId, "output-artifact-project-a");
  assert.equal(file.event.identity.projectId.value, "project-a");
  assert.equal(
    historyB.readSnapshot().fileReferences[0]?.jobId,
    "task-project-b",
  );
  assert.notEqual(file.path, historyB.readSnapshot().fileReferences[0]?.path);
});

test("activity fence serializes competing writers and blocks archived labels", (t) => {
  const fixture = setupProjects(t, ["project-a"]);
  const project = registeredProject(fixture.registry, "project-a");
  const fenced = openHistory(fixture.registry, project, { busyTimeoutMs: 0 });
  const competing = openHistory(fixture.registry, project, {
    busyTimeoutMs: 0,
  });
  t.after(() => {
    competing.close();
    fenced.close();
  });

  const initial = fenced.snapshot(FIXTURE_NOW);
  const archived = fenced.withActivityFence((activity) => {
    assert.equal(activity.projectId, project.projectId);
    assert.equal(activity.databaseId, project.databaseId);
    assert.deepEqual(activity.snapshot(FIXTURE_NOW).revision, initial.revision);
    assert.throws(
      () =>
        competing.setProjectAlias("Late writer", initial.revision, FIXTURE_NOW),
      { code: "HISTORY_DB_BUSY" },
    );
    return activity.setLifecycleIfRevision(
      lifecycle(false, FIXTURE_NOW),
      initial.revision,
    );
  });

  assert.equal(archived.lifecycle.monitoring, false);
  assert.equal(archived.lifecycle.archivedAtMs, FIXTURE_NOW);
  const current = competing.snapshot(FIXTURE_NOW + 1);
  assert.throws(
    () =>
      competing.setProjectAlias(
        "Archived write",
        current.revision,
        FIXTURE_NOW + 1,
      ),
    { code: "HISTORY_PROJECT_ARCHIVED" },
  );
  assert.throws(
    () =>
      competing.setAgentAlias(
        { kind: "session", id: "session-a" },
        "Archived write",
        current.revision,
        FIXTURE_NOW + 1,
      ),
    { code: "HISTORY_PROJECT_ARCHIVED" },
  );
});

test("schema v6 migrates atomically to identity-label schema v7", (t) => {
  const fixture = setupProjects(t, ["project-a"]);
  const project = registeredProject(fixture.registry, "project-a");
  const initial = openHistory(fixture.registry, project);
  const initialRevision = revisionAfter(initial);
  initial.close();

  const databasePath = historyAdapters.projectHistoryDatabasePath(project.path);
  const database = new DatabaseSync(databasePath);
  database.exec("DROP TABLE agent_aliases; PRAGMA user_version = 6;");
  database.close();

  const migratedOptions: OpenProjectHistoryOptions = {
    projectRoot: project.path,
    projectId: project.projectId,
    expectedDatabaseId: project.databaseId,
    initializeIfMissing: false,
    now: () => FIXTURE_NOW,
  };
  const migrated = historyAdapters.openProjectHistoryStore(migratedOptions);
  t.after(() => migrated.close());
  assert.deepEqual(migrated.snapshot(FIXTURE_NOW).revision, initialRevision);
  assert.deepEqual(migrated.snapshot(FIXTURE_NOW).agentAliases, []);
  const labeled = migrated.setAgentAlias(
    { kind: "client", id: "client-a" },
    "Migrated label",
    initialRevision,
    FIXTURE_NOW,
  );
  assert.equal(labeled.agentAliases[0]?.alias, "Migrated label");

  const verify = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    verify.prepare("PRAGMA user_version").get()?.["user_version"],
    7,
  );
  verify.close();
});

test("missing registered history is not recreated and retained project files remain", (t) => {
  const fixture = setupProjects(t, ["project-a"]);
  const project = registeredProject(fixture.registry, "project-a");
  const outputBefore = fs.readFileSync(
    fixture.projects.get("project-a")!.outputPath,
    "utf8",
  );
  const queueBefore = fs.readFileSync(
    fixture.projects.get("project-a")!.queueStatePath,
    "utf8",
  );
  const databasePath = historyAdapters.projectHistoryDatabasePath(project.path);
  fs.unlinkSync(databasePath);

  assert.throws(
    () =>
      historyAdapters.openRegisteredProjectHistoryStore(fixture.registry, {
        projectId: project.projectId,
        projectRoot: project.path,
      }),
    { code: "HISTORY_DB_MISSING" },
  );
  assert.equal(fs.existsSync(databasePath), false);
  assert.equal(
    fs.readFileSync(fixture.projects.get("project-a")!.outputPath, "utf8"),
    outputBefore,
  );
  assert.equal(
    fs.readFileSync(fixture.projects.get("project-a")!.queueStatePath, "utf8"),
    queueBefore,
  );
});

test("quota exhaustion preserves unresolved history, foreign projects and committed revisions across reopen", (t) => {
  const fixture = setupProjects(t, ["quota-owner", "quota-foreign"]);
  const project = registeredProject(fixture.registry, "quota-owner");
  const foreign = openHistory(
    fixture.registry,
    registeredProject(fixture.registry, "quota-foreign"),
    { readOnly: true },
  );
  t.after(() => foreign.close());
  const protectedForeign = foreign.readSnapshot();
  const core = load(
    path.join(repositoryRoot, "packages/core/dist/index.js"),
  ) as typeof import("../packages/core/dist/index.js");
  let store = openHistory(fixture.registry, project);
  t.after(() => store.close());
  store.ingest([
    core.normalizeConsoleTelemetryJob(
      {
        id: "uncertain-job",
        requestId: "original-request",
        clientId: "quota-client",
        state: "needs_reconciliation",
        submittedAt: FIXTURE_NOW,
        request: {
          clientContext: { projectId: project.projectId },
          inputFiles: [],
        },
      },
      {
        sourceId: "quota-original-source",
        epoch: "quota-epoch",
        sequence: 1,
        revision: 1,
        observedAtMs: FIXTURE_NOW,
        readAtMs: FIXTURE_NOW,
        projectId: project.projectId,
        transport: "mcp",
      },
    ),
  ]);
  const protectedHistory = store.readSnapshot();
  assert.ok(protectedHistory.jobs.some((job) => job.jobId === "uncertain-job"));
  store.close();
  // Existing pages remain; the cap must refuse growth rather than discard evidence.
  store = openHistory(fixture.registry, project, { maxDatabasePages: 1 });
  let committed = store.snapshot(FIXTURE_NOW);
  let exhausted = false;
  for (let index = 0; index < 2000; index++) {
    committed = store.snapshot(FIXTURE_NOW);
    try {
      store.setAlias(`quota-${index}-${"x".repeat(110)}`, FIXTURE_NOW);
    } catch (error) {
      assert.equal((error as { code?: string }).code, "HISTORY_DB_FULL");
      exhausted = true;
      break;
    }
  }
  assert.equal(
    exhausted,
    true,
    "stable bounded fixture must reach the SQLite page cap",
  );
  assert.deepEqual(store.snapshot(FIXTURE_NOW), committed);
  store.close();
  store = openHistory(fixture.registry, project, { readOnly: true });
  const reopened = store.readSnapshot();
  assert.deepEqual(reopened.jobs, protectedHistory.jobs);
  assert.deepEqual(reopened.events, protectedHistory.events);
  assert.deepEqual(reopened.fileReferences, protectedHistory.fileReferences);
  assert.deepEqual(store.snapshot(FIXTURE_NOW), committed);
  assert.deepEqual(foreign.readSnapshot(), protectedForeign);
  assert.throws(() => store.listEvents({ limit: 501 }));
  assert.throws(() => store.readSnapshot(1));
});

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";
import type {
  ConsoleQueryPrincipal,
  ConsoleRevision,
} from "../packages/control-center/dist/contracts/query.js";
import type {
  ProjectActionFreshPresence,
  ProjectActionFreshSource,
  ProjectActionFreshState,
  ProjectActionFreshTask,
  ProjectActionsOptions,
} from "../packages/control-center/dist/server/project-actions.js";
import type { ProjectRegistryEntry } from "../packages/core/dist/domain/project-registry.js";
import type { ProjectHistoryStore } from "../packages/core/dist/ports/project-history.js";
import type { ProjectRegistryStore } from "../packages/core/dist/ports/project-registry.js";
import type { OpenProjectHistoryOptions } from "../packages/node-adapters/dist/persistence/project-history/sqlite.js";

const load = createRequire(__filename);
const repositoryRoot = process.cwd();
const loadModule = <T>(relativePath: string): T =>
  load(path.join(repositoryRoot, relativePath)) as T;

const core = loadModule<typeof import("../packages/core/dist/index.js")>(
  "packages/core/dist/index.js",
);
const controlCenter = loadModule<
  typeof import("../packages/control-center/dist/server/index.js")
>("packages/control-center/dist/server/index.js");
const historyAdapters = loadModule<
  typeof import("../packages/node-adapters/dist/persistence/project-history/index.js")
>("packages/node-adapters/dist/persistence/project-history/index.js");
const revisionAdapter = loadModule<
  typeof import("../packages/node-adapters/dist/control-center/revisions.js")
>("packages/node-adapters/dist/control-center/revisions.js");

export const FIXTURE_NOW = 1_798_027_200_000;

export const fixturePrincipal: ConsoleQueryPrincipal = {
  subject: "agents-projects-typescript-fixture",
  projectIds: ["project-a", "project-b", "__proto__"],
  globalRead: false,
};

export interface FixtureProjectFiles {
  readonly projectRoot: string;
  readonly queueDirectory: string;
  readonly queueStatePath: string;
  readonly outputPath: string;
}

export interface ProjectFixture {
  readonly root: string;
  readonly registry: ProjectRegistryStore;
  readonly projects: Map<string, FixtureProjectFiles>;
}

export interface FreshStateOverrides {
  readonly activityFence?: Partial<ProjectActionFreshState["activityFence"]>;
  readonly sources?: Partial<ProjectActionFreshState["sources"]>;
  readonly queue?: Partial<ProjectActionFreshState["queue"]>;
  readonly tasks?: readonly ProjectActionFreshTask[] | null;
  readonly presence?: readonly ProjectActionFreshPresence[] | null;
  readonly capturedAtMs?: number;
}

export type FreshStateProvider = (
  projectId: string,
  readCount: number,
) => ProjectActionFreshState;

export function registeredProject(
  registry: ProjectRegistryStore,
  projectId: string,
): ProjectRegistryEntry {
  const entry = registry.lookup(projectId);
  if (!entry) throw new Error(`Test project is not registered: ${projectId}`);
  return entry;
}

export function setupProjects(
  testContext: TestContext,
  projectIds: readonly string[] = ["project-a", "project-b", "__proto__"],
): ProjectFixture {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-project-actions-ts-"),
  );
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registryPath = path.join(root, "user", "projects.json");
  const registry = historyAdapters.openProjectRegistry({
    filePath: registryPath,
    now: () => FIXTURE_NOW,
  });
  const projects = new Map<string, FixtureProjectFiles>();

  for (const projectId of projectIds) {
    const projectRoot = path.join(
      root,
      "projects",
      projectId.replaceAll("/", "_"),
    );
    const outputPath = path.join(
      projectRoot,
      ".cad",
      "results",
      `task-${projectId}`,
      "stdout.txt",
    );
    const queueDirectory = path.join(root, "queue", projectId);
    const queueStatePath = path.join(queueDirectory, "queue-state.json");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.mkdirSync(queueDirectory, { recursive: true });
    fs.writeFileSync(outputPath, `retained output ${projectId}\n`);
    fs.writeFileSync(queueStatePath, `unchanged queue ${projectId}\n`);

    const store = historyAdapters.registerProjectHistoryStore(registry, {
      projectRoot,
      projectId,
      now: () => FIXTURE_NOW,
    });
    const initial = store.snapshot(FIXTURE_NOW);
    store.setProjectAlias(
      `Original ${projectId}`,
      initial.revision,
      FIXTURE_NOW,
    );
    const outputHash = createHash("sha256")
      .update(fs.readFileSync(outputPath))
      .digest("hex");
    store.ingest([
      core.normalizeConsoleTelemetryJob(
        {
          id: `task-${projectId}`,
          requestId: `request-${projectId}`,
          clientId: `mcp:${projectId}`,
          state: "succeeded",
          submittedAt: FIXTURE_NOW - 20,
          startedAt: FIXTURE_NOW - 10,
          finishedAt: FIXTURE_NOW,
          request: {
            requestId: `request-${projectId}`,
            clientId: `mcp:${projectId}`,
            transport: "mcp",
            phased: false,
            clientContext: {
              projectId,
              sessionId: `session-${projectId}`,
              agentId: `agent:${projectId}`,
              purpose: "Isolated project action contract test",
            },
            inputFiles: [],
          },
          outputFiles: [
            {
              path: outputPath,
              fileId: `output-file-${projectId}`,
              artifactId: `output-artifact-${projectId}`,
              sha256: outputHash,
              provenance: "isolated-project-action-fixture",
            },
          ],
        },
        {
          sourceId: `queue:${projectId}`,
          epoch: `queue-epoch-${projectId}`,
          sequence: 1,
          revision: 1,
          observedAtMs: FIXTURE_NOW,
          readAtMs: FIXTURE_NOW,
          projectId,
          transport: "mcp",
        },
      ),
    ]);
    store.close();
    projects.set(projectId, {
      projectRoot,
      queueDirectory,
      queueStatePath,
      outputPath,
    });
  }

  return { root, registry, projects };
}

export function openHistory(
  registry: ProjectRegistryStore,
  project: ProjectRegistryEntry,
  options: Partial<OpenProjectHistoryOptions> = {},
): ProjectHistoryStore {
  return historyAdapters.openRegisteredProjectHistoryStore(registry, {
    projectId: project.projectId,
    projectRoot: project.path,
    now: () => FIXTURE_NOW,
    ...options,
  });
}

export function projectRevision(
  registry: ProjectRegistryStore,
  projectId: string,
): ConsoleRevision {
  const project = registeredProject(registry, projectId);
  const store = openHistory(registry, project, { readOnly: true });
  try {
    return revisionAdapter.consoleProjectRevision(store.snapshot(FIXTURE_NOW));
  } finally {
    store.close();
  }
}

export function freshState(
  registry: ProjectRegistryStore,
  projectId: string,
  revision: ConsoleRevision,
  overrides: FreshStateOverrides = {},
): ProjectActionFreshState {
  const project = registeredProject(registry, projectId);
  const source = (name: string): ProjectActionFreshSource => ({
    state: "available",
    complete: true,
    sourceId: `fixture:${projectId}:${name}`,
    epoch: `fixture-epoch-${name}`,
    revision: 1,
    observedAtMs: FIXTURE_NOW,
  });
  return {
    projectId,
    activityFence: {
      projectId,
      databaseId: project.databaseId,
      queueAdmission: "project-history",
      presenceWriters: "project-history",
      ...overrides.activityFence,
    },
    revision,
    capturedAtMs: overrides.capturedAtMs ?? FIXTURE_NOW,
    sources: {
      tasks: source("tasks"),
      queue: source("queue"),
      presence: source("presence"),
      ...overrides.sources,
    },
    queue: {
      state: "free",
      unresolved: false,
      openPhases: [],
      ...overrides.queue,
    },
    tasks: overrides.tasks ?? [],
    presence: overrides.presence ?? [],
  };
}

export function createProjectActions(
  fixture: ProjectFixture,
  readFreshState: FreshStateProvider = (projectId) =>
    freshState(
      fixture.registry,
      projectId,
      projectRevision(fixture.registry, projectId),
    ),
): ReturnType<typeof controlCenter.createProjectActions> {
  const readCounts = new Map<string, number>();
  const options: ProjectActionsOptions = {
    registry: fixture.registry,
    openHistory: (project) => openHistory(fixture.registry, project),
    readFreshState: (projectId) => {
      const readCount = (readCounts.get(projectId) ?? 0) + 1;
      readCounts.set(projectId, readCount);
      return readFreshState(projectId, readCount);
    },
    projectRevision: (snapshot) =>
      revisionAdapter.consoleProjectRevision(snapshot),
    publishProjectChange: () => {},
    authorizeProjectWrite: (principal: ConsoleQueryPrincipal, projectId) =>
      principal.projectIds.includes(projectId),
    now: () => FIXTURE_NOW,
  };
  return controlCenter.createProjectActions(options);
}

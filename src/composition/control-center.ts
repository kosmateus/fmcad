import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import path from "node:path";
import type {
  ControlCenterComposition,
  ControlCenterCompositionContext,
} from "../../packages/control-center/src/server/composition.js";
import type { ProjectRegistryOptions } from "../../packages/node-adapters/src/persistence/project-history/registry.js";
import type { PassiveConsoleOptions } from "../../packages/node-adapters/src/control-center/passive-runtime.js";

const runtimeRequire = createRequire(__filename);
const server = runtimeRequire(
  "../control-center/server",
) as typeof import("../../packages/control-center/src/server/index.js");
const resources = runtimeRequire(
  "../control-center/resources",
) as typeof import("../../packages/control-center/src/resources/index.js");
const projects = runtimeRequire(
  "../node-adapters/persistence/project-history/registry.js",
) as typeof import("../../packages/node-adapters/src/persistence/project-history/registry.js");
const queries = runtimeRequire(
  "../node-adapters/control-center/read-port.js",
) as typeof import("../../packages/node-adapters/src/control-center/read-port.js");
const telemetry = runtimeRequire(
  "../node-adapters/control-center/passive-runtime.js",
) as typeof import("../../packages/node-adapters/src/control-center/passive-runtime.js");
const history = runtimeRequire(
  "../node-adapters/persistence/project-history/sqlite.js",
) as typeof import("../../packages/node-adapters/src/persistence/project-history/sqlite.js");
const projectActions = runtimeRequire(
  "../control-center/server/project-actions.js",
) as typeof import("../../packages/control-center/src/server/project-actions.js");
const activity = runtimeRequire(
  "../node-adapters/control-center/project-activity.js",
) as typeof import("../../packages/node-adapters/src/control-center/project-activity.js");
const queue = runtimeRequire("../../queue-connection.js") as {
  queueDirectory(): string;
};
const locks = runtimeRequire("../../console-locks.js") as {
  inspectLocks: PassiveConsoleOptions["inspectLocks"];
};

/** Storage locations can be isolated without substituting the production readers. */
export interface ControlCenterStorageOptions {
  readonly registry?: ProjectRegistryOptions;
  readonly queueDirectory?: string;
  readonly openCodePresenceDirectory?: string;
}

/** Compose real registered histories and passive observations; never starts CAD work. */
export function createControlCenterComposition(
  context: ControlCenterCompositionContext,
  storage: ControlCenterStorageOptions = {},
): ControlCenterComposition {
  // Verify the installation before opening any user data.
  const assets = resources.loadConsoleHttpAssets(context.installationRoot);
  const registry = projects.openProjectRegistry(storage.registry);
  const queueDirectory = storage.queueDirectory ?? queue.queueDirectory();
  const adapter = queries.createConsoleQueryNodeAdapter({
    registry,
    queueDirectory,
    telemetry: telemetry.createPassiveConsoleTelemetry({
      registry,
      queueDirectory,
      inspectLocks: locks.inspectLocks,
      ...(storage.openCodePresenceDirectory !== undefined
        ? { openCodePresenceDirectory: storage.openCodePresenceDirectory }
        : {}),
    }),
  });
  const actions = projectActions.createProjectActions({
    registry,
    openHistory: (project) =>
      history.openRegisteredProjectHistoryStore(registry, {
        projectId: project.projectId,
        projectRoot: project.path,
        readOnly: false,
      }),
    readFreshState: activity.createProjectActivityReader({
      registry,
      queueDirectory,
      projectRevision: (snapshot) => adapter.revisions.observeProject(snapshot),
      ...(storage.openCodePresenceDirectory !== undefined
        ? { openCodePresenceDirectory: storage.openCodePresenceDirectory }
        : {}),
    }),
    projectRevision: (snapshot) => adapter.revisions.observeProject(snapshot),
    publishProjectChange: (snapshot) =>
      adapter.revisions.publishProjectCommit(snapshot),
    authorizeProjectWrite: (principal, projectId) =>
      principal.projectIds.includes(projectId),
  });
  let controls:
    | {
        handle: NonNullable<ControlCenterComposition["systemControls"]>;
        close(): void;
      }
    | undefined;
  // Isolated readers must never connect to a different, default broker directory.
  const defaultStorage =
    storage.queueDirectory === undefined && storage.registry === undefined;
  try {
    return server.composeControlCenterService({
      readPort: adapter.readPort,
      projectActions: actions.execute,
      ...(defaultStorage
        ? {
            systemControls: async (
              request: Parameters<
                NonNullable<ControlCenterComposition["systemControls"]>
              >[0],
            ) => {
              if (!controls) {
                const { loadConfig } = runtimeRequire("../../config.js");
                const { createControlCenterSystemControlsRuntime } =
                  runtimeRequire("../../control-center-system-controls.cjs");
                controls = createControlCenterSystemControlsRuntime(
                  loadConfig().cfg,
                  () =>
                    registry
                      .read()
                      .projects.map((project) => project.projectId),
                );
              }
              return controls!.handle(request);
            },
          }
        : {}),
      assets,
      resolvePrincipal: (session) => ({
        subject: session.subject,
        projectIds: registry
          .read()
          .projects.map((project) => project.projectId),
        globalRead: true,
      }),
      subscribeRevisions: (listener) => adapter.revisions.subscribe(listener),
      close: () => {
        controls?.close();
        adapter.close();
      },
    });
  } catch (error) {
    adapter.close();
    throw error;
  }
}

/** Shared standalone/OpenCode launch path; the installed service owns its lifetime. */
export async function ensureControlCenter(port: number): Promise<void> {
  const runtime = runtimeRequire(
    "../config-platform/runtime-paths.js",
  ) as typeof import("../../packages/node-adapters/src/config-platform/runtime-paths.js");
  const paths = runtime.resolveRuntimePaths({ anchor: __filename });
  await server.ensureService({
    port,
    installationRoot: paths.installation,
    buildIdentity: runtime.runtimeBuildIdentity(paths),
    processEntrypoint: path.join(
      paths.installation,
      "src/dist/control-center/server/process-main.js",
    ),
    compositionModule: path.join(
      paths.installation,
      "src/dist/composition/control-center.js",
    ),
  });
}

/** Resolve an explicit registered identity before starting the shared service. */
export async function openControlCenter(options: {
  readonly port: number;
  readonly projectPath?: string;
}): Promise<{ url: string; projectId: string | null; dispose(): void }> {
  let projectId: string | null = null;
  if (options.projectPath !== undefined) {
    const canonicalPath = realpathSync(options.projectPath);
    const matches = projects
      .openProjectRegistry()
      .read()
      .projects.filter((project) => project.path === canonicalPath);
    if (matches.length !== 1) {
      throw Object.assign(
        new Error(
          matches.length === 0
            ? "The project is not registered with Control Center"
            : "The project path has multiple registered identities",
        ),
        {
          code:
            matches.length === 0
              ? "CONTROL_CENTER_PROJECT_UNREGISTERED"
              : "CONTROL_CENTER_PROJECT_AMBIGUOUS",
        },
      );
    }
    projectId = matches[0]!.projectId;
  }
  await ensureControlCenter(options.port);
  const url = new URL(`http://localhost:${options.port}/`);
  if (projectId !== null) url.searchParams.set("project", projectId);
  return {
    url: url.href,
    projectId,
    dispose() {
      // The shared detached service owns its lifetime; this caller owns no handles.
    },
  };
}

export { createMcpStdioTelemetry } from "./control-center-telemetry.js";

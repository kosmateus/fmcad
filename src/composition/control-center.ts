import { createRequire } from "node:module";
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
  try {
    return server.composeControlCenterService({
      readPort: adapter.readPort,
      assets,
      resolvePrincipal: (session) => ({
        subject: session.subject,
        projectIds: registry
          .read()
          .projects.map((project) => project.projectId),
        globalRead: true,
      }),
      subscribeRevisions: (listener) => adapter.revisions.subscribe(listener),
      close: () => adapter.close(),
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

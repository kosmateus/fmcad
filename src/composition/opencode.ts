import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { createFmcad, createCatalogServices } from "../api";
import type {
  Dependencies,
  Presence,
} from "../../packages/opencode-adapter/src/shared/contracts";

const runtimeRequire = createRequire(__filename);

/** Called only by the selected host entrypoint. Construction never starts services. */
export function dependencies(): Dependencies {
  const deps: Dependencies = {
    catalog: createCatalogServices(),
    create: createFmcad,
    instanceID: randomUUID(),
    requestID: randomUUID,
    clientID: (session, agent) =>
      "opencode:" +
      createHash("sha256")
        .update(session + ":" + agent)
        .digest("hex")
        .slice(0, 40),
    config(directory, options) {
      const {
        loadConfig,
      }: {
        loadConfig(options: unknown): {
          cfg: ReturnType<Dependencies["config"]>;
        };
      } = require("../config");
      const loaded = loadConfig({ cwd: directory });
      return {
        ...loaded.cfg,
        ...(options["config"] as Partial<typeof loaded.cfg> | undefined),
      };
    },
    presence(directory) {
      const {
        createReporter,
      }: {
        createReporter(directory: string): Presence | null;
      } = require("../opencode/presence.cjs");
      try {
        return createReporter(directory);
      } catch {
        return null;
      }
    },
    diagnostic(message) {
      process.stderr.write("fmcad: " + message + "\n");
    },
  };
  deps.ensureWeb = async () => {
    const cfg = deps.config(process.cwd(), {});
    const runtimePaths = runtimeRequire("../config-platform/runtime-paths") as {
      resolveRuntimePaths(options: { anchor: string }): {
        installation: string;
      };
      runtimeBuildIdentity(paths: { installation: string }): string;
    };
    const paths = runtimePaths.resolveRuntimePaths({ anchor: __filename });
    const controlCenter = runtimeRequire("../control-center/server") as {
      ensureService(options: {
        port: number;
        installationRoot: string;
        buildIdentity: string;
        processEntrypoint: string;
        compositionModule: string;
      }): Promise<unknown>;
    };
    await controlCenter.ensureService({
      port: cfg.controlCenter.port,
      installationRoot: paths.installation,
      buildIdentity: runtimePaths.runtimeBuildIdentity(paths),
      processEntrypoint: path.join(
        paths.installation,
        "src/dist/control-center/server/process-main.js",
      ),
      compositionModule: path.join(
        paths.installation,
        "src/dist/composition/control-center.js",
      ),
    });
  };
  return deps;
}

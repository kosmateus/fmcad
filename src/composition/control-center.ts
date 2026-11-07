import { createRequire } from "node:module";

interface ControlCenterCompositionContext {
  readonly installationRoot: string;
}

interface ConsoleHttpAsset {
  readonly path: string;
  readonly contentType: string;
  readonly body: Uint8Array;
}

const runtimeRequire = createRequire(__filename);
const server = runtimeRequire("../control-center/server") as {
  composeControlCenterService(dependencies: {
    readPort: null;
    assets: readonly ConsoleHttpAsset[];
  }): unknown;
};
const resources = runtimeRequire("../control-center/resources") as {
  loadConsoleHttpAssets(installationRoot: string): readonly ConsoleHttpAsset[];
};

/** Serve verified installed assets while unavailable project data stays explicit. */
export function createControlCenterComposition(
  context: ControlCenterCompositionContext,
): unknown {
  return server.composeControlCenterService({
    readPort: null,
    assets: resources.loadConsoleHttpAssets(context.installationRoot),
  });
}

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const { buildBridgeScript: build } = load(
  "../fusion-transport/bridge",
) as typeof import("../../packages/node-adapters/src/fusion-transport/bridge");
const { resolveRuntimePaths } = load(
  "../config-platform",
) as typeof import("../../packages/node-adapters/src/config-platform/runtime-paths");
/** Shared source for public preparation and the physical broker adapter. */
export function addinBridgeSource(): string {
  const { assets, runtime } = resolveRuntimePaths({ anchor: __filename });
  return (
    fs.readFileSync(
      path.join(runtime, "fmcad/adapters/fusion/identity.py"),
      "utf8",
    ) +
    "\n" +
    fs.readFileSync(path.join(assets, "addin-bridge.py"), "utf8")
  );
}

export function buildBridgeScript(
  toolName: string,
  request: Record<string, unknown>,
): string {
  return build(toolName, request, addinBridgeSource());
}

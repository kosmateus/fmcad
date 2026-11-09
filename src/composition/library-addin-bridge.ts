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
/** Asset bytes and ordering are part of the checked bridge program identity. */
export function buildBridgeScript(
  toolName: string,
  request: Record<string, unknown>,
): string {
  const assets = resolveRuntimePaths({ anchor: __filename }).assets;
  const source =
    fs.readFileSync(path.join(assets, "cad/identity.py"), "utf8") +
    "\n" +
    fs.readFileSync(path.join(assets, "addin-bridge.py"), "utf8");
  return build(toolName, request, source);
}

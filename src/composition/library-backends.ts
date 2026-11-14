import { McpClient, type CompatibilityServer } from "./library-client";
import { AddinClient } from "./library-addin-client";
export interface BackendConstructors<T> {
  McpClient?: new (server: CompatibilityServer) => T;
  AddinClient?: new (server: CompatibilityServer) => T;
}
export function createBackend(server: CompatibilityServer): McpClient;
export function createBackend<T>(
  server: CompatibilityServer,
  constructors: BackendConstructors<T>,
): T | McpClient;
export function createBackend<T>(
  server: CompatibilityServer,
  constructors: BackendConstructors<T> = {},
): T | McpClient {
  if (server?.["routing"] === "direct")
    throw Object.assign(
      new Error(
        "routing=direct is no longer supported; use the shared fmcad broker",
      ),
      { code: "UNSUPPORTED_ROUTING" },
    );
  const backend = server["backend"] || "mcp";
  if (backend === "mcp")
    return new (constructors.McpClient || McpClient)(server);
  if (backend === "addin")
    return new (constructors.AddinClient || AddinClient)(server);
  throw new Error("Unknown backend: " + (backend as string));
}

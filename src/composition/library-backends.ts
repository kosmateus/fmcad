import type { McpClient, CompatibilityServer } from "./library-client";
import { AddinClient } from "./library-addin-client";
import { assertAutodeskFusionBackend } from "../../packages/core/src/domain/physical-backend";
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
  assertAutodeskFusionBackend({
    backend: server["backend"],
    url: server["url"],
  });
  const backend = server["backend"] || "addin";
  if (backend === "addin")
    return new (constructors.AddinClient || AddinClient)(server);
  throw new Error("Unknown backend: " + (backend as string));
}

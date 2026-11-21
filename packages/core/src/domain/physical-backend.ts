/** Admission for new physical clients; historical record decoding stays separate. */
export function assertAutodeskFusionBackend(server: {
  backend?: unknown;
  url?: unknown;
}): void {
  if (server.backend !== undefined && server.backend !== "addin")
    throw Object.assign(
      new Error(
        "Unsupported physical backend; use autodesk-fusion-mcp on port 8765 (backend=addin)",
      ),
      { code: "UNSUPPORTED_BACKEND" },
    );
  if (typeof server.url === "string") {
    // Inspect only the HTTP authority; paths and query values are not ports.
    // Keep this domain rule independent of host URL implementations.
    const authority = /^https?:\/\/([^/?#]*)/i.exec(server.url)?.[1];
    if (authority && /:0*27182$/.test(authority))
      throw Object.assign(
        new Error(
          "Native Fusion MCP on port 27182 is unsupported; configure autodesk-fusion-mcp explicitly",
        ),
        { code: "UNSUPPORTED_BACKEND" },
      );
  }
}

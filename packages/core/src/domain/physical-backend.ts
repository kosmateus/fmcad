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
    if (
      /[\u0000-\u0020\u007f\\]/.test(server.url) ||
      !/^https?:\/\/[^/?#]+/i.test(server.url)
    )
      throw Object.assign(
        new Error(
          "Unsupported endpoint spelling; configure an explicit autodesk-fusion-mcp HTTP(S) URL without whitespace or backslashes",
        ),
        { code: "UNSUPPORTED_BACKEND" },
      );
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

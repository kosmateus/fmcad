#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";

try {
  const installation = path.resolve(__dirname, "..");
  const packaged = path.join(
    installation,
    "dist/src/dist/entrypoints/mcp-stdio.js",
  );
  const nested = path.join(installation, "src/dist/entrypoints/mcp-stdio.js");
  const entrypoint: unknown = createRequire(__filename)(
    fs.existsSync(packaged) ? packaged : nested,
  );
  if (
    typeof entrypoint !== "object" ||
    entrypoint === null ||
    !("startStdio" in entrypoint) ||
    typeof entrypoint.startStdio !== "function"
  ) {
    throw new TypeError("Installed MCP entrypoint is missing startStdio");
  }
  entrypoint.startStdio(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
}

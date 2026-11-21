#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const installation = path.resolve(__dirname, "..");
const packaged = path.join(installation, "dist/src/dist/entrypoints/cli.js");
const nested = path.join(installation, "src/dist/entrypoints/cli.js");
const entrypoint: unknown = createRequire(__filename)(
  fs.existsSync(packaged) ? packaged : nested,
);
if (
  typeof entrypoint !== "object" ||
  entrypoint === null ||
  !("main" in entrypoint) ||
  typeof entrypoint.main !== "function"
) {
  throw new TypeError("Installed CLI entrypoint is missing main");
}
entrypoint.main(process.argv.slice(2));

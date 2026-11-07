#!/usr/bin/env node
try {
  const path = require("node:path");
  const fs = require("node:fs");
  const installation = path.resolve(__dirname, "..");
  const packaged = path.join(
    installation,
    "dist/src/dist/entrypoints/mcp-stdio.js",
  );
  const nested = path.join(installation, "src/dist/entrypoints/mcp-stdio.js");
  require(fs.existsSync(packaged) ? packaged : nested).startStdio(
    process.argv.slice(2),
  );
} catch (error) {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
}

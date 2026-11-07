"use strict";

// Compatibility launcher to the emitted TypeScript autostart composition.
const path = require("node:path");
const runtime = require(
  path.join(__dirname, "dist/entrypoints/autostart-worker.js"),
);

module.exports = runtime;

if (require.main === module) {
  runtime.main().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
}

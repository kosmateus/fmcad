"use strict";

// Compatibility launcher to the emitted TypeScript worker composition root.
const path = require("node:path");
const runtime = require(path.join(__dirname, "dist/entrypoints/worker.js"));

module.exports = runtime;

if (require.main === module) {
  runtime.run(process.argv[2]).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `ERROR ${error.code || "WORKER_ERROR"}: ${error.message}\n`,
      );
      process.exitCode = 1;
    },
  );
}

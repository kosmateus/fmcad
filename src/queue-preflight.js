"use strict";

// Compatibility launcher to the emitted TypeScript broker preflight classifier.
const path = require("node:path");
module.exports = require(
  path.join(__dirname, "dist/entrypoints/queue-preflight.js"),
);

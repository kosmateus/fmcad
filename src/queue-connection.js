"use strict";

// Compatibility launcher to the emitted TypeScript queue IPC adapter.
const path = require("node:path");
module.exports = require(
  path.join(__dirname, "dist/entrypoints/queue-connection.js"),
);

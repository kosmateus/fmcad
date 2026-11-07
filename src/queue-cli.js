"use strict";

// Compatibility launcher to the emitted TypeScript queue command adapter.
const path = require("node:path");
module.exports = require(path.join(__dirname, "dist/entrypoints/queue-cli.js"));

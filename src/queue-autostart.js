"use strict";

// Compatibility launcher to the emitted TypeScript queue autostart lifecycle.
const path = require("node:path");
module.exports = require(
  path.join(__dirname, "dist/entrypoints/queue-autostart.js"),
);

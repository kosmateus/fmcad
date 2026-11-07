"use strict";
// Bootstrap only. Build compiles the strict TypeScript staging implementation first.
const path = require("node:path");
require("../dist/scripts/devtools/stage-core.js").stageCore(
  path.resolve(__dirname, ".."),
  process.argv.includes("--identity-only"),
);

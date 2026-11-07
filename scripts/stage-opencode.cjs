"use strict";
// Bootstrap only; the strict TypeScript devtools build owns staging.
const path = require("node:path");
require("../dist/scripts/devtools/stage-opencode.js").stageOpenCode(
  path.resolve(__dirname, ".."),
);

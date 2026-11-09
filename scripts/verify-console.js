"use strict";
// Production browser tests own screenshots, traces and network evidence. Run
// npm run test:control-center:e2e to build and typecheck before this same suite.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--test",
    "tests/browser-network-evidence.test.ts",
    "tests/control-center-browser-e2e.test.mts",
    "tests/control-center-production-browser.test.mts",
  ],
  { cwd: path.resolve(__dirname, ".."), env: process.env, stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;

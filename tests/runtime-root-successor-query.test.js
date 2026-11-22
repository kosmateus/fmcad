"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { runtimeRootSuccessorQueryPython } = require("../dist/src/dist/node-adapters/execution/runtime-root-successor-query");

test("private successor query executes real pinned PR4 SQLite guards offline", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-successor-query-"));
  fs.chmodSync(directory, 0o700);
  const fragment = path.join(directory, "query.py");
  fs.writeFileSync(fragment, runtimeRootSuccessorQueryPython, { mode: 0o600 });
  const result = spawnSync(process.env.FMCAD_TEST_PYTHON || "python3", [
    "-I", "-S", "-B",
    path.join(__dirname, "fixtures/runtime-root-successor/check_query.py"),
    path.join(__dirname, "fixtures/runtime-root-successor/native-pr4.zip"),
    fragment, directory,
  ], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 26 tests/);
  assert.match(result.stderr, /\nOK\s*$/);
  assert.equal(result.stdout, "");
  // Keep owned fixture artifacts on failures; successful cases need no recovery.
  fs.rmSync(directory, { recursive: true, force: true });
});

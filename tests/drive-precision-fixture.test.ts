import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

test("FAKE precision fixture separates stage evidence and stops after unproven restore", () => {
  const result = spawnSync(
    "python3",
    ["-B", path.join(process.cwd(), "tests/drive_precision_fixture_test.py")],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ownedAutoloadLaunchNative } from "../packages/node-adapters/src/execution/owned-autoload-launch-native";

test("owned lineage proves historical PID reuse without granting current process access", () => {
  const result = spawnSync(
    "python3",
    [path.resolve("tests/fixtures/owned-historical-process.py")],
    { input: ownedAutoloadLaunchNative(), encoding: "utf8", timeout: 10_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.SDK, 0);
  assert.equal(evidence.cases.length, 12);
});

test("owned kernel inventory validates ABI, exact self-birth and complete bounded records", () => {
  const result = spawnSync(
    "python3",
    [path.resolve("tests/fixtures/owned-process-inventory.py")],
    { input: ownedAutoloadLaunchNative(), encoding: "utf8", timeout: 10_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.SDK, 0);
  assert.equal(evidence.cases.length, 13);
});

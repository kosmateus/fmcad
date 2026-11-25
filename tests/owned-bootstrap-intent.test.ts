import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ownedAutoloadLaunchNative } from "../packages/node-adapters/src/execution/owned-autoload-launch-native";

test("generated owned launch publishes receipt names within the pinned directory", () => {
  const result = spawnSync(
    "python3",
    [path.resolve("tests/fixtures/owned-bootstrap-intent.py")],
    {
      input: ownedAutoloadLaunchNative(),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.SDK, 0);
  assert.equal(evidence.nativeProcessControl, 0);
  assert.deepEqual(evidence.receiptNames, ["entry.json", "returned.json"]);
});

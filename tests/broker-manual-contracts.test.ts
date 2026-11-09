import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { descriptors } = load("./src/queue-cli") as {
  descriptors: Readonly<Record<string, unknown>>;
};
const { manuals } = load(
  "./src/broker-manual",
) as typeof import("../src/composition/library-broker-manual");

for (const action of Object.keys(descriptors))
  test("offline queue help has an explicit return contract: " + action, () => {
    const sections = manuals["queue " + action]?.sections;
    const contract = sections?.find(
      (section) => section.title === "Return Contract",
    )?.text;
    assert.equal(
      typeof contract,
      "string",
      action + " return contract is missing",
    );
    assert.ok(typeof contract === "string");
    assert.ok(
      contract.trim().length > 30,
      action + " return contract must describe its actual receipt/output",
    );
    assert.doesNotMatch(contract, /\bundefined\b/);
  });

test("offline owner scratch help separates metadata permission from SDK and validation", () => {
  const text = (action: string): string => {
    const sections = manuals["queue " + action]?.sections;
    const value = sections?.find(
      (section) => section.title === "Return Contract",
    )?.text;
    assert.ok(
      typeof value === "string",
      action + " return contract is missing",
    );
    return value;
  };
  assert.match(text("successor-epoch"), /metadata|SDK0/i);
  assert.match(text("authorize-closed-successor"), /same live|same Fusion/i);
  assert.match(text("grant-native-fixture"), /manifest|source\/build/i);
  assert.match(text("observe-successor"), /unknown|historical/i);
});

test("built CLI prints owner return contracts offline without configuration, broker or user-state writes", (t) => {
  const directory = fs.mkdtempSync("/tmp/opencode/queue-help-contracts-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const action of [
    "successor-epoch",
    "observe-successor",
    "authorize-closed-successor",
    "grant-native-fixture",
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "bin/fmcad.js"), "help", "queue", action],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          FMCAD_CONFIG: path.join(directory, "missing-config.json"),
          XDG_STATE_HOME: directory,
        },
      },
    );
    assert.equal(
      result.status,
      0,
      action + ": " + (result.stderr || String(result.error)),
    );
    assert.match(result.stdout, /Return Contract:/);
    assert.doesNotMatch(result.stdout, /\bundefined\b/);
  }
  assert.deepEqual(fs.readdirSync(directory), []);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const inventory = require("./live-suite-inventory.json");
const runner = require("./run-live");
const root = path.resolve(__dirname, "..");

test("every live suite and helper has one explicit coverage classification", () => {
  const sources = fs
    .readdirSync(__dirname)
    .filter(
      (name) => /^live-.+\.(?:js|ts)$/.test(name) && !name.includes(".test."),
    )
    .map((name) => "tests/" + name)
    .sort();
  assert.deepEqual(
    inventory.entries.map((entry) => entry.source).sort(),
    sources,
  );
  assert.equal(
    new Set(inventory.entries.map((entry) => entry.id)).size,
    sources.length,
  );
  for (const entry of inventory.entries) {
    assert.equal(
      entry.source.replace(/^tests\/live-/, "").replace(/\.(js|ts)$/, ""),
      entry.id,
    );
    assert.ok(["all", "scoped", "standalone", "helper"].includes(entry.runner));
    assert.ok(
      ["partial", "pending", "native-only", "helper"].includes(entry.model),
    );
    assert.ok(entry.scope.length > 20);
    assert.ok(entry.prerequisites.length > 20);
    assert.equal(entry.model === "helper", entry.runner === "helper");
    if (entry.model === "partial") assert.ok(entry.sharedScenarios.length > 0);
    else assert.deepEqual(entry.sharedScenarios, []);
  }
});

test("inventory distinguishes runner registration from pending shared coverage", () => {
  for (const [classification, names] of [
    ["all", runner.suites],
    ["scoped", runner.scopedSuites],
  ]) {
    assert.deepEqual(
      inventory.entries
        .filter((entry) => entry.runner === classification)
        .map((entry) => entry.id)
        .sort(),
      [...names].sort(),
    );
  }
  for (const entry of inventory.entries.filter(
    (entry) => entry.model === "partial",
  )) {
    for (const suite of entry.sharedScenarios) {
      const options = require("../dist/tests/scenarios/cli").parse([
        "--suite",
        suite,
      ]);
      assert.equal(options.suite, suite);
    }
  }
});

test("historical byte identity claims retain their archived hashes", () => {
  assert.equal(
    inventory.baselineCommit,
    "a26222ff617b0e9597b2a91b50474bdca8d0a0ce",
  );
  for (const entry of inventory.entries) {
    const baseline = entry.baseline;
    assert.ok(["later", "unchanged", "changed"].includes(baseline.kind));
    if (baseline.kind === "later") continue;
    assert.match(baseline.path, /^tests\/live-[a-z-]+\.(js|ts)$/);
    assert.match(baseline.sha256, /^[a-f0-9]{64}$/);
    const hash = createHash("sha256")
      .update(fs.readFileSync(path.join(root, entry.source)))
      .digest("hex");
    assert.equal(
      hash === baseline.sha256,
      baseline.kind === "unchanged",
      entry.source,
    );
  }
});

test("listing coverage is offline and cannot be combined with execution", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "live-inventory-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    FMCAD_CONFIG: path.join(home, "missing.json"),
  };
  const launch = (args) =>
    spawnSync(
      process.execPath,
      [path.join(__dirname, "run-live.js"), ...args],
      {
        cwd: home,
        env,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
  const listing = launch(["--list"]);
  assert.ifError(listing.error);
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(JSON.parse(listing.stdout), inventory);
  assert.equal(launch(["--list", "--run"]).status, 1);
  assert.deepEqual(fs.readdirSync(home), []);
});

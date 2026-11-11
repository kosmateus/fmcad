import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
interface Entry {
  id: string;
  source: string;
  runner: "all" | "scoped" | "standalone" | "helper";
  model: "partial" | "pending" | "native-only" | "helper";
  scope: string;
  prerequisites: string;
  baseline:
    | { kind: "later" }
    | { kind: "unchanged" | "changed"; path: string; sha256: string };
  sharedScenarios: string[];
  nativeScenarios?: string[];
}
const inventory = load("./tests/live-suite-inventory.json") as {
  baselineCommit: string;
  entries: Entry[];
};
const runner = load("./tests/run-live.js") as {
  suites: string[];
  scopedSuites: string[];
};
const testsDirectory = path.join(root, "tests");
const { parse } = load(
  "./dist/tests/scenarios/cli.js",
) as typeof import("./scenarios/cli.js");
test("every live suite and helper has one explicit coverage classification", () => {
  const sources = fs
    .readdirSync(testsDirectory)
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
  ] as const) {
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
      const options = parse(["--suite", suite]);
      assert.equal(options.suite, suite);
    }
  }
});

test("native scenario extraction does not claim supported model coverage", () => {
  const manifest = load("./tests/live-required-profiles.json") as {
    profiles: Record<
      string,
      {
        cases: {
          id: string;
          command: string;
          sharedScenario?: string;
          qualification?: string;
          expectationCorrection?: string;
        }[];
      }
    >;
  };
  const modeled = new Set(
    manifest.profiles["required-model"]!.cases.map((row) => row.id),
  );
  for (const entry of inventory.entries) {
    for (const suite of entry.nativeScenarios ?? []) {
      assert.ok(
        !modeled.has(suite),
        "Native obligation promoted to required model coverage",
      );
      const obligation = manifest.profiles["native-qualification"]!.cases.find(
        (row) => row.id === entry.id,
      );
      assert.ok(obligation, entry.id);
      assert.ok(obligation.command.includes("--suite " + suite));
      assert.equal(
        parse([
          "--backend",
          "fusion",
          "--run",
          "--suite",
          suite,
          "--project-id",
          "owned-project",
          "--folder-id",
          "owned-folder",
        ]).suite,
        suite,
      );
      assert.throws(
        () => parse(["--backend", "fusion", "--suite", suite]),
        /requires --run/,
      );
    }
  }
  const solids = inventory.entries.find(
    (entry) => entry.id === "shape-native-solids",
  )!;
  assert.equal(solids.model, "pending");
  assert.deepEqual(solids.sharedScenarios, []);
  assert.deepEqual(solids.nativeScenarios, ["native-solids"]);
  const nativeSolids = manifest.profiles["native-qualification"]!.cases.find(
    (row) => row.id === solids.id,
  );
  assert.ok(nativeSolids);
  assert.equal(nativeSolids.sharedScenario, "native-solids-*");
  assert.equal(nativeSolids.qualification, "not-run");
  assert.match(
    String(nativeSolids.expectationCorrection),
    /20mm.*90degree.*0\.001mm/u,
  );
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

test("listing coverage is offline and cannot be combined with execution", (t: TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "live-inventory-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {
    PATH: process.env["PATH"],
    HOME: home,
    FMCAD_CONFIG: path.join(home, "missing.json"),
  };
  const launch = (args: string[]) =>
    spawnSync(
      process.execPath,
      [path.join(testsDirectory, "run-live.js"), ...args],
      {
        cwd: home,
        env,
        encoding: "utf8",
      },
    );
  const listing = launch(["--list"]);
  assert.ifError(listing.error);
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(JSON.parse(listing.stdout), inventory);
  assert.equal(launch(["--list", "--run"]).status, 1);
  assert.deepEqual(fs.readdirSync(home), []);
});

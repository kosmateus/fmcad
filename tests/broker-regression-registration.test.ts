import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const root = path.resolve(__dirname, "../..");
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.ok(typeof value === "string");
  return value;
}
function positive(value: unknown): number {
  assert.ok(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  );
  return value;
}
function json(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) as unknown;
}

test("CI executes every retained broker regression family and its historical comparison", () => {
  const scripts = record(record(json("package.json"))["scripts"]);
  const command = text(scripts["test:broker-regressions"]);
  const files = command
    .split(/\s+/)
    .filter((token) => token.endsWith(".test.js"));
  const required = [
    "queue-scheduling",
    "queue-cloud-save",
    "queue-document",
    "queue-native-receipt",
    "queue-probe-recovery",
    "queue-snapshot-size",
    "dead-epoch-successor",
    "closed-epoch-successor",
    "instance-loss-recovery",
    "queue-atomic-recovery-audit",
  ];
  for (const name of required) {
    const emitted = fs.existsSync(path.join(root, `tests/${name}.test.ts`));
    assert.ok(
      files.includes(`${emitted ? "dist/" : ""}tests/${name}.test.js`),
      name,
    );
  }
  assert.ok(files.includes("dist/tests/queue-scheduling-history.test.js"));
  assert.ok(
    files.includes("dist/tests/broker-regression-registration.test.js"),
  );
  assert.equal(
    new Set(files).size,
    files.length,
    "No duplicate suite execution",
  );
  for (const file of files)
    assert.ok(fs.existsSync(path.join(root, file)), file);
  const workflow: unknown = YAML.parse(
    fs.readFileSync(path.join(root, ".github/workflows/ci-tests.yml"), "utf8"),
  );
  const job = record(record(record(workflow)["jobs"])["broker-regressions"]);
  const steps = list(job["steps"]).map(record);
  assert.ok(
    steps.some((step) => step["run"] === "npm run test:broker-regressions"),
  );
  assert.ok(steps.some((step) => step["run"] === "mkdir -p /tmp/opencode"));
});

test("CI executes every required modeled profile with at least ten owned fixtures at every required concurrency", () => {
  const workflow: unknown = YAML.parse(
    fs.readFileSync(path.join(root, ".github/workflows/ci-tests.yml"), "utf8"),
  );
  const job = record(record(record(workflow)["jobs"])["scenario-broker"]);
  assert.equal(job["timeout-minutes"], "${{ matrix.suite.jobMinutes }}");
  const matrix = record(record(job["strategy"])["matrix"]);
  assert.deepEqual(matrix["protocol"], ["mcp", "addin"]);
  assert.deepEqual(matrix["concurrency"], [1, 2, 10]);
  const profiles = record(
    record(json("tests/live-required-profiles.json"))["profiles"],
  );
  const required = list(record(profiles["required-model"])["cases"]).map(
    record,
  );
  const suites = list(matrix["suite"]).map(record);
  assert.deepEqual(
    suites.map((row) => text(row["id"])).sort(),
    required.map((row) => text(row["id"])).sort(),
  );
  assert.equal(new Set(suites.map((row) => row["id"])).size, suites.length);
  assert.equal(
    matrix["exclude"],
    undefined,
    "No required combination may be excluded",
  );
  assert.equal(
    matrix["include"],
    undefined,
    "The required Cartesian grid needs no overrides",
  );
  for (const row of required) {
    const copies = positive(row["ownerCopies"]);
    assert.ok(positive(row["minimumOwnerFixtures"]) >= 10, text(row["id"]));
    assert.match(
      text(row["command"]),
      new RegExp(`--owners ${copies}(?:\\s|$)`),
    );
    const suite = suites.find((item) => item["id"] === row["id"]);
    assert.ok(suite);
    assert.equal(suite["owners"], copies);
    assert.ok(positive(suite["jobMinutes"]));
    assert.equal(suite["timeoutMinutes"], undefined, text(row["id"]));
  }
  const steps = list(job["steps"]).map(record);
  const step = steps.find(
    (row) =>
      typeof row["run"] === "string" &&
      row["run"].includes("test:scenarios:broker"),
  );
  assert.ok(step);
  const command = text(step["run"]);
  assert.doesNotMatch(command, /^timeout\s/);
  assert.match(command, /--suite \$\{\{ matrix\.suite\.id \}\}/);
  assert.match(command, /--concurrency \$\{\{ matrix\.concurrency \}\}/);
  assert.match(command, /--owners \$\{\{ matrix\.suite\.owners \}\}/);
  const artifact = steps.at(-1);
  assert.ok(artifact);
  assert.equal(
    record(artifact["with"])["name"],
    "scenario-broker-${{ matrix.protocol }}-${{ matrix.suite.id }}-c${{ matrix.concurrency }}",
  );
});

test("long CI commands rely on their job timeout instead of shell wrappers", () => {
  const workflow: unknown = YAML.parse(
    fs.readFileSync(path.join(root, ".github/workflows/ci-tests.yml"), "utf8"),
  );
  const jobs = record(record(workflow)["jobs"]);
  for (const [name, command] of [
    ["contracts", "npm run test:contracts"],
    ["public-consumers", "npm run test:public-consumers"],
  ] as const) {
    const job = record(jobs[name]);
    assert.ok(positive(job["timeout-minutes"]), name);
    const steps = list(job["steps"]).map(record);
    assert.ok(
      steps.some((step) => step["run"] === command),
      name,
    );
  }
});

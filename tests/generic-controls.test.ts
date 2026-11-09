import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "../..");
const FIXTURE_DIR = path.join(root, "tests/fixtures/generic-controls");
interface Expected {
  status: string;
  failedChecks: string[];
}
interface FixtureCase {
  id: string;
  identity: string;
  variant: string;
  expected: Expected;
}
interface Fixture {
  schemaVersion: number;
  fixtureId: string;
  identity: string;
  family: string;
  readPaths: string[];
  cases: FixtureCase[];
}
interface ControlResult {
  status: string;
  failedChecks: string[];
  source: string;
  coverage: { requestedReadPaths: string[]; complete: boolean };
}
interface Strategy {
  pythonCallerSource: string;
  pythonPayloadBytes: number;
  pythonGlueLoc: number;
  fakeRpcCount: number;
  resultBytes: number;
  result: ControlResult;
}
interface CaseReport {
  fixtureId: string;
  caseId: string;
  equivalentResult: boolean;
  expected: Expected;
  individual: Strategy;
  bundled: Strategy;
  budget: { passed: boolean };
}
interface Report {
  qualification: string;
  nativeFusionExecuted: boolean;
  elapsedBudgetPassed: boolean;
  cases: CaseReport[];
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function strings(value: unknown): void {
  assert.ok(Array.isArray(value));
  for (const item of value as unknown[]) assert.equal(typeof item, "string");
}
function expected(value: unknown): void {
  const row = object(value);
  assert.equal(typeof row["status"], "string");
  strings(row["failedChecks"]);
}
function parseFixture(value: unknown): Fixture {
  const row = object(value);
  assert.equal(typeof row["schemaVersion"], "number");
  for (const key of ["fixtureId", "identity", "family"])
    assert.equal(typeof row[key], "string");
  strings(row["readPaths"]);
  assert.ok(Array.isArray(row["cases"]));
  for (const item of row["cases"] as unknown[]) {
    const entry = object(item);
    for (const key of ["id", "identity", "variant"])
      assert.equal(typeof entry[key], "string");
    expected(entry["expected"]);
  }
  return value as Fixture;
}
function strategy(value: unknown): void {
  const row = object(value);
  assert.equal(typeof row["pythonCallerSource"], "string");
  for (const key of [
    "pythonPayloadBytes",
    "pythonGlueLoc",
    "fakeRpcCount",
    "resultBytes",
  ])
    assert.equal(typeof row[key], "number");
  const result = object(row["result"]);
  expected(result);
  assert.equal(typeof result["source"], "string");
  const coverage = object(result["coverage"]);
  strings(coverage["requestedReadPaths"]);
  assert.equal(typeof coverage["complete"], "boolean");
}
function parseReport(value: unknown): Report {
  const row = object(value);
  assert.equal(typeof row["qualification"], "string");
  for (const key of ["nativeFusionExecuted", "elapsedBudgetPassed"])
    assert.equal(typeof row[key], "boolean");
  assert.ok(Array.isArray(row["cases"]));
  for (const item of row["cases"] as unknown[]) {
    const entry = object(item);
    for (const key of ["fixtureId", "caseId"])
      assert.equal(typeof entry[key], "string");
    assert.equal(typeof entry["equivalentResult"], "boolean");
    expected(entry["expected"]);
    strategy(entry["individual"]);
    strategy(entry["bundled"]);
    assert.equal(typeof object(entry["budget"])["passed"], "boolean");
  }
  return value as Report;
}
const HARNESS_PATH = path.join(root, "tests/generic-controls/harness.ts");

function loadFixtures() {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) =>
      parseFixture(
        JSON.parse(
          fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"),
        ) as unknown,
      ),
    );
}

function runBenchmark(iterations: number) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      HARNESS_PATH,
      "--iterations",
      String(iterations),
    ],
    { encoding: "utf8", timeout: 120000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return parseReport(JSON.parse(result.stdout) as unknown);
}

test("generic-control fixtures have isolated identities and good/bad expected cases", () => {
  const identities = new Set();
  const fixtureIds = new Set();
  const families = new Set();

  for (const fixture of loadFixtures()) {
    assert.equal(fixture.schemaVersion, 1);
    assert.ok(fixture.fixtureId && !fixtureIds.has(fixture.fixtureId));
    fixtureIds.add(fixture.fixtureId);
    assert.ok(fixture.identity && !identities.has(fixture.identity));
    identities.add(fixture.identity);
    families.add(fixture.family);
    assert.ok(fixture.readPaths.length > 1);
    assert.equal(new Set(fixture.readPaths).size, fixture.readPaths.length);

    const variants = new Set();
    for (const row of fixture.cases) {
      assert.ok(
        row.identity && !identities.has(row.identity),
        `${row.identity} must be unique`,
      );
      identities.add(row.identity);
      assert.ok(
        !variants.has(row.id),
        `${fixture.fixtureId}/${row.id} must be unique`,
      );
      variants.add(row.id);
      assert.ok(["good", "bad"].includes(row.variant));
      assert.ok(["pass", "fail"].includes(row.expected.status));
      assert.equal(
        row.expected.status === "pass",
        row.expected.failedChecks.length === 0,
      );
    }
    assert.ok(
      fixture.cases.some(
        (row) => row.variant === "good" && row.expected.status === "pass",
      ),
    );
    assert.ok(
      fixture.cases.some(
        (row) => row.variant === "bad" && row.expected.status === "fail",
      ),
    );
  }

  assert.deepEqual([...families].sort(), [
    "arcSketch",
    "branchedChannel",
    "enclosure",
    "gearPair",
    "shaftSocket",
  ]);
});

test("offline fake baseline and bundled reads return each declared expected control result", () => {
  const report = runBenchmark(25);
  assert.equal(report.qualification, "offline-fake-only");
  assert.equal(report.nativeFusionExecuted, false);
  assert.ok(report.elapsedBudgetPassed);
  assert.ok(report.cases.length >= 10);

  assert.ok(report.cases[0]);
  const { individual, bundled } = report.cases[0];
  for (const strategy of [individual, bundled]) {
    const syntax = spawnSync(
      "python3",
      [
        "-B",
        "-c",
        'import sys; compile(sys.stdin.read(), "caller.py", "exec")',
      ],
      {
        input: strategy.pythonCallerSource,
        encoding: "utf8",
      },
    );
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.equal(
      strategy.pythonPayloadBytes,
      Buffer.byteLength(strategy.pythonCallerSource, "utf8"),
    );
    assert.equal(
      strategy.pythonGlueLoc,
      strategy.pythonCallerSource.split("\n").length,
    );
  }

  for (const row of report.cases) {
    assert.equal(row.equivalentResult, true, `${row.fixtureId}/${row.caseId}`);
    assert.equal(row.individual.result.status, row.expected.status);
    assert.deepEqual(
      row.individual.result.failedChecks,
      row.expected.failedChecks,
    );
    assert.deepEqual(row.bundled.result, row.individual.result);
    assert.equal(
      row.individual.fakeRpcCount,
      row.individual.result.coverage.requestedReadPaths.length,
    );
    assert.equal(row.bundled.fakeRpcCount, 1);
    assert.equal(
      row.budget.passed,
      true,
      `${row.fixtureId}/${row.caseId} bundled budget`,
    );
    assert.equal(row.individual.result.source, "offline-fake");
    assert.equal(row.individual.result.coverage.complete, true);
    assert.ok(row.individual.resultBytes > 0);
    assert.ok(row.individual.pythonPayloadBytes > 0);
    assert.ok(row.individual.pythonGlueLoc > 0);
  }
});

test("native generator is isolated and syntax-valid but never imported or executed by this test", () => {
  const sourcePath = path.join(
    root,
    "tests/native/generic-controls/generate.py",
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  const syntax = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec")',
      sourcePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(source, /confirmNativeFixtureGeneration/);
  assert.match(source, /projectId.*folderId.*fileId.*creationId/s);
  assert.match(source, /ownedOccurrences/);
  assert.match(source, /deleteMe\(\)/);
  assert.doesNotMatch(source, /\brequests\.|urllib\.request|socket\./);
});

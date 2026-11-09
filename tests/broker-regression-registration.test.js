"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

test("CI executes every retained broker regression family and its historical comparison", () => {
  const root = path.resolve(__dirname, "..");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const command = pkg.scripts["test:broker-regressions"];
  assert.equal(typeof command, "string");
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
  ];
  for (const name of required)
    assert.ok(files.includes(`tests/${name}.test.js`), name);
  assert.ok(files.includes("dist/tests/queue-scheduling-history.test.js"));
  assert.ok(files.includes("tests/broker-regression-registration.test.js"));
  assert.equal(
    new Set(files).size,
    files.length,
    "No duplicate suite execution",
  );
  for (const file of files)
    assert.ok(fs.existsSync(path.join(root, file)), file);
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(workflow, /^\s+- run: npm run test:broker-regressions\s*$/m);
});

test("CI executes saved reopen and revision profiles at every required concurrency", () => {
  const root = path.resolve(__dirname, "..");
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf8",
  );
  const job = YAML.parse(workflow).jobs["scenario-broker"];
  const matrix = job.strategy.matrix;
  assert.deepEqual(matrix.protocol, ["mcp", "addin"]);
  assert.deepEqual(matrix.concurrency, [10]);
  for (const suite of ["reopen", "revisions"])
    assert.ok(matrix.suite.includes(suite));
  const additions = new Set(
    matrix.include.map(({ protocol, suite, concurrency }) =>
      [protocol, suite, concurrency].join(":"),
    ),
  );
  for (const protocol of ["mcp", "addin"]) {
    for (const suite of ["reopen", "revisions"]) {
      for (const concurrency of [1, 2]) {
        assert.ok(additions.has([protocol, suite, concurrency].join(":")));
      }
    }
  }
  const command = job.steps.find(({ run }) =>
    run?.includes("test:scenarios:broker"),
  ).run;
  assert.match(command, /--concurrency \$\{\{ matrix\.concurrency \}\}/);
  assert.equal(
    job.steps.at(-1).with.name,
    "scenario-broker-${{ matrix.protocol }}-${{ matrix.suite }}-c${{ matrix.concurrency }}",
  );
});

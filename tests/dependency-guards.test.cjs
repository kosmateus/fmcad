const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const cli = path.join(
  root,
  "node_modules",
  "dependency-cruiser",
  "bin",
  "dependency-cruiser.mjs",
);
const config = path.join(root, ".dependency-cruiser.cjs");

function cruise(cwd, configPath, entries, outputType = "json") {
  const result = spawnSync(
    process.execPath,
    [cli, "--config", configPath, "--output-type", outputType, ...entries],
    { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );

  assert.ifError(result.error);
  assert.ok(result.stdout, result.stderr);

  return {
    ...result,
    ...(outputType === "json" ? { report: JSON.parse(result.stdout) } : {}),
  };
}

function createFixture(files) {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-dependency-guard-"),
  );

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  const fixtureConfig = path.join(fixtureRoot, "dependency-cruiser.cjs");
  fs.writeFileSync(
    fixtureConfig,
    `const config = require(${JSON.stringify(config)});\nmodule.exports = {\n  ...config,\n  options: { ...config.options, baseDir: ${JSON.stringify(fixtureRoot)} },\n};\n`,
  );

  return { fixtureRoot, fixtureConfig };
}

test("the configured source graph has real modules and no forbidden edges", () => {
  const { status, report, stderr } = cruise(root, config, ["src", "packages"]);
  const sources = report.modules.map((module) => module.source);

  assert.equal(status, 0, stderr || JSON.stringify(report.summary.violations));
  assert.equal(
    report.summary.advisedExitCode,
    0,
    JSON.stringify(report.summary.violations),
  );
  assert.equal(report.summary.violations.length, 0);
  assert.ok(report.summary.totalCruised > 0, "no source modules were cruised");
  assert.ok(
    report.summary.totalDependenciesCruised > 0,
    "the source graph contains no dependency edges",
  );
  for (const layer of [
    "src/",
    "packages/core/src/",
    "packages/node-adapters/src/",
    "packages/control-center/src/",
    "packages/opencode-adapter/src/",
  ]) {
    assert.ok(
      sources.some((source) => source.startsWith(layer)),
      `the graph omitted ${layer}`,
    );
  }

  const worker = report.modules.find(
    (module) =>
      module.source === "packages/node-adapters/src/execution/worker.ts",
  );
  assert.ok(
    worker?.dependencies.some((dependency) =>
      dependency.resolved?.startsWith("packages/core/src/"),
    ),
    "workspace imports must resolve to the core source, not an empty or package-only graph",
  );
});

test("build, CI, and package lifecycles run the dependency guard", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const ci = fs.readFileSync(
    path.join(root, ".github/workflows/ci-tests.yml"),
    "utf8",
  );

  assert.equal(packageJson.scripts.prebuild, "npm run check:dependencies");
  assert.equal(packageJson.scripts.prepack, "npm run build");
  assert.match(ci, /run: npm run build\s/);
});

test("a core-to-node-adapter import fails the layer guard", () => {
  const { fixtureRoot, fixtureConfig } = createFixture({
    "packages/core/src/entry.ts":
      'import type { Adapter } from "../../node-adapters/src/adapter.ts";\nexport type { Adapter };\n',
    "packages/node-adapters/src/adapter.ts":
      "export interface Adapter { ready: true; }\n",
  });

  try {
    const { report } = cruise(fixtureRoot, fixtureConfig, [
      "packages/core/src/entry.ts",
    ]);
    const edge = report.modules
      .find((module) => module.source === "packages/core/src/entry.ts")
      ?.dependencies.find(
        (dependency) =>
          dependency.resolved === "packages/node-adapters/src/adapter.ts",
      );

    assert.ok(edge, "the bad-edge fixture did not produce a resolved import");
    assert.ok(
      report.summary.advisedExitCode > 0,
      "the invalid layer edge unexpectedly passed",
    );
    assert.ok(
      report.summary.violations.some(
        (violation) =>
          violation.rule.name ===
          "core-must-not-import-adapters-or-composition",
      ),
      "the bad-edge fixture did not trigger the core layer rule",
    );
    assert.notEqual(
      cruise(
        fixtureRoot,
        fixtureConfig,
        ["packages/core/src/entry.ts"],
        "err-long",
      ).status,
      0,
      "dependency-cruiser did not fail the invalid layer edge",
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("a source cycle fails the cycle guard", () => {
  const { fixtureRoot, fixtureConfig } = createFixture({
    "packages/core/src/first.ts":
      'import { second } from "./second.ts";\nexport const first = second;\n',
    "packages/core/src/second.ts":
      'import { first } from "./first.ts";\nexport const second = first;\n',
  });

  try {
    const { report } = cruise(fixtureRoot, fixtureConfig, [
      "packages/core/src/first.ts",
    ]);

    assert.ok(
      report.summary.advisedExitCode > 0,
      "the circular fixture unexpectedly passed",
    );
    assert.ok(
      report.summary.violations.some(
        (violation) => violation.rule.name === "no-circular-dependencies",
      ),
      "the cycle fixture did not trigger the cycle rule",
    );
    assert.notEqual(
      cruise(
        fixtureRoot,
        fixtureConfig,
        ["packages/core/src/first.ts"],
        "err-long",
      ).status,
      0,
      "dependency-cruiser did not fail the circular fixture",
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("a type-only cycle is excluded from emitted-JS cycle checks", () => {
  const { fixtureRoot, fixtureConfig } = createFixture({
    "packages/core/src/first.ts":
      'import type { Second } from "./second.ts";\nexport type First = Second;\n',
    "packages/core/src/second.ts":
      'import type { First } from "./first.ts";\nexport type Second = First;\n',
  });

  try {
    const { report } = cruise(fixtureRoot, fixtureConfig, [
      "packages/core/src/first.ts",
    ]);
    const dependencies = report.modules.flatMap(
      (module) => module.dependencies,
    );

    assert.ok(
      dependencies.some((dependency) =>
        dependency.dependencyTypes.includes("pre-compilation-only"),
      ),
      "the fixture must contain real compile-time-only edges",
    );
    assert.equal(report.summary.advisedExitCode, 0);
    assert.deepEqual(report.summary.violations, []);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

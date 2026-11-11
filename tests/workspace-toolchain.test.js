const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const workspaces = [
  ["@fmcad/core", "packages/core"],
  ["@fmcad/node-adapters", "packages/node-adapters"],
  ["@fmcad/opencode-adapter", "packages/opencode-adapter"],
  ["@fmcad/control-center", "packages/control-center"],
];

test("declares one public root package and four private workspaces", () => {
  const rootPackage = require(path.join(root, "package.json"));
  assert.deepEqual(
    rootPackage.workspaces,
    workspaces.map(([, directory]) => directory),
  );
  assert.equal(rootPackage.engines.node, ">=22.13.0 <23 || >=24.0.0 <25");
  assert.notEqual(rootPackage.private, true);

  for (const [name, directory] of workspaces) {
    const workspace = require(path.join(root, directory, "package.json"));
    assert.equal(workspace.name, name);
    assert.equal(workspace.private, true);
    assert.ok(workspace.exports["."].types.endsWith(".d.ts"));
    assert.ok(workspace.exports["."].require.endsWith(".js"));
  }
});

test("build emits resolvable JavaScript and declarations without TS runtime imports", () => {
  for (const [name, directory] of workspaces) {
    const packageRoot = path.join(root, directory);
    const runtimePath = path.join(packageRoot, "dist/index.js");
    const declarationPath = path.join(packageRoot, "dist/index.d.ts");
    assert.ok(fs.existsSync(runtimePath), `${name} runtime entry is missing`);
    assert.ok(
      fs.existsSync(declarationPath),
      `${name} declaration entry is missing`,
    );
    assert.equal(require.resolve(name, { paths: [root] }), runtimePath);
    assert.doesNotMatch(
      fs.readFileSync(runtimePath, "utf8"),
      /(?:from\s*|require\s*\()\s*["'][^"']+\.tsx?["']/,
    );
    assert.doesNotMatch(fs.readFileSync(declarationPath, "utf8"), /\.tsx?["']/);
  }

  for (const subpath of ["server", "web"]) {
    assert.doesNotThrow(() =>
      require.resolve(`@fmcad/control-center/${subpath}`, { paths: [root] }),
    );
  }
});

test("core can be imported without loading external dependencies or starting services", () => {
  const runtime = fs.readFileSync(
    path.join(root, "packages/core/dist/index.js"),
    "utf8",
  );
  assert.doesNotMatch(runtime, /\bimport\s*\(/);
  for (const [, dependency] of runtime.matchAll(
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  )) {
    assert.ok(
      dependency.startsWith("./"),
      `core barrel loaded external dependency: ${dependency}`,
    );
  }

  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `
        const assert = require("node:assert/strict");
        const net = require("node:net");
        const childProcess = require("node:child_process");
        for (const [target, key] of [[net.Server.prototype, "listen"], [childProcess, "spawn"], [childProcess, "exec"], [childProcess, "execFile"]]) {
          target[key] = () => { throw new Error("core import started an external service"); };
        }
        require("@fmcad/core");
        assert.equal(process.exitCode, undefined);
      `,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
});

test("ESLint rejects a forbidden core-to-adapter or host import", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: root });
  const forbiddenImports = [
    ["node:fs", "import-x/no-nodejs-modules"],
    ["fs", "import-x/no-nodejs-modules"],
    ["@fmcad/node-adapters", "no-restricted-imports"],
    ["@fmcad/opencode-adapter/private", "no-restricted-imports"],
    ["@fmcad/control-center", "no-restricted-imports"],
    ["terminal-kit", "no-restricted-imports"],
    ["@opencode-ai/plugin", "no-restricted-imports"],
    ["../../node-adapters/src/index.js", "no-restricted-imports"],
  ];

  for (const [moduleName, expectedRule] of forbiddenImports) {
    const [result] = await eslint.lintText(
      `import ${JSON.stringify(moduleName)};`,
      {
        filePath: path.join(root, "packages/core/src/architecture-fixture.ts"),
      },
    );
    assert.ok(
      result.messages.some((message) => message.ruleId === expectedRule),
      `expected core import ${moduleName} to be rejected`,
    );
  }
});

test("ESLint detects package-local TypeScript cycles", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: root });
  const fixture = fs.mkdtempSync(
    path.join(root, "packages/core/src/.cycle-fixture-"),
  );
  const first = path.join(fixture, "first.ts");
  const second = path.join(fixture, "second.ts");
  fs.writeFileSync(
    first,
    'import { second } from "./second.js"; export const first = second;',
  );
  fs.writeFileSync(
    second,
    'import { first } from "./first.js"; export const second = first;',
  );

  try {
    const results = await eslint.lintFiles([first, second]);
    assert.ok(
      results
        .flatMap((result) => result.messages)
        .some((message) => message.ruleId === "import-x/no-cycle"),
      "expected the TypeScript cycle to be rejected",
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("npm pack publishes only the root package, not private workspaces", () => {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  assert.equal(packed.length, 1);
  assert.equal(packed[0].name, "fmcad");
  assert.ok(
    packed[0].files.some(({ path: file }) => file === "dist/bin/fmcad.js"),
  );
  assert.ok(packed[0].files.some(({ path: file }) => file === "server.mjs"));
  assert.ok(
    packed[0].files.every(({ path: file }) => !file.startsWith("packages/")),
  );
});

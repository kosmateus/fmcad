import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createRequire } from "node:module";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
const workspaces = [
  ["@fmcad/core", "packages/core"],
  ["@fmcad/node-adapters", "packages/node-adapters"],
  ["@fmcad/opencode-adapter", "packages/opencode-adapter"],
  ["@fmcad/control-center", "packages/control-center"],
] as const;

test("declares one public root package and four private workspaces", () => {
  const rootPackage = record(load(path.join(root, "package.json")));
  assert.deepEqual(
    rootPackage["workspaces"],
    workspaces.map(([, directory]) => directory),
  );
  assert.equal(
    record(rootPackage["engines"])["node"],
    ">=22.13.0 <23 || >=24.0.0 <25",
  );
  assert.notEqual(rootPackage["private"], true);

  for (const [name, directory] of workspaces) {
    const workspace = record(load(path.join(root, directory, "package.json")));
    const exports = record(record(workspace["exports"])["."]);
    assert.equal(workspace["name"], name);
    assert.equal(workspace["private"], true);
    assert.ok(text(exports["types"]).endsWith(".d.ts"));
    assert.ok(text(exports["require"]).endsWith(".js"));
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
    assert.equal(load.resolve(name, { paths: [root] }), runtimePath);
    assert.doesNotMatch(
      fs.readFileSync(runtimePath, "utf8"),
      /(?:from\s*|require\s*\()\s*["'][^"']+\.tsx?["']/,
    );
    assert.doesNotMatch(fs.readFileSync(declarationPath, "utf8"), /\.tsx?["']/);
  }

  for (const subpath of ["server", "web"]) {
    assert.doesNotThrow(() =>
      load.resolve(`@fmcad/control-center/${subpath}`, { paths: [root] }),
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
    assert.ok(dependency);
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
  ] as const;

  for (const [moduleName, expectedRule] of forbiddenImports) {
    const [result] = await eslint.lintText(
      `import ${JSON.stringify(moduleName)};`,
      {
        filePath: path.join(root, "packages/core/src/architecture-fixture.ts"),
      },
    );
    assert.ok(result);
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
  const packed = array(
    JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
        cwd: root,
        encoding: "utf8",
      }),
    ) as unknown,
  );
  assert.equal(packed.length, 1);
  const item = record(packed[0]);
  const files = array(item["files"]).map((value) => {
    const entry = record(value);
    return { path: text(entry["path"]) };
  });
  assert.equal(item["name"], "fmcad");
  assert.ok(files.some(({ path: file }) => file === "dist/bin/fmcad.js"));
  assert.ok(files.some(({ path: file }) => file === "server.mjs"));
  assert.ok(files.every(({ path: file }) => !file.startsWith("packages/")));
});

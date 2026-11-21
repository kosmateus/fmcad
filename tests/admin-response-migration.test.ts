import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createAdmin } from "../src/queue-console-admin";

const root = path.resolve(__dirname, "../..");
const revision = "dce47c5e214b91b4ab68151e0b40510c4f7edfaf";

test("malformed durable admin evidence cannot authorize a new physical probe", async () => {
  let probes = 0;
  let writes = 0;
  const admin = createAdmin({
    state: {
      data: {},
      summary: () => ({}),
      pause: () => undefined,
      _commit: (fn) => fn({}),
    },
    gate: {
      instanceId: "instance",
      adminTransition: null,
      resuming: false,
      active: new Set(),
      administrative: (fn) => fn(),
    },
    dir: "/fixture",
    marker: { nonce: "instance" },
    buildHash: "build",
    getContext: () => ({
      active: null,
      busy: false,
      stopping: false,
      held: null,
    }),
    setBusy: () => undefined,
    resumeCheck: async () => {
      probes++;
      return { pid: 42, birth: "birth", version: "version" };
    },
    observeControlCompletion: async () => {
      throw new Error("No original receipt may be fabricated");
    },
    close: async () => {
      throw new Error("No lifecycle mutation expected");
    },
    diagnostics: () => undefined,
    durable: () => {
      writes++;
    },
    readJson: () => false,
    hash: () => "a".repeat(64),
  });
  await assert.rejects(
    admin.handle(
      {
        action: "console-inspect",
        control: {
          requestId: "original",
          instanceId: "instance",
          expectedGeneration: 0,
        },
      },
      "owner",
    ),
    { code: "INVALID_RECORD" },
  );
  assert.equal(probes, 0);
  assert.equal(writes, 0);
});

// Execute every retained assertion against each implementation in a fresh
// process. Only this module is replaced; dependencies and fixtures are shared.
for (const [moduleName, suite] of [
  ["queue-console-admin", "console-services"],
  ["queue-response-migration", "project-responses"],
] as const) {
  for (const historical of [true, false]) {
    test(`${moduleName}: all retained ${historical ? "historical" : "typed"} effects and refusal assertions`, (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "fmcad-paired-admin-"),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const bootstrap = path.join(directory, "bootstrap.cjs");
      fs.writeFileSync(
        bootstrap,
        `
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const root = ${JSON.stringify(root)};
const filename = path.join(root, ${JSON.stringify(`src/${moduleName}.js`)});
const isolated = new Module(filename, module);
isolated.filename = filename;
isolated.paths = Module.createRequire(filename).resolve.paths('fixture') || [];
if (${historical}) {
  isolated.exports = require(path.join(root, 'tests/fixtures/historical-module.cjs'))(
    ${JSON.stringify(revision)}, ${JSON.stringify(`src/${moduleName}.js`)});
} else {
  const ts = require(path.join(root, 'node_modules/typescript'));
  const source = fs.readFileSync(path.join(root, ${JSON.stringify(`src/${moduleName}.ts`)}), 'utf8');
  isolated._compile(ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023
  }}).outputText, filename);
}
require.cache[filename] = isolated;
`,
      );
      const env = { ...process.env };
      delete env["NODE_TEST_CONTEXT"];
      const result = spawnSync(
        process.execPath,
        [
          "--require",
          bootstrap,
          "--test",
          "--test-reporter=tap",
          fs.existsSync(path.join(root, `tests/${suite}.test.js`))
            ? `tests/${suite}.test.js`
            : `dist/tests/${suite}.test.js`,
        ],
        {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /# fail 0\b/);
      assert.match(result.stdout, /# skipped 0\b/);
      const count = /# tests (\d+)/.exec(result.stdout);
      assert.ok(
        count?.[1] && Number(count[1]) >= 6,
        "Retained test bodies actually executed",
      );
    });
  }
}

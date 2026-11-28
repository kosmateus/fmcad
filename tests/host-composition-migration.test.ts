import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
const root = path.resolve(__dirname, "../..");
const revision = "dce47c5e214b91b4ab68151e0b40510c4f7edfaf";
// Execute every retained assertion against each implementation in a fresh
// process. Only this module is replaced; dependencies and fixtures are shared.
for (const [moduleName, sourcePath, suite] of [
  [
    "control-center-system-controls",
    "src/control-center-system-controls.cjs",
    "system-controls",
  ],
  ["direct-telemetry", "src/direct-telemetry.js", "observation-ports"],
  ["direct-telemetry", "src/direct-telemetry.js", "console-data"],
  ["direct-telemetry", "src/direct-telemetry.js", "console-interface"],
  ["legacy-worker", "src/composition/legacy-worker.js", "server-metadata"],
  ["legacy-worker", "src/composition/legacy-worker.js", "diagnostics"],
] as const) {
  for (const historical of [true, false]) {
    test(`${moduleName}: all retained ${historical ? "historical" : "typed"} effects and refusal assertions`, (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "fmcad-paired-host-"),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const bootstrap = path.join(directory, "bootstrap.cjs");
      const compiled = path.join(directory, "candidate.cjs");
      if (!historical)
        fs.writeFileSync(
          compiled,
          ts.transpileModule(
            fs.readFileSync(
              path.join(root, `src/composition/library-${moduleName}.ts`),
              "utf8",
            ),
            {
              compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2023,
              },
            },
          ).outputText,
        );

      fs.writeFileSync(
        bootstrap,
        `
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const root = ${JSON.stringify(root)};
const filename = path.join(root, ${JSON.stringify(sourcePath)});
const isolated = new Module(filename, module);
isolated.filename = filename;
isolated.paths = Module.createRequire(filename).resolve.paths('fixture') || [];
if (${historical}) {
  isolated.exports = require(path.join(root, 'tests/fixtures/historical-module.cjs'))(
    ${JSON.stringify(revision)}, ${JSON.stringify(sourcePath)});
} else {
  const runtimeFilename = path.join(root, ${JSON.stringify(`src/dist/composition/library-${moduleName}.js`)});
  isolated.filename = runtimeFilename;
  isolated._compile(fs.readFileSync(${JSON.stringify(compiled)}, 'utf8'), runtimeFilename);
}
require.cache[filename] = isolated;
`,
      );
      const env = { ...process.env };
      delete env["NODE_TEST_CONTEXT"];
      env["NODE_OPTIONS"] = [env["NODE_OPTIONS"], `--require=${bootstrap}`]
        .filter(Boolean)
        .join(" ");
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
        count?.[1] && Number(count[1]) >= 3,
        "Retained test bodies actually executed",
      );
    });
  }
}

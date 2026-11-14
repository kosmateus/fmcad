import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const revision = "dce47c5e214b91b4ab68151e0b40510c4f7edfaf";
// Same retained scenarios and assertions, replacing only the migrated host seam.
const retained = [
  {
    module: "queue-closed-epoch-successor",
    suite: "closed-epoch-successor",
    minimum: 11,
  },
  {
    module: "queue-settled-epoch-evidence",
    suite: "saved-first-save-evidence",
    minimum: 6,
  },
  { module: "queue-state", suite: "queue-snapshot-size", minimum: 1 },
  { module: "fusion-reset", suite: "fusion-reset", minimum: 12 },
  { module: "queue-document", suite: "queue-document", minimum: 2 },
  { module: "atomic-runtime-abi", suite: "atomic-runtime-abi", minimum: 1 },
  {
    module: "queue-audit-facts-capture",
    suite: "audit-facts-capture",
    minimum: 3,
  },
  {
    module: "queue-phased",
    suite: "phased-queue",
    minimum: 3,
    pattern:
      "^(two projects prepare concurrently|killing a preparing process|local publication after the SDK result)",
  },
] as const;
for (const entry of retained)
  for (const historical of [true, false]) {
    test(
      `${entry.module}: ${historical ? "predecessor" : "typed"} retained effects and refusal assertions`,
      { timeout: 360_000 },
      (t) => {
        const dir = fs.mkdtempSync(
          path.join(os.tmpdir(), "fmcad-recovery-host-parity-"),
        );
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const bootstrap = path.join(dir, "bootstrap.cjs");
        fs.writeFileSync(
          bootstrap,
          `
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const root=${JSON.stringify(root)},filename=path.join(root,${JSON.stringify(`src/${entry.module}.js`)});
const isolated=new Module(filename,module);isolated.filename=filename;
isolated.paths=Module.createRequire(filename).resolve.paths('fixture')||[];
if(${historical}) isolated.exports=require(path.join(root,'tests/fixtures/historical-module.cjs'))(${JSON.stringify(revision)},${JSON.stringify(`src/${entry.module}.js`)});
else {
 const ts=require(path.join(root,'node_modules/typescript'));
 isolated._compile(ts.transpileModule(fs.readFileSync(path.join(root,${JSON.stringify(`src/${entry.module}.ts`)}),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText,filename);
}
require.cache[filename]=isolated;
`,
        );
        const env = { ...process.env };
        delete env["NODE_TEST_CONTEXT"];
        const suite = fs.existsSync(
          path.join(root, `tests/${entry.suite}.test.js`),
        )
          ? `tests/${entry.suite}.test.js`
          : `dist/tests/${entry.suite}.test.js`;
        const args = [
          "--require",
          bootstrap,
          "--test",
          "--test-concurrency=1",
          "--test-reporter=tap",
        ];
        if ("pattern" in entry)
          args.push(`--test-name-pattern=${entry.pattern}`);
        args.push(suite);
        const result = spawnSync(process.execPath, args, {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 350_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /# fail 0\b/);
        const count = /# pass (\d+)/.exec(result.stdout);
        assert.ok(
          count?.[1] && Number(count[1]) >= entry.minimum,
          "Selected retained assertion bodies actually executed",
        );
        if (!("pattern" in entry)) assert.match(result.stdout, /# skipped 0\b/);
      },
    );
  }

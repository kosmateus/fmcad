import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const root = process.cwd();
const sourcePath = "src/opencode/project-logger.cjs";
const revision = "dce47c5e214b91b4ab68151e0b40510c4f7edfaf";
interface Fixture {
  revision: string;
  sourcePath: string;
  file: string;
  sha256: string;
}
for (const historical of [true, false]) {
  test(`project observer: original and typed process share all rotation, correlation and refusal assertions (${historical ? "historical" : "typed"})`, (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "fmcad-observer-paired-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bootstrap = path.join(directory, "bootstrap.cjs");
    const historicalFile = path.join(directory, sourcePath);
    if (historical) {
      const fixtures = path.join(root, "tests/fixtures/history");
      const manifest = JSON.parse(
        fs.readFileSync(path.join(fixtures, "manifest.json"), "utf8"),
      ) as Fixture[];
      const fixture = manifest.find(
        (item) => item.revision === revision && item.sourcePath === sourcePath,
      );
      assert.ok(fixture);
      assert.equal(path.basename(fixture.file), fixture.file);
      const source = fs.readFileSync(path.join(fixtures, fixture.file));
      assert.equal(
        createHash("sha256").update(source).digest("hex"),
        fixture.sha256,
      );
      fs.mkdirSync(path.dirname(historicalFile), { recursive: true });
      fs.writeFileSync(historicalFile, source);
      fs.symlinkSync(
        path.join(root, "src/dist"),
        path.join(directory, "src/dist"),
        "dir",
      );
    }
    fs.writeFileSync(
      bootstrap,
      `
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = ${JSON.stringify(root)};
const filename = require('node:path').join(root, ${JSON.stringify(sourcePath)});
const observer = require(${historical ? JSON.stringify(historicalFile) : "filename"});
assert.deepEqual(Object.keys(observer).sort(), ['ensureProjectLogger','attachProject','clientEvent','createEventSink','stopProjectLogger','locations','workspaceLog','appendSafe'].sort());
const events = require(require('node:path').join(root,'src/dist/composition/library-project-events'));
assert.equal(observer.locations,events.locations);
assert.equal(observer.createEventSink,events.createEventSink);
if (${historical}) {
  const entry = new Module(filename,module);
  entry.filename = filename;
  entry.exports = observer;
  entry.loaded = true;
  require.cache[filename] = entry;
}
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
        "dist/tests/project-logger-rotation.test.js",
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
    assert.match(result.stdout, /# tests 5\b/);
    assert.match(result.stdout, /# pass 5\b/);
    assert.match(result.stdout, /# fail 0\b/);
    assert.match(result.stdout, /# skipped 0\b/);
  });
}

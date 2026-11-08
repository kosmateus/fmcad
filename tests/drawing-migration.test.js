"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const history = require("./fixtures/file-workflows/load.cjs");
const drawing = require("../src/drawing-package");
const current = require("../src/drawing-export");
const check = require("../src/drawing-check");
const {
  publishDirectory,
} = require("../src/dist/node-adapters/persistence/drawing-output");
const versions = ["baseline", "before", "typed"];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawing-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = structuredClone(
    drawing.descriptors["drawing.package"].example,
  );
  request.out = path.join(root, "package");
  const report = drawing.execute("drawing.package", request);
  return { root, report, out: path.join(root, "output") };
}
function api(label, family, io) {
  if (label !== "typed")
    return history(label, `src/drawing-${family}.js`, { "node:fs": io ?? fs });
  if (!io) return family === "export" ? current : check;
  // Factories expose filesystem ports for deterministic fault injection.
  const module = require(
    `../src/dist/node-adapters/persistence/drawing-${family}`,
  );
  return family === "export"
    ? module.createDrawingExporter(drawing, io)
    : module.createDrawingChecker(drawing, io);
}
test("drawing migration preserves complete export bytes, check reports and source identities", (t) => {
  const { report, out } = fixture(t);
  const exports = [],
    checks = [];
  for (const label of versions) {
    const result = api(label, "export").execute("drawing.export", {
      schemaVersion: 1,
      package: report.reportPath,
      out,
      formats: ["svg", "pdf", "dxf"],
    });
    exports.push({
      result,
      files: Object.fromEntries(
        fs
          .readdirSync(out)
          .map((name) => [name, fs.readFileSync(path.join(out, name), "hex")]),
      ),
    });
    fs.rmSync(out, { recursive: true });
    const checked = api(label, "check").execute("drawing.check", {
      schemaVersion: 1,
      package: report.reportPath,
      out,
    });
    checks.push({
      checked,
      bytes: fs.readFileSync(path.join(out, "report.json"), "hex"),
    });
    fs.rmSync(out, { recursive: true });
  }
  for (const snapshot of exports.slice(1))
    assert.deepEqual(snapshot, exports[0]);
  for (const snapshot of checks.slice(1)) assert.deepEqual(snapshot, checks[0]);
});
for (const label of versions) {
  for (const family of ["check", "export"]) {
    test(`${label} ${family}: failed publication removes owned partial output without changing the package`, (t) => {
      const { report, out } = fixture(t),
        original = fs.readFileSync(report.reportPath);
      const failure = new Error("injected report publication failure");
      const io = {
        ...fs,
        writeFileSync(file, ...args) {
          if (path.basename(file) === "report.json") throw failure;
          return fs.writeFileSync(file, ...args);
        },
      };
      assert.throws(
        () =>
          api(label, family, io).execute("drawing." + family, {
            schemaVersion: 1,
            package: report.reportPath,
            out,
            formats: ["svg", "pdf"],
          }),
        (error) => error === failure,
      );
      assert.equal(fs.existsSync(out), false);
      assert.deepEqual(fs.readFileSync(report.reportPath), original);
    });
    test(`${label} ${family}: cleanup failure retains both errors in the migrated implementation`, (t) => {
      const { report, out } = fixture(t);
      const publication = new Error("original failure"),
        cleanup = new Error("cleanup failure");
      const io = {
        ...fs,
        writeFileSync() {
          throw publication;
        },
        rmSync() {
          throw cleanup;
        },
      };
      assert.throws(
        () =>
          api(label, family, io).execute("drawing." + family, {
            schemaVersion: 1,
            package: report.reportPath,
            out,
            formats: ["svg"],
          }),
        (error) => {
          if (label !== "typed") return error === cleanup; // Reproduces the inherited loss of the original error.
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, publication);
          assert.deepEqual(error.errors, [publication, cleanup]);
          return true;
        },
      );
    });
    test(`${label} ${family}: changed scene is refused before creating output`, (t) => {
      const { report, out } = fixture(t);
      fs.appendFileSync(report.result.scene.path, "changed");
      assert.throws(
        () =>
          api(label, family).execute("drawing." + family, {
            schemaVersion: 1,
            package: report.reportPath,
            out,
            formats: ["svg"],
          }),
        /sha256 mismatch/,
      );
      assert.equal(fs.existsSync(out), false);
    });
  }
}
test("cleanup refuses a replacement directory and preserves its foreign contents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawing-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, "out"),
    retained = path.join(root, "original");
  const original = new Error("publication interrupted");
  assert.throws(
    () =>
      publishDirectory(out, fs, () => {
        fs.renameSync(out, retained);
        fs.mkdirSync(out);
        fs.writeFileSync(path.join(out, "foreign"), "protected");
        throw original;
      }),
    (error) => {
      assert.equal(error.cause, original);
      assert.match(error.errors[1].message, /ownership changed/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(path.join(out, "foreign"), "utf8"), "protected");
  assert.ok(fs.existsSync(retained));
});

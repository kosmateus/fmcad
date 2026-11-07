"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const current = require("../src/cad");
const previous = require("./fixtures/historical-module.cjs")(
  "5292078741b417d6e921d3252a8bf19b3f0cc15b",
  "src/cad.js",
);
const fakeWsl = require("./fixtures/fake-wsl-platform.cjs");

test("CAD preparation retains exact source, units, hashes and context across migrated routes", (t) => {
  const restore = fakeWsl();
  t.after(restore);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cad-preparation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "model Ż.step");
  fs.writeFileSync(file, "ISO-10303-21;\nEND-ISO-10303-21;\n");
  const operations = [
    "document.status",
    "inspect.pack",
    "curve.fit",
    "curve.offset-edit",
    "param.import",
    "catalog.import",
    "cots.replace",
    "export.step",
    "import.file",
  ];
  const context = {
    doc: "Model Ż",
    docId: "owned-id",
    docFileId: "owned-file",
  };
  for (const operation of operations) {
    const data = structuredClone(current.catalog[operation].example);
    if (operation === "cots.replace") data.model.path = file;
    if (operation === "catalog.import")
      data.records[0].model = {
        path: file,
        representation: "envelope",
        source: "model fixture",
        status: "ESTIMATED",
      };
    const input = structuredClone(data);
    const before = previous.prepareCadScript(operation, data, context);
    const after = current.prepareCadScript(operation, data, context);
    assert.deepEqual(after, before, operation);
    assert.equal(
      current.buildCadScript(operation, data, context),
      before.script,
      operation,
    );
    assert.deepEqual(data, input, operation + " changed caller data");
    assert.deepEqual(after.context, context);
  }
  const fullContext = { ...context, component: "root" };
  const full = current.prepareCadScript("document.status", {}, fullContext);
  assert.deepEqual(
    full,
    previous.prepareCadScript("document.status", {}, fullContext),
  );
  assert.ok(
    full.units.length >
      current.prepareCadScript("document.status", {}, context).units.length,
  );
});

test("path mapping preserves platform spelling, all nested path families and caller data", (t) => {
  t.after(fakeWsl());
  const file = "relative/part Ż.step";
  for (const [operation, data] of [
    ["export.step", { path: file, directory: "out", parts: [{ path: file }] }],
    [
      "checkpoint.create",
      { path: file, directory: "out", parts: [{ path: file }] },
    ],
    ["import.file", { path: file }],
    [
      "shot.pack",
      { shots: [{ path: file }, { path: "C:\\native\\frame.png" }] },
    ],
    ["view.compare", { left: file, right: "\\\\server\\share\\frame.png" }],
    ["texture.heightmap", { path: file }],
    ...["motion.sample", "animation.joints", "explode.render"].map(
      (operation) => [
        operation,
        { directory: "out", frameFiles: [file, "D:/native/frame.png"] },
      ],
    ),
    ["animation.export", { frames: [file], output: "out/movie.mp4" }],
    ["unrelated.operation", { path: file, nested: [{ value: 1 }] }],
  ]) {
    const original = structuredClone(data);
    const expected = previous.mapCadPaths(operation, data);
    const actual = current.mapCadPaths(operation, data);
    assert.deepEqual(actual, expected, operation);
    assert.deepEqual(data, original);
    assert.notEqual(actual, data);
  }
  for (const value of ["C:/native/file.step", "\\\\server\\share\\file.step"]) {
    assert.equal(
      current.mapCadPaths("export.step", { path: value }).path,
      value,
    );
  }
});

test("preparation retains validation and path failures before execution", (t) => {
  t.after(fakeWsl());
  for (const [operation, data] of [
    ["not.a.command", {}],
    ["shape.box", {}],
    ["document.status", { unexpected: true }],
    ["curve.fit", { ...current.catalog["curve.fit"].example, plane: "XY" }],
  ]) {
    let expected;
    assert.throws(
      () => previous.prepareCadScript(operation, data, { doc: "Owned" }),
      (error) => {
        expected = error.message;
        return true;
      },
    );
    assert.throws(
      () => current.prepareCadScript(operation, data, { doc: "Owned" }),
      (error) => error.message === expected,
    );
  }
  for (const value of [null, 42, {}, []]) {
    for (const api of [previous, current])
      assert.throws(
        () =>
          api.mapCadPaths("view.compare", {
            left: value,
            right: "C:/good.png",
          }),
        /File path must be a string/,
      );
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import type { CadData } from "../packages/core/src/application/cad/contracts.js";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
type CadApi = typeof import("../src/composition/cad-execution.js");
const current = load("./src/cad.js") as CadApi;
const previous = historical(
  "5292078741b417d6e921d3252a8bf19b3f0cc15b",
  "src/cad.js",
) as CadApi;
const fakeWsl = load(
  "./tests/fixtures/fake-wsl-platform.cjs",
) as () => () => void;

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
    const data = structuredClone(current.catalog[operation]!.example);
    if (operation === "cots.replace") {
      const model = data["model"];
      assert.ok(model && typeof model === "object" && !Array.isArray(model));
      (model as CadData)["path"] = file;
    }
    if (operation === "catalog.import") {
      const records = data["records"];
      assert.ok(Array.isArray(records));
      const first: unknown = records[0];
      assert.ok(first && typeof first === "object" && !Array.isArray(first));
      (first as CadData)["model"] = {
        path: file,
        representation: "envelope",
        source: "model fixture",
        status: "ESTIMATED",
      };
    }
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
      (operation): [string, CadData] => [
        operation,
        { directory: "out", frameFiles: [file, "D:/native/frame.png"] },
      ],
    ),
    ["animation.export", { frames: [file], output: "out/movie.mp4" }],
    ["unrelated.operation", { path: file, nested: [{ value: 1 }] }],
  ] satisfies [string, CadData][]) {
    const original = structuredClone(data);
    const expected = previous.mapCadPaths(operation, data);
    const actual = current.mapCadPaths(operation, data);
    assert.deepEqual(actual, expected, operation);
    assert.deepEqual(data, original);
    assert.notEqual(actual, data);
  }
  for (const value of ["C:/native/file.step", "\\\\server\\share\\file.step"]) {
    assert.equal(
      current.mapCadPaths("export.step", { path: value })["path"],
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
    ["curve.fit", { ...current.catalog["curve.fit"]!.example, plane: "XY" }],
  ] satisfies [string, CadData][]) {
    let expected: string;
    assert.throws(
      () => previous.prepareCadScript(operation, data, { doc: "Owned" }),
      (error) => {
        assert.ok(error instanceof Error);
        expected = error.message;
        return true;
      },
    );
    assert.throws(
      () => current.prepareCadScript(operation, data, { doc: "Owned" }),
      (error) => error instanceof Error && error.message === expected,
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

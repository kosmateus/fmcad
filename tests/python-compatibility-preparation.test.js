"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  cadBundleManifest,
  cadBundleUnits,
  orderBundle,
} = require("../packages/node-adapters/dist/python/bundle");
const {
  geometryFamilies,
} = require("../packages/node-adapters/dist/python/geometry-manifest");
const {
  assemblyFamilies,
} = require("../packages/node-adapters/dist/python/assembly-manifest");
const root = path.resolve(__dirname, "..");

test("every compatibility unit remains present, but prepared code validates canonical initialization without a filesystem loader", () => {
  const units = cadBundleUnits(root);
  assert.deepEqual(
    units.map((unit) => unit.id),
    orderBundle(
      cadBundleManifest,
      cadBundleManifest.map((unit) => unit.id),
    ).map((unit) => unit.id),
  );
  const names = [...geometryFamilies, ...assemblyFamilies];
  const facades = units.filter((unit) => names.includes(unit.id));
  assert.equal(facades.length, 19);
  const compatibilityUnits = facades.map((unit) => ({
    ...unit,
    compatibility: true,
  }));
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      `
import ast,json,sys
units=json.load(sys.stdin)
for unit in units:
    tree=ast.parse(unit['source'])
    if unit['compatibility']:
        assert not any(isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in {'exec','compile','eval'} for node in ast.walk(tree)), unit['id']
        assert isinstance(tree.body[-1],ast.If), unit['id']
print(len(units))
`,
    ],
    { input: JSON.stringify(compatibilityUnits), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "19");
  for (const unit of facades) {
    assert.equal(unit.filename, `assets/cad/${unit.id}.py`);
    assert.match(
      unit.source,
      /Prepared compatibility boundary; original-sha256=[a-f0-9]{64}/,
    );
    assert.match(
      fs.readFileSync(path.join(root, unit.filename), "utf8"),
      /exec\(compile/,
      "Standalone fixture loader remains intact",
    );
  }
});

test("unreviewed facade statements and missing canonical prerequisites reject rather than disappear from analysis", (t) => {
  const module = cadBundleManifest.find((unit) => unit.id === "model");
  const source = fs.readFileSync(path.join(root, module.path), "utf8");
  const directory = fs.mkdtempSync("/tmp/opencode/compatibility-source-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.cpSync(path.join(root, "assets/cad"), path.join(directory, "assets/cad"), {
    recursive: true,
  });
  fs.cpSync(
    path.join(root, "runtime/python"),
    path.join(directory, "runtime/python"),
    { recursive: true },
  );
  fs.appendFileSync(
    path.join(directory, module.path),
    "\ndef must_not_disappear():\n    return 123\n",
  );
  assert.throws(
    () => cadBundleUnits(directory),
    /Unrecognized compatibility loader source/,
  );
  const missing = cadBundleManifest.map((item) =>
    item.id === "model" ? { ...item, dependencies: [] } : item,
  );
  assert.throws(
    () => cadBundleUnits(root, "full", missing),
    /Incomplete compatibility loader sources/,
  );
});

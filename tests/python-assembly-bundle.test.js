"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { cadBundleManifest, cadBundleUnits } = require("../packages/node-adapters/dist/python/bundle");
const { assemblyBundleManifest, assemblyFamilies } = require("../packages/node-adapters/dist/python/assembly-manifest");

test("assembly-owned manifest closes dependencies and remote bundle never loads local compatibility sources", () => {
  const units = cadBundleUnits(process.cwd());
  for (const unit of assemblyBundleManifest) {
    assert.deepEqual(cadBundleManifest.find(item => item.id === unit.id), unit);
  }
  for (const family of assemblyFamilies) {
    assert.equal(units.filter(unit => unit.id === `${family}-domain`).length, 1);
    assert.equal(units.filter(unit => unit.id === `${family}-fusion`).length, 1);
    assert.ok(units.findIndex(unit => unit.id === `${family}-fusion`) < units.findIndex(unit => unit.id === family));
  }
  const run = spawnSync("python3", ["-B", "tests/python_assembly_bundle.py"], {
    input: JSON.stringify(units), encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.families.sort(), [...assemblyFamilies].sort());
  assert.ok(result.handlers > 200);
  assert.ok(result.familyHandlers > 60);
});

test("assembly family manifest is immutable and narrow document-status excludes it", () => {
  assert.ok(Object.isFrozen(assemblyBundleManifest));
  assert.ok(assemblyBundleManifest.every(unit => Object.isFrozen(unit) && Object.isFrozen(unit.dependencies)));
  const units = cadBundleUnits(process.cwd(), "document-status");
  assert.ok(!units.some(unit => assemblyFamilies.some(family => unit.id.startsWith(family))));
});

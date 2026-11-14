import { createRequire } from "node:module";
import type { ModelingApi } from "./modeling-unit-test-support";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const load = createRequire(path.join(process.cwd(), "tests/datum.test.ts"));
test.after(load("./fixtures/fake-wsl-platform.cjs")());
const { catalog, validateCad, buildCadScript, executeCad } =
  load("../src/cad") as ModelingApi;
import { spawnSync } from "node:child_process";

test("GM04 public descriptors and bundled routes are executable offline", () => {
  for (const op of ["datum.transform", "datum.plane-on-path", "joint.frame"]) {
    validateCad(op, catalog[op]!.example);
    assert.match(
      buildCadScript(op, catalog[op]!.example, { doc: "GM04" }),
      /def _datum_transform/,
    );
  }
  const python = spawnSync(
    "python3",
    ["-B", "-m", "unittest", "discover", "-s", "tests", "-p", "datum_test.py"],
    { encoding: "utf8" },
  );
  assert.equal(python.status, 0, python.stdout + python.stderr);
});

test("GM04 validates vector versus point, frames, endpoints and rigid matrices", () => {
  const valid = {
    from: "root",
    to: { occurrence: "A:1+B:2" },
    vectors: [
      [0, 0, 0],
      [0, 0, 7],
    ],
  };
  validateCad("datum.transform", valid);
  for (const patch of [
    { vectors: [["1 mm", 0, 0]] },
    { points: [[1, 2, 3]] },
    { from: {} },
    { schemaVersion: 2 },
    { vectors: [[Infinity, 0, 0]] },
  ])
    assert.throws(() => validateCad("datum.transform", { ...valid, ...patch }));
  assert.throws(
    () =>
      validateCad("datum.plane-on-path", {
        ...catalog["datum.plane-on-path"]!.example,
        position: { mode: "proportional", value: "1.000001" },
      }),
    /clamping/,
  );
  const matrix = [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1];
  validateCad("occurrence.transform", {
    occurrence: "A:1+B:1",
    placement: { matrix, translationUnits: "mm" },
  });
  for (const [i, v] of [
    [0, -1],
    [0, 2],
    [1, 0.2],
    [15, 0],
    [3, NaN],
  ]) {
    const bad = [...matrix];
    bad[i!] = v!;
    assert.throws(() =>
      validateCad("occurrence.transform", {
        occurrence: "A:1",
        placement: { matrix: bad, translationUnits: "mm" },
      }),
    );
  }
});

test("GM04 snapshot consent and conditional joint requirements are explicit", () => {
  for (const op of ["datum.plane", "datum.axis"]) {
    assert.throws(
      () => validateCad(op, { name: "D", mode: "frame", frame: "root" }),
      /snapshot/,
    );
    validateCad(op, {
      name: "D",
      mode: "frame",
      frame: "root",
      associativity: "snapshot",
    });
  }
  const joint = { name: "j", occurrenceOne: "A:1+B:1", occurrenceTwo: "C:1" };
  assert.throws(() => validateCad("joint.revolute", joint), /point and axis/);
  validateCad("joint.revolute", {
    ...joint,
    frame: { occurrence: "A:1+B:1", datum: "mount" },
    associativity: "snapshot",
  });
  validateCad("joint.slider", {
    ...joint,
    point: "origin",
    axis: { ref: "rail" },
  });
  assert.throws(
    () =>
      validateCad("joint.slider", {
        ...joint,
        frame: "root",
        associativity: "snapshot",
        point: "origin",
      }),
    /replaces/,
  );
});

test("GM04 blocked and failed results preserve status, identity, actual pose and affected paths", async () => {
  const result = {
    schemaVersion: 1,
    status: "fail",
    documentIdentity: { creationId: "id" },
    actual: [1],
    affected: [{ path: "A:1+B:1" }],
    associativity: "snapshot",
  };
  let calls = 0;
  const client = {
    callTool: async () => {
      calls++;
      return {
        text: "FMCAD_RESULT " + JSON.stringify({ success: false, result }),
      };
    },
  };
  const output = await executeCad(
    client,
    "occurrence.transform",
    { occurrence: "A:1", placement: {} },
    { doc: "GM04" },
  );
  assert.equal(calls, 1);
  assert.equal(output.status, "fail");
  assert.equal(output.success, false);
  assert.deepEqual(output.affected, result.affected);
  assert.deepEqual(output.result.actual, [1]);
});

test("GM04 native handoff batch validates through the real CLI without backend access", () => {
  const out = spawnSync(
    process.execPath,
    [
      "bin/fmcad.js",
      "batch",
      "validate",
      "--doc",
      "GM04_Acceptance",
      "--file",
      "tests/fixtures/gm04/native.json",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr + out.stdout);
  const result = JSON.parse(out.stdout);
  assert.equal(result.success, true);
  assert.equal(result.mutated, false);
  assert.equal(result.operations.length, 32);
});

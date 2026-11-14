import { createRequire } from "node:module";
import type { Descriptor, ModelingApi } from "./modeling-unit-test-support";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
const load = createRequire(path.join(process.cwd(), "tests/model.test.ts"));
test.after(load("./fixtures/fake-wsl-platform.cjs")());
const catalog = load("../src/catalog/model.json") as Record<
  string,
  Descriptor
>;

test("model catalog entries have complete offline help and examples", () => {
  assert.equal(Object.keys(catalog).length, 30);
  for (const [key, entry] of Object.entries(catalog)) {
    assert.ok(entry.summary, key);
    assert.equal(typeof entry.readOnly, "boolean", key);
    assert.ok(entry.limitations.length, key);
    for (const input of entry.required) {
      assert.ok(
        Object.hasOwn(entry.example, input),
        `${key}: example missing ${input}`,
      );
      assert.ok(entry.inputs[input], `${key}: undocumented ${input}`);
    }
    for (const input of Object.keys(entry.example))
      assert.ok(entry.inputs[input], `${key}: ${input}`);
  }
});

test("model handlers pass offline Python API-contract tests", () => {
  const result = spawnSync(
    "python3",
    ["-B", path.join(process.cwd(), "tests", "model_test.py")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("priority geometry catalog has conditional extents and exact public API limits", () => {
  const { validateCad } = load("../src/cad") as ModelingApi;
  assert.deepEqual(catalog["model.extrude"]!.required, []);
  assert.match(
    catalog["model.extrude"]!.inputs["profile"]!,
    /exactly one of profile\/profiles/,
  );
  assert.match(
    catalog["model.extrude"]!.inputs["profiles"]!,
    /nonempty ordered array.*co-planar/,
  );
  assert.match(
    catalog["model.extrude"]!.limitations.join(" "),
    /stable per-profile body association/i,
  );
  assert.deepEqual(catalog["model.hole"]!.required, ["points", "diameter"]);
  for (const command of ["model.extrude", "model.hole"]) {
    for (const field of ["extent", "target"])
      assert.ok(catalog[command]!.inputs[field]);
    assert.match(
      catalog[command]!.inputs["extent"]!,
      /distance.*throughAll.*toEntity/,
    );
  }
  assert.ok(catalog["model.extrude"]!.inputs["startOffset"]!);
  assert.ok(catalog["model.extrude"]!.inputs["offset"]!);
  assert.equal(catalog["model.hole"]!.inputs["offset"]!, undefined);
  assert.ok(catalog["model.sweep"]!.inputs["orientation"]!);
  assert.match(catalog["model.sweep"]!.inputs["guideRail"]!, /Cannot combine/);
  assert.ok(catalog["model.loft"]!.inputs["rails"]!);
  assert.ok(catalog["model.loft"]!.inputs["centerLine"]!);
  assert.match(
    catalog["model.loft"]!.limitations.join(" "),
    /centerLineOrRails.addRail\/addCenterLine/,
  );
  for (const [operation, data] of [
    [
      "model.extrude",
      {
        profile: { kind: "profile", sketch: "Section", index: 0 },
        extent: "throughAll",
        operation: "cut",
        participants: ["Base"],
      },
    ],
    [
      "model.extrude",
      {
        profiles: [
          { kind: "profile", sketch: "Section", index: 0 },
          { kind: "profile", sketch: "OtherSection", index: 0 },
        ],
        distance: "5 mm",
        operation: "newBody",
      },
    ],
    [
      "model.extrude",
      {
        profile: { kind: "profile", sketch: "Section", index: 0 },
        extent: "toEntity",
        target: "XY",
        offset: "-1 mm",
        startOffset: "2 mm",
      },
    ],
    [
      "model.hole",
      {
        points: [{ token: "point-token" }],
        diameter: "5 mm",
        extent: "throughAll",
        reverse: true,
      },
    ],
    [
      "model.hole",
      {
        points: [{ token: "point-token" }],
        diameter: "5 mm",
        extent: "toEntity",
        target: "XY",
      },
    ],
    [
      "model.sweep",
      { ...catalog["model.sweep"]!.example, orientation: "parallel" },
    ],
    [
      "model.sweep",
      {
        ...catalog["model.sweep"]!.example,
        guideRail: { curves: [{ token: "rail-token" }] },
      },
    ],
    [
      "model.loft",
      {
        ...catalog["model.loft"]!.example,
        rails: [{ curves: [{ token: "rail-token" }] }],
      },
    ],
    [
      "model.loft",
      {
        ...catalog["model.loft"]!.example,
        centerLine: { token: "center-token" },
      },
    ],
  ] as [string, Record<string, unknown>][]) {
    assert.doesNotThrow(() => validateCad(operation, data));
    assert.throws(
      () => validateCad(operation, { ...data, invented: true }),
      /Unknown CAD inputs/,
    );
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const root = process.cwd();
const load = createRequire(path.join(root, "package.json"));
interface Policy {
  validate(operation: string, data: unknown): void;
  descriptors?: Record<string, unknown>;
}
interface Fixture {
  family: string;
  revision: string;
  file: string;
  sha256: string;
}
const folder = path.join(root, "tests/fixtures/modeling-history");
const manifest: Fixture[] = JSON.parse(
  fs.readFileSync(path.join(folder, "manifest.json"), "utf8"),
);
const catalog = (
  load("./src/cad") as { catalog: Record<string, { example?: unknown }> }
).catalog;
function historical(entry: Fixture): Policy {
  const bytes = fs.readFileSync(path.join(folder, entry.file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  const context = { module: { exports: {} } };
  vm.runInNewContext(bytes.toString("utf8"), context, { filename: entry.file });
  return context.module.exports as Policy;
}
function outcome(policy: Policy, operation: string, value: unknown): string {
  const data: unknown = structuredClone(value);
  const before = JSON.stringify(data);
  try {
    policy.validate(operation, data);
    return "accepted";
  } catch (error) {
    return error instanceof Error
      ? error.message
      : String((error as { message: string }).message);
  } finally {
    assert.equal(
      JSON.stringify(data),
      before,
      "validation must not mutate input",
    );
  }
}
const origin = ["0 mm", "0 mm", "0 mm"];
const cases: Record<string, [string, unknown][]> = {
  sketch: [
    [
      "sketch.build",
      {
        geometry: [
          {
            type: "rectangle",
            name: "box",
            start: origin,
            end: ["10 mm", "20 mm", "0 mm"],
          },
        ],
      },
    ],
    [
      "sketch.geometry",
      {
        sketch: "S",
        geometry: [
          { type: "line", start: origin, end: ["-1 mm", "0 mm", "1 mm"] },
        ],
      },
    ],
    [
      "sketch.geometry",
      {
        sketch: "S",
        geometry: [{ type: "line", start: [0, 0, 0], end: origin }],
      },
    ],
    [
      "sketch.geometry",
      {
        sketch: "S",
        geometry: [
          {
            type: "bezier",
            controlPoints: [origin, origin, origin, origin],
            fixed: false,
          },
        ],
      },
    ],
    [
      "sketch.dimension",
      {
        sketch: "S",
        type: "radius",
        entities: ["circle"],
        text: origin,
        expression: "5 mm",
      },
    ],
    [
      "sketch.dimension",
      {
        sketch: "S",
        type: "radius",
        entities: ["circle"],
        text: origin,
        driving: false,
      },
    ],
    [
      "sketch.dimension",
      {
        sketch: "S",
        type: "radius",
        entities: ["circle"],
        text: origin,
        driving: false,
        expression: "5 mm",
      },
    ],
    [
      "sketch.transform",
      {
        sketch: "S",
        entities: ["line"],
        rotate: { angle: "30 deg", center: origin },
      },
    ],
    [
      "sketch.transform",
      {
        sketch: "S",
        entities: ["line"],
        rotate: { angle: "30 deg", scale: 2 },
      },
    ],
    ["sketch.dimension-plan", { sketch: "S", maxEntities: 0 }],
    [
      "sketch.dimension-apply",
      { sketch: "S", plan: { $ref: "plan" }, accept: ["a", "a"] },
    ],
    ["sketch.edit", { sketch: "S", movePoints: [] }],
  ],
  spring: [
    [
      "curve.helix",
      { schemaVersion: 1, frame: "component", radius: "4 mm", pitch: "5 mm" },
    ],
    [
      "curve.helix",
      { schemaVersion: 1, frame: "component", pitch: "5 mm", height: "30 mm" },
    ],
    [
      "spring.evaluate",
      { schemaVersion: 1, frame: "component", activeCoils: -1 },
    ],
    [
      "spring.configure",
      {
        schemaVersion: 1,
        frame: "component",
        compressedLength: "5 mm",
        deflection: "2 mm",
      },
    ],
  ],
  thread: [
    [
      "thread.custom-profile",
      {
        schemaVersion: 1,
        frame: "component",
        majorDiameter: "10 mm",
        pitch: "1.5 mm",
      },
    ],
    [
      "thread.custom-profile",
      {
        schemaVersion: 1,
        frame: "component",
        majorDiameter: "10 mm",
        pitch: "1.5 mm",
        minorDiameter: "8 mm",
        pitchDiameter: "9 mm",
      },
    ],
    [
      "thread.pair-check",
      { schemaVersion: 1, frame: "component", external: [], internal: {} },
    ],
    [
      "thread.catalog",
      { schemaVersion: 1, frame: "component", system: "unsupported" },
    ],
  ],
  "entity-query": [
    [
      "entity.find",
      {
        kind: "edge",
        filters: { radius: { min: "1 mm" } },
        expect: { min: 0, max: 2 },
      },
    ],
    ["entity.find", { expect: { min: 3, max: 1 } }],
    ["entity.stats", { filters: { axis: [0, 0, 0] } }],
    ["entity.find", { scope: { body: "B", feature: "F" } }],
    ["entity.find", { frame: { sketch: "S", occurrence: "P:1" } }],
    ["entity.find", { unique: true, expect: 1 }],
    ["model.fillet", { query: { kind: "edge", expect: 1 }, radius: "1 mm" }],
    ["model.fillet", { query: { kind: "face", expect: 1 }, radius: "1 mm" }],
    ["model.fillet", { query: {}, radius: "1 mm" }],
    ["measure.length", { ref: { query: { kind: "edge", expect: 1 } } }],
    [
      "check",
      {
        measurement: {
          operation: "measure.length",
          data: { ref: { query: { expect: true } } },
        },
      },
    ],
  ],
  seal: [],
  cam: [],
};
for (const entry of manifest) {
  const old = historical(entry);
  const current = load("./src/" + entry.family) as Policy;
  test(`${entry.family}: descriptors remain identical at ${entry.revision.slice(0, 7)}`, () => {
    assert.equal(
      JSON.stringify(current.descriptors),
      JSON.stringify(old.descriptors),
    );
  });
  const examples = Object.keys(old.descriptors ?? {}).map(
    (op) => [op, catalog[op]?.example] as [string, unknown],
  );
  for (const [index, [operation, data]] of [
    ...examples,
    ...(cases[entry.family] ?? []),
  ].entries()) {
    test(`${entry.family}: paired case ${index} ${operation} at ${entry.revision.slice(0, 7)}`, () => {
      assert.equal(
        outcome(current, operation, data),
        outcome(old, operation, data),
      );
    });
  }
}
const sketch = load("./src/sketch") as Policy;
const currentSketch = historical(
  manifest.find(
    (e) => e.family === "sketch" && e.revision.startsWith("0b84454"),
  )!,
);
for (const op of ["sketch.coordinate-check", "sketch.profile-query"]) {
  test(`${op}: post-baseline proof routes retain their own historical contract`, () => {
    for (const data of [
      catalog[op]?.example,
      { schemaVersion: 1, sketch: "S", expected: { profiles: -1 } },
      { schemaVersion: 1, sketch: "S", query: { area: 0 } },
    ]) {
      assert.equal(outcome(sketch, op, data), outcome(currentSketch, op, data));
    }
  });
}
test("public sketch entrypoint is the canonical compiled policy", () => {
  assert.equal(sketch, load("./src/dist/core/application/modeling/sketch"));
});

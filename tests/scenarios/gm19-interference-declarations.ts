import assert from "node:assert/strict";
import { number, record } from "./contracts";
import type { DeclarationCase } from "./retained-declaration-cases";
const list = (v: unknown): unknown[] => {
  assert.ok(Array.isArray(v));
  return v;
};
const at = (v: unknown, ...keys: (string | number)[]): unknown => {
  for (const key of keys)
    v = typeof key === "number" ? list(v)[key] : record(v)[key];
  return v;
};
const near = (actual: unknown, expected: number, tol = 1e-6, msg = "") =>
  assert.ok(
    Math.abs(number(actual) - expected) <= tol,
    `${msg} expected ${expected}, got ${String(actual)}`,
  );

export const cases: readonly DeclarationCase[] = [
  {
    id: "g19-01",
    async run(cad) {
      const out = await cad("clearance.grid", {
        schemaVersion: 1,
        frame: "component",
        instances: ["body-a", "body-b", "body-c", "body-d"],
        budget: { maxChecks: 1 },
      });
      assert.equal(at(out, "status"), "unknown", JSON.stringify(out));
      assert.equal(at(at(out, "plan"), "pairCount"), 6, JSON.stringify(out));
      assert.equal(at(at(out, "plan"), "totalChecks"), 6, JSON.stringify(out));
      assert.equal(
        at(at(out, "coverage"), "continuousVerified"),
        false,
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g19-03",
    async run(cad) {
      const out = await cad("clearance.grid", {
        schemaVersion: 1,
        frame: "component",
        pairs: [{ a: "body-a", b: "body-b" }],
        joints: [
          { joint: "j1", rotation: { from: "0 deg", to: "90 deg" } },
          { joint: "j2", rotation: { from: "0 deg", to: "180 deg" } },
        ],
        samples: 3,
        budget: { maxChecks: 1 },
      });
      assert.equal(at(out, "status"), "unknown", JSON.stringify(out));
      assert.equal(at(at(out, "plan"), "configCount"), 9, JSON.stringify(out));
      assert.equal(at(at(out, "plan"), "pairCount"), 1, JSON.stringify(out));
      assert.equal(at(at(out, "plan"), "totalChecks"), 9, JSON.stringify(out));
    },
  },
  {
    id: "g19-05",
    async run(cad) {
      const out = await cad("clearance.grid", {
        schemaVersion: 1,
        frame: "component",
        instances: ["body-a", "body-b", "body-c"],
        budget: { maxChecks: 1 },
      });
      assert.equal(at(out, "status"), "unknown", JSON.stringify(out));
      assert.equal(
        at(at(out, "plan"), "withinBudget"),
        false,
        JSON.stringify(out),
      );
      assert.equal(
        at(at(at(out, "plan"), "budget"), "maxChecks"),
        1,
        JSON.stringify(out),
      );
      assert.equal(
        at(out, "skippedReason"),
        "budget exceeded",
        JSON.stringify(out),
      );
      assert.deepEqual(at(out, "results"), [], JSON.stringify(out));
      assert.equal(at(at(out, "coverage"), "unknown"), 3, JSON.stringify(out));
    },
  },
  {
    id: "g19-06",
    async run(cad) {
      const out = await cad("motion.envelope", {
        schemaVersion: 1,
        frame: "component",
        motion: {
          type: "translation",
          axis: [1, 0, 0],
          from: "0 mm",
          to: "20 mm",
        },
        bounds: { min: [0, 0, 0], max: [10, 10, 10] },
        representation: "sampled",
        samples: 5,
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(at(out, "sampleCount"), 5, JSON.stringify(out));
      near(
        at(at(at(out, "sampledEnvelope"), "max"), 0),
        12.0,
        1e-6,
        "sampled max x",
      );
      assert.equal(at(out, "continuousVerified"), false, JSON.stringify(out));
    },
  },
  {
    id: "g19-07",
    async run(cad) {
      const out = await cad("motion.envelope", {
        schemaVersion: 1,
        frame: "component",
        motion: {
          type: "rotation",
          axis: [0, 0, 1],
          from: "0 deg",
          to: "360 deg",
        },
        bounds: { min: [0, 0, 0], max: [10, 10, 10] },
        representation: "conservative",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.ok(at(out, "sampledEnvelope"), JSON.stringify(out));
      assert.ok(at(out, "conservativeEnvelope"), JSON.stringify(out));
      near(
        at(at(out, "errorBound"), "value"),
        Math.sqrt(number(75)),
        1e-5,
        "bounding-sphere radius",
      );
      assert.equal(at(out, "continuousVerified"), false, JSON.stringify(out));
    },
  },
  {
    id: "g19-11",
    async run(cad) {
      const out = await cad("motion.envelope", {
        schemaVersion: 1,
        frame: "component",
        motion: {
          type: "translation",
          axis: [1, 0, 0],
          from: "0 mm",
          to: "20 mm",
        },
        bounds: { min: [0, 0, 0], max: [10, 10, 10] },
        representation: "certified",
      });
      assert.equal(at(out, "status"), "unknown", JSON.stringify(out));
      assert.equal(at(out, "continuousVerified"), false, JSON.stringify(out));
      assert.equal(at(out, "certified"), false, JSON.stringify(out));
    },
  },
];

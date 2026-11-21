import assert from "node:assert/strict";
import { number, record, text } from "./contracts";
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
const cylinder = (points: string[][], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  frame: "component",
  region: {
    type: "cylinder",
    origin: ["0 mm", "0 mm", "0 mm"],
    direction: [0, 0, 1],
    radius: "5 mm",
    height: "10 mm",
  },
  points,
  boundaryTolerance: "0.01 mm",
  ...extra,
});
export const cases: readonly DeclarationCase[] = [
  {
    id: "g20-01",
    async run(cad) {
      const out = await cad(
        "measure.contains",
        cylinder([
          ["0 mm", "0 mm", "5 mm"],
          ["6 mm", "0 mm", "5 mm"],
          ["4.999 mm", "0 mm", "5 mm"],
        ]),
      );
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.deepEqual(
        list(at(out, "results")).map((r) => at(r, "classification")),
        ["inside", "outside", "boundary"],
        JSON.stringify(out),
      );
      assert.deepEqual(
        at(out, "counts"),
        { inside: 1, outside: 1, boundary: 1, error: 0, unknown: 0 },
        JSON.stringify(out),
      );
      assert.equal(
        at(at(out, "frame"), "space"),
        "component",
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g20-02",
    async run(cad) {
      const out = await cad(
        "measure.contains",
        cylinder([
          ["0 mm", "0 mm", "5 mm"],
          ["4.999 mm", "0 mm", "5 mm"],
          ["4.98 mm", "0 mm", "5 mm"],
          ["6 mm", "0 mm", "5 mm"],
        ]),
      );
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      near(at(out, "boundaryTolerance"), 0.001, 1e-9, "boundaryTolerance cm");
      assert.deepEqual(
        list(at(out, "results")).map((r) => at(r, "classification")),
        ["inside", "boundary", "inside", "outside"],
        JSON.stringify(out),
      );
      // The boundary point carries its distance to the region surface.
      assert.ok(
        number(at(at(at(out, "results"), 1), "boundaryDistance")) <
          number(at(out, "boundaryTolerance")),
        JSON.stringify(out),
      );
      assert.match(
        text(list(at(out, "limitations")).join(" ")),
        /signed[- ]distance/,
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g20-03",
    async run(cad) {
      const out = await cad("measure.corridor", {
        schemaVersion: 1,
        frame: "component",
        path: [
          ["0 mm", "0 mm", "0 mm"],
          ["0 mm", "10 mm", "0 mm"],
          ["0 mm", "20 mm", "0 mm"],
        ],
        radius: "2 mm",
        obstacles: [
          { point: ["3 mm", "5 mm", "0 mm"] },
          { point: ["0.5 mm", "5 mm", "0 mm"] },
        ],
        minimumClearance: "0.5 mm",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const occupancy = at(out, "occupancy");
      near(
        at(at(occupancy, 0), "clearance"),
        0.1,
        1e-5,
        "obstacle 0 clearance",
      );
      assert.equal(
        at(at(occupancy, 0), "intrudes"),
        false,
        JSON.stringify(out),
      );
      near(
        at(at(occupancy, 1), "clearance"),
        -0.15,
        1e-5,
        "obstacle 1 clearance",
      );
      assert.equal(at(at(occupancy, 1), "intrudes"), true, JSON.stringify(out));
      assert.equal(at(out, "intrusions"), 1, JSON.stringify(out));
      near(at(out, "arcLength"), 2.0, 1e-5, "arcLength cm");
    },
  },
  {
    id: "g20-04",
    async run(cad) {
      const out = await cad("measure.region", {
        schemaVersion: 1,
        frame: "component",
        region: {
          type: "box",
          min: ["0 mm", "0 mm", "0 mm"],
          max: ["10 mm", "10 mm", "10 mm"],
        },
        occupants: [
          { point: ["5 mm", "5 mm", "5 mm"], radius: "2 mm" },
          { point: ["20 mm", "5 mm", "5 mm"] },
        ],
        sections: [{ z: "5 mm" }],
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(at(out, "occupiedCount"), 1, JSON.stringify(out));
      assert.equal(at(out, "occupantCount"), 2, JSON.stringify(out));
      assert.equal(
        at(at(at(out, "sections"), 0), "occupantCount"),
        1,
        JSON.stringify(out),
      );
      assert.ok(
        number(at(at(at(out, "sections"), 0), "occupiedUnionArea")) > number(0),
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g20-05",
    async run(cad) {
      const out = await cad("measure.contains", {
        schemaVersion: 1,
        frame: "component",
        region: {
          type: "ring",
          origin: ["0 mm", "0 mm", "0 mm"],
          direction: [0, 0, 1],
          outerRadius: "8 mm",
          innerRadius: "3 mm",
          height: "5 mm",
        },
        points: [
          ["1 mm", "0 mm", "2.5 mm"],
          ["5 mm", "0 mm", "2.5 mm"],
        ],
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.deepEqual(
        list(at(out, "results")).map((r) => at(r, "classification")),
        ["outside", "inside"],
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g20-06",
    async run(cad) {
      const box = await cad("measure.contains", {
        schemaVersion: 1,
        frame: "component",
        region: {
          type: "box",
          min: ["0 mm", "0 mm", "0 mm"],
          max: ["10 mm", "10 mm", "10 mm"],
        },
        points: [
          ["5 mm", "5 mm", "5 mm"],
          ["12 mm", "5 mm", "5 mm"],
        ],
      });
      assert.equal(at(box, "status"), "pass", JSON.stringify(box));
      assert.deepEqual(
        list(at(box, "results")).map((r) => at(r, "classification")),
        ["inside", "outside"],
        JSON.stringify(box),
      );
      near(
        at(at(at(box, "results"), 1), "signedDistance"),
        -0.2,
        1e-5,
        "box exterior signed distance",
      );
      const sphere = await cad("measure.contains", {
        schemaVersion: 1,
        frame: "component",
        region: {
          type: "sphere",
          center: ["0 mm", "0 mm", "0 mm"],
          radius: "10 mm",
        },
        points: [["0 mm", "0 mm", "0 mm"]],
      });
      assert.equal(
        at(at(at(sphere, "results"), 0), "classification"),
        "inside",
        JSON.stringify(sphere),
      );
      const union = await cad("measure.contains", {
        schemaVersion: 1,
        frame: "component",
        region: {
          type: "union",
          regions: [
            {
              type: "sphere",
              center: ["0 mm", "0 mm", "0 mm"],
              radius: "5 mm",
            },
            {
              type: "sphere",
              center: ["10 mm", "0 mm", "0 mm"],
              radius: "5 mm",
            },
          ],
        },
        points: [["7 mm", "0 mm", "0 mm"]],
      });
      assert.equal(
        at(at(at(union, "results"), 0), "classification"),
        "inside",
        JSON.stringify(union),
      );
    },
  },
];

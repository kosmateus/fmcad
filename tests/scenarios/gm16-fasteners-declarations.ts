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

export const cases: readonly DeclarationCase[] = [
  {
    id: "g16-03",
    async run(cad) {
      const out = await cad("fastener.stack", {
        schemaVersion: 1,
        frame: "component",
        screw: { length: "12 mm", threadLength: "10 mm", headDiameter: "6 mm" },
        stack: [
          { id: "bracket", thickness: "4 mm" },
          { id: "pcb", thickness: "1.6 mm" },
        ],
        receptacle: { kind: "insert", depth: "8 mm" },
        torque: "0.5 N*m",
        tool: { diameter: "5 mm" },
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const body = out;
      near(at(at(body, "clampedLength"), "value"), 5.6, 1e-6, "clampedLength");
      near(at(at(body, "engagement"), "value"), 4.4, 1e-6, "engagement");
      assert.equal(at(body, "torqueStatus"), "declared", JSON.stringify(out));
      near(
        at(at(at(body, "bottoming"), "clearance"), "value"),
        1.6,
        1e-6,
        "bottoming clearance",
      );
      assert.equal(
        at(at(body, "bottoming"), "bottomed"),
        false,
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g16-04",
    async run(cad) {
      const out = await cad("fastener.check", {
        schemaVersion: 1,
        frame: "component",
        screw: { length: "12 mm", threadLength: "10 mm" },
        stack: [{ thickness: "4 mm" }, { thickness: "1.6 mm" }],
        minimumEngagement: "4 mm",
        receptacle: { kind: "insert", depth: "8 mm" },
        tool: { diameter: "4 mm", recess: "5 mm" },
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const statuses = Object.fromEntries(
        list(at(out, "checks")).map((c) => [at(c, "check"), at(c, "status")]),
      );
      assert.equal(at(statuses, "engagement"), "pass", JSON.stringify(out));
      assert.equal(at(statuses, "bottoming"), "pass", JSON.stringify(out));
      assert.equal(at(statuses, "access"), "pass", JSON.stringify(out));
    },
  },
  {
    id: "g16-05",
    async run(cad) {
      const complete = await cad("fastener.schedule", {
        schemaVersion: 1,
        frame: "component",
        fasteners: [
          {
            id: "A",
            torque: "0.5 N*m",
            process: "torque wrench",
            material: "A2-70",
          },
        ],
      });
      assert.equal(at(complete, "success"), true, JSON.stringify(complete));
      assert.equal(at(complete, "status"), "pass", JSON.stringify(complete));
      assert.deepEqual(
        at(complete, "missingData"),
        [],
        JSON.stringify(complete),
      );
      const incomplete = await cad(
        "fastener.schedule",
        {
          schemaVersion: 1,
          frame: "component",
          fasteners: [{ id: "B", torque: "0.5 N*m" }],
        },
        true,
      );
      assert.equal(
        at(incomplete, "status"),
        "unknown",
        JSON.stringify(incomplete),
      );
      assert.deepEqual(
        at(incomplete, "missingData"),
        ["B"],
        JSON.stringify(incomplete),
      );
    },
  },
  {
    id: "g16-06",
    async run(cad) {
      const out = await cad("bearing.stack-check", {
        schemaVersion: 1,
        frame: "component",
        rings: { inner: { bore: "10 mm" }, outer: { od: "26 mm" } },
        journal: "10 mm",
        seat: "26 mm",
        shaftClearance: "0.005 mm",
        housingClearance: "0.0 mm",
        shoulder: { inner: true },
        arrangement: "fixed-floating",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(at(out, "fixedRing"), "inner", JSON.stringify(out));
      assert.match(
        text(at(out, "preload")),
        /none declared/,
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g16-07",
    async run(cad) {
      const out = await cad("shaft.interface", {
        schemaVersion: 1,
        frame: "component",
        shaft: { type: "D-flat", d: "6 mm", flat: { depth: "0.5 mm" } },
        hub: {
          bore: "6 mm",
          boreType: "D-flat",
          splitClampGap: "0.8 mm",
          shoulders: [{}],
        },
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const statuses = Object.fromEntries(
        list(at(out, "checks")).map((c) => [at(c, "check"), at(c, "status")]),
      );
      assert.equal(at(statuses, "d-flat-mate"), "pass", JSON.stringify(out));
    },
  },
  {
    id: "g16-08",
    async run(cad) {
      const out = await cad("retention.bayonet", {
        schemaVersion: 1,
        frame: "component",
        lugs: { count: 3, width: "4 mm", height: "2 mm" },
        stroke: "6 mm",
        rotation: "30 deg",
        capture: { depth: "1.5 mm" },
        clearances: { radial: "0.2 mm" },
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(
        at(out, "assemblyPath"),
        "insert -> rotate -> capture",
        JSON.stringify(out),
      );
      assert.equal(
        at(out, "unlockPath"),
        "counter-rotate -> retract",
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g16-09",
    async run(cad) {
      const out = await cad("snap.define", {
        schemaVersion: 1,
        frame: "component",
        geometry: {
          length: "10 mm",
          width: "4 mm",
          thickness: "1 mm",
          engagementDepth: "0.6 mm",
        },
        material: { name: "ABS", modulus: "2.1 GPa" },
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(at(at(out, "material"), "name"), "ABS", JSON.stringify(out));
      assert.match(text(at(out, "shape")), /cantilever beam snap/);
    },
  },
  {
    id: "g16-11",
    async run(cad) {
      const out = await cad("snap.evaluate", {
        schemaVersion: 1,
        frame: "component",
        geometry: {
          length: "10 mm",
          width: "4 mm",
          thickness: "1 mm",
          engagementDepth: "0.6 mm",
          deflection: "0.6 mm",
        },
        material: { name: "ABS", modulus: "2.1 GPa", yieldStrength: "40 MPa" },
        support: { condition: "cantilever" },
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const body = out;
      // I = w*t^3/12 = 1/3 mm^4; k = 3*E*I/L^3 = 3*2100*(1/3)/1000 = 2.1 N/mm.
      near(at(at(body, "stiffness"), "value"), 2.1, 1e-6, "stiffness");
      near(
        at(at(body, "engagementForce"), "value"),
        1.26,
        1e-6,
        "engagementForce",
      );
      near(at(at(body, "stress"), "value"), 18.9, 1e-6, "stress");
    },
  },
  {
    id: "g16-02",
    async run(cad) {
      const ok = await cad("mount.check", {
        schemaVersion: 1,
        frame: "component",
        scheme: "pin-slot",
        holes: [
          { diameter: "3 mm", clearance: "0.5 mm" },
          { diameter: "3 mm", clearance: "0.5 mm" },
        ],
        connector: { supported: true, supportPresent: true },
      });
      assert.equal(at(ok, "success"), true, JSON.stringify(ok));
      assert.equal(at(ok, "status"), "pass", JSON.stringify(ok));
      assert.equal(at(ok, "overConstrained"), false, JSON.stringify(ok));
      const bad = await cad(
        "mount.check",
        {
          schemaVersion: 1,
          frame: "component",
          scheme: "two-pin",
          holes: [{ diameter: "3 mm", clearance: "0 mm" }],
          connector: { supported: true },
        },
        true,
      );
      assert.equal(at(bad, "status"), "fail", JSON.stringify(bad));
      // The retained source separately requires the real CLI exit code 1.
    },
  },
  {
    id: "g16-12",
    async run(cad) {
      const out = await cad(
        "shaft.interface",
        {
          schemaVersion: 1,
          frame: "component",
          shaft: { type: "D-flat", d: "6 mm", flat: { depth: "0.5 mm" } },
          hub: { bore: "6 mm", boreType: "round" },
        },
        true,
      );
      assert.equal(at(out, "status"), "fail", JSON.stringify(out));
      const statuses = Object.fromEntries(
        list(at(out, "checks")).map((c) => [
          String(at(c, "check")),
          at(c, "status"),
        ]),
      );
      assert.equal(statuses["d-flat-mate"], "fail", JSON.stringify(out));
      // The retained source separately requires the real CLI exit code 1.
    },
  },
];

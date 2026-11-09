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
    id: "g17-01",
    async run(cad) {
      const gear = await cad("mechanism.couple", {
        schemaVersion: 1,
        frame: "component",
        coupling: {
          type: "rotation",
          driverTeeth: 20,
          drivenTeeth: 40,
          external: true,
        },
        driverRange: { from: "0 deg", to: "720 deg" },
        samples: 16,
      });
      assert.equal(at(gear, "success"), true, JSON.stringify(gear));
      assert.equal(at(gear, "status"), "pass", JSON.stringify(gear));
      assert.equal(at(gear, "sign"), -1, JSON.stringify(gear));
      near(at(gear, "ratio"), -0.5, 1e-9, "gear ratio");
      assert.equal(
        at(at(gear, "evaluated"), "unwrapped"),
        true,
        JSON.stringify(gear),
      );
      near(
        at(
          at(
            at(
              at(at(gear, "evaluated"), "track"),
              number(list(at(at(gear, "evaluated"), "track")).length) -
                number(1),
            ),
            "driven",
          ),
          "value",
        ),
        number(-2) * number(Math.PI),
        1e-5,
        "driven at 720deg",
      );
      const screw = await cad("mechanism.couple", {
        schemaVersion: 1,
        frame: "component",
        coupling: { type: "screw", lead: "5 mm" },
        driverRange: { from: "0 deg", to: "360 deg" },
        samples: 16,
      });
      assert.equal(at(screw, "status"), "pass", JSON.stringify(screw));
      assert.equal(at(screw, "type"), "screw", JSON.stringify(screw));
      near(at(screw, "lead"), 0.5, 1e-9, "screw lead cm");
      const track = at(at(screw, "evaluated"), "track");
      near(
        at(
          at(at(track, number(list(track).length) - number(1)), "driven"),
          "value",
        ),
        0.5,
        1e-6,
        "one revolution advance",
      );
    },
  },
  {
    id: "g17-02",
    async run(cad) {
      const out = await cad("mechanism.couple", {
        schemaVersion: 1,
        frame: "component",
        coupling: { type: "rotation", ratio: -0.5, zeroPhase: "0 deg" },
        driverRange: { from: "0 deg", to: "90 deg" },
        samples: 4,
        drivenMeasured: ["0 deg", "-15 deg", "-30 deg", "-45 deg"],
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(
        at(at(out, "evaluated"), "engaged"),
        true,
        JSON.stringify(out),
      );
      near(
        at(at(at(out, "evaluated"), "maxResidual"), "value"),
        0.0,
        1e-9,
        "max residual",
      );
      near(at(at(out, "zeroPhase"), "value"), 0.0, 1e-9, "zero phase");
    },
  },
  {
    id: "g17-04",
    async run(cad) {
      const out = await cad("mechanism.stop-check", {
        schemaVersion: 1,
        frame: "component",
        coupling: { type: "rotation", ratio: -0.5 },
        limits: {
          working: { min: "0 deg", max: "200 deg" },
          program: { max: "180 deg" },
          hard: { max: "200 deg" },
        },
        stopSurfaces: [{ clearance: "0.2 mm" }],
        sensorWindow: { from: "0 deg", to: "170 deg" },
        tolerance: "0.01 deg",
        driverValue: "200 deg",
        drivenValue: "-100 deg",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(
        at(out, "programLimitIsNotPhysicalStop"),
        true,
        JSON.stringify(out),
      );
      const statuses = Object.fromEntries(
        list(at(out, "checks")).map((c) => [at(c, "check"), at(c, "status")]),
      );
      assert.equal(
        at(statuses, "program-vs-hard"),
        "pass",
        JSON.stringify(out),
      );
      assert.equal(at(statuses, "engagement"), "pass", JSON.stringify(out));
    },
  },
  {
    id: "g17-05",
    async run(cad) {
      const out = await cad("mechanism.couple", {
        schemaVersion: 1,
        frame: "component",
        coupling: { type: "rotation", ratio: -0.5 },
        driverRange: { from: "0 deg", to: "360 deg" },
        samples: 16,
        representation: "native",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const body = out;
      // Whether or not the SDK exposes motion links, an explicit unwrapped track is returned.
      assert.equal(
        at(at(body, "evaluated"), "unwrapped"),
        true,
        JSON.stringify(out),
      );
      assert.ok(
        Array.isArray(at(at(body, "evaluated"), "track")) &&
          list(at(at(body, "evaluated"), "track")).length === 16,
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g17-06",
    async run(cad) {
      const out = await cad("mechanism.stop-check", {
        schemaVersion: 1,
        frame: "component",
        coupling: { type: "rotation", ratio: -0.5 },
        limits: {
          working: { min: "0 deg", max: "720 deg" },
          program: { max: "180 deg" },
          hard: { max: "720 deg" },
        },
        stopSurfaces: [{ clearance: "0.2 mm" }],
        sensorWindow: { from: "0 deg", to: "700 deg" },
        tolerance: "0.01 deg",
        driverValue: "720 deg",
        drivenValue: "-360 deg",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const statuses = Object.fromEntries(
        list(at(out, "checks")).map((c) => [at(c, "check"), at(c, "status")]),
      );
      assert.equal(at(statuses, "engagement"), "pass", JSON.stringify(out));
      assert.equal(
        at(statuses, "program-vs-hard"),
        "pass",
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g17-03",
    async run(cad) {
      const data = {
        schemaVersion: 1,
        frame: "component",
        coupling: { type: "rotation", ratio: -0.5, zeroPhase: "0 deg" },
        driverValue: "90 deg",
        tolerance: "0.01 deg",
      };
      const out = await cad("mechanism.inspect", {
        ...data,
        drivenValue: "-45 deg",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(at(out, "engaged"), true, JSON.stringify(out));
      near(at(out, "residual", "value"), 0, 1e-9, "residual");
      const slipped = await cad(
        "mechanism.inspect",
        { ...data, drivenValue: "-30 deg" },
        true,
      );
      assert.equal(at(slipped, "status"), "fail", JSON.stringify(slipped));
      assert.equal(at(slipped, "engaged"), false, JSON.stringify(slipped));
      // The retained source separately requires the real CLI exit code 1.
    },
  },
];

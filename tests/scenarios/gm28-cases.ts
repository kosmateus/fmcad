import assert from "node:assert/strict";
import type { ScenarioSession } from "./runner";
import { gmCommands } from "./gm-command-contract";
import { at, list, text, number } from "../integration/offline-cli";
const near = (actual: unknown, expected: unknown, tol = 1e-6) =>
  assert.ok(
    Math.abs(number(actual) - number(expected)) < tol,
    `expected ${actual} ~= ${expected} (tol ${tol})`,
  );
const frustum = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  pupil: {
    origin: ["0 mm", "0 mm", "0 mm"],
    direction: [0, 0, 1],
    up: [0, 1, 0],
  },
  fov: { horizontal: "60 deg", vertical: "40 deg" },
  ranges: { near: "10 mm", far: "100 mm" },
  ...extra,
});
export const g28_1 = {
  id: "G28-01",
  title:
    "G28-01: optics frustum builds the basis and clips against a limiting window",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "optics",
      "frustum",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify(frustum()),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.deepEqual(at(out, "result", "axis"), [0, 0, 1]);
    assert.deepEqual(at(out, "result", "horizontal"), [0, 1, 0]);
    assert.deepEqual(at(out, "result", "vertical"), [-1, 0, 0]);
    near(at(out, "result", "halfAngles", "horizontal"), Math.PI / 6);
    near(at(out, "result", "halfAngles", "vertical"), (20 * Math.PI) / 180);
    assert.equal(list(at(out, "result", "corners", "near")).length, 4);
    assert.equal(at(out, "result", "windowLimited"), false);
    const clipped = await fmcad([
      "optics",
      "frustum",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify(
        frustum({
          window: { distance: "50 mm", width: "20 mm", height: "20 mm" },
        }),
      ),
    ]);
    assert.equal(
      at(clipped, "result", "windowLimited"),
      true,
      JSON.stringify(at(clipped, "result")),
    );
    near(
      at(clipped, "result", "effectiveHalfAngles", "horizontal"),
      Math.atan(1 / 5),
    );
    assert.ok(
      number(at(clipped, "result", "effectiveHalfAngles", "horizontal")) <
        number(at(clipped, "result", "halfAngles", "horizontal")),
    );
  },
};
export const g28_2 = {
  id: "G28-02",
  title:
    "G28-02: optics coverage union is below the individual sum with dead zones",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "optics",
      "coverage",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        sensors: [
          {
            name: "camA",
            pupil: {
              origin: ["-20 mm", "0 mm", "30 mm"],
              direction: [0.5, 0, -0.866],
              up: [0, 1, 0],
            },
            fov: { horizontal: "40 deg", vertical: "30 deg" },
            ranges: { near: "1 mm", far: "100 mm" },
          },
          {
            name: "camB",
            pupil: {
              origin: ["20 mm", "0 mm", "30 mm"],
              direction: [-0.5, 0, -0.866],
              up: [0, 1, 0],
            },
            fov: { horizontal: "40 deg", vertical: "30 deg" },
            ranges: { near: "1 mm", far: "100 mm" },
          },
        ],
        targets: [
          {
            name: "board",
            origin: ["0 mm", "0 mm", "0 mm"],
            normal: [0, 0, 1],
            u: [1, 0, 0],
            outline: [
              ["-30 mm", "-30 mm"],
              ["30 mm", "-30 mm"],
              ["30 mm", "30 mm"],
              ["-30 mm", "30 mm"],
            ],
          },
        ],
        samplingBudget: 40000,
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    const target = at(out, "result", "targets", 0);
    assert.ok(
      number(at(target, "unionCoveredArea")) > 0,
      JSON.stringify(target),
    );
    assert.ok(
      number(at(target, "sumIndividualArea")) >
        number(at(target, "unionCoveredArea")),
      JSON.stringify(target),
    );
    assert.ok(
      number(at(target, "coveredFraction")) > 0 &&
        number(at(target, "coveredFraction")) < 1,
      JSON.stringify(target),
    );
    assert.ok(
      number(at(target, "deadZoneFraction")) > 0,
      JSON.stringify(target),
    );
  },
};
export const g28_3 = {
  id: "G28-03",
  title:
    "G28-03: optics occlusion blocks a baffled line, passes a declared window",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const blocked = await fmcad([
      "optics",
      "occlusion",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        pupil: { origin: ["0 mm", "0 mm", "0 mm"] },
        rays: [{ target: ["0 mm", "0 mm", "50 mm"] }],
        obstacles: [
          {
            name: "baffle",
            kind: "baffle",
            shape: {
              type: "disk",
              origin: ["0 mm", "0 mm", "25 mm"],
              normal: [0, 0, 1],
              radius: "4 mm",
            },
          },
        ],
      }),
    ]);
    assert.equal(
      at(blocked, "result", "rays", 0, "result"),
      "blocked",
      JSON.stringify(at(blocked, "result")),
    );
    assert.equal(at(blocked, "result", "rays", 0, "obstacleName"), "baffle");
    assert.equal(at(blocked, "result", "blockedCount"), 1);
    const window = await fmcad([
      "optics",
      "occlusion",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        pupil: { origin: ["0 mm", "0 mm", "0 mm"] },
        rays: [{ target: ["0 mm", "0 mm", "50 mm"] }],
        obstacles: [
          {
            name: "window",
            kind: "window",
            transmittance: 0.9,
            shape: {
              type: "disk",
              origin: ["0 mm", "0 mm", "25 mm"],
              normal: [0, 0, 1],
              radius: "8 mm",
            },
          },
        ],
      }),
    ]);
    assert.equal(
      at(window, "result", "rays", 0, "result"),
      "window",
      JSON.stringify(at(window, "result")),
    );
    near(at(window, "result", "rays", 0, "transmittance"), 0.9);
    assert.equal(at(window, "result", "transparentCount"), 1);
  },
};
export const g28_4 = {
  id: "G28-04",
  title:
    "G28-04: sensor alignment-check reports angle deviation and forbidden zones",
  async run(session: ScenarioSession) {
    const { cad } = gmCommands(session);
    const angle = at(
      await cad([
        "sensor",
        "alignment-check",
        "--doc",
        session.document.name,
        "--data",
        JSON.stringify({
          schemaVersion: 1,
          sensor: {
            name: "ir",
            origin: ["0 mm", "0 mm", "0 mm"],
            axis: [
              0,
              Math.sin((10 * Math.PI) / 180),
              Math.cos((10 * Math.PI) / 180),
            ],
          },
          reference: {
            name: "magnet",
            origin: ["0 mm", "0 mm", "0 mm"],
            axis: [0, 0, 1],
          },
          limits: { angle: "5 deg", offset: "0.5 mm" },
        }),
      ]),
      "json",
    );
    assert.ok(angle, "expected a JSON envelope for a failing alignment-check");
    assert.equal(at(angle, "status"), "fail", JSON.stringify(angle));
    assert.equal(at(angle, "result", "aligned"), false);
    near(at(angle, "result", "angleDeviationDegrees"), 10, 1e-3);
    assert.ok(
      list(at(angle, "result", "violations")).some((v) =>
        text(v).includes("angle"),
      ),
      JSON.stringify(at(angle, "result", "violations")),
    );
    const zone = at(
      await cad([
        "sensor",
        "alignment-check",
        "--doc",
        session.document.name,
        "--data",
        JSON.stringify({
          schemaVersion: 1,
          sensor: {
            name: "ir",
            origin: ["0 mm", "0 mm", "0 mm"],
            axis: [0, 0, 1],
          },
          reference: {
            name: "magnet",
            origin: ["0 mm", "0 mm", "0 mm"],
            axis: [0, 0, 1],
          },
          limits: { angle: "5 deg", offset: "0.5 mm" },
          forbiddenZones: [
            {
              name: "magnet-zone",
              type: "box",
              min: ["0 mm", "0 mm", "0 mm"],
              max: ["10 mm", "10 mm", "10 mm"],
            },
          ],
        }),
      ]),
      "json",
    );
    assert.ok(zone, "expected a JSON envelope for a forbidden-zone failure");
    assert.equal(at(zone, "status"), "fail", JSON.stringify(zone));
    assert.ok(
      list(at(zone, "result", "forbiddenZoneIntersections")).includes(
        "magnet-zone",
      ),
      JSON.stringify(at(zone, "result")),
    );
  },
};
export const g28_5 = {
  id: "G28-05",
  title: "G28-05: near-field gap is reported, not hidden by angle sums",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "optics",
      "coverage",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        sensors: [
          {
            name: "cam",
            pupil: { origin: ["0 mm", "0 mm", "30 mm"], direction: [0, 0, -1] },
            fov: { horizontal: "60 deg", vertical: "60 deg" },
            ranges: { near: "50 mm", far: "200 mm" },
          },
        ],
        targets: [
          {
            name: "board",
            origin: ["0 mm", "0 mm", "0 mm"],
            normal: [0, 0, 1],
            u: [1, 0, 0],
            outline: [
              ["-10 mm", "-10 mm"],
              ["10 mm", "-10 mm"],
              ["10 mm", "10 mm"],
              ["-10 mm", "10 mm"],
            ],
          },
        ],
        samplingBudget: 40000,
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    const target = at(out, "result", "targets", 0);
    assert.ok(
      number(at(target, "nearFieldGapFraction")) > 0.9,
      JSON.stringify(target),
    );
    assert.ok(
      number(at(target, "coveredFraction")) < 0.05,
      JSON.stringify(target),
    );
  },
};
export const g28_6 = {
  id: "G28-06",
  title: "G28-06: aligned sensor passes without any optical/RF/magnetic claim",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "sensor",
      "alignment-check",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        sensor: {
          name: "ir",
          origin: ["0 mm", "0 mm", "0 mm"],
          axis: [0, 0, 1],
        },
        reference: {
          name: "magnet",
          origin: ["0 mm", "0 mm", "0 mm"],
          axis: [0, 0, 1],
        },
        limits: {
          angle: "5 deg",
          offset: "0.5 mm",
          gap: { min: "0 mm", max: "2 mm" },
        },
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "aligned"), true);
    near(at(out, "result", "angleDeviation"), 0, 1e-6);
    assert.deepEqual(at(out, "result", "violations"), []);
    assert.ok(
      list(at(out, "limitations")).some((l) =>
        /magnetic-field|RF/i.test(text(l)),
      ),
      JSON.stringify(at(out, "limitations")),
    );
  },
};
export const gm28Cases = [g28_1, g28_2, g28_3, g28_4, g28_5, g28_6];

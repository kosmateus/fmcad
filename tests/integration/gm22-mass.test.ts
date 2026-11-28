import type { JsonValue } from "../../packages/core/src/domain/contracts";

// Live integration tests for GM-22 (mass system / load axis / stability check).
// These are LOCAL methods: no --doc, no document clear, no backend. Each test
// asserts the SPEC's expected numeric/status result through the real fmcad CLI.

import test from "node:test";
import assert from "node:assert/strict";
import { local, at, number, list } from "./offline-cli";

const base = (): Record<string, JsonValue> => ({
  schemaVersion: 1,
  identity: { model: "mass-live", revision: "1" },
  frame: "assembly",
  assumptions: [
    "Rigid items; declared masses and local tensors; ZYX rotations.",
  ],
});
const zeros = () => ({
  ixx: "0 kg*m2",
  iyy: "0 kg*m2",
  izz: "0 kg*m2",
  ixy: "0 kg*m2",
  ixz: "0 kg*m2",
  iyz: "0 kg*m2",
});
const point = (id: string, placement: { x: string; y: string; z: string }) => ({
  id,
  mass: "1 kg",
  cg: { x: "0 m", y: "0 m", z: "0 m" },
  inertia: zeros(),
  placement,
});
const near = (actual: unknown, expected: unknown, tol = 1e-9) =>
  assert.ok(
    Math.abs(number(actual) - number(expected)) < tol,
    `expected ${actual} ~= ${expected} (tol ${tol})`,
  );

test("G22-01: derived mass from explicit density status and repeated instance count", () => {
  const d = base();
  d["items"] = [
    {
      id: "block",
      density: {
        value: "1000 kg/m3",
        status: "CONFIRMED",
        source: "material datasheet",
      },
      volume: "2 L",
      cg: { x: "0 m", y: "0 m", z: "0 m" },
      inertia: zeros(),
      placement: { x: "0 m", y: "0 m", z: "0 m" },
      count: 2,
    },
  ];
  d["maximumMass"] = "5 kg";
  const out = local(["mass", "system", "--data", JSON.stringify(d)]);
  assert.equal(at(out, "status"), "pass", JSON.stringify(out));
  assert.equal(at(out, "documentIdentity"), null);
  near(at(out, "result", "mass", "value"), 4); // 2 L x 1000 kg/m3 = 2 kg, counted twice
  assert.equal(at(out, "result", "completeness", "mass"), true);
});

test("G22-02: ownedContents prevent PCBA double counting (ledger + contents)", () => {
  const d = base();
  d["maximumMass"] = "100 g";
  d["items"] = [
    {
      id: "pcba",
      mass: "100 g",
      ownedContents: ["chip1", "chip2"],
      cg: { x: "0 m", y: "0 m", z: "0 m" },
      inertia: zeros(),
      placement: { x: "0 m", y: "0 m", z: "0 m" },
    },
    {
      id: "chip1",
      density: "1000 kg/m3",
      volume: "20 mL",
      cg: { x: "0 m", y: "0 m", z: "0 m" },
      inertia: zeros(),
      placement: { x: "0.01 m", y: "0 m", z: "0 m" },
    },
    {
      id: "chip2",
      density: "1000 kg/m3",
      volume: "20 mL",
      cg: { x: "0 m", y: "0 m", z: "0 m" },
      inertia: zeros(),
      placement: { x: "0.01 m", y: "0 m", z: "0 m" },
    },
  ];
  const out = local(["mass", "system", "--data", JSON.stringify(d)]);
  assert.equal(at(out, "status"), "pass", JSON.stringify(out));
  near(at(out, "result", "mass", "value"), 0.1); // children are already inside pcba, not added again
  assert.equal(
    at(
      list(at(out, "result", "items")).find((i) => at(i, "id") === "chip1"),
      "role",
    ),
    "included-in-parent",
  );
});

test("G22-03: supplier mass override replaces reference exclusion without zeroing", () => {
  const d = base();
  d["maximumMass"] = "100 g";
  d["items"] = [
    {
      id: "cots",
      referenceExclusion: true,
      massOverride: {
        value: "90 g",
        status: "CONFIRMED",
        source: "supplier C003 datasheet",
      },
    },
  ];
  const out = local(["mass", "system", "--data", JSON.stringify(d)]);
  assert.equal(at(out, "status"), "unknown", JSON.stringify(out));
  near(at(out, "result", "mass", "value"), 0.09);
  assert.equal(at(out, "result", "completeness", "mass"), true);
  assert.equal(at(out, "result", "completeness", "cg"), false);
});

test("G22-04: CG, inertia tensor, principal moments/axes", () => {
  const d = base();
  d["items"] = [
    point("a", { x: "0 m", y: "0 m", z: "0 m" }),
    point("b", { x: "2 m", y: "0 m", z: "0 m" }),
  ];
  d["maximumMass"] = "2 kg";
  const out = local(["mass", "system", "--data", JSON.stringify(d)]);
  assert.equal(at(out, "status"), "pass", JSON.stringify(out));
  near(at(out, "result", "mass", "value"), 2);
  near(at(out, "result", "cg", "x", "value"), 1);
  near(at(out, "result", "cg", "y", "value"), 0);
  near(at(out, "result", "inertiaAboutCG", "ixx", "value"), 0);
  near(at(out, "result", "inertiaAboutCG", "iyy", "value"), 2);
  near(at(out, "result", "inertiaAboutCG", "izz", "value"), 2);
  near(at(out, "result", "principal", "moments", 0, "value"), 0);
  near(at(out, "result", "principal", "moments", 1, "value"), 2);
  near(at(out, "result", "principal", "moments", 2, "value"), 2);
  near(Math.abs(number(at(out, "result", "principal", "axes", 0, "x"))), 1);
});

test("G22-05: load axis torques, friction/efficiency, stall torque is not a continuous rating", () => {
  const d = base();
  d["items"] = [point("a", { x: "1 m", y: "0 m", z: "0 m" })];
  d["axis"] = {
    pivot: { x: "0 m", y: "0 m", z: "0 m" },
    direction: { x: 0, y: 0, z: 1 },
  };
  d["gravity"] = { direction: { x: 0, y: -1, z: 0 }, magnitude: "10 m/s2" };
  d["accelerations"] = [
    { id: "lat", direction: { x: 0, y: 1, z: 0 }, magnitude: "3 m/s2" },
  ];
  d["externalLoads"] = [
    {
      id: "ext",
      force: { magnitude: "4 N", direction: { x: 0, y: 1, z: 0 } },
      at: { x: "1 m", y: "0 m", z: "0 m" },
    },
  ];
  d["angularAccelerations"] = [{ id: "spin", angularAcceleration: "2 rad/s2" }];
  d["angularSpeed"] = "2 rad/s";
  d["friction"] = "1 N*m";
  d["efficiency"] = "0.8 1";
  d["availableTorque"] = "10 N*m";
  const out = local(["load", "axis", "--data", JSON.stringify(d)]);
  assert.equal(at(out, "status"), "pass", JSON.stringify(out));
  near(at(out, "result", "gravitationalTorque", "value"), 10);
  near(at(out, "result", "accelerationTorques", 0, "torque", "value"), -3);
  near(at(out, "result", "externalTorques", 0, "torque", "value"), -4);
  near(at(out, "result", "dynamicTorque", "value"), 2);
  near(at(out, "result", "activeTorque", "value"), 5);
  near(at(out, "result", "netTorque", "value"), 4);
  near(at(out, "result", "requiredTorque", "value"), 7.5);
  near(at(out, "result", "radialLoad", "value"), 7);
  near(at(out, "result", "inertiaAboutAxis", "value"), 1);
  delete d["availableTorque"]; // no criterion: stall torque is not a continuous rating
  const noRating = local(["load", "axis", "--data", JSON.stringify(d)]);
  assert.equal(
    at(noRating, "status"),
    "notEvaluated",
    JSON.stringify(noRating),
  );
});

test("G22-06: stability tip-over margin against a support polygon", () => {
  const d = base();
  d["items"] = [
    {
      id: "m",
      mass: "1 kg",
      cg: { x: "0 m", y: "0 m", z: "0 m" },
      inertia: zeros(),
      placement: { x: "0 m", y: "0 m", z: "0.1 m" },
    },
  ];
  d["supportPolygon"] = [
    { x: "0.05 m", y: "0.05 m", z: "0 m" },
    { x: "0.05 m", y: "-0.05 m", z: "0 m" },
    { x: "-0.05 m", y: "-0.05 m", z: "0 m" },
    { x: "-0.05 m", y: "0.05 m", z: "0 m" },
  ];
  d["gravity"] = { direction: { x: 0, y: 0, z: -1 }, magnitude: "10 m/s2" };
  d["minimumMargin"] = "0.03 m";
  const out = local(["stability", "check", "--data", JSON.stringify(d)]);
  assert.equal(at(out, "status"), "pass", JSON.stringify(out));
  near(at(out, "result", "margin", "value"), 0.05);
  near(at(out, "result", "tipTiltAngle", "value"), Math.atan2(0.05, 0.1));
});

test("G22-07: repeated and rotated instances, Steiner parallel-axis transfer", () => {
  const repeated = base();
  repeated["items"] = [
    { ...point("a", { x: "0 m", y: "0 m", z: "0 m" }), count: 2 },
    point("b", { x: "2 m", y: "0 m", z: "0 m" }),
  ];
  repeated["maximumMass"] = "3 kg";
  const r = local(["mass", "system", "--data", JSON.stringify(repeated)]);
  assert.equal(at(r, "status"), "pass", JSON.stringify(r));
  near(at(r, "result", "mass", "value"), 3);
  near(at(r, "result", "cg", "x", "value"), 2 / 3);
  near(at(r, "result", "inertiaAboutCG", "iyy", "value"), 8 / 3);

  const rotated = base();
  rotated["items"] = [
    point("a", { x: "0 m", y: "0 m", z: "0 m" }),
    point("b", { x: "2 m", y: "0 m", z: "0 m" }),
    {
      id: "c",
      mass: "1 kg",
      cg: { x: "0.5 m", y: "0 m", z: "0 m" },
      inertia: zeros(),
      placement: { x: "1 m", y: "0 m", z: "0 m" },
      rotation: { roll: "0 deg", pitch: "0 deg", yaw: "90 deg" },
    },
  ];
  rotated["maximumMass"] = "3 kg";
  rotated["aboutPoint"] = { x: "1 m", y: "0 m", z: "0 m" };
  const s = local(["mass", "system", "--data", JSON.stringify(rotated)]);
  assert.equal(at(s, "status"), "pass", JSON.stringify(s));
  near(at(s, "result", "cg", "y", "value"), 1 / 6);
  near(at(s, "result", "inertiaAboutPoint", "izz", "value"), 2.25);
  near(at(s, "result", "inertiaAboutPoint", "ixx", "value"), 0.25);
});

test("G22-08: missing inertia is an unknown partial result, never zero", () => {
  const d = base();
  d["maximumMass"] = "1 kg";
  d["items"] = [
    {
      id: "x",
      mass: "1 kg",
      cg: { x: "0 m", y: "0 m", z: "0 m" },
      placement: { x: "0 m", y: "0 m", z: "0 m" },
    },
  ];
  const out = local(["mass", "system", "--data", JSON.stringify(d)]);
  assert.equal(at(out, "status"), "unknown", JSON.stringify(out));
  assert.equal(at(out, "result", "inertiaAboutCG"), null);
  assert.equal(at(out, "result", "completeness", "mass"), true);
  assert.equal(at(out, "result", "completeness", "cg"), true);
  assert.equal(at(out, "result", "completeness", "inertia"), false);
});

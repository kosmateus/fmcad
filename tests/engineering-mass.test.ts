import { createRequire } from "node:module";
import { record, list } from "./integration/offline-cli";
const root = process.cwd(),
  load = createRequire(__filename);
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
const { system, loadAxis, stability } = load(
  path.join(root, "src/engineering-mass"),
) as typeof import("../packages/core/src/domain/engineering/mass");
const base = () => ({
  schemaVersion: 1,
  identity: { model: "mass-fixture", revision: "1" },
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
const point = (id: string, placement: unknown) => ({
  id,
  mass: "1 kg",
  cg: { x: "0 m", y: "0 m", z: "0 m" },
  inertia: zeros(),
  placement,
});
const near = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
function cli(key: string, data: unknown) {
  return spawnSync(
    process.execPath,
    [
      "bin/fmcad.js",
      ...key.split(" "),
      "--data",
      JSON.stringify(data),
      "--json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FMCAD_BACKEND: "no-backend" },
    },
  );
}
test("system ledger, Steiner aggregation, principal axes and rotated repeated instances", () => {
  const d = base();
  record(d)["items"] = [
    point("a", { x: "0 m", y: "0 m", z: "0 m" }),
    point("b", { x: "2 m", y: "0 m", z: "0 m" }),
  ];
  record(d)["maximumMass"] = "2 kg";
  const r = system(d);
  assert.equal(r.status, "pass");
  near(present(r.result.mass).value, 2);
  near(present(present(r.result.cg).x).value, 1);
  near(present(present(r.result.cg).y).value, 0);
  near(present(present(r.result.inertiaAboutCG).ixx).value, 0);
  near(present(present(r.result.inertiaAboutCG).iyy).value, 2);
  near(present(present(r.result.inertiaAboutCG).izz).value, 2);
  near(present(present(r.result.principal).moments[0]).value, 0);
  near(present(present(r.result.principal).moments[1]).value, 2);
  near(present(present(r.result.principal).moments[2]).value, 2);
  near(Math.abs(present(present(r.result.principal).axes[0]).x), 1);
  assert.ok(
    r.result.completeness.mass &&
      r.result.completeness.cg &&
      r.result.completeness.inertia,
  );
  list(record(d)["items"]).push({
    id: "c",
    mass: "1 kg",
    cg: { x: "0.5 m", y: "0 m", z: "0 m" },
    inertia: zeros(),
    placement: { x: "1 m", y: "0 m", z: "0 m" },
    rotation: { roll: "0 deg", pitch: "0 deg", yaw: "90 deg" },
  });
  record(d)["maximumMass"] = "3 kg";
  const s = system(d);
  assert.equal(s.status, "pass");
  near(present(s.result.mass).value, 3);
  near(present(present(s.result.cg).x).value, 1);
  near(present(present(s.result.cg).y).value, 1 / 6);
  near(present(present(s.result.inertiaAboutCG).ixx).value, 1 / 6);
  near(present(present(s.result.inertiaAboutCG).iyy).value, 2);
  near(present(present(s.result.inertiaAboutCG).izz).value, 13 / 6);
  near(present(present(s.result.inertiaAboutCG).ixy).value, 0);
  record(d)["aboutPoint"] = { x: "1 m", y: "0 m", z: "0 m" };
  const p = system(d);
  near(present(present(p.result.inertiaAboutPoint).izz).value, 2.25);
  near(present(present(p.result.inertiaAboutPoint).ixx).value, 0.25);
  const repeated = base();
  record(repeated)["items"] = [point("a", { x: "0 m", y: "0 m", z: "0 m" })];
  record(list(record(repeated)["items"])[0])["count"] = 2;
  list(record(repeated)["items"]).push(
    point("b", { x: "2 m", y: "0 m", z: "0 m" }),
  );
  record(repeated)["maximumMass"] = "3 kg";
  const t = system(repeated);
  near(present(t.result.mass).value, 3);
  near(present(present(t.result.cg).x).value, 2 / 3);
  near(present(present(t.result.inertiaAboutCG).iyy).value, 8 / 3);
});
test("ownership prevents PCBA double counting, reference exclusion needs replacement, missing data is not zero", () => {
  const d = base();
  record(d)["maximumMass"] = "100 g";
  record(d)["items"] = [
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
  const r = system(d);
  assert.equal(r.status, "pass");
  near(present(r.result.mass).value, 0.1);
  assert.equal(
    present(r.result.items.find((i) => i.id === "chip1")).role,
    "included-in-parent",
  );
  record(list(record(d)["items"])[0])["ownedContents"] = ["chip1"];
  near(present(system(d).result.mass).value, 0.12);
  const twice = base();
  record(twice)["items"] = [
    list(record(d)["items"])[0],
    list(record(d)["items"])[1],
    {
      id: "other",
      mass: "5 g",
      ownedContents: ["chip1"],
      cg: { x: "0 m", y: "0 m", z: "0 m" },
      inertia: zeros(),
      placement: { x: "0 m", y: "0 m", z: "0 m" },
    },
  ];
  assert.throws(() => system(twice), /owned by both/);
  const cyclic = base();
  record(cyclic)["items"] = [
    {
      id: "a",
      mass: "1 g",
      ownedContents: ["b"],
      cg: { x: "0 m", y: "0 m", z: "0 m" },
      inertia: zeros(),
      placement: { x: "0 m", y: "0 m", z: "0 m" },
    },
    {
      id: "b",
      mass: "1 g",
      ownedContents: ["a"],
      cg: { x: "0 m", y: "0 m", z: "0 m" },
      inertia: zeros(),
      placement: { x: "0 m", y: "0 m", z: "0 m" },
    },
  ];
  assert.throws(() => system(cyclic), /Cyclic/);
  const missing = base();
  record(missing)["maximumMass"] = "1 kg";
  record(missing)["items"] = [
    {
      id: "x",
      mass: "1 kg",
      cg: { x: "0 m", y: "0 m", z: "0 m" },
      placement: { x: "0 m", y: "0 m", z: "0 m" },
    },
  ];
  const m = system(missing);
  assert.equal(m.status, "unknown");
  assert.equal(m.result.inertiaAboutCG, null);
  assert.equal(m.result.completeness.inertia, false);
  const excluded = base();
  record(excluded)["maximumMass"] = "100 g";
  record(excluded)["items"] = [{ id: "cots", referenceExclusion: true }];
  assert.equal(system(excluded).status, "unknown");
  record(list(record(excluded)["items"])[0])["massOverride"] = {
    value: "90 g",
    status: "CONFIRMED",
    source: "supplier C003 datasheet",
  };
  const e = system(excluded);
  assert.equal(e.status, "unknown");
  near(present(e.result.mass).value, 0.09);
  assert.equal(e.result.completeness.mass, true);
  assert.equal(e.result.completeness.cg, false);
  assert.throws(
    () =>
      system({
        ...base(),
        items: [{ id: "x", mass: "1 kg", density: "1 kg/m3" }],
      }),
    /exactly one/,
  );
});
test("load axis torques: gravity, acceleration, external, dynamic, friction/efficiency and radial load", () => {
  const d = base();
  record(d)["items"] = [point("a", { x: "1 m", y: "0 m", z: "0 m" })];
  record(d)["axis"] = {
    pivot: { x: "0 m", y: "0 m", z: "0 m" },
    direction: { x: 0, y: 0, z: 1 },
  };
  record(d)["gravity"] = {
    direction: { x: 0, y: -1, z: 0 },
    magnitude: "10 m/s2",
  };
  record(d)["accelerations"] = [
    { id: "lat", direction: { x: 0, y: 1, z: 0 }, magnitude: "3 m/s2" },
  ];
  record(d)["externalLoads"] = [
    {
      id: "ext",
      force: { magnitude: "4 N", direction: { x: 0, y: 1, z: 0 } },
      at: { x: "1 m", y: "0 m", z: "0 m" },
    },
  ];
  record(d)["angularAccelerations"] = [
    { id: "spin", angularAcceleration: "2 rad/s2" },
  ];
  record(d)["angularSpeed"] = "2 rad/s";
  record(d)["friction"] = "1 N*m";
  record(d)["efficiency"] = "0.8 1";
  record(d)["availableTorque"] = "10 N*m";
  const r = loadAxis(d);
  assert.equal(r.status, "pass");
  near(present(r.result.gravitationalTorque).value, 10);
  near(present(present(r.result.accelerationTorques[0]).torque).value, -3);
  near(present(present(r.result.externalTorques[0]).torque).value, -4);
  near(present(r.result.dynamicTorque).value, 2);
  near(present(r.result.activeTorque).value, 5);
  near(present(r.result.netTorque).value, 4);
  near(present(r.result.requiredTorque).value, 7.5);
  near(present(r.result.radialLoad).value, 7);
  near(present(r.result.inertiaAboutAxis).value, 1);
  record(d)["availableTorque"] = "7 N*m";
  assert.equal(loadAxis(d).status, "fail");
  delete record(d)["availableTorque"];
  assert.equal(loadAxis(d).status, "notEvaluated");
  const missing = d;
  delete record(missing)["friction"];
  assert.equal(loadAxis(missing).status, "unknown");
  delete record(d)["angularAccelerations"];
  delete record(d)["angularSpeed"];
  record(d)["availableTorque"] = "10 N*m";
  const simple = loadAxis(d);
  near(present(simple.result.activeTorque).value, 3);
  near(present(simple.result.radialLoad).value, 3);
  record(list(record(d)["items"])[0])["cg"] = undefined;
  assert.equal(loadAxis(d).status, "unknown");
  assert.throws(
    () =>
      loadAxis({
        ...d,
        items: [point("a", { x: "1 m", y: "0 m", z: "0 m" })],
        axis: {
          pivot: { x: "0 m", y: "0 m", z: "0 m" },
          direction: { x: 0, y: 0, z: 0 },
        },
      }),
    /nonzero/,
  );
});
test("stability tip-over margin on a support polygon with declared loads", () => {
  const d = base();
  record(d)["items"] = [
    {
      id: "m",
      mass: "1 kg",
      cg: { x: "0 m", y: "0 m", z: "0 m" },
      inertia: zeros(),
      placement: { x: "0 m", y: "0 m", z: "0.1 m" },
    },
  ];
  record(d)["supportPolygon"] = [
    { x: "0.05 m", y: "0.05 m", z: "0 m" },
    { x: "0.05 m", y: "-0.05 m", z: "0 m" },
    { x: "-0.05 m", y: "-0.05 m", z: "0 m" },
    { x: "-0.05 m", y: "0.05 m", z: "0 m" },
  ];
  record(d)["gravity"] = {
    direction: { x: 0, y: 0, z: -1 },
    magnitude: "10 m/s2",
  };
  record(d)["minimumMargin"] = "0.03 m";
  const r = stability(d);
  assert.equal(r.status, "pass");
  near(present(r.result.margin).value, 0.05);
  near(present(r.result.tipTiltAngle).value, Math.atan2(0.05, 0.1));
  record(d)["minimumMargin"] = "0.06 m";
  assert.equal(stability(d).status, "fail");
  record(d)["minimumMargin"] = "0.03 m";
  record(d)["accelerations"] = [
    { id: "tip", direction: { x: 1, y: 0, z: 0 }, magnitude: "5 m/s2" },
  ];
  const edge = stability(d);
  assert.equal(edge.status, "fail");
  assert.ok(present(edge.result.margin).value <= 1e-12);
  record(list(record(d)["accelerations"])[0])["magnitude"] = "20 m/s2";
  delete record(d)["minimumMargin"];
  const out = stability(d);
  assert.equal(out.status, "fail");
  assert.ok(present(out.result.margin).value < 0);
  const parallel = base();
  record(parallel)["items"] = record(d)["items"];
  record(parallel)["supportPolygon"] = record(d)["supportPolygon"];
  record(parallel)["gravity"] = {
    direction: { x: 1, y: 0, z: 0 },
    magnitude: "10 m/s2",
  };
  record(parallel)["minimumMargin"] = "0.01 m";
  const p = stability(parallel);
  assert.equal(p.status, "pass");
  assert.equal(p.result.margin, null);
  const warped = base();
  record(warped)["items"] = record(d)["items"];
  record(warped)["gravity"] = record(d)["gravity"];
  record(warped)["supportPolygon"] = list(record(d)["supportPolygon"]).map(
    (p) => ({ ...record(p) }),
  );
  record(list(record(warped)["supportPolygon"])[2])["z"] = "0.01 m";
  assert.throws(() => stability(warped), /coplanar/);
  const missing = base();
  record(missing)["items"] = [
    {
      id: "m",
      mass: "1 kg",
      cg: { x: "0 m", y: "0 m", z: "0.1 m" },
      inertia: zeros(),
    },
  ];
  record(missing)["supportPolygon"] = record(d)["supportPolygon"];
  record(missing)["gravity"] = record(d)["gravity"];
  assert.equal(stability(missing).status, "unknown");
});
test("mass real CLI variants, bad input, missing data and schema", () => {
  const d = base();
  record(d)["items"] = [point("a", { x: "0 m", y: "0 m", z: "0 m" })];
  record(d)["maximumMass"] = "1 kg";
  assert.equal(cli("mass system", d).status, 0);
  delete record(d)["maximumMass"];
  record(d)["axis"] = {
    pivot: { x: "0 m", y: "0 m", z: "0 m" },
    direction: { x: 0, y: 0, z: 1 },
  };
  record(d)["gravity"] = {
    direction: { x: 0, y: -1, z: 0 },
    magnitude: "10 m/s2",
  };
  record(d)["friction"] = "0 N*m";
  record(d)["efficiency"] = "1 1";
  record(d)["availableTorque"] = "100 N*m";
  assert.equal(cli("load axis", d).status, 0);
  const s = base();
  record(s)["items"] = record(d)["items"];
  record(s)["gravity"] = {
    direction: { x: 0, y: 0, z: -1 },
    magnitude: "10 m/s2",
  };
  record(s)["supportPolygon"] = [
    { x: "0.05 m", y: "0.05 m", z: "0 m" },
    { x: "0.05 m", y: "-0.05 m", z: "0 m" },
    { x: "-0.05 m", y: "-0.05 m", z: "0 m" },
    { x: "-0.05 m", y: "0.05 m", z: "0 m" },
  ];
  record(s)["minimumMargin"] = "0.01 m";
  assert.equal(cli("stability check", s).status, 0);
  const missing = base();
  record(missing)["maximumMass"] = "1 kg";
  record(missing)["items"] = [{ id: "x", mass: "1 kg" }];
  assert.equal(cli("mass system", missing).status, 1);
  assert.equal(cli("mass system", { ...d, typo: true }).status, 1);
  const schema = spawnSync(
    process.execPath,
    ["bin/fmcad.js", "mass", "system", "--schema"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(schema.status, 0, schema.stderr);
  assert.match(schema.stdout, /items/);
});

function present<T>(value: T | null | undefined): T {
  assert(value !== null && value !== undefined, "Expected a calculated value");
  return value;
}

import { createRequire } from "node:module";
import { at, record, list } from "./integration/offline-cli";
const root = process.cwd(),
  load = createRequire(__filename);
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
const { fillVolume, levelCurve, drainCheck, cleaningAccess } = load(
  path.join(root, "src/engineering-fluid"),
) as typeof import("../packages/core/src/domain/engineering/fluid");
const base = () => ({
  schemaVersion: 1,
  identity: { model: "fluid-fixture", revision: "1" },
  frame: "tank",
  assumptions: [
    "Closed analytic box cavity; fill axis is the declared frame Z; box displacers only.",
  ],
});
const near = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
const cavity = () => ({
  type: "box",
  length: "1 m",
  width: "1 m",
  height: "0.5 m",
});
const gravity = { direction: { x: 0, y: 0, z: -1 } };
const displacers = () => [
  {
    id: "d1",
    length: "0.4 m",
    width: "0.4 m",
    height: "0.2 m",
    position: { x: "0.2 m", y: "0.2 m", z: "0.1 m" },
  },
  {
    id: "d2",
    length: "0.4 m",
    width: "0.4 m",
    height: "0.2 m",
    position: { x: "0.3 m", y: "0.3 m", z: "0.1 m" },
  },
];
const closure = () => ({ closedDomain: true });
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
test("fill volume: unioned overlapping displacers are never double subtracted, CG and inertia", () => {
  const d = base();
  record(d)["cavity"] = cavity();
  record(d)["level"] = "0.5 m";
  record(d)["density"] = "1000 kg/m3";
  record(d)["gravity"] = gravity;
  record(d)["displacers"] = displacers();
  record(d)["closure"] = closure();
  record(d)["minimumVolume"] = "0.45 m3";
  record(d)["maximumVolume"] = "0.46 m3";
  const r = fillVolume(d);
  assert.equal(r.status, "pass");
  near(present(r.result.grossVolume).value, 0.5);
  near(present(r.result.displacedUnionVolume).value, 0.046);
  near(present(r.result.netVolume).value, 0.454);
  near(present(r.result.liquidMass).value, 454);
  near(present(present(r.result.liquidCG).z).value, 0.1204 / 0.454);
  near(present(present(r.result.liquidCG).x).value, 0.2385 / 0.454);
  assert.ok(
    present(present(r.result.liquidInertia).ixx).value > 0 &&
      present(present(r.result.liquidInertia).ixx).value < 100,
  );
  record(d)["maximumVolume"] = "0.45 m3";
  assert.equal(fillVolume(d).status, "fail");
  record(d)["maximumVolume"] = "0.46 m3";
  record(d)["minimumVolume"] = "0.46 m3";
  assert.equal(fillVolume(d).status, "fail");
  const open = base();
  record(open)["cavity"] = cavity();
  record(open)["level"] = "0.5 m";
  record(open)["density"] = "1000 kg/m3";
  record(open)["gravity"] = gravity;
  record(open)["displacers"] = displacers();
  record(open)["closure"] = {
    closedDomain: false,
    errors: ["open cavity without caps or seed faces"],
  };
  const o = fillVolume(open);
  assert.equal(o.status, "blocked");
  assert.equal(present(o.result.closureErrors).length, 1);
  assert.equal(o.result.netVolume, null);
  const noDensity = base();
  record(noDensity)["cavity"] = cavity();
  record(noDensity)["level"] = "0.5 m";
  record(noDensity)["gravity"] = gravity;
  record(noDensity)["displacers"] = displacers();
  record(noDensity)["closure"] = closure();
  record(noDensity)["minimumVolume"] = "0.45 m3";
  const n = fillVolume(noDensity);
  assert.equal(n.status, "unknown");
  near(present(n.result.netVolume).value, 0.454);
  assert.equal(n.result.liquidMass, null);
  const high = base();
  record(high)["cavity"] = cavity();
  record(high)["level"] = "0.6 m";
  record(high)["density"] = "1000 kg/m3";
  record(high)["gravity"] = gravity;
  record(high)["closure"] = closure();
  assert.throws(() => fillVolume(high), /exceeds/);
  const tilted = base();
  record(tilted)["cavity"] = cavity();
  record(tilted)["level"] = "0.5 m";
  record(tilted)["density"] = "1000 kg/m3";
  record(tilted)["gravity"] = { direction: { x: 0, y: 1, z: 0 } };
  record(tilted)["closure"] = closure();
  assert.throws(() => fillVolume(tilted), /Z axis/);
  const rotated = base();
  record(rotated)["cavity"] = cavity();
  record(rotated)["level"] = "0.5 m";
  record(rotated)["density"] = "1000 kg/m3";
  record(rotated)["gravity"] = gravity;
  record(rotated)["closure"] = closure();
  record(rotated)["displacers"] = [
    {
      id: "r1",
      length: "0.4 m",
      width: "0.4 m",
      height: "0.2 m",
      position: { x: "0.5 m", y: "0.5 m", z: "0.1 m" },
      rotation: { roll: "0 deg", pitch: "0 deg", yaw: "45 deg" },
    },
  ];
  assert.throws(() => fillVolume(rotated), /axis-aligned/);
});
test("level-curve is monotonic with MIN/MAX criteria and closure evidence", () => {
  const d = base();
  record(d)["cavity"] = cavity();
  record(d)["density"] = "1000 kg/m3";
  record(d)["gravity"] = gravity;
  record(d)["displacers"] = displacers();
  record(d)["closure"] = closure();
  record(d)["levels"] = ["0.1 m", "0.2 m", "0.3 m"];
  record(d)["criteria"] = [
    { id: "pickup", level: "0.2 m", kind: "minimum", volume: "0.15 m3" },
    { id: "headspace", level: "0.3 m", kind: "maximum", volume: "0.26 m3" },
  ];
  const r = levelCurve(d);
  assert.equal(r.status, "pass");
  assert.equal(r.result.monotonic, true);
  near(present(present(r.result.curve[0]).volume).value, 0.077);
  near(present(present(r.result.curve[1]).volume).value, 0.154);
  near(present(present(r.result.curve[2]).volume).value, 0.254);
  assert.equal(present(r.result.criteria[0]).status, "pass");
  assert.equal(present(r.result.criteria[1]).status, "pass");
  record(list(record(d)["criteria"])[0])["volume"] = "0.16 m3";
  assert.equal(levelCurve(d).status, "fail");
  record(list(record(d)["criteria"])[0])["volume"] = "0.15 m3";
  record(list(record(d)["criteria"])[1])["volume"] = "0.25 m3";
  assert.equal(levelCurve(d).status, "fail");
  record(list(record(d)["criteria"])[1])["volume"] = "0.26 m3";
  record(d)["levels"] = ["0.2 m", "0.1 m"];
  assert.throws(() => levelCurve(d), /strictly increasing/);
  record(d)["levels"] = ["0.1 m", "0.2 m", "0.3 m"];
  const open = { ...d, closure: { closedDomain: false, errors: ["no caps"] } };
  assert.equal(levelCurve(open).status, "blocked");
  delete record(d)["criteria"];
  delete record(d)["displacers"];
  const plain = levelCurve(d);
  assert.equal(plain.status, "pass");
  near(present(present(present(plain.result.curve)[1]).volume).value, 0.2);
});
test("drain check: outlet low point, raised outlet residual and unreachable drain level", () => {
  const d = base();
  record(d)["cavity"] = cavity();
  record(d)["density"] = "1000 kg/m3";
  record(d)["gravity"] = gravity;
  record(d)["outlet"] = {
    position: { x: "0.5 m", y: "0.5 m", z: "0 m" },
    diameter: "10 mm",
  };
  record(d)["drainLevel"] = "0 m";
  record(d)["maximumResidual"] = "0.001 m3";
  const r = drainCheck(d);
  assert.equal(r.status, "pass");
  near(present(r.result.residualVolume).value, 0);
  assert.equal(r.result.drainStatus, "pass");
  record(record(record(d)["outlet"])["position"])["z"] = "0.05 m";
  record(d)["maximumResidual"] = "0.1 m3";
  const raised = drainCheck(d);
  assert.equal(raised.status, "fail");
  assert.equal(raised.result.drainStatus, "fail");
  near(present(raised.result.poolVolume).value, 0.05);
  record(d)["drainLevel"] = "0.06 m";
  const reachable = drainCheck(d);
  assert.equal(reachable.status, "pass");
  near(present(reachable.result.residualVolume).value, 0.06);
  record(d)["drainLevel"] = "0 m";
  record(record(record(d)["outlet"])["position"])["z"] = "0 m";
  record(d)["pockets"] = [
    { id: "p1", volume: "0.01 m3", drains: false },
    { id: "p2", volume: "0.02 m3", drains: true },
  ];
  record(d)["maximumResidual"] = "0.005 m3";
  assert.equal(drainCheck(d).status, "fail");
  record(d)["maximumResidual"] = "0.02 m3";
  const pockets = drainCheck(d);
  assert.equal(pockets.status, "pass");
  near(present(pockets.result.residualVolume).value, 0.01);
  assert.equal(present(pockets.result.pockets[0]).countedInResidual, true);
  assert.equal(present(pockets.result.pockets[1]).countedInResidual, false);
  record(record(record(d)["outlet"])["position"])["x"] = "2 m";
  assert.throws(() => drainCheck(d), /outside/);
});
test("cleaning access: tool reach/fit, pocket and slope reports never certify hygiene", () => {
  const d = base();
  record(d)["cavity"] = cavity();
  record(d)["gravity"] = gravity;
  record(d)["tool"] = { type: "brush", length: "300 mm", diameter: "50 mm" };
  record(d)["accesses"] = [
    {
      id: "a1",
      at: { x: "0.5 m", y: "0.5 m", z: "0.5 m" },
      direction: { x: 0, y: 0, z: -1 },
      depth: "200 mm",
      openingDiameter: "60 mm",
    },
  ];
  const r = cleaningAccess(d);
  assert.equal(r.status, "pass");
  assert.equal(present(r.result.accesses[0]).reach, true);
  assert.equal(present(r.result.accesses[0]).fits, true);
  list(record(d)["accesses"]).push({
    id: "a2",
    at: { x: "0.1 m", y: "0.1 m", z: "0.5 m" },
    direction: { x: 0, y: 0, z: -1 },
    depth: "400 mm",
    openingDiameter: "60 mm",
  });
  assert.equal(cleaningAccess(d).status, "fail");
  list(record(d)["accesses"]).pop();
  record(list(record(d)["accesses"])[0])["openingDiameter"] = "40 mm";
  assert.equal(cleaningAccess(d).status, "fail");
  record(list(record(d)["accesses"])[0])["openingDiameter"] = "60 mm";
  record(d)["pockets"] = [
    {
      id: "pk",
      depth: "100 mm",
      openingDiameter: "60 mm",
      at: { x: "0.2 m", y: "0.2 m", z: "0.4 m" },
    },
  ];
  record(d)["slopes"] = [
    { id: "s1", angle: "10 deg", direction: { x: 1, y: 0, z: 0 } },
  ];
  record(d)["maximumSlope"] = "15 deg";
  const slopes = cleaningAccess(d);
  assert.equal(slopes.status, "pass");
  assert.equal(present(slopes.result.slopes[0]).status, "pass");
  assert.equal(present(slopes.result.pockets[0]).toolFits, true);
  record(d)["maximumSlope"] = "5 deg";
  assert.equal(cleaningAccess(d).status, "fail");
  record(d)["maximumSlope"] = "15 deg";
  delete record(record(d)["tool"])["length"];
  assert.equal(cleaningAccess(d).status, "unknown");
  record(record(d)["tool"])["length"] = "300 mm";
  record(record(d)["tool"])["type"] = "scraper";
  assert.throws(() => cleaningAccess(d), /tool.type/);
});
test("fluid real CLI variants, bad input and schema", () => {
  const d = base();
  record(d)["cavity"] = cavity();
  record(d)["level"] = "0.5 m";
  record(d)["density"] = "1000 kg/m3";
  record(d)["gravity"] = gravity;
  record(d)["displacers"] = displacers();
  record(d)["closure"] = closure();
  record(d)["minimumVolume"] = "0.45 m3";
  assert.equal(cli("measure fill-volume", d).status, 0);
  const curve = base();
  record(curve)["cavity"] = cavity();
  record(curve)["density"] = "1000 kg/m3";
  record(curve)["gravity"] = gravity;
  record(curve)["closure"] = closure();
  record(curve)["levels"] = ["0.1 m", "0.2 m"];
  assert.equal(cli("fluid level-curve", curve).status, 0);
  const drain = base();
  record(drain)["cavity"] = cavity();
  record(drain)["density"] = "1000 kg/m3";
  record(drain)["gravity"] = gravity;
  record(drain)["outlet"] = {
    position: { x: "0.5 m", y: "0.5 m", z: "0 m" },
    diameter: "10 mm",
  };
  record(drain)["drainLevel"] = "0 m";
  record(drain)["maximumResidual"] = "0.001 m3";
  assert.equal(cli("drain check", drain).status, 0);
  const clean = base();
  record(clean)["cavity"] = cavity();
  record(clean)["gravity"] = gravity;
  record(clean)["tool"] = {
    type: "brush",
    length: "300 mm",
    diameter: "50 mm",
  };
  record(clean)["accesses"] = [
    {
      id: "a1",
      at: { x: "0.5 m", y: "0.5 m", z: "0.5 m" },
      direction: { x: 0, y: 0, z: -1 },
      depth: "200 mm",
      openingDiameter: "60 mm",
    },
  ];
  assert.equal(cli("cleaning access", clean).status, 0);
  const open = {
    ...d,
    closure: { closedDomain: false, errors: ["ambiguous open cavity"] },
  };
  const blocked = cli("measure fill-volume", open);
  assert.equal(blocked.status, 1);
  assert.equal(at(JSON.parse(blocked.stdout), "status"), "blocked");
  assert.equal(cli("measure fill-volume", { ...d, typo: true }).status, 1);
  const schema = spawnSync(
    process.execPath,
    ["bin/fmcad.js", "drain", "check", "--schema"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(schema.status, 0, schema.stderr);
  assert.match(schema.stdout, /outlet/);
});

function present<T>(value: T | null | undefined): T {
  assert(value !== null && value !== undefined, "Expected a calculated value");
  return value;
}

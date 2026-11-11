import { createRequire } from "node:module";
import { at, record } from "./integration/offline-cli";
const root = process.cwd(),
  load = createRequire(__filename);
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
const { thermal } = load(
  path.join(root, "src/engineering-thermal"),
) as typeof import("../packages/core/src/domain/engineering/thermal");
const base = () => ({
  schemaVersion: 1,
  identity: { model: "thermal-fixture", revision: "1" },
  frame: "contact-normal",
  assumptions: [
    "Steady series heat flow; nominal constant material properties; all loads at source.",
  ],
  heatLoads: [
    { id: "chip", power: "4 W" },
    { id: "driver", power: "1 W" },
  ],
  ambient: "25 degC",
  maximumTemperature: "50 degC",
  contacts: [
    {
      id: "pad",
      model: "pad",
      contactPresent: true,
      area: "100 mm2",
      thickness: "1 mm",
      conductivity: "2 W/(m*K)",
      compression: { nominal: "20 %", minimum: "10 %", maximum: "30 %" },
      allowableCompression: { minimum: "10 %", maximum: "30 %" },
      interfaceResistance: "0 K/W",
    },
  ] as Record<string, unknown>[],
  ambientPath: { model: "resistance", resistance: ".5 K/W" } as Record<
    string,
    unknown
  >,
});
const near = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
function cli(data: unknown, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "dist/bin/fmcad.js"),
      "thermal",
      "contact-budget",
      "--data",
      JSON.stringify(data),
      "--json",
      ...extra,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FMCAD_BACKEND: "no-backend" },
    },
  );
}
test("analytic pad resistance, compression extrema, balance and sensitivity", () => {
  const r = thermal(base());
  assert.equal(r.status, "pass");
  near(present(r.result.contactResistance).value, 4);
  near(present(r.result.totalResistance).value, 4.5);
  near(present(r.result.sourceTemperature).value, 320.65);
  near(present(r.result.maximumSourceTemperature).value, 323.15);
  near(present(r.result.minimumSourceTemperature).value, 318.15);
  near(present(r.result.heatRejected).value, 5);
  near(
    present(
      present(present(r.result.contacts[0]).sensitivity)
        .resistancePerCompression,
    ).value,
    -5,
  );
  near(present(present(r.result.contacts[0]).coldTemperature).value, 300.65);
  const d = base();
  record(present(d.contacts[0])["compression"])["nominal"] = "20.001 %";
  near(
    (present(thermal(d).result.sourceTemperature).value -
      present(r.result.sourceTemperature).value) /
      0.00001,
    -25,
    1e-6,
  );
});
test("gap variant, convection and explicit contact resistance", () => {
  const d = base();
  delete record(present(d.contacts[0]))["compression"];
  record(present(d.contacts[0]))["gap"] = {
    nominal: ".8 mm",
    minimum: ".7 mm",
    maximum: ".9 mm",
  };
  d.ambientPath = {
    model: "convection",
    coefficient: "20 W/(m2*K)",
    area: ".1 m2",
  };
  near(present(thermal(d).result.totalResistance).value, 4.5);
  d.contacts.push({
    id: "joint",
    model: "resistance",
    contactPresent: true,
    resistance: "1 K/W",
  });
  near(present(thermal(d).result.totalResistance).value, 5.5);
  assert.equal(thermal(d).status, "fail");
});
test("missing ambient, sink, interface and contact never become zero", () => {
  for (const field of ["ambient", "ambientPath"]) {
    const d = base();
    delete record(d)[field];
    const r = thermal(d);
    assert.equal(r.status, "unknown");
    assert.equal(r.result.sourceTemperature, null);
    near(present(r.result.contactResistance).value, 4);
  }
  for (const field of [
    "interfaceResistance",
    "contactPresent",
    "conductivity",
    "allowableCompression",
  ]) {
    const d = base();
    delete present(d.contacts[0])[field];
    assert.equal(thermal(d).status, "unknown");
  }
  const d = base();
  delete record(present(d.heatLoads[0]))["power"];
  assert.equal(thermal(d).status, "unknown");
  assert.equal(thermal(d).result.heatLoad, null);
});
test("physical contact, invalid compression, unit and schema bounds", () => {
  const d = base();
  present(d.contacts[0])["contactPresent"] = false;
  assert.equal(thermal(d).status, "fail");
  assert.equal(thermal(d).result.sourceTemperature, null);
  present(d.contacts[0])["contactPresent"] = true;
  record(present(d.contacts[0])["compression"])["maximum"] = "100 %";
  assert.throws(() => thermal(d), /finite/);
  record(present(d.contacts[0])["compression"])["maximum"] = "40 %";
  assert.equal(thermal(d).status, "fail");
  delete record(present(d.contacts[0]))["compression"];
  record(present(d.contacts[0]))["gap"] = {
    nominal: "2 mm",
    minimum: "2 mm",
    maximum: "2 mm",
  };
  assert.equal(thermal(d).status, "fail");
  assert.equal(thermal(d).result.sourceTemperature, null);
  const bad = base();
  bad.ambient = "25 deltaK";
  assert.throws(() => thermal(bad), /temperature/);
  bad.ambient = "-300 degC";
  assert.throws(() => thermal(bad), /absolute zero/);
  assert.throws(
    () => thermal({ ...base(), budget: { maxEvaluations: 1, timeMs: 1000 } }),
    /budget/,
  );
});
test("thermal real CLI variants, bad input, missing data, help and schema", () => {
  const gap = base();
  delete record(present(gap.contacts[0]))["compression"];
  record(present(gap.contacts[0]))["gap"] = {
    nominal: ".8 mm",
    minimum: ".7 mm",
    maximum: ".9 mm",
  };
  const convection = base();
  convection.ambientPath = {
    model: "convection",
    coefficient: "20 W/(m2*K)",
    area: ".1 m2",
  };
  const resistance = base();
  resistance.contacts = [
    {
      id: "specified",
      model: "resistance",
      contactPresent: true,
      resistance: "1 K/W",
    },
  ];
  for (const d of [base(), gap, convection, resistance]) {
    const r = cli(d);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(
      at(JSON.parse(r.stdout), "operation"),
      "thermal.contact-budget",
    );
  }
  const missing = base();
  delete record(missing)["ambientPath"];
  const r = cli(missing);
  assert.equal(r.status, 1);
  assert.equal(at(JSON.parse(r.stdout), "status"), "unknown");
  assert.equal(cli({ ...base(), typo: true }).status, 1);
  for (const flag of ["--help", "--schema"]) {
    const r = spawnSync(
      process.execPath,
      [path.join(root, "dist/bin/fmcad.js"), "thermal", "contact-budget", flag],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ambientPath/);
  }
});

function present<T>(value: T | null | undefined): T {
  assert(value !== null && value !== undefined, "Expected a calculated value");
  return value;
}

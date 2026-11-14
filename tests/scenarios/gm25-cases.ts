import assert from "node:assert/strict";
import type { ScenarioSession } from "./runner";
import { gmCommands } from "./gm-command-contract";
import { at, list, text, number } from "../integration/offline-cli";
const near = (actual: unknown, expected: unknown, tol = 1e-6) =>
  assert.ok(
    Math.abs(number(actual) - number(expected)) < tol,
    `expected ${actual} ~= ${expected} (tol ${tol})`,
  );
export const g25_1 = {
  id: "G25-01",
  title: "G25-01: route create3d solves a spatial S-curve through waypoints",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "route",
      "create3d",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        waypoints: [
          ["0 mm", "0 mm", "0 mm"],
          ["0 mm", "10 mm", "10 mm"],
          ["0 mm", "0 mm", "20 mm"],
        ],
        up: [0, 0, 1],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "routeState"), "numerically-solved");
    assert.ok(
      number(at(out, "result", "arcLength")) > 0,
      JSON.stringify(at(out, "result")),
    );
    assert.ok(
      at(out, "result", "minBendRadius") !== null,
      JSON.stringify(at(out, "result")),
    );
    assert.ok(
      list(at(out, "result", "frames")).length > 0,
      JSON.stringify(at(out, "result")),
    );
    assert.ok(
      at(out, "result", "frames", 0, "position"),
      JSON.stringify(at(out, "result", "frames", 0)),
    );
  },
};
export const g25_2 = {
  id: "G25-02",
  title:
    "G25-02: end tangents, normal sections and a stable transport frame at inflection",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "route",
      "create3d",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        waypoints: [
          ["0 mm", "0 mm", "0 mm"],
          ["0 mm", "10 mm", "10 mm"],
          ["0 mm", "0 mm", "20 mm"],
        ],
        up: [0, 0, 1],
        endTangents: { start: [0, 0, 1], end: [0, 0, 1] },
        normalSections: [{ station: "0.5 cm" }, { station: "2 cm" }],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "result", "routeState"), "set");
    assert.equal(
      list(at(out, "result", "normalSections")).length,
      2,
      JSON.stringify(at(out, "result")),
    );
    assert.ok(
      at(out, "result", "endTangents", "computed", "start"),
      JSON.stringify(at(out, "result", "endTangents")),
    );
    assert.ok(
      at(out, "result", "endTangents", "computed", "end"),
      JSON.stringify(at(out, "result", "endTangents")),
    );
  },
};
export const g25_3 = {
  id: "G25-03",
  title:
    "G25-03: route inspect reports arc length, bend radius and self-clearance",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "route",
      "inspect",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        waypoints: [
          ["0 mm", "0 mm", "0 mm"],
          ["0 mm", "10 mm", "0 mm"],
          ["10 mm", "10 mm", "0 mm"],
        ],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.ok(
      number(at(out, "result", "arcLength")) > 0,
      JSON.stringify(at(out, "result")),
    );
    assert.ok(
      typeof at(out, "result", "minBendRadius") === "number",
      JSON.stringify(at(out, "result")),
    );
    assert.ok(
      at(out, "result", "selfClearance") !== null,
      JSON.stringify(at(out, "result")),
    );
  },
};
export const g25_4 = {
  id: "G25-04",
  title: "G25-04: route cut-list uses 1.1*L + 2*15 mm interpretation",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "route",
      "cut-list",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        length: "100 mm",
        allowanceFactor: 1.1,
        serviceTail: "15 mm",
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    near(at(out, "result", "cutLengthPerPiece"), 140);
    assert.ok(
      text(at(out, "result", "interpretation")).includes("1.1"),
      text(at(out, "result", "interpretation")),
    );
  },
};
export const g25_5 = {
  id: "G25-05",
  title:
    "G25-05: route motion-states evaluates the PAN x TILT cartesian product preserving length",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "route",
      "motion-states",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        length: "100 mm",
        pan: { min: "-45 deg", max: "45 deg" },
        tilt: { min: "-30 deg", max: "30 deg" },
        minBendRadius: "5 mm",
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(
      list(at(out, "result", "states")).length,
      4,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(at(out, "result", "lengthPreserved"), true);
    assert.ok(
      list(at(out, "result", "states")).every((s) => at(s, "lengthPreserved")),
      JSON.stringify(at(out, "result", "states")),
    );
    assert.ok(
      text(at(out, "result", "extremeCoverage")).includes("cartesian"),
      text(at(out, "result", "extremeCoverage")),
    );
  },
};
export const g25_6 = {
  id: "G25-06",
  title:
    "G25-06: route state is explicitly set or native-dependent, never guessed",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const set = await fmcad([
      "route",
      "motion-states",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        length: "100 mm",
        poses: [{ pan: "0 deg", tilt: "0 deg", bendRadius: "8 mm" }],
      }),
    ]);
    assert.equal(
      at(set, "result", "states", 0, "state"),
      "set",
      JSON.stringify(at(set, "result")),
    );
    near(at(set, "result", "states", 0, "requiredBendRadius"), 0.8);
    const native = await fmcad([
      "route",
      "motion-states",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        length: "100 mm",
        pan: { min: "-45 deg", max: "45 deg" },
        tilt: { min: "-30 deg", max: "30 deg" },
        state: "native-dependent",
      }),
    ]);
    assert.ok(
      list(at(native, "result", "states")).every(
        (s) => at(s, "state") === "native-dependent",
      ),
      JSON.stringify(at(native, "result", "states")),
    );
  },
};
export const g25_7 = {
  id: "G25-07",
  title: "G25-07: bend limit flags a route whose required radius is too tight",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const fits = await fmcad([
      "route",
      "motion-states",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        length: "100 mm",
        pan: { min: "-45 deg", max: "45 deg" },
        tilt: { min: "-30 deg", max: "30 deg" },
        minBendRadius: "5 mm",
      }),
    ]);
    assert.ok(
      list(at(fits, "result", "states")).every((s) => at(s, "fits") === true),
      JSON.stringify(at(fits, "result", "states")),
    );
    const tooTight = await fmcad([
      "route",
      "motion-states",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        length: "100 mm",
        pan: { min: "-45 deg", max: "45 deg" },
        tilt: { min: "-30 deg", max: "30 deg" },
        minBendRadius: "100 mm",
      }),
    ]);
    assert.ok(
      list(at(tooTight, "result", "states")).every(
        (s) => at(s, "fits") === false,
      ),
      JSON.stringify(at(tooTight, "result", "states")),
    );
  },
};
export const g25_8 = {
  id: "G25-08",
  title:
    "G25-08: modeled service tail is not added twice; AWG is not insulation diameter",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "route",
      "cut-list",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        length: "100 mm",
        allowanceFactor: 1.1,
        serviceTail: "15 mm",
        serviceTailModeled: true,
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    near(at(out, "result", "cutLengthPerPiece"), 110);
    assert.ok(
      list(at(out, "result", "warnings")).some((w) =>
        text(w).includes("not added again"),
      ),
      JSON.stringify(at(out, "result", "warnings")),
    );
    assert.ok(
      list(at(out, "limitations")).some((l) => text(l).includes("AWG")),
      JSON.stringify(at(out, "limitations")),
    );
  },
};
export const gm25Cases = [
  g25_1,
  g25_2,
  g25_3,
  g25_4,
  g25_5,
  g25_6,
  g25_7,
  g25_8,
];

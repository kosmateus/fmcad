import assert from "node:assert/strict";
import type { ScenarioSession } from "./runner";
import { gmCommands } from "./gm-command-contract";
import { at, list, text, number } from "../integration/offline-cli";
const near = (actual: unknown, expected: unknown, tol = 1e-6) =>
  assert.ok(
    Math.abs(number(actual) - number(expected)) < tol,
    `expected ${actual} ~= ${expected} (tol ${tol})`,
  );
const foldChain = [
  { type: "line", length: "10 mm" },
  { type: "bend", radius: "2 mm", angle: "90 deg", axis: "y" },
  { type: "line", length: "10 mm" },
];
const boardOutline = [
  ["0 mm", "0 mm"],
  ["20 mm", "0 mm"],
  ["20 mm", "20 mm"],
  ["0 mm", "20 mm"],
];
export const g26_1 = {
  id: "G26-01",
  title: "G26-01: fpc fold preserves the neutral-axis length, never scales",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "fpc",
      "fold",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        chain: foldChain,
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "neutralLengthPreserved"), true);
    assert.equal(at(out, "result", "scaled"), false);
    near(
      at(out, "result", "flatNeutralLength"),
      1.0 + 0.2 * (Math.PI / 2) + 1.0,
    );
    near(
      at(out, "result", "foldedNeutralLength"),
      at(out, "result", "flatNeutralLength"),
    );
  },
};
export const g26_2 = {
  id: "G26-02",
  title:
    "G26-02: fpc flatten straightens bends without changing neutral length",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "fpc",
      "flatten",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        chain: foldChain,
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "result", "neutralLengthPreserved"), true);
    assert.equal(at(out, "result", "scaled"), false);
    near(
      at(out, "result", "flatNeutralLength"),
      at(out, "result", "foldedNeutralLength"),
    );
    near(at(out, "result", "straightenedBendLengths"), 0.2 * (Math.PI / 2));
  },
};
export const g26_3 = {
  id: "G26-03",
  title:
    "G26-03: pcb mechanical-exchange reports the STEP-center vs lens datum offset",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "pcb",
      "mechanical-exchange",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        source: {
          datum: {
            name: "step-center",
            type: "step-center",
            origin: ["0 mm", "0 mm", "0 mm"],
          },
        },
        target: {
          datum: {
            name: "lens-datum",
            type: "lens",
            origin: ["2 mm", "1 mm", "0 mm"],
          },
        },
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "result", "compatibleDatum"), false);
    near(at(out, "result", "datumOffset", 0), 0.2);
    near(at(out, "result", "datumOffset", 1), 0.1);
    assert.ok(
      list(at(out, "result", "warnings")).some((w) => text(w).includes("STEP")),
      JSON.stringify(at(out, "result", "warnings")),
    );
  },
};
export const g26_4 = {
  id: "G26-04",
  title: "G26-04: pcb check requires both-side height zones",
  async run(session: ScenarioSession) {
    const { fmcad, cad } = gmCommands(session);
    const valid = await fmcad([
      "pcb",
      "check",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        board: {
          thickness: "1.6 mm",
          outline: boardOutline,
          holes: [
            {
              center: ["5 mm", "5 mm", "0 mm"],
              type: "round",
              diameter: "2 mm",
            },
          ],
          heightZones: [{ side: "top" }, { side: "bottom" }],
        },
      }),
    ]);
    assert.equal(at(valid, "success"), true, JSON.stringify(valid));
    assert.equal(
      at(valid, "result", "passed"),
      true,
      JSON.stringify(at(valid, "result")),
    );
    assert.deepEqual(at(valid, "result", "heightZones"), ["bottom", "top"]);
    const missing = at(
      await cad([
        "pcb",
        "check",
        "--doc",
        session.document.name,
        "--data",
        JSON.stringify({
          schemaVersion: 1,
          board: {
            thickness: "1.6 mm",
            outline: boardOutline,
            heightZones: [{ side: "top" }],
          },
        }),
      ]),
      "json",
    );
    assert.ok(missing, "expected a JSON envelope for a failing pcb.check");
    assert.equal(
      at(missing, "result", "passed"),
      false,
      JSON.stringify(at(missing, "result")),
    );
    assert.ok(
      list(at(missing, "result", "violations")).some((v) =>
        text(v).includes("bottom"),
      ),
      JSON.stringify(at(missing, "result", "violations")),
    );
  },
};
export const g26_5 = {
  id: "G26-05",
  title: "G26-05: port define reports origin, normal, pin1 and mating stroke",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "port",
      "define",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        name: "PWR",
        frame: {
          origin: ["0 mm", "0 mm", "0 mm"],
          normal: [0, 0, 1],
          pin1: ["1 mm", "0 mm", "0 mm"],
        },
        matingStroke: "5 mm",
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.deepEqual(at(out, "result", "normal"), [0, 0, 1]);
    near(at(out, "result", "matingStroke"), 0.5);
  },
};
export const g26_6 = {
  id: "G26-06",
  title: "G26-06: connector mate-check passes a correct intended pair",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "connector",
      "mate-check",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        connectors: [
          { name: "POWER_M", gender: "male", pinCount: 4, key: "pwr-k" },
          { name: "POWER_F", gender: "female", pinCount: 4, key: "pwr-k" },
        ],
        intendedPairs: [["POWER_M", "POWER_F"]],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(
      at(out, "result", "passed"),
      true,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(at(out, "result", "intended", 0, "mates"), true);
  },
};
export const g26_7 = {
  id: "G26-07",
  title: "G26-07: forbidden pair with shared key is a poka-yoke hazard",
  async run(session: ScenarioSession) {
    const { cad } = gmCommands(session);
    const out = await cad([
      "connector",
      "mate-check",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        connectors: [
          { name: "POWER_M", gender: "male", pinCount: 4, key: "4pin-k" },
          { name: "POWER_F", gender: "female", pinCount: 4, key: "4pin-k" },
          { name: "DATA_F", gender: "female", pinCount: 4, key: "4pin-k" },
        ],
        intendedPairs: [["POWER_M", "POWER_F"]],
        forbiddenPairs: [["POWER_M", "DATA_F"]],
      }),
    ]);
    assert.equal(
      at(out, "json", "success"),
      false,
      JSON.stringify(at(out, "json")),
    );
    assert.equal(
      at(out, "json", "status"),
      "fail",
      JSON.stringify(at(out, "json")),
    );
    assert.equal(at(out, "json", "result", "passed"), false);
    assert.equal(
      at(out, "json", "result", "forbidden", 0, "canReachSeating"),
      true,
      JSON.stringify(at(out, "json", "result", "forbidden")),
    );
    assert.equal(at(out, "json", "result", "pokaYokeViolation"), true);
  },
};
export const g26_8 = {
  id: "G26-08",
  title:
    "G26-08: pack cross-section uses cavity area as the reserve denominator",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "pack",
      "cross-section",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        cavity: [
          ["0 mm", "0 mm"],
          ["10 mm", "0 mm"],
          ["10 mm", "10 mm"],
          ["0 mm", "10 mm"],
        ],
        items: [{ center: ["5 mm", "5 mm", "0 mm"], radius: "2 mm" }],
        reserve: 0.3,
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(
      at(out, "result", "passed"),
      true,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(at(out, "result", "reserve", "denominator"), "cavity area");
    near(at(out, "result", "cavityArea"), 1);
    assert.ok(
      number(at(out, "result", "occupiedUnionArea")) > 0,
      JSON.stringify(at(out, "result")),
    );
  },
};
export const g26_9 = {
  id: "G26-09",
  title: "G26-09: keepout check flags a keepout outside the board outline",
  async run(session: ScenarioSession) {
    const { fmcad, cad } = gmCommands(session);
    const inside = await fmcad([
      "keepout",
      "check",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        board: { outline: boardOutline },
        keepouts: [
          {
            name: "K1",
            outline: [
              ["2 mm", "2 mm"],
              ["8 mm", "2 mm"],
              ["8 mm", "8 mm"],
              ["2 mm", "8 mm"],
            ],
          },
        ],
      }),
    ]);
    assert.equal(
      at(inside, "result", "passed"),
      true,
      JSON.stringify(at(inside, "result")),
    );
    const outside = at(
      await cad([
        "keepout",
        "check",
        "--doc",
        session.document.name,
        "--data",
        JSON.stringify({
          schemaVersion: 1,
          board: { outline: boardOutline },
          keepouts: [
            {
              name: "K2",
              outline: [
                ["15 mm", "15 mm"],
                ["25 mm", "15 mm"],
                ["25 mm", "25 mm"],
                ["15 mm", "25 mm"],
              ],
            },
          ],
        }),
      ]),
      "json",
    );
    assert.ok(outside, "expected a JSON envelope for a failing keepout.check");
    assert.equal(
      at(outside, "result", "passed"),
      false,
      JSON.stringify(at(outside, "result")),
    );
    assert.ok(
      list(at(outside, "result", "violations")).length > 0,
      JSON.stringify(at(outside, "result")),
    );
  },
};
export const g26_10 = {
  id: "G26-10",
  title:
    "G26-10: PCB02/04 height zones and through-hole tails, FPC never scaled",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const pcb = await fmcad([
      "pcb",
      "check",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        board: {
          thickness: "1.6 mm",
          outline: boardOutline,
          holes: [
            {
              center: ["5 mm", "5 mm", "0 mm"],
              type: "round",
              diameter: "2 mm",
            },
            {
              center: ["10 mm", "10 mm", "0 mm"],
              type: "slot",
              length: "4 mm",
              width: "1 mm",
            },
          ],
          heightZones: [{ side: "top" }, { side: "bottom" }],
        },
      }),
    ]);
    assert.equal(
      at(pcb, "result", "passed"),
      true,
      JSON.stringify(at(pcb, "result")),
    );
    assert.equal(at(pcb, "result", "holeCount"), 2);
    assert.ok(list(at(pcb, "result", "heightZones")).includes("bottom"));
    const fpc = await fmcad([
      "fpc",
      "fold",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({ schemaVersion: 1, chain: foldChain }),
    ]);
    assert.equal(at(fpc, "result", "scaled"), false);
    near(
      at(fpc, "result", "foldedNeutralLength"),
      at(fpc, "result", "flatNeutralLength"),
    );
  },
};
export const g26_11 = {
  id: "G26-11",
  title: "G26-11: equal area but geometrically out-of-fit shape is rejected",
  async run(session: ScenarioSession) {
    const { cad } = gmCommands(session);
    const out = at(
      await cad([
        "pack",
        "cross-section",
        "--doc",
        session.document.name,
        "--data",
        JSON.stringify({
          schemaVersion: 1,
          cavity: [
            ["0 mm", "0 mm"],
            ["10 mm", "0 mm"],
            ["10 mm", "10 mm"],
            ["0 mm", "10 mm"],
          ],
          items: [
            {
              outline: [
                ["8 mm", "8 mm"],
                ["16 mm", "8 mm"],
                ["16 mm", "16 mm"],
                ["8 mm", "16 mm"],
              ],
            },
          ],
          reserve: 0.0,
        }),
      ]),
      "json",
    );
    assert.ok(out, "expected a JSON envelope for a failing pack.cross-section");
    assert.equal(
      at(out, "result", "passed"),
      false,
      JSON.stringify(at(out, "result")),
    );
    assert.ok(
      list(at(out, "result", "shapeFitViolations")).length > 0,
      JSON.stringify(at(out, "result")),
    );
  },
};
export const g26_12 = {
  id: "G26-12",
  title:
    "G26-12: native ECAD/flex remains an explicit gate, recipe is the honest alternative",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "fpc",
      "fold",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({ schemaVersion: 1, chain: foldChain }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.ok(
      list(at(out, "limitations")).some((l) => text(l).includes("ECAD")),
      JSON.stringify(at(out, "limitations")),
    );
  },
};
export const gm26Cases = [
  g26_1,
  g26_2,
  g26_3,
  g26_4,
  g26_5,
  g26_6,
  g26_7,
  g26_8,
  g26_9,
  g26_10,
  g26_11,
  g26_12,
];

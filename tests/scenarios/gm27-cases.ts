import assert from "node:assert/strict";
import type { ScenarioSession } from "./runner";
import { gmCommands } from "./gm-command-contract";
import { at, list, text, number } from "../integration/offline-cli";
const near = (actual: unknown, expected: unknown, tol = 1e-6) =>
  assert.ok(
    Math.abs(number(actual) - number(expected)) < tol,
    `expected ${actual} ~= ${expected} (tol ${tol})`,
  );
export const g27_1 = {
  id: "G27-01",
  title:
    "G27-01: assembly sequence orders rigid dependencies, media never rigidized",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "assembly",
      "sequence",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        parts: ["base", "connector", "shaft", "housing"],
        dependencies: [
          ["base", "connector"],
          ["connector", "shaft"],
          ["shaft", "housing"],
        ],
        removedParts: ["connector"],
        disconnectedMedia: [
          { name: "PWR-cable", connects: ["connector", "shaft"] },
        ],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.deepEqual(at(out, "result", "order"), [
      "base",
      "connector",
      "shaft",
      "housing",
    ]);
    assert.deepEqual(at(out, "result", "disassemblyOrder"), [
      "housing",
      "shaft",
      "connector",
      "base",
    ]);
    assert.equal(at(out, "result", "mediaRigidized"), false);
    assert.deepEqual(at(out, "result", "blockers", "shaft"), ["connector"]);
    const removals = {
      ...Object.fromEntries(
        list(at(out, "result", "removals")).map((r) => [at(r, "part"), r]),
      ),
    };
    assert.deepEqual(at(removals, "connector", "removeBlockers"), ["shaft"]);
    assert.deepEqual(at(removals, "connector", "disconnections"), [
      "PWR-cable",
    ]);
  },
};
export const g27_2 = {
  id: "G27-02",
  title: "G27-02: service path-check verifies a straight tank withdrawal",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "service",
      "path-check",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        part: {
          name: "tank",
          outline: [
            ["-10 mm", "0 mm"],
            ["10 mm", "0 mm"],
            ["10 mm", "20 mm"],
            ["-10 mm", "20 mm"],
          ],
        },
        direction: [0, 1],
        distance: "30 mm",
        obstacles: [
          {
            name: "wall",
            outline: [
              ["15 mm", "0 mm"],
              ["30 mm", "0 mm"],
              ["30 mm", "50 mm"],
              ["15 mm", "50 mm"],
            ],
          },
        ],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(
      at(out, "result", "feasible"),
      true,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(at(out, "result", "blocked"), false);
    assert.deepEqual(at(out, "result", "blockers"), []);
    near(at(out, "result", "minClearance"), 0.5);
  },
};
export const g27_3 = {
  id: "G27-03",
  title: "G27-03: D6x40 tool reaches the fastener seat",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "tool",
      "access",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        tool: { diameter: "6 mm", length: "40 mm" },
        target: {
          origin: ["0 mm", "0 mm", "0 mm"],
          axis: [0, 0, 1],
          engagementDepth: "4 mm",
        },
        entry: { origin: ["0 mm", "0 mm", "30 mm"], direction: [0, 0, -1] },
        obstacles: [
          { name: "rib", point: ["6 mm", "0 mm", "15 mm"], radius: "2 mm" },
        ],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(
      at(out, "result", "reachable"),
      true,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(at(out, "result", "lengthSufficient"), true);
    assert.equal(at(out, "result", "axisAligned"), true);
    near(at(out, "result", "reach"), 2.6);
    assert.deepEqual(at(out, "result", "blockers"), []);
  },
};
export const g27_4 = {
  id: "G27-04",
  title: "G27-04: fixture access seats a pin/hole and datum pair",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "fixture",
      "access",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        part: {
          name: "pcb",
          features: [
            {
              name: "pinA",
              kind: "pin",
              origin: ["0 mm", "0 mm", "0 mm"],
              diameter: "2 mm",
            },
            {
              name: "datA",
              kind: "datum",
              origin: ["10 mm", "0 mm", "0 mm"],
              direction: [0, 0, 1],
            },
          ],
        },
        fixture: {
          approach: { direction: [0, 0, 1] },
          features: [
            {
              name: "holeA",
              kind: "hole",
              origin: ["0 mm", "0 mm", "0 mm"],
              diameter: "2.1 mm",
            },
            {
              name: "datA",
              kind: "datum",
              origin: ["10 mm", "0 mm", "0 mm"],
              direction: [0, 0, 1],
            },
          ],
        },
        pairs: [
          ["pinA", "holeA"],
          ["datA", "datA"],
        ],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(
      at(out, "result", "seatPossible"),
      true,
      JSON.stringify(at(out, "result")),
    );
    assert.ok(
      list(at(out, "result", "pairs")).every((p) => at(p, "fits")),
      JSON.stringify(at(out, "result", "pairs")),
    );
  },
};
export const g27_5 = {
  id: "G27-05",
  title: "G27-05: trapped screw requires cover removal first",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "assembly",
      "sequence",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        parts: ["housing", "screw", "cover"],
        dependencies: [
          ["screw", "cover"],
          ["housing", "cover"],
        ],
        removedParts: ["screw"],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    const screw = list(at(out, "result", "removals")).find(
      (r) => at(r, "part") === "screw",
    );
    assert.deepEqual(at(screw, "removeBlockers"), ["cover"]);
  },
};
export const g27_6 = {
  id: "G27-06",
  title:
    "G27-06: head/ring/power service states; exploded endpoint is never an assembly path",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "assembly",
      "sequence",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        parts: ["head", "ring", "power", "chassis"],
        dependencies: [
          ["chassis", "head"],
          ["chassis", "ring"],
          ["chassis", "power"],
        ],
        removedParts: ["head", "ring", "power"],
        serviceStates: [
          {
            part: "head",
            requires: [{ media: "head-media", state: "disconnected" }],
          },
          {
            part: "ring",
            requires: [{ media: "ring-media", state: "disconnected" }],
          },
          {
            part: "power",
            requires: [
              { state: "powerOff" },
              { media: "power-cable", state: "disconnected" },
            ],
          },
        ],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    const removals = {
      ...Object.fromEntries(
        list(at(out, "result", "removals")).map((r) => [at(r, "part"), r]),
      ),
    };
    assert.deepEqual(at(removals, "power", "servicePrerequisites"), [
      { state: "powerOff" },
      { media: "power-cable", state: "disconnected" },
    ]);
    assert.deepEqual(at(removals, "head", "servicePrerequisites"), [
      { media: "head-media", state: "disconnected" },
    ]);
    assert.ok(
      list(at(out, "limitations")).some((l) =>
        text(l).includes("exploded endpoint"),
      ),
      JSON.stringify(at(out, "limitations")),
    );
  },
};
export const gm27Cases = [g27_1, g27_2, g27_3, g27_4, g27_5, g27_6];

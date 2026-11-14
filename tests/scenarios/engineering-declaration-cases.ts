import assert from "node:assert/strict";
import { number, record, type FixtureFolder } from "./contracts";
import type { Scenario } from "./runner";
import { cadCommand } from "./cad-programs";
import { boxState, createBox } from "./box-cases";

const array = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value));
  return value;
};
const near = (actual: unknown, expected: number, tolerance: number) =>
  assert.ok(Math.abs(number(actual) - expected) <= tolerance);

/** Declared arithmetic and planning; no native cam, contact or motion solver. */
export function engineeringDeclarationScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "engineering-declarations-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "rectangular-extrusion",
      "engineering-declarations",
    ],
    async run(session) {
      const before = await session.execute(
        "owned-body",
        createBox(session.document, 10 + index),
      );
      let sequence = 0;
      const cad = async (operation: string, data: Record<string, unknown>) => {
        const output = await session.execute(
          "declaration-" + sequence++ + "-" + operation,
          cadCommand(session.document, operation, data),
          session.document,
          "cad-v1",
        );
        assert.equal(output["error"], null, JSON.stringify(output));
        const result = record(output["result"]);
        assert.equal(result["operation"], operation);
        assert.equal(result["success"], true);
        assert.equal(result["status"], "pass");
        return result;
      };
      const rise = { law: "halfCosine", lift: "10 mm", angle: "240 deg" };
      const profile = await cad("cam.profile", {
        schemaVersion: 1,
        frame: "component",
        baseRadius: "15 mm",
        rollerRadius: "5 mm",
        rise,
        followerLine: [0, 1, 0],
        phase: "0 deg",
        direction: "ccw",
      });
      const pitch = array(profile["pitchProfile"]);
      assert.equal(pitch.length, 2001);
      near(array(pitch[0])[0], 15, 1e-8);
      near(record(profile["normalOffset"])["value"], 5, 1e-8);
      assert.equal(
        array(profile["unresolvedIntervals"]).some(
          (item) => record(item)["interval"] === "release",
        ),
        true,
      );
      const evaluated = await cad("cam.evaluate", {
        schemaVersion: 1,
        frame: "component",
        baseRadius: "15 mm",
        rollerRadius: "5 mm",
        rise,
        minimumCurvatureRadius: "0.1 mm",
        maximumPressureAngle: "89 deg",
      });
      assert.equal(
        array(evaluated["checks"]).every(
          (item) => record(item)["status"] === "pass",
        ),
        true,
      );
      assert.ok(number(record(evaluated["maxPressureAngle"])["value"]) <= 89);
      assert.ok(
        number(record(evaluated["minPitchCurvatureRadius"])["value"]) >= 0.1,
      );
      const cycle = await cad("cam.cycle-check", {
        schemaVersion: 1,
        frame: "component",
        rise,
        dwell: "0 deg",
        returnLaw: "spring-return",
        followerCoupling: "spring-return",
      });
      assert.equal(
        array(cycle["resolvedIntervals"]).join(","),
        "rise,dwell,release",
      );
      assert.equal(cycle["cycleStatus"], "pass");
      assert.equal(array(cycle["unresolvedIntervals"]).length, 0);
      assert.equal(
        cycle["dropEdgeDynamics"],
        "blocked (no proper definition or evidence)",
      );
      const assembly = await cad("assembly.sequence", {
        schemaVersion: 1,
        parts: ["base", "connector", "shaft", "housing"],
        dependencies: [
          ["base", "connector"],
          ["connector", "shaft"],
          ["shaft", "housing"],
        ],
        removedParts: ["connector"],
        disconnectedMedia: [
          { name: "flexible-wire", connects: ["connector", "shaft"] },
        ],
        serviceStates: [
          {
            part: "connector",
            requires: [{ media: "flexible-wire", state: "disconnected" }],
          },
        ],
        phases: [
          { name: "foundation", parts: ["base", "connector"] },
          { name: "drive", parts: ["shaft", "housing"] },
        ],
      });
      assert.equal(
        array(assembly["order"]).join(","),
        "base,connector,shaft,housing",
      );
      assert.equal(
        array(assembly["disassemblyOrder"]).join(","),
        "housing,shaft,connector,base",
      );
      const removal = record(array(assembly["removals"])[0]);
      assert.equal(array(removal["removeBlockers"]).join(","), "shaft");
      assert.equal(assembly["mediaRigidized"], false);
      assert.equal(array(removal["servicePrerequisites"]).length, 1);
      assert.equal(record(assembly["phaseAssignments"])["base"], "foundation");
      const withdrawal = await cad("service.path-check", {
        schemaVersion: 1,
        part: {
          name: "bracket",
          outline: [
            ["-10 mm", "0 mm"],
            ["10 mm", "0 mm"],
            ["10 mm", "20 mm"],
            ["-10 mm", "20 mm"],
          ],
        },
        direction: [0, 1],
        distance: "30 mm",
        minimumClearance: "4 mm",
        samples: 6,
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
      });
      assert.equal(withdrawal["feasible"], true);
      assert.equal(array(withdrawal["blockers"]).length, 0);
      near(withdrawal["minClearance"], 0.5, 1e-9);
      near(array(record(withdrawal["sweptBounds"])["max"])[1], 5, 1e-9);
      const envelope = await cad("motion.envelope", {
        schemaVersion: 1,
        frame: "component",
        motion: {
          type: "translation",
          axis: [1, 0, 0],
          from: "0 mm",
          to: "20 mm",
        },
        bounds: {
          min: ["0 mm", "0 mm", "0 mm"],
          max: ["10 mm", "20 mm", "30 mm"],
        },
        samples: 3,
        representation: "conservative",
      });
      assert.equal(envelope["representation"], "conservative");
      assert.equal(envelope["sampleCount"], 3);
      const maximum = array(record(envelope["conservativeEnvelope"])["max"]);
      near(maximum[0], 3, 1e-9);
      assert.equal(maximum[1] + "|" + maximum[2], "2|3");
      assert.equal(envelope["continuousVerified"], false);
      assert.deepEqual(
        await session.execute("geometry-readback", boxState(session.document)),
        before,
      );
    },
  }));
}

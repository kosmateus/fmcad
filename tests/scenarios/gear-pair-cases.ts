import assert from "node:assert/strict";
import { number, record, type FixtureFolder } from "./contracts";
import type { Scenario } from "./runner";
import { cadCommand } from "./cad-programs";
import { boxState, createBox } from "./box-cases";

/** Declared involute arithmetic; this does not create or simulate gear teeth. */
export function gearPairScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "gear-pair-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "rectangular-extrusion",
      "gear-pair-analytics",
    ],
    async run(session) {
      const before = await session.execute(
        "owned-body",
        createBox(session.document, 10 + index),
      );
      let sequence = 0;
      const pair = async (data: Record<string, unknown>) => {
        const output = await session.execute(
          "pair-" + sequence++,
          cadCommand(session.document, "gear.pair-check", data),
          session.document,
          "cad-v1",
        );
        assert.equal(output["error"], null, JSON.stringify(output));
        const result = record(output["result"]);
        assert.equal(result["operation"], "gear.pair-check");
        assert.equal(result["status"], "pass");
        assert.equal(result["success"], true);
        return result;
      };
      const near = (value: unknown, expected: number) =>
        assert.ok(Math.abs(number(value) - expected) <= 1e-9);
      const external = await pair({
        schemaVersion: 1,
        gear1: {
          module: "2 mm",
          teeth: 20,
          pressureAngle: "20 deg",
          backlashAllocation: "0.05 mm",
        },
        gear2: {
          module: "2 mm",
          teeth: 40,
          pressureAngle: "20 deg",
          toothThicknessReduction: "0.05 mm",
        },
        external: true,
        phase: 0.25,
      });
      near(external["ratio"], 2);
      near(external["nominalCenterDistance"], 6);
      near(external["workingAngle"], (20 * Math.PI) / 180);
      near(external["backlash"], 0.01);
      assert.deepEqual(external["teeth"], [20, 40]);
      const internal = await pair({
        schemaVersion: 1,
        gear1: { module: "2 mm", teeth: 40, pressureAngle: "20 deg" },
        gear2: { module: "2 mm", teeth: 20, pressureAngle: "20 deg" },
        external: false,
        centerDistance: "20 mm",
      });
      near(internal["ratio"], -0.5);
      near(internal["nominalCenterDistance"], 2);
      near(internal["centerDistance"], 2);
      near(internal["workingAngle"], (20 * Math.PI) / 180);
      assert.deepEqual(
        await session.execute("geometry-readback", boxState(session.document)),
        before,
      );
    },
  }));
}

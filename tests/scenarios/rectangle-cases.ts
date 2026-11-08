import assert from "node:assert/strict";
import type { Scenario } from "./runner";
import { number, record, type FixtureFolder } from "./contracts";
import { parameter } from "./programs";
import { parameterCommand } from "./parameter-programs";
import { cadCommand } from "./cad-programs";
import { boxState } from "./box-cases";

function prism(state: Record<string, unknown>, width: number): void {
  assert.equal(state["bodies"], 1);
  const dimensions = state["dimensions"],
    volumes = state["volumes"];
  assert.ok(Array.isArray(dimensions) && dimensions.length === 1);
  assert.ok(Array.isArray(dimensions[0]) && dimensions[0].length === 3);
  for (const [index, expected] of [width, 11, 7].entries())
    assert.ok(Math.abs(number(dimensions[0][index]) - expected) <= 1e-6);
  assert.ok(Array.isArray(volumes) && volumes.length === 1);
  assert.ok(Math.abs(number(volumes[0]) - width * 11 * 7) <= 1e-6);
}

/** A real shape recipe, parameter regeneration and persisted geometry, on either backend. */
export function rectangleScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "dimensioned-rectangle-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "saved-revisions",
      "saved-reopen",
      "dimensioned-rectangle",
    ],
    async run(session) {
      const width = 23 + index;
      await session.execute("parameter", parameter(session.document, width));
      const created = await session.execute(
        "shape",
        cadCommand(session.document, "shape.box", {
          name: "OwnedPrism",
          width: "OwnedCounter",
          depth: "11 mm",
          height: "7 mm",
        }),
        session.document,
        "cad-v1",
      );
      assert.equal(created["error"], null);
      prism(
        await session.execute("initial-bounds", boxState(session.document)),
        width,
      );
      const changed = await session.execute(
        "parameter-change",
        parameterCommand(session.document, "param_set", [
          "OwnedCounter",
          `${width + 5} mm`,
        ]),
      );
      assert.ok(Array.isArray(changed["commands"]));
      assert.equal(record(changed["commands"][0])["error"], null);
      prism(
        await session.execute("regenerated-bounds", boxState(session.document)),
        width + 5,
      );
      await session.saveRevision();
      await session.reopen();
      prism(
        await session.execute("persisted-bounds", boxState(session.document)),
        width + 5,
      );
      const changedAgain = await session.execute(
        "reopened-change",
        parameterCommand(session.document, "param_set", [
          "OwnedCounter",
          `${width + 8} mm`,
        ]),
      );
      assert.ok(Array.isArray(changedAgain["commands"]));
      assert.equal(record(changedAgain["commands"][0])["error"], null);
      prism(
        await session.execute(
          "reopened-regeneration",
          boxState(session.document),
        ),
        width + 8,
      );
    },
  }));
}

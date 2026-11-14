import assert from "node:assert/strict";
import type { Scenario, ScenarioSession } from "./runner";
import { number, record } from "./contracts";
import { concurrencyLimit } from "./scheduling";
import { nativeModelingHarness, values } from "./native-modeling-support";
export { nativeResultUncertain as thickenResultUncertain } from "./native-modeling-support";
export const nativeThickenSlotPatternCapability = "native-thicken-slot-pattern";
const retainedSource = "tests/live-thicken-slot-pattern.js";
const setupOperations = [
  "shape.box",
  "entity.find",
  "shape.slot",
  "entity.list",
  "entity.inspect",
  "measure.bounds",
  "measure.volume",
];
const targetOperations = ["model.thicken", "shape.slot_pattern"];

/** No save/cloud mutation: the original readbacks require an unsaved document. */
export function nativeThickenSlotPatternScenarios(owners = 10): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-thicken-slot-pattern-" + index,
    requires: ["documents", nativeThickenSlotPatternCapability],
    scope: "exclusive-instance",
    async run(session: ScenarioSession) {
      const { cad, check, validated, guard, persist } =
        await nativeModelingHarness(
          session,
          retainedSource,
          setupOperations,
          targetOperations,
        );
      const measureSolid = async (
        operation: string,
        body: unknown,
        size: number[],
        volume: number,
      ) => {
        const inspected = await cad("entity.inspect", { ref: body });
        check(
          "entity.inspect",
          operation + " returned a solid body",
          inspected["isSolid"],
          true,
        );
        validated("entity.inspect");
        const bounds = await cad("measure.bounds", { ref: body, units: "mm" });
        assert.equal(
          values(bounds["size"]).length,
          3,
          "Native bounds must contain all three dimensions.",
        );
        values(bounds["size"]).forEach((value, index) =>
          check(
            "measure.bounds",
            operation + " bounds " + "xyz"[index],
            value,
            size[index],
            0.001,
          ),
        );
        validated("measure.bounds");
        const measured = await cad("measure.volume", {
          ref: body,
          units: "mm3",
        });
        check(
          "measure.volume",
          operation + " body volume mm3",
          measured["value"],
          volume,
          Math.max(0.001, volume * 0.00001),
        );
        validated("measure.volume");
      };
      const base = await cad("shape.box", {
        name: "ThickenBase",
        width: "10 mm",
        depth: "8 mm",
        height: "2 mm",
      });
      check(
        "shape.box",
        "thicken fixture body",
        values(base["bodies"]).length,
        1,
      );
      validated("shape.box");
      const faceResult = await cad(
        "entity.find",
        {
          kind: "face",
          filters: {
            geometry: "plane",
            axis: [0, 0, 1],
            position: ["0 mm", "0 mm", "2 mm"],
          },
          expect: 1,
        },
        "root",
        false,
      );
      check(
        "entity.find",
        "one top planar face selected",
        values(faceResult["entities"]).length,
        1,
      );
      validated("entity.find");
      const thickened = await cad("model.thicken", {
        name: "ThickenedTop",
        entities: [values(faceResult["entities"])[0]],
        thickness: "1 mm",
        operation: "newBody",
        symmetric: false,
        tangentChain: false,
      });
      check(
        "model.thicken",
        "one new thickened body returned",
        values(thickened["bodies"]).length,
        1,
      );
      await measureSolid(
        "model.thicken",
        values(thickened["bodies"])[0],
        [10, 8, 1],
        80,
      );
      validated("model.thicken");

      const beforePattern = await cad(
        "entity.list",
        { kind: "body" },
        "root",
        false,
      );
      const seed = await cad("shape.slot", {
        name: "PatternSeed",
        length: "10 mm",
        width: "4 mm",
        position: ["20 mm", "0 mm", "0 mm"],
        thickness: "2 mm",
        operation: "newBody",
      });
      check(
        "shape.slot",
        "newBody seed slot returned one body",
        values(seed["bodies"]).length,
        1,
      );
      validated("shape.slot");
      const seedVolume = await cad(
        "measure.volume",
        { ref: values(seed["bodies"])[0], units: "mm3" },
        "root",
        false,
      );
      check(
        "measure.volume",
        "native slot seed has positive volume",
        number(seedVolume["value"]) > 0,
        true,
      );
      validated("measure.volume");
      const pattern = await cad("shape.slot_pattern", {
        name: "TwoSlots",
        entities: [seed["feature"]],
        direction: "X",
        quantity: 2,
        distance: "20 mm",
        distanceType: "spacing",
      });
      check(
        "shape.slot_pattern",
        "pattern feature returned",
        pattern["feature"] && typeof pattern["feature"] === "object"
          ? record(pattern["feature"])["kind"]
          : undefined,
        "feature",
      );
      const afterPattern = await cad(
        "entity.list",
        { kind: "body" },
        "root",
        false,
      );
      check(
        "entity.list",
        "pattern adds one seed copy body",
        values(afterPattern["entities"]).length,
        values(beforePattern["entities"]).length + 2,
      );
      const idsBefore = new Set(
        values(beforePattern["entities"]).map(
          (entity) => record(entity)["token"],
        ),
      );
      const slotBodies = values(afterPattern["entities"]).filter(
        (entity) => !idsBefore.has(record(entity)["token"]),
      );
      check(
        "entity.list",
        "two isolated slot bodies exist",
        slotBodies.length,
        2,
      );
      validated("entity.list", true);
      const volumes: unknown[] = [];
      for (const [index, body] of slotBodies.entries()) {
        const measured = await cad(
          "measure.volume",
          { ref: body, units: "mm3" },
          "root",
          false,
        );
        volumes.push(measured["value"]);
        check(
          "measure.volume",
          "pattern body " + index + " volume matches seed",
          measured["value"],
          seedVolume["value"],
          0.001,
        );
      }
      validated("measure.volume", true);
      check(
        "shape.slot_pattern",
        "patterned slots have equal native volume",
        volumes[0],
        volumes[1],
        0.001,
      );
      check(
        "shape.slot_pattern",
        "patterned slot volume matches seed",
        volumes[0],
        seedVolume["value"],
        0.001,
      );
      validated("shape.slot_pattern");
      await guard();
      // Exact closure, zero remaining owned documents, original foreign inventory,
      // active restoration and uncertainty deferral remain in ScenarioSession/runScenarios.
      persist();
    },
  }));
}

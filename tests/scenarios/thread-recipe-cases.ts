import assert from "node:assert/strict";
import type { Scenario } from "./runner";
import { number, record, type FixtureFolder } from "./contracts";
import { cadCommand } from "./cad-programs";
import { createBox, boxState } from "./box-cases";

/** Analytical contracts from live-thread-method; no native thread is simulated. */
export function threadRecipeScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "thread-recipes-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "rectangular-extrusion",
      "thread-recipes",
    ],
    async run(session) {
      const before = await session.execute(
        "owned-body",
        createBox(session.document, 10 + index),
      );
      let sequence = 0;
      const cad = async (operation: string, data: Record<string, unknown>) => {
        const output = await session.execute(
          "thread-" + sequence++,
          cadCommand(session.document, operation, data),
          session.document,
          "cad-v1",
        );
        assert.equal(output["error"], null, JSON.stringify(output));
        const result = record(output["result"]);
        assert.equal(result["success"], true);
        assert.equal(result["operation"], operation);
        assert.equal(result["status"], "pass");
        assert.equal(
          record(result["documentIdentity"])["creationId"],
          session.document.creationId,
        );
        return result;
      };
      const near = (actual: unknown, expected: number) =>
        assert.ok(Math.abs(number(actual) - expected) <= 1e-9);
      const catalog = await cad("thread.catalog", {
        schemaVersion: 1,
        frame: "component",
        system: "iso-metric-coarse",
        query: "M10",
        starts: 2,
      });
      const entries = catalog["entries"];
      assert.ok(Array.isArray(entries));
      assert.equal(entries.length, 1);
      assert.equal(catalog["curated"], true);
      near(record(record(entries[0])["lead"])["value"], 3);
      near(record(record(entries[0])["pitch"])["value"], 1.5);
      const custom = await cad("thread.custom-profile", {
        schemaVersion: 1,
        frame: "component",
        majorDiameter: "10 mm",
        minorDiameter: "8.16 mm",
        pitch: "1.5 mm",
        starts: 2,
        hand: "left",
        flankAngle: "60 deg",
        rootShape: "rounded",
        length: "12 mm",
        runout: "0.5 mm",
        clearance: "0.1 mm",
      });
      assert.equal(custom["representation"], "recipe");
      const profile = record(custom["profile"]);
      near(record(profile["lead"])["value"], 3);
      near(record(profile["depth"])["value"], 0.92);
      assert.equal(
        profile["hand"] + "|" + profile["rootShape"],
        "left|rounded",
      );
      near(record(profile["turnsPerLength"])["value"], 1 / 3);
      const pair = await cad("thread.pair-check", {
        schemaVersion: 1,
        frame: "component",
        external: {
          majorDiameter: "10 mm",
          minorDiameter: "8.16 mm",
          pitch: "1.5 mm",
          starts: 1,
          hand: "right",
        },
        internal: {
          majorDiameter: "10 mm",
          minorDiameter: "8.38 mm",
          pitch: "1.5 mm",
          starts: 1,
          hand: "right",
        },
      });
      assert.equal(pair["pairFit"], "pass");
      assert.ok(Array.isArray(pair["checks"]));
      assert.ok(pair["checks"].length > 0);
      assert.ok(
        pair["checks"].every((item) => record(item)["status"] === "pass"),
      );
      near(record(pair["engagementDepth"])["value"], 0.81);
      assert.equal(
        record(pair["crossSection"])["type"],
        "ISO-style 60-degree V",
      );
      const rejected = await session.execute(
        "unsupported-designation",
        cadCommand(session.document, "thread.catalog", {
          schemaVersion: 1,
          frame: "component",
          system: "iso-metric-coarse",
          query: "M10x1.5",
          starts: 2,
        }),
        session.document,
        "cad-v1",
      );
      assert.equal(rejected["result"], null);
      assert.equal(
        rejected["error"],
        "ValueError: Unknown designation in curated table: M10x1.5",
      );
      assert.deepEqual(
        await session.execute("geometry-readback", boxState(session.document)),
        before,
      );
    },
  }));
}

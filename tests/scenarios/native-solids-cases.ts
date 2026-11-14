import assert from "node:assert/strict";
import type { Scenario } from "./runner";
import { number, record, type FixtureFolder } from "./contracts";

export const nativeSolidsCapability = "native-profile-sector-torus";
/** 0..120 degrees includes the interior outer-arc Y extremum at 90 degrees. */
export const nativeAnnularBounds = [30, 20, 5] as const;
const array = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value));
  return value;
};
const near = (actual: unknown, expected: number, tolerance: number) =>
  assert.ok(
    Math.abs(number(actual) - expected) <= tolerance,
    `Expected ${expected} +/- ${tolerance}, received ${String(actual)}`,
  );

/** Retained native kernel obligations. The model does not advertise this capability. */
export function nativeSolidsScenarios(
  folder: FixtureFolder | undefined,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-solids-" + (folder ? "" : "unsaved-") + index,
    ...(folder
      ? { fixture: folder }
      : { scope: "exclusive-instance" as const }),
    requires: [
      "documents",
      ...(folder ? ["saved-fixtures"] : []),
      nativeSolidsCapability,
    ],
    async run(session) {
      let sequence = 0;
      const cad = async (operation: string, data: Record<string, unknown>) => {
        if (!folder)
          await session.verifyOwnedUnsaved("observe-solids-" + sequence++);
        const output = await session.cad(
          "cad-solid-" + sequence++ + "-" + operation,
          operation,
          data,
        );
        assert.equal(output["success"], true);
        assert.equal(output["operation"], operation);
        const result = record(output["result"]);
        // CLI envelope supplies the execution outcome. Raw entity.inspect has
        // no success/operation/status fields; all native geometry checks follow.
        if (result["status"] !== undefined)
          assert.equal(result["status"], "pass");
        return result;
      };
      const profile = async (
        sketchName: string,
        geometryName: string,
        end: string[],
      ) => {
        const created = await cad("sketch.create", {
          name: sketchName,
          plane: "XY",
        });
        assert.equal(record(created["sketch"])["kind"], "sketch");
        const made = await cad("sketch.geometry", {
          sketch: created["sketch"],
          geometry: [
            {
              type: "rectangle",
              name: geometryName,
              start: ["0 mm", "0 mm", "0 mm"],
              end,
            },
          ],
        });
        assert.equal(Object.keys(record(made["refs"])).length, 1);
        const inspected = await cad("sketch.inspect", {
          sketch: created["sketch"],
        });
        const profiles = array(inspected["profiles"]);
        assert.equal(profiles.length, 1);
        return record(profiles[0])["ref"];
      };
      const body = (result: Record<string, unknown>) => {
        const bodies = array(result["bodies"]);
        assert.equal(bodies.length, 1);
        return bodies[0];
      };
      const measure = async (
        ref: unknown,
        size: number[],
        volume: number,
        boundsTolerance = 0.001,
        volumeTolerance = 0.001,
      ) => {
        assert.equal((await cad("entity.inspect", { ref }))["isSolid"], true);
        const bounds = array(
          (await cad("measure.bounds", { ref, units: "mm" }))["size"],
        );
        assert.equal(bounds.length, 3);
        bounds.forEach((value, i) => near(value, size[i]!, boundsTolerance));
        near(
          (await cad("measure.volume", { ref, units: "mm3" }))["value"],
          volume,
          volumeTolerance,
        );
      };
      const ribProfile = await profile("RibSection", "RibProfile", [
        "10 mm",
        "2 mm",
        "0 mm",
      ]);
      const rib = await cad("shape.rib", {
        name: "NativeRib",
        profile: ribProfile,
        thickness: "2 mm",
        operation: "newBody",
      });
      await measure(body(rib), [10, 2, 2], 40);
      const webProfile = await profile("WebSection", "WebProfile", [
        "2 mm",
        "10 mm",
        "0 mm",
      ]);
      const web = await cad("shape.web", {
        name: "NativeWeb",
        profile: webProfile,
        thickness: "1 mm",
        operation: "newBody",
      });
      await measure(body(web), [2, 10, 1], 20);
      const annular = await cad("shape.annular_segment", {
        name: "NativeAnnularSector",
        innerRadius: "10 mm",
        outerRadius: "20 mm",
        start: "0 deg",
        sweep: "120 deg",
        height: "5 mm",
        operation: "newBody",
      });
      const annularVolume = Math.PI * (120 / 360) * (20 ** 2 - 10 ** 2) * 5;
      // Correct the historical endpoint-only Y expectation; radius, request,
      // measured API and 0.001mm tolerance are unchanged. See the evidence note.
      await measure(
        body(annular),
        [...nativeAnnularBounds],
        annularVolume,
        0.001,
        0.01,
      );
      const diameters = record(annular["diameters"]);
      assert.equal(
        [diameters["inner"], diameters["outer"], diameters["sweep"]].join("|"),
        "10 mm|20 mm|120 deg",
      );
      const strip = await cad("shape.arc_strip", {
        name: "NativeArcStrip",
        centerline: { radius: "30 mm", start: "10 deg", sweep: "80 deg" },
        thickness: "2 mm",
        height: "20 mm",
        operation: "newBody",
      });
      const stripVolume = Math.PI * (80 / 360) * (31 ** 2 - 29 ** 2) * 20;
      const stripBounds = [
        31 * Math.cos(Math.PI / 18),
        31 - 29 * Math.sin(Math.PI / 18),
        20,
      ];
      await measure(body(strip), stripBounds, stripVolume, 0.002, 0.01);
      const centerline = record(strip["centerline"]);
      assert.equal(
        String(centerline["outerRadius"]).includes("2 mm") &&
          String(centerline["innerRadius"]).includes("2 mm"),
        true,
      );
      const ring = await cad("shape.o_ring", {
        schemaVersion: 1,
        frame: "component",
        name: "NativeORing",
        id: "10 mm",
        cs: "2 mm",
      });
      const ringBody = body(ring);
      assert.equal(ring["free"] && ring["torus"], true);
      assert.equal(
        [
          record(ring["innerDiameter"])["value"],
          record(ring["cs"])["value"],
        ].join("|"),
        "10|2",
      );
      const ringVolume = 2 * Math.PI ** 2 * 6 * 1 ** 2;
      await measure(ringBody, [14, 14, 2], ringVolume, 0.001, 0.01);
      near(record(ring["volume"])["value"], ringVolume, 0.01);
    },
  }));
}

import assert from "node:assert/strict";
import { number, record, type FixtureFolder } from "./contracts";
import type { Scenario } from "./runner";
import { cadSequence } from "./cad-programs";
import { boxState, createBox } from "./box-cases";

const list = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value));
  return value;
};
const at = (value: unknown, ...keys: (string | number)[]): unknown => {
  for (const key of keys)
    value = typeof key === "number" ? list(value)[key] : record(value)[key];
  return value;
};
const near = (actual: unknown, expected: number, tolerance = 1e-8) =>
  assert.ok(
    Math.abs(number(actual) - expected) < tolerance,
    `${String(actual)} != ${expected}`,
  );
const base = { schemaVersion: 1, frame: "component" };
const rise = { law: "halfCosine", lift: "10 mm", angle: "240 deg" };
const cam = {
  ...base,
  baseRadius: "15 mm",
  rollerRadius: "5 mm",
  rise,
  followerLine: [0, 1, 0],
  phase: "0 deg",
  direction: "ccw",
};
const spring = {
  ...base,
  wireDiameter: "0.5 mm",
  meanDiameter: "8 mm",
  activeCoils: 6,
  totalCoils: 8,
  freeLength: "35 mm",
};

/** Original GM12/GM14 declaration calculations; no native Coil/contact solver. */
export function mechanicalDeclarationScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "mechanical-declarations-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "rectangular-extrusion",
      "mechanical-declarations",
    ],
    async run(session) {
      const before = await session.execute(
        "owned-body",
        createBox(session.document, 10 + index),
      );
      const samples = Array.from({ length: 17 }, (_, i) => {
        const deg = 15 * i,
          theta = (Math.PI * deg) / 180;
        const lift =
          5 * (1 - Math.cos((Math.PI * theta) / ((Math.PI * 240) / 180)));
        return {
          angle: `${deg.toFixed(1)} deg`,
          lift: `${lift.toFixed(6)} mm`,
        };
      });
      const output = await session.execute(
        "mechanical-declarations",
        cadSequence(session.document, [
          {
            operation: "curve.helix",
            data: {
              ...base,
              radius: "4 mm",
              pitch: "5.75 mm",
              turns: 8,
              hand: "right",
            },
          },
          {
            operation: "shape.helix",
            data: { ...base, radius: "4 mm", pitch: "5.75 mm", turns: 8 },
          },
          {
            operation: "curve.helix",
            data: { ...base, radius: "4 mm", turns: 8, height: "46 mm" },
          },
          {
            operation: "curve.helix",
            data: {
              ...base,
              radius: "4 mm",
              pitch: "5.75 mm",
              turns: 1,
              hand: "left",
            },
          },
          {
            operation: "shape.spring",
            data: {
              ...spring,
              name: "Spring",
              endStyle: "ground",
              hand: "right",
            },
          },
          {
            operation: "spring.evaluate",
            data: {
              ...base,
              wireDiameter: "1 mm",
              meanDiameter: "10 mm",
              activeCoils: 10,
              totalCoils: 12,
              freeLength: "30 mm",
              shearModulus: "77000 N/mm^2",
              density: "7850 kg/m^3",
              installedLength: "25 mm",
              compressedLength: "20 mm",
            },
          },
          {
            operation: "spring.configure",
            data: {
              ...spring,
              installedLength: "27 mm",
              compressedLength: "17 mm",
              guide: { kind: "rod", diameter: "7.4 mm" },
            },
          },
          {
            operation: "spring.evaluate",
            data: {
              ...spring,
              shearModulus: "77000 N/mm^2",
              density: "7850 kg/m^3",
              installedLength: "27 mm",
              compressedLength: "17 mm",
            },
          },
          {
            operation: "spring.configure",
            data: {
              ...spring,
              installedLength: "27 mm",
              compressedLength: "17 mm",
            },
          },
          { operation: "cam.profile", data: cam },
          {
            operation: "cam.evaluate",
            data: {
              ...cam,
              maximumPressureAngle: "12 deg",
              minimumCurvatureRadius: "10 mm",
            },
          },
          {
            operation: "cam.cycle-check",
            data: { ...base, rise },
            statuses: ["unknown"],
            success: false,
          },
          {
            operation: "cam.cycle-check",
            data: { ...base, rise, returnLaw: "spring-return", dwell: {} },
          },
          {
            operation: "cam.profile",
            data: {
              ...base,
              baseRadius: "15 mm",
              rollerRadius: "5 mm",
              rise: { samples },
            },
          },
        ]),
        session.document,
        "cad-v1",
      );
      const rows = list(output["rows"]).map((row) => record(at(row, "result")));
      assert.equal(rows.length, 14);
      const get = (index: number) => {
        const value = rows[index];
        assert.ok(value);
        return value;
      };
      // G12-01 and G12-02: generated centerline, dimensional derivation and handedness.
      const helix = get(0);
      near(at(helix, "radius", "value"), 4);
      near(at(helix, "pitch", "value"), 5.75);
      assert.equal(helix["turns"], 8);
      near(at(helix, "height", "value"), 46);
      assert.equal(helix["hand"], "right");
      assert.equal(helix["representation"], "recipe");
      assert.equal(helix["nativeCoil"], false);
      near(
        at(helix, "arcLength", "value"),
        Math.hypot(5.75, 2 * Math.PI * 4) * 8,
      );
      near(
        at(helix, "curvature", "value"),
        4 / (4 ** 2 + (5.75 / (2 * Math.PI)) ** 2),
        1e-9,
      );
      assert.ok(get(1)["arcLength"]);
      near(at(get(2), "pitch", "value"), 5.75, 1e-9);
      assert.equal(get(3)["hand"], "left");
      // G12-03/G12-04: spring recipe and explicit ground-end/native gap.
      const shaped = get(4);
      near(at(shaped, "outerDiameter", "value"), 8.5);
      near(at(shaped, "innerDiameter", "value"), 7.5);
      near(at(shaped, "solidHeight", "value"), 4);
      assert.equal(shaped["representation"], "recipe");
      assert.equal(shaped["nativeCoil"], false);
      for (const key of ["wireLength", "mass", "stiffness"])
        assert.ok(number(at(shaped, key, "value")) > 0);
      assert.equal(shaped["endStyle"], "ground");
      assert.ok(
        list(shaped["assumptions"]).some((a) =>
          String(a).includes("recipe representations only"),
        ),
      );
      // G12-05/G12-07: original numeric fixtures, units and installed/compressed force.
      for (const [
        result,
        stiffness,
        solidHeight,
        compressedDeflection,
        installedDeflection,
      ] of [
        [get(5), 0.9625, 12, 10, 5],
        [get(7), 0.19582112630208334, 4, 18, 8],
      ] as const) {
        near(at(result, "stiffness", "value"), stiffness, 1e-9);
        assert.equal(at(result, "stiffness", "units"), "N/mm");
        near(at(result, "solidHeight", "value"), solidHeight);
        for (const key of ["wireLength", "mass", "solidHeightMargin"])
          assert.ok(number(at(result, key, "value")) > 0);
        const forces = Object.fromEntries(
          list(result["forces"]).map((force) => [
            String(at(force, "state")),
            at(force, "force", "value"),
          ]),
        );
        near(forces["compressed"], stiffness * compressedDeflection);
        near(forces["installed"], stiffness * installedDeflection);
      }
      // G12-06/G12-08: rod clearance and the independent material-volume margin.
      const guideRod = list(get(6)["checks"]).find(
        (check) => at(check, "check") === "guide-rod",
      );
      assert.equal(at(guideRod, "status"), "pass");
      near(at(guideRod, "clearance", "value"), 0.1, 1e-9);
      const volume = list(get(8)["checks"]).find(
        (check) => at(check, "check") === "material-volume",
      );
      assert.equal(at(volume, "status"), "pass");
      near(at(volume, "margin", "value"), 13, 1e-9);
      near(at(get(8), "configuredState", "solidHeight", "value"), 4);
      near(at(get(8), "configuredState", "compressedLength", "value"), 17);
      // G14-01/02/06: numeric extremums, normal offset samples and honest release gap.
      const profile = get(9);
      near(at(profile, "maxPressureAngle", "value"), 10.95961788503868, 1e-4);
      near(
        at(profile, "minPitchCurvatureRadius", "value"),
        18.326658996398017,
        1e-4,
      );
      assert.equal(at(profile, "maxPressureAngle", "units"), "deg");
      assert.equal(at(profile, "minPitchCurvatureRadius", "units"), "mm");
      assert.equal(at(profile, "normalOffset", "value"), 5);
      assert.deepEqual(profile["followerLine"], [0, 1, 0]);
      const pitch = list(profile["pitchProfile"]),
        working = list(profile["workingProfile"]);
      near(
        Math.hypot(number(at(pitch[0], 0)), number(at(pitch[0], 1))),
        15,
        1e-3,
      );
      near(
        Math.hypot(
          number(at(pitch[pitch.length - 1], 0)),
          number(at(pitch[pitch.length - 1], 1)),
        ),
        25,
        1e-3,
      );
      for (
        let i = 0;
        i < pitch.length;
        i += Math.max(1, Math.floor(pitch.length / 20))
      ) {
        near(
          Math.hypot(
            number(at(pitch[i], 0)) - number(at(working[i], 0)),
            number(at(pitch[i], 1)) - number(at(working[i], 1)),
          ),
          5,
          1e-3,
        );
      }
      assert.equal(profile["contact"], "resolved over the rise only");
      assert.equal(profile["separation"], "release contact unresolved");
      assert.ok(
        list(profile["unresolvedIntervals"]).some(
          (u) => at(u, "interval") === "release",
        ),
      );
      // G14-03/04/07: declared thresholds and separate unknown versus closed cycle.
      const checks = Object.fromEntries(
        list(get(10)["checks"]).map((c) => [
          String(at(c, "check")),
          at(c, "status"),
        ]),
      );
      assert.equal(checks["pressure-angle"], "pass");
      assert.equal(checks["curvature"], "pass");
      assert.equal(get(11)["status"], "unknown");
      assert.ok(
        list(get(11)["unresolvedIntervals"]).some(
          (u) => at(u, "interval") === "release",
        ),
      );
      assert.equal(get(11)["cycleStatus"], "unknown");
      assert.equal(
        get(11)["dropEdgeDynamics"],
        "blocked (no proper definition or evidence)",
      );
      assert.equal(get(12)["cycleStatus"], "pass");
      // G14-05: sampled source is independently evaluated with unchanged tolerance.
      const sampled = get(13),
        sampledPitch = list(sampled["pitchProfile"]);
      near(
        Math.hypot(
          number(at(sampledPitch[0], 0)),
          number(at(sampledPitch[0], 1)),
        ),
        15,
        1e-3,
      );
      near(
        Math.hypot(
          number(at(sampledPitch[sampledPitch.length - 1], 0)),
          number(at(sampledPitch[sampledPitch.length - 1], 1)),
        ),
        25,
        1e-3,
      );
      assert.ok(number(at(sampled, "minPitchCurvatureRadius", "value")) > 5);
      assert.equal(at(sampled, "normalOffset", "value"), 5);
      assert.deepEqual(
        await session.execute("geometry-readback", boxState(session.document)),
        before,
      );
    },
  }));
}

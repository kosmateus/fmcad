import assert from "node:assert/strict";
import type { Scenario, ScenarioSession } from "./runner";
import { number, record, type FixtureFolder } from "./contracts";
import { cadCommand } from "./cad-programs";

export function cameraEqual(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  assert.equal(actual["cameraType"], expected["cameraType"]);
  assert.deepEqual(actual["document"], expected["document"]);
  assert.equal(actual["units"], "cm");
  for (const key of ["eye", "target", "up", "extents"]) {
    const values = expected[key];
    if (values !== undefined) {
      const observed = actual[key];
      assert.ok(Array.isArray(values) && Array.isArray(observed));
      assert.equal(observed.length, values.length);
      values.forEach((value, index) =>
        assert.ok(
          Math.abs(number(observed[index]) - number(value)) <= 0.00001,
          key + "[" + index + "]",
        ),
      );
    }
  }
  if (expected["perspectiveAngle"] !== undefined)
    assert.ok(
      Math.abs(
        number(actual["perspectiveAngle"]) -
          number(expected["perspectiveAngle"]),
      ) <= 0.00001,
    );
}
async function camera(
  session: ScenarioSession,
  phase: string,
  operation: string,
  data: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const output = await session.execute(
    phase,
    cadCommand(session.document, operation, data),
    session.document,
    "cad-v1",
  );
  assert.equal(output["error"], null, String(output["error"]));
  return record(output["result"]);
}
/** Historical explicit pose/40-degree lens checks; rendering remains a separate native obligation. */
export function cameraScenarios(folder: FixtureFolder, owners = 2): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "camera-state-" + index,
    fixture: folder,
    scope: "exclusive-instance",
    requires: ["documents", "saved-fixtures", "camera-state"],
    async run(session) {
      const original = record(
        (await camera(session, "camera-original", "camera.save"))["state"],
      );
      let primary: unknown;
      try {
        const applied = await camera(
          session,
          "camera-perspective",
          "camera.set",
          {
            projection: "perspective",
            perspectiveAngle: "40 deg",
            eye: ["80 mm", "60 mm", "50 mm"],
            target: ["10 mm", "6 mm", "5 mm"],
            up: [0, 0, 1],
            fit: false,
          },
        );
        cameraEqual(record(applied["restoreState"]), original);
        const changed = record(
          (await camera(session, "camera-readback", "camera.save"))["state"],
        );
        cameraEqual(changed, {
          document: original["document"],
          cameraType: "PerspectiveCameraType",
          eye: [8, 6, 5],
          target: [1, 0.6, 0.5],
          up: [0, 0, 1],
          perspectiveAngle: (40 * Math.PI) / 180,
        });
        const foreign = structuredClone(original);
        record(foreign["document"])["creationId"] = "foreign-document";
        for (const [phase, operation, data, message] of [
          [
            "camera-foreign",
            "camera.restore",
            { state: foreign },
            /State belongs to a different document/u,
          ],
          [
            "camera-invalid",
            "camera.set",
            { projection: "perspective", perspectiveAngle: "180 deg" },
            /Perspective angle must be between zero and pi/u,
          ],
        ] as const) {
          const rejected = await session.execute(
            phase,
            cadCommand(session.document, operation, data),
            session.document,
            "cad-v1",
          );
          assert.match(String(rejected["error"]), message);
          cameraEqual(
            record(
              (await camera(session, phase + "-unchanged", "camera.save"))[
                "state"
              ],
            ),
            changed,
          );
        }
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        try {
          await camera(session, "camera-restore", "camera.restore", {
            state: original,
          });
          cameraEqual(
            record(
              (await camera(session, "camera-restored", "camera.save"))[
                "state"
              ],
            ),
            original,
          );
        } catch (error) {
          if (primary !== undefined)
            throw new AggregateError(
              [primary, error],
              "Camera scenario failed and restoration could not be verified",
            );
          throw error;
        }
      }
    },
  }));
}

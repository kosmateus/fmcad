import assert from "node:assert/strict";
import type { Scenario, ScenarioSession } from "./runner";
import { record, text, type FixtureFolder } from "./contracts";
import { cadCommand } from "./cad-programs";
import { program, guard, emit } from "./programs";

const base = { schemaVersion: 1, frame: "component" };
const poseA = "PoseAlternate",
  poseB = "PoseBaseline";
async function call(
  session: ScenarioSession,
  phase: string,
  operation: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const output = await session.execute(
    phase,
    cadCommand(session.document, operation, data),
    session.document,
    "cad-v1",
  );
  assert.equal(output["error"], null, String(output["error"]));
  const result = record(output["result"]);
  if (operation.startsWith("pose.")) {
    assert.equal(result["success"], true);
    assert.equal(result["status"], "pass");
    assert.equal(result["operation"], operation);
    assert.equal(
      record(result["documentIdentity"])["creationId"],
      session.document.creationId,
    );
  }
  return result;
}
function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
async function visibility(
  session: ScenarioSession,
  phase: string,
  token: string,
): Promise<boolean> {
  const value = await session.execute(
    phase,
    program(`${guard(session.document)}
bodies = [b for b in design.rootComponent.bRepBodies if b.entityToken == ${JSON.stringify(token)}]
assert len(bodies) == 1, 'Owned pose body is ambiguous'
${emit("dict(creationId=doc.creationId, visible=bodies[0].isLightBulbOn)")}`),
  );
  assert.equal(typeof value["visible"], "boolean");
  return value["visible"] as boolean;
}
export function poseScenarios(folder: FixtureFolder, owners = 2): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "pose-visibility-" + index,
    fixture: folder,
    scope: "exclusive-instance",
    requires: [
      "documents",
      "saved-fixtures",
      "dimensioned-rectangle",
      "pose-visibility",
    ],
    async run(session) {
      const shape = await call(session, "pose-body", "shape.box", {
        name: "PoseBody",
        width: "10 mm",
        depth: "12 mm",
        height: "14 mm",
      });
      const body = rows(shape["bodies"])[0]!;
      const token = text(body["token"]);
      const originalVisible = await visibility(
        session,
        "pose-initial-visibility",
        token,
      );
      const alternate = !originalVisible;
      const saveA = {
        ...base,
        name: poseA,
        visibility: [{ ref: body, visible: alternate }],
        fillState: "EMPTY",
        springState: "COCKED",
        routeVariant: "coverage-route",
        service: { disconnections: ["coverage-wire"] },
      };
      const savedA = await call(session, "pose-save-a", "pose.save", saveA);
      assert.equal(savedA["revision"], 1);
      const manifest = record(savedA["manifest"]);
      assert.equal(manifest["schema"], "fmcad.pose.manifest.v1");
      assert.equal(
        record(manifest["document"])["creationId"],
        session.document.creationId,
      );
      assert.deepEqual(
        [
          manifest["fillState"],
          manifest["springState"],
          manifest["routeVariant"],
          record(manifest["service"])["disconnections"],
        ],
        ["EMPTY", "COCKED", "coverage-route", ["coverage-wire"]],
      );
      const updatedA = await call(session, "pose-update-a", "pose.save", {
        ...saveA,
        onExisting: "update",
        confirm: true,
      });
      assert.equal(updatedA["revision"], 2);
      const savedB = await call(session, "pose-save-b", "pose.save", {
        ...base,
        name: poseB,
        visibility: [{ ref: body, visible: originalVisible }],
        fillState: "FULL",
        routeVariant: "baseline-route",
      });
      assert.equal(savedB["revision"], 1);
      assert.equal(record(savedB["manifest"])["fillState"], "FULL");
      const listed = await call(session, "pose-list", "pose.list", base);
      assert.equal(listed["count"], 2);
      const indexed = rows(listed["poses"]);
      assert.equal(
        indexed.find((pose) => pose["name"] === poseA)?.["revision"],
        2,
      );
      assert.equal(
        record(indexed.find((pose) => pose["name"] === poseB)!["document"])[
          "creationId"
        ],
        session.document.creationId,
      );
      let primary: unknown;
      try {
        const appliedA = await call(session, "pose-apply-a", "pose.apply", {
          ...base,
          name: poseA,
        });
        assert.equal(appliedA["leftApplied"], true);
        assert.equal(
          record(record(appliedA["after"])["visibility"])[token],
          alternate,
        );
        assert.equal(
          rows(appliedA["applied"]).some(
            (item) =>
              item["dimension"] === "fillState" &&
              item["applied"] === "manifest-carried",
          ),
          true,
        );
        assert.deepEqual(appliedA["unapplied"], []);
        assert.equal(
          await visibility(session, "pose-applied-readback", token),
          alternate,
        );
        const evaluatedB = await call(
          session,
          "pose-evaluate-b",
          "pose.evaluate",
          { ...base, name: poseB },
        );
        assert.equal(evaluatedB["restored"], true);
        assert.equal(evaluatedB["primaryError"], null);
        assert.deepEqual(evaluatedB["restoreErrors"], []);
        assert.equal(
          record(record(evaluatedB["before"])["visibility"])[token],
          alternate,
        );
        assert.equal(
          record(record(evaluatedB["after"])["visibility"])[token],
          originalVisible,
        );
        assert.equal(
          record(record(evaluatedB["restoration"])["visibility"])[token],
          alternate,
        );
        assert.equal(
          await visibility(session, "pose-evaluated-readback", token),
          alternate,
        );
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        try {
          const appliedB = await call(session, "pose-restore-b", "pose.apply", {
            ...base,
            name: poseB,
          });
          assert.equal(
            record(record(appliedB["after"])["visibility"])[token],
            originalVisible,
          );
          assert.equal(
            await visibility(session, "pose-restored-readback", token),
            originalVisible,
          );
        } catch (error) {
          if (primary !== undefined)
            throw new AggregateError(
              [primary, error],
              "Pose failed and original visibility could not be verified",
            );
          throw error;
        }
      }
      const deletedA = await call(session, "pose-delete-a", "pose.delete", {
        ...base,
        name: poseA,
        confirm: true,
      });
      assert.equal(deletedA["deleted"], true);
      assert.equal(deletedA["revision"], 2);
      const deletedB = await call(session, "pose-delete-b", "pose.delete", {
        ...base,
        name: poseB,
        confirm: true,
      });
      assert.equal(deletedB["deleted"], true);
      assert.equal(
        (await call(session, "pose-empty", "pose.list", base))["count"],
        0,
      );
    },
  }));
}

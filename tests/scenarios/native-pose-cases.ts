import assert from "node:assert/strict";
import type { Scenario } from "./runner";
import { NativeProbe } from "./native-probe";

export const nativePoseCapability = "native-pose-manifest-visibility";
interface Ref extends Record<string, unknown> {
  token: string;
  kind: string;
}
interface Manifest {
  schema: string;
  document: { creationId: string };
  fillState: string;
  springState: string;
  routeVariant: string;
  service: { disconnections: string[] };
}
interface PoseState {
  visibility: Record<string, boolean>;
}
interface Results {
  "shape.box": { bodies: Ref[] };
  "pose.save": { revision: number; manifest: Manifest };
  "pose.list": {
    count: number;
    poses: {
      name: string;
      revision: number;
      document: { creationId: string };
    }[];
  };
  "pose.apply": {
    leftApplied: boolean;
    after: PoseState;
    applied: { dimension: string; applied: string }[];
    unapplied: unknown[];
  };
  "pose.evaluate": {
    restored: boolean;
    primaryError: unknown;
    restoreErrors: unknown[];
    before: PoseState;
    after: PoseState;
    restoration: PoseState;
  };
  "pose.delete": { deleted: boolean; revision: number };
}
function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value!;
}
/** Original native pose assertions, on the shared owned-unsaved session lifecycle. */
export function nativePoseScenarios(owners = 2): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-pose-methods-" + index,
    scope: "exclusive-instance",
    requires: ["documents", nativePoseCapability, "original-user-view"],
    async run(session) {
      const probe = new NativeProbe(
        session,
        "native-pose-methods",
        "LIVE_POSE ",
      );
      const name = session.document.name,
        identity = session.document,
        poseA = "PoseAlternate",
        poseB = "PoseBaseline";
      const check = probe.check.bind(probe),
        validated = probe.validated.bind(probe);
      const cad = <K extends keyof Results>(
        operation: K,
        data: Record<string, unknown> = {},
      ): Promise<Results[K]> => probe.cad<Results[K]>(operation, data);
      const visibility = async () => {
        return probe.script<{
          creationId: string;
          visible: boolean;
        }>(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.name == ${JSON.stringify(name)} and d.creationId == ${JSON.stringify(identity.creationId)}]
assert len(matches) == 1, 'Fixture identity ambiguous'
doc = matches[0]
assert doc == app.activeDocument and doc.dataFile is None and not doc.isSaved
body = doc.design.rootComponent.bRepBodies.itemByName('PoseBody')
assert body is not None
print('LIVE_POSE ' + json.dumps({"creationId": doc.creationId, "visible": body.isLightBulbOn}))`);
      };
      try {
        await probe.guard();
        const shape = await cad("shape.box", {
          name: "PoseBody",
          width: "10 mm",
          depth: "12 mm",
          height: "14 mm",
        });
        const body = shape.bodies[0];
        assert.ok(body, "Native body ref is missing");
        check(
          "shape.box",
          "owned native BRep body ref is available",
          Boolean(body.token),
          true,
        );
        validated("shape.box");
        const bodyState = await visibility();
        assert.equal(
          bodyState.creationId,
          identity.creationId,
          "Visibility probe resolved a different document.",
        );
        const originalVisible = bodyState.visible;

        const alternate = !originalVisible;
        const saveA = {
          schemaVersion: 1,
          frame: "component",
          name: poseA,
          visibility: [{ ref: body, visible: alternate }],
          fillState: "EMPTY",
          springState: "COCKED",
          routeVariant: "coverage-route",
          service: { disconnections: ["coverage-wire"] },
        };
        const savedA = await cad("pose.save", saveA);
        check(
          "pose.save",
          "first local manifest revision is one",
          savedA.revision,
          1,
        );
        check(
          "pose.save",
          "manifest is explicitly schema v1",
          savedA.manifest.schema,
          "fmcad.pose.manifest.v1",
        );
        check(
          "pose.save",
          "manifest captures exact owner document identity",
          savedA.manifest.document.creationId,
          identity.creationId,
        );
        check(
          "pose.save",
          "fill/spring/route/service are declared manifest fields",
          [
            savedA.manifest.fillState,
            savedA.manifest.springState,
            savedA.manifest.routeVariant,
            savedA.manifest.service.disconnections.join(","),
          ].join("|"),
          "EMPTY|COCKED|coverage-route|coverage-wire",
        );
        validated("pose.save");

        const updateA = { ...saveA, onExisting: "update", confirm: true };
        const updatedA = await cad("pose.save", updateA);
        check(
          "pose.save",
          "confirmed update increments revision",
          updatedA.revision,
          2,
        );
        validated("pose.save");

        const savedB = await cad("pose.save", {
          schemaVersion: 1,
          frame: "component",
          name: poseB,
          visibility: [{ ref: body, visible: originalVisible }],
          fillState: "FULL",
          routeVariant: "baseline-route",
        });
        check(
          "pose.save",
          "second manifest starts at revision one",
          savedB.revision,
          1,
        );
        check(
          "pose.save",
          "manifest-carried full state remains declared only",
          savedB.manifest.fillState,
          "FULL",
        );
        validated("pose.save");

        const listed = await cad("pose.list", {
          schemaVersion: 1,
          frame: "component",
        });
        check("pose.list", "both named manifests are indexed", listed.count, 2);
        check(
          "pose.list",
          "updated manifest revision is listed",
          required(listed.poses.find((pose) => pose.name === poseA)).revision,
          2,
        );
        check(
          "pose.list",
          "baseline manifest belongs to the exact fixture document",
          required(listed.poses.find((pose) => pose.name === poseB)).document
            .creationId,
          identity.creationId,
        );
        validated("pose.list");

        const appliedA = await cad("pose.apply", {
          schemaVersion: 1,
          frame: "component",
          name: poseA,
        });
        check(
          "pose.apply",
          "apply intentionally leaves requested state in place",
          appliedA.leftApplied,
          true,
        );
        check(
          "pose.apply",
          "visibility target is applied",
          appliedA.after.visibility[body.token],
          alternate,
        );
        check(
          "pose.apply",
          "manifest-only state is reported as carried, not recomputed",
          appliedA.applied.some(
            (item) =>
              item.dimension === "fillState" &&
              item.applied === "manifest-carried",
          ),
          true,
        );
        check(
          "pose.apply",
          "there are no unapplied native dimensions",
          appliedA.unapplied.length,
          0,
        );
        validated("pose.apply");
        check(
          "pose.apply",
          "native body visibility readback matches apply result",
          (await visibility()).visible,
          alternate,
        );

        const evaluatedB = await cad("pose.evaluate", {
          schemaVersion: 1,
          frame: "component",
          name: poseB,
        });
        check(
          "pose.evaluate",
          "temporary evaluation restores the pre-call state",
          evaluatedB.restored,
          true,
        );
        check(
          "pose.evaluate",
          "evaluate has no primary or restoration error",
          evaluatedB.primaryError === null &&
            evaluatedB.restoreErrors.length === 0,
          true,
        );
        check(
          "pose.evaluate",
          "temporary before-state is the alternate pose",
          evaluatedB.before.visibility[body.token],
          alternate,
        );
        check(
          "pose.evaluate",
          "temporary after-state is the baseline pose",
          evaluatedB.after.visibility[body.token],
          originalVisible,
        );
        check(
          "pose.evaluate",
          "restoration readback equals the alternate pose",
          evaluatedB.restoration.visibility[body.token],
          alternate,
        );
        validated("pose.evaluate");
        check(
          "pose.evaluate",
          "native visibility is restored after temporary evaluation",
          (await visibility()).visible,
          alternate,
        );

        const appliedB = await cad("pose.apply", {
          schemaVersion: 1,
          frame: "component",
          name: poseB,
        });
        check(
          "pose.apply",
          "baseline apply leaves the original visibility in place",
          appliedB.after.visibility[body.token],
          originalVisible,
        );
        validated("pose.apply");
        check(
          "pose.apply",
          "native body visibility returns to its original value",
          (await visibility()).visible,
          originalVisible,
        );

        const deletedA = await cad("pose.delete", {
          schemaVersion: 1,
          frame: "component",
          name: poseA,
          confirm: true,
        });
        check(
          "pose.delete",
          "confirmed delete removes the updated pose",
          deletedA.deleted,
          true,
        );
        check(
          "pose.delete",
          "delete reports the current manifest revision",
          deletedA.revision,
          2,
        );
        validated("pose.delete");
        const deletedB = await cad("pose.delete", {
          schemaVersion: 1,
          frame: "component",
          name: poseB,
          confirm: true,
        });
        check(
          "pose.delete",
          "confirmed delete removes the baseline pose",
          deletedB.deleted,
          true,
        );
        validated("pose.delete");
        const empty = await cad("pose.list", {
          schemaVersion: 1,
          frame: "component",
        });
        check(
          "pose.list",
          "deleting owned poses empties the local index",
          empty.count,
          0,
        );
        validated("pose.list");

        assert.equal(
          (await visibility()).visible,
          originalVisible,
          "Owned fixture visibility was not restored before close.",
        );
      } finally {
        probe.persist();
      }
    },
  }));
}

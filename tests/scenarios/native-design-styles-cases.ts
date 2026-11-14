import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Scenario } from "./runner";
import { NativeProbe } from "./native-probe";

export const nativeDesignStylesCapability = "native-design-local-styles";
interface StyleItem {
  id: string;
  name: string;
}
interface StyleSource extends StyleItem {
  library: string;
}
interface Ref extends Record<string, unknown> {
  kind: string;
  token: string;
}
interface ListResult {
  items: StyleItem[];
  libraries: { id: string }[];
}
interface CreateResult {
  id: string;
  created?: StyleItem;
  copiedFrom: string;
}
interface EditResult {
  after: StyleItem;
  changed: boolean;
  changedFields: string[];
}
interface MapResult {
  count: number;
  mismatchCount: number;
  assignments: { assigned: { id: string } }[];
}
interface Results {
  "material.list": ListResult;
  "appearance.list": ListResult;
  "material.create": CreateResult;
  "appearance.create": CreateResult;
  "material.edit": EditResult;
  "appearance.edit": EditResult;
  "appearance.projection": {
    id: string;
    changed: boolean;
    projection: unknown;
  };
  "appearance.texture": {
    status: string;
    affected: unknown[];
    id: string;
    channel: string;
    changed: unknown[];
    before: { image: unknown };
    after: { image: unknown };
  };
  "shape.box": { bodies: Ref[] };
  "appearance.assign": { count: number; id: string };
  "material.assign": { count: number; id: string };
  "appearance.assign-map": MapResult;
  "material.assign-map": MapResult;
}
function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value!;
}
/** Copies loaded library entries before editing; never edits user/library definitions. */
export function nativeDesignStylesScenarios(owners = 2): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-design-styles-" + index,
    scope: "exclusive-instance",
    requires: ["documents", nativeDesignStylesCapability, "original-user-view"],
    async run(session) {
      const probe = new NativeProbe(
        session,
        "native-design-styles",
        "LIVE_STYLE ",
      );
      const check = probe.check.bind(probe),
        validated = probe.validated.bind(probe);
      const cad = <K extends keyof Results>(
        operation: K,
        data: Record<string, unknown> = {},
        _mutation = true,
        allowBlocked = false,
      ): Promise<Results[K]> => {
        // Public operation metadata controls read-only admission.
        void _mutation;
        return probe.cad<Results[K]>(operation, data, allowBlocked);
      };
      try {
        await probe.guard();
        const local = await cad("material.list", {}, false);
        check(
          "material.list",
          "design material list is an array",
          Array.isArray(local.items),
          true,
        );
        check(
          "material.list",
          "loaded material libraries are an array",
          Array.isArray(local.libraries),
          true,
        );
        validated("material.list");

        let source: StyleSource | undefined;
        for (const library of local.libraries) {
          if (!library?.id) continue;
          const result = await cad(
            "material.list",
            { library: library.id },
            false,
          );
          const item = result.items.find(
            (value) =>
              typeof value.id === "string" &&
              value.id &&
              !local.items.some(
                (localItem) =>
                  localItem.id === value.id || localItem.name === value.name,
              ),
          );
          if (item) {
            source = { ...item, library: library.id };
            break;
          }
        }
        if (!source) {
          throw new Error(
            "Material edit test has no safe source material; no edit was attempted.",
          );
        }

        const originalName =
          "FMCAD_Material_" + randomUUID().replaceAll("-", "_");
        const copy = await cad("material.create", {
          id: source.id,
          library: source.library,
          name: originalName,
        });
        const localId = copy.id || copy.created?.id;
        assert.ok(
          typeof localId === "string" && localId.length,
          "material.create returned no actual design-local ID.",
        );
        check(
          "material.create",
          "copied material ID is design-local",
          copy.id,
          localId,
        );
        check(
          "material.create",
          "copied from exact library item",
          copy.copiedFrom,
          source.id,
        );

        const editedName = originalName + "_Edited";
        const edit = await cad("material.edit", {
          id: localId,
          name: editedName,
        });
        check(
          "material.edit",
          "native material edit reports same ID",
          edit.after.id,
          localId,
        );
        check(
          "material.edit",
          "native material name changed",
          edit.after.name,
          editedName,
        );
        check(
          "material.edit",
          "native material edit reports a change",
          edit.changed,
          true,
        );
        assert.ok(
          edit.changedFields.includes("name"),
          "material.edit did not report the name field.",
        );

        const collisionName = originalName + "_Collision";
        const secondCopy = await cad("material.create", {
          id: source.id,
          library: source.library,
          name: collisionName,
        });
        const secondId = secondCopy.id || secondCopy.created?.id;
        assert.ok(
          typeof secondId === "string" && secondId.length,
          "Second native copy returned no design-local ID.",
        );
        check(
          "material.create",
          "second copy returned its actual ID",
          secondCopy.id,
          secondId,
        );
        await probe.rejected(
          "material.edit",
          { id: localId, name: collisionName },
          /material name already exists in the Design/i,
        );

        const after = await cad("material.list", {}, false);
        const items = new Map(after.items.map((value) => [value.id, value]));
        const readback = items.get(localId),
          secondReadback = items.get(secondId);
        assert.ok(
          readback && secondReadback,
          "A copied design-local material is missing from native list readback.",
        );
        check(
          "material.list",
          "native list readback contains edited name",
          readback.name,
          editedName,
        );
        check(
          "material.list",
          "rejected duplicate edit leaves the second copy unchanged",
          secondReadback.name,
          collisionName,
        );
        validated("material.list");
        validated("material.create", true);
        validated("material.edit");

        const localAppearances = await cad("appearance.list", {}, false);
        check(
          "appearance.list",
          "design-local appearance list is an array",
          Array.isArray(localAppearances.items),
          true,
        );
        check(
          "appearance.list",
          "loaded appearance libraries are an array",
          Array.isArray(localAppearances.libraries),
          true,
        );
        let appearanceSource: StyleSource | undefined;
        for (const library of localAppearances.libraries) {
          if (!library?.id) continue;
          const result = await cad(
            "appearance.list",
            { library: library.id },
            false,
          );
          const item = result.items.find(
            (value) =>
              typeof value.id === "string" &&
              value.id &&
              !localAppearances.items.some(
                (localItem) => localItem.id === value.id,
              ),
          );
          if (item) {
            appearanceSource = { ...item, library: library.id };
            break;
          }
        }
        if (!appearanceSource) {
          throw new Error(
            "Appearance edit test has no safe source appearance; no visual style mutation was attempted.",
          );
        }
        validated("appearance.list", true);

        const appearanceName =
          "FMCAD_Appearance_" + randomUUID().replaceAll("-", "_");
        const appearanceCopy = await cad("appearance.create", {
          id: appearanceSource.id,
          library: appearanceSource.library,
          name: appearanceName,
        });
        const appearanceId = appearanceCopy.id;
        assert.ok(
          typeof appearanceId === "string" && appearanceId.length,
          "appearance.create returned no actual design-local ID.",
        );
        check(
          "appearance.create",
          "actual copy ID is returned",
          appearanceCopy.id,
          appearanceId,
        );
        check(
          "appearance.create",
          "source library ID is preserved in copiedFrom",
          appearanceCopy.copiedFrom,
          appearanceSource.id,
        );

        const editedAppearanceName = appearanceName + "_Edited";
        const appearanceEdit = await cad("appearance.edit", {
          id: appearanceId,
          name: editedAppearanceName,
        });
        check(
          "appearance.edit",
          "native appearance edit preserves actual ID",
          appearanceEdit.after.id,
          appearanceId,
        );
        check(
          "appearance.edit",
          "native appearance rename is returned",
          appearanceEdit.after.name,
          editedAppearanceName,
        );
        check(
          "appearance.edit",
          "native appearance edit reports a change",
          appearanceEdit.changed,
          true,
        );
        assert.ok(
          appearanceEdit.changedFields.includes("name"),
          "appearance.edit omitted the changed name field.",
        );

        await probe.guard();
        const projection = await cad(
          "appearance.projection",
          { id: appearanceId },
          false,
        );
        check(
          "appearance.projection",
          "projection read uses the exact design-local appearance ID",
          projection.id,
          appearanceId,
        );
        check(
          "appearance.projection",
          "projection read is non-mutating",
          projection.changed,
          false,
        );
        check(
          "appearance.projection",
          "projection read returns a nullable current property",
          projection.projection === null ||
            typeof projection.projection === "string" ||
            typeof projection.projection === "number" ||
            typeof projection.projection === "object",
          true,
        );

        const texture = await cad(
          "appearance.texture",
          { id: appearanceId, channel: "color" },
          false,
          true,
        );
        if (texture.status === "blocked") {
          check(
            "appearance.texture",
            "unavailable preview texture API is reported blocked, not substituted",
            texture.status,
            "blocked",
          );
          check(
            "appearance.texture",
            "blocked read-only texture probe reports no affected entities",
            texture.affected.length,
            0,
          );
          const blockedTexture = probe.methods.findLast(
            (result) => result.operation === "appearance.texture",
          );
          assert.ok(blockedTexture);
          blockedTexture.assertions = [
            "installed SDK returned explicit blocked status; no texture setter was requested",
          ];
        } else {
          check(
            "appearance.texture",
            "read-only color texture probe status",
            texture.status,
            "pass",
          );
          check(
            "appearance.texture",
            "texture probe uses the exact local appearance",
            texture.id,
            appearanceId,
          );
          check(
            "appearance.texture",
            "texture channel is preserved",
            texture.channel,
            "color",
          );
          check(
            "appearance.texture",
            "no texture property was changed",
            texture.changed.length,
            0,
          );
          check(
            "appearance.texture",
            "texture readback is stable",
            texture.before.image,
            texture.after.image,
          );
          validated("appearance.texture");
        }

        const box = await cad("shape.box", {
          name: "StyleAppearanceFixture",
          width: "4 mm",
          depth: "5 mm",
          height: "6 mm",
        });
        check(
          "shape.box",
          "one isolated assignment target body is created",
          box.bodies.length,
          1,
        );
        const body = box.bodies[0];
        assert.ok(body);
        const assigned = await cad("appearance.assign", {
          refs: [body],
          id: appearanceId,
        });
        check(
          "appearance.assign",
          "one body receives the design-local appearance",
          assigned.count,
          1,
        );
        check(
          "appearance.assign",
          "assignment returns the copied appearance ID",
          assigned.id,
          appearanceId,
        );
        const assignmentMap = await cad("appearance.assign-map", {
          refs: [body],
        });
        check(
          "appearance.assign-map",
          "one native body is mapped",
          assignmentMap.count,
          1,
        );
        check(
          "appearance.assign-map",
          "assignment map reports no mismatches",
          assignmentMap.mismatchCount,
          0,
        );
        check(
          "appearance.assign-map",
          "native body readback resolves the edited local appearance",
          required(assignmentMap.assignments[0]).assigned.id,
          appearanceId,
        );

        const assignedMaterial = await cad("material.assign", {
          refs: [body],
          id: localId,
        });
        check(
          "material.assign",
          "one native body receives the copied physical material",
          assignedMaterial.count,
          1,
        );
        check(
          "material.assign",
          "physical assignment returns the copied material ID",
          assignedMaterial.id,
          localId,
        );
        const materialMap = await cad("material.assign-map", { refs: [body] });
        check(
          "material.assign-map",
          "one native body is mapped for physical material",
          materialMap.count,
          1,
        );
        check(
          "material.assign-map",
          "physical assignment map reports no mismatches",
          materialMap.mismatchCount,
          0,
        );
        check(
          "material.assign-map",
          "native body readback resolves the copied material ID",
          required(materialMap.assignments[0]).assigned.id,
          localId,
        );

        const appearanceReadback = await cad("appearance.list", {}, false);
        const appearanceReadbackItem = appearanceReadback.items.find(
          (value) => value.id === appearanceId,
        );
        assert.ok(
          appearanceReadbackItem,
          "Edited appearance is missing from design-local list readback.",
        );
        check(
          "appearance.list",
          "native list readback contains edited appearance name",
          appearanceReadbackItem.name,
          editedAppearanceName,
        );

        validated("appearance.list", true);
        validated("appearance.create");
        validated("appearance.edit");
        validated("appearance.projection");
        validated("shape.box");
        validated("appearance.assign");
        validated("appearance.assign-map");
        validated("material.assign");
        validated("material.assign-map");

        const blockedOperations = probe.methods
          .filter((result) => result.status === "blocked")
          .map((result) => result.operation);
        probe.observations.push({
          phase: "native-style-readback",
          result: { blockedOperations },
        });
      } finally {
        probe.persist();
      }
    },
  }));
}

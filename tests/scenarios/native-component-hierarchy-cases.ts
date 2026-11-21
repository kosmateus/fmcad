import assert from "node:assert/strict";
import type { Scenario } from "./runner";
import { number, record, text } from "./contracts";
import { concurrencyLimit } from "./scheduling";
import { nativeModelingHarness, values } from "./native-modeling-support";

export const nativeComponentHierarchyCapability = "native-component-hierarchy";
const targetOperations = [
  "component.from_bodies",
  "component.rename",
  "component.reparent",
  "assembly.parts",
  "assembly.rigid_group",
  "occurrence.duplicate",
  "occurrence.align",
];
const setupOperations = [
  "shape.box",
  "component.create",
  "component.inspect",
  "assembly.unground",
  "measure.bounds",
];

/** Exact retained physical readbacks; the simulator never advertises this kernel. */
export function nativeComponentHierarchyScenarios(owners = 10): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-component-hierarchy-" + index,
    requires: ["documents", nativeComponentHierarchyCapability],
    scope: "exclusive-instance",
    async run(session) {
      const { cad, check, validated, guard, persist } =
        await nativeModelingHarness(
          session,
          "tests/live-component-hierarchy.js",
          setupOperations,
          targetOperations,
          { honorResultStatus: true },
        );
      const rootBody = values(
        (
          await cad("shape.box", {
            name: "RootBody",
            width: "10 mm",
            depth: "8 mm",
            height: "4 mm",
          })
        )["bodies"],
      )[0];
      const moved = await cad("component.from_bodies", {
        name: "BodyContainer",
        bodies: [rootBody],
        confirm: true,
      });
      check(
        "component.from_bodies",
        "one explicit root body moved into the new component",
        values(moved["bodies"]).length,
        1,
      );
      check(
        "component.from_bodies",
        "move operation reports non-atomic semantics",
        moved["atomic"],
        false,
      );
      validated("component.from_bodies");
      const renamedName = "RenamedBodyContainer";
      const renamed = await cad("component.rename", {
        component: moved["component"],
        name: renamedName,
      });
      check(
        "component.rename",
        "rename affects all linked instances",
        renamed["affectsAllInstances"],
        true,
      );
      check(
        "component.rename",
        "returned component ref contains the new name",
        record(renamed["component"])["name"],
        renamedName,
      );
      validated("component.rename");
      const componentState = await cad("component.inspect", {
        component: renamed["component"],
      });
      check(
        "component.inspect",
        "renamed component owns the moved native body",
        values(componentState["bodies"]).length,
        1,
      );
      validated("component.inspect");
      const parent = await cad("component.create", { name: "ReparentTarget" });
      const child = await cad("component.create", {
        name: "ReparentChild",
        placement: { translation: ["10 mm", "20 mm", "30 mm"] },
      });
      const childBody = values(
        (
          await cad(
            "shape.box",
            {
              name: "ReparentChildBody",
              width: "4 mm",
              depth: "5 mm",
              height: "6 mm",
            },
            "ReparentChild",
          )
        )["bodies"],
      )[0];
      const ungrounded = await cad("assembly.unground", {
        occurrence: child["occurrence"],
      });
      check(
        "assembly.unground",
        "source occurrence is eligible for reparent",
        ungrounded["grounded"],
        false,
      );
      validated("assembly.unground");
      const before = await cad("measure.bounds", {
        ref: { ...record(childBody), occurrence: child["occurrence"] },
        units: "mm",
      });
      const reparented = await cad("component.reparent", {
        occurrence: child["occurrence"],
        target: parent["occurrence"],
        confirm: true,
      });
      check(
        "component.reparent",
        "native reparent reports world-pose preservation",
        reparented["worldPosePreserved"],
        true,
      );
      check(
        "component.reparent",
        "affected nested path is reported",
        values(reparented["affectedPaths"]).join(","),
        "ReparentTarget:1+ReparentChild:1",
      );
      const after = await cad("measure.bounds", {
        ref: { ...record(childBody), occurrence: reparented["occurrence"] },
        units: "mm",
      });
      for (const key of ["min", "max", "size"]) {
        assert.equal(
          values(before[key]).length,
          3,
          "Native bounds must contain all three dimensions.",
        );
        values(before[key]).forEach((value, i) =>
          check(
            "measure.bounds",
            "reparent preserves world " + key + " " + "xyz"[i],
            values(after[key])[i],
            value,
            0.001,
          ),
        );
      }
      const parentState = await cad("component.inspect", {
        component: parent["component"],
      });
      check(
        "component.inspect",
        "destination definition owns the reparented child occurrence",
        values(parentState["occurrences"]).some(
          (ref) => record(ref)["name"] === "ReparentChild",
        ),
        true,
      );
      validated("component.reparent");
      const duplicate = await cad("occurrence.duplicate", {
        occurrence: moved["occurrence"],
        copyMode: "linked",
        placement: { translation: ["50 mm", "0 mm", "0 mm"] },
      });
      check(
        "occurrence.duplicate",
        "linked duplicate preserves component definition token",
        record(duplicate["component"])["token"],
        record(renamed["component"])["token"],
      );
      check(
        "occurrence.duplicate",
        "copy mode is returned explicitly",
        duplicate["copyMode"],
        "linked",
      );
      check(
        "occurrence.duplicate",
        "source and duplicate paths are returned",
        values(duplicate["affectedPaths"]).length,
        2,
      );
      const originalBodyBounds = await cad("measure.bounds", {
        ref: {
          ...record(values(moved["bodies"])[0]),
          occurrence: moved["occurrence"],
        },
        units: "mm",
      });
      const duplicateBodyBounds = await cad("measure.bounds", {
        ref: {
          ...record(values(moved["bodies"])[0]),
          occurrence: duplicate["occurrence"],
        },
        units: "mm",
      });
      check(
        "occurrence.duplicate",
        "duplicate body is placed 50 mm from the source",
        number(values(duplicateBodyBounds["min"])[0]) -
          number(values(originalBodyBounds["min"])[0]),
        50,
        0.001,
      );
      validated("occurrence.duplicate");
      const parts = await cad("assembly.parts", {});
      const partRows = values(parts["parts"]).map(record);
      const bodyPart = partRows.find(
        (row) => record(row["component"])["name"] === renamedName,
      );
      const parentPart = partRows.find(
        (row) => record(row["component"])["name"] === "ReparentTarget",
      );
      const childPart = partRows.find(
        (row) => record(row["component"])["name"] === "ReparentChild",
      );
      assert.ok(
        bodyPart && parentPart && childPart,
        "assembly.parts is missing one of the fixture component definitions.",
      );
      check(
        "assembly.parts",
        "renamed component has two linked occurrences",
        bodyPart["quantity"],
        2,
      );
      check(
        "assembly.parts",
        "renamed component carries the moved BRep body",
        bodyPart["bodyCount"],
        1,
      );
      check(
        "assembly.parts",
        "parent assembly has one root occurrence",
        parentPart["quantity"],
        1,
      );
      check(
        "assembly.parts",
        "reparented child remains one occurrence",
        childPart["quantity"],
        1,
      );
      check(
        "assembly.parts",
        "reparented child reports its native BRep body",
        childPart["bodyCount"],
        1,
      );
      check(
        "assembly.parts",
        "assembly parts scope is explicit",
        text(parts["scope"]).includes("subassemblies"),
        true,
      );
      validated("assembly.parts");
      const rigid = await cad("assembly.rigid_group", {
        name: "RigidFixtureGroup",
        occurrences: [moved["occurrence"], parent["occurrence"]],
        includeChildren: false,
      });
      const rigidGroup =
        rigid["rigidGroup"] == null ? undefined : record(rigid["rigidGroup"]);
      check(
        "assembly.rigid_group",
        "native rigid group reference is returned",
        typeof rigidGroup?.["token"] === "string" &&
          rigidGroup["token"].length > 0,
        true,
      );
      check(
        "assembly.rigid_group",
        "native rigid group preserves the requested name",
        record(rigid["rigidGroup"])["name"],
        "RigidFixtureGroup",
      );
      validated("assembly.rigid_group");
      const alignTarget = await cad("component.create", {
        name: "AlignTarget",
      });
      const alignSource = await cad("component.create", {
        name: "AlignSource",
        placement: { translation: ["30 mm", "0 mm", "0 mm"] },
      });
      const alignBody = values(
        (
          await cad(
            "shape.box",
            { name: "AlignBody", width: "4 mm", depth: "5 mm", height: "6 mm" },
            "AlignSource",
          )
        )["bodies"],
      )[0];
      const sourceUnground = await cad("assembly.unground", {
        occurrence: alignSource["occurrence"],
      });
      check(
        "assembly.unground",
        "alignment source occurrence is ungrounded",
        sourceUnground["grounded"],
        false,
      );
      const beforeAlign = await cad("measure.bounds", {
        ref: { ...record(alignBody), occurrence: alignSource["occurrence"] },
        units: "mm",
      });
      const aligned = await cad("occurrence.align", {
        occurrence: alignSource["occurrence"],
        target: alignTarget["occurrence"],
      });
      check(
        "occurrence.align",
        "native root alignment residual is within tolerance",
        number(aligned["residual"]) <= 1e-8,
        true,
      );
      check(
        "occurrence.align",
        "aligned origin matches target root transform",
        values(aligned["actual"])[3],
        0,
        1e-8,
      );
      const afterAlign = await cad("measure.bounds", {
        ref: { ...record(alignBody), occurrence: aligned["occurrence"] },
        units: "mm",
      });
      check(
        "occurrence.align",
        "aligned body moves from 30 mm offset to target origin",
        values(afterAlign["min"])[0],
        0,
        0.001,
      );
      check(
        "occurrence.align",
        "alignment preserves body dimensions",
        values(afterAlign["size"]).join(","),
        values(beforeAlign["size"]).join(","),
      );
      validated("occurrence.align");
      validated("component.create", true);
      validated("shape.box", true);
      validated("assembly.unground", true);
      validated("measure.bounds", true);
      validated("component.inspect");
      await guard();
      persist();
    },
  }));
}

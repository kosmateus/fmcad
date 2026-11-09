import assert from "node:assert/strict";
import type { Scenario } from "./runner";
import { record, text, type FixtureFolder, type Document } from "./contracts";
import { cadCommand } from "./cad-programs";
import { emit, guard, program } from "./programs";

export function styleAssignmentReadback(document: Document): string {
  return program(`${guard(document)}
${emit("dict(creationId=doc.creationId, bodies=[dict(token=body.entityToken, appearance=body.appearance.id if body.appearance else None, material=body.material.id if body.material else None, volume=body.volume) for body in design.rootComponent.bRepBodies])")}`);
}

export function styleAssignmentScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "body-style-assignment-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "saved-reopen",
      "saved-revisions",
      "dimensioned-rectangle",
      "material-metadata",
      "appearance-metadata",
      "body-style-assignment",
    ],
    async run(session) {
      let step = 0;
      const call = async (operation: string, data: Record<string, unknown>) => {
        const output = await session.execute(
          "style-" + step++ + "-" + operation,
          cadCommand(session.document, operation, data),
          session.document,
          "cad-v1",
        );
        assert.equal(output["error"], null, String(output["error"]));
        const result = record(output["result"]);
        assert.ok(Object.keys(result).length > 0);
        return result;
      };
      const copy = async (kind: "appearance" | "material") => {
        const local = await call(kind + ".list", {});
        assert.ok(Array.isArray(local["items"]));
        assert.ok(Array.isArray(local["libraries"]));
        const existing = local["items"].map(record);
        for (const raw of local["libraries"]) {
          const library = record(raw);
          if (!library["id"]) continue;
          const listed = await call(kind + ".list", { library: library["id"] });
          assert.ok(Array.isArray(listed["items"]));
          const source = listed["items"]
            .map(record)
            .find(
              (item) =>
                typeof item["id"] === "string" &&
                item["id"] &&
                !existing.some(
                  (old) =>
                    old["id"] === item["id"] ||
                    (kind === "material" && old["name"] === item["name"]),
                ),
            );
          if (!source) continue;
          const name =
            "FMCAD_Style_" +
            session.report.owner.runId +
            "_" +
            index +
            "_" +
            kind;
          const created = await call(kind + ".create", {
            id: source["id"],
            library: library["id"],
            name,
          });
          const id = text(created["id"]);
          assert.equal(created["copiedFrom"], source["id"]);
          const editedName = name + "_Edited";
          const edited = await call(kind + ".edit", { id, name: editedName });
          assert.equal(record(edited["after"])["id"], id);
          assert.equal(record(edited["after"])["name"], editedName);
          return { id, name: editedName };
        }
        throw new Error(
          "No safe loaded library source for " +
            kind +
            "; no assignment attempted",
        );
      };
      const material = await copy("material");
      const appearance = await copy("appearance");
      const box = await call("shape.box", {
        name: "StyleAppearanceFixture",
        width: "4 mm",
        depth: "5 mm",
        height: "6 mm",
      });
      assert.ok(Array.isArray(box["bodies"]));
      assert.equal(box["bodies"].length, 1);
      const body = box["bodies"][0];
      const assigned = await call("appearance.assign", {
        refs: [body],
        id: appearance.id,
      });
      assert.equal(assigned["count"], 1);
      assert.equal(assigned["id"], appearance.id);
      const assignmentMap = await call("appearance.assign-map", {
        refs: [body],
      });
      assert.equal(assignmentMap["count"], 1);
      assert.equal(assignmentMap["mismatchCount"], 0);
      assert.ok(Array.isArray(assignmentMap["assignments"]));
      assert.equal(
        record(record(assignmentMap["assignments"][0])["assigned"])["id"],
        appearance.id,
      );
      const assignedMaterial = await call("material.assign", {
        refs: [body],
        id: material.id,
      });
      assert.equal(assignedMaterial["count"], 1);
      assert.equal(assignedMaterial["id"], material.id);
      const materialMap = await call("material.assign-map", { refs: [body] });
      assert.equal(materialMap["count"], 1);
      assert.equal(materialMap["mismatchCount"], 0);
      assert.ok(Array.isArray(materialMap["assignments"]));
      assert.equal(
        record(record(materialMap["assignments"][0])["assigned"])["id"],
        material.id,
      );
      const local = await call("appearance.list", {});
      assert.ok(Array.isArray(local["items"]));
      const found = local["items"]
        .map(record)
        .find((item) => item["id"] === appearance.id);
      assert.ok(found);
      assert.equal(found["name"], appearance.name);
      const before = await session.execute(
        "style-independent",
        styleAssignmentReadback(session.document),
      );
      assert.ok(Array.isArray(before["bodies"]));
      assert.equal(before["bodies"].length, 1);
      const observed = record(before["bodies"][0]);
      assert.equal(observed["appearance"], appearance.id);
      assert.equal(observed["material"], material.id);
      assert.ok(Math.abs(Number(observed["volume"]) - 0.12) < 1e-9);
      await session.saveRevision();
      await session.reopen();
      const reopened = await session.execute(
        "style-reopened",
        styleAssignmentReadback(session.document),
      );
      assert.deepEqual(reopened["bodies"], before["bodies"]);
    },
  }));
}

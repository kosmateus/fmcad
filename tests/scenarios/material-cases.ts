import assert from "node:assert/strict";
import type { Scenario } from "./runner";
import { record, text, type FixtureFolder, type Document } from "./contracts";
import { cadCommand } from "./cad-programs";
import { emit, guard, program } from "./programs";

function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
export function materialReadback(document: Document): string {
  return program(`${guard(document)}
${emit("dict(creationId=doc.creationId, materials=[dict(id=item.id, name=item.name, description=item.description) for item in design.materials])")}`);
}
export function materialScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "material-metadata-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "saved-reopen",
      "saved-revisions",
      "material-metadata",
    ],
    async run(session) {
      let step = 0;
      const call = async (
        operation: string,
        data: Record<string, unknown>,
        rejection?: RegExp,
      ) => {
        const output = await session.execute(
          "material-" + step++ + "-" + operation,
          cadCommand(session.document, operation, data),
          session.document,
          "cad-v1",
        );
        if (rejection) {
          assert.match(String(output["error"]), rejection);
          return {};
        }
        assert.equal(output["error"], null, String(output["error"]));
        const result = record(output["result"]);
        assert.ok(Object.keys(result).length > 0);
        return result;
      };
      const local = await call("material.list", {});
      const original = rows(local["items"]),
        libraries = rows(local["libraries"]);
      let source: { id: string; library: string } | undefined;
      for (const library of libraries) {
        if (!library["id"]) continue;
        const items = rows(
          (await call("material.list", { library: library["id"] }))["items"],
        );
        const item = items.find(
          (item) =>
            typeof item["id"] === "string" &&
            item["id"] &&
            !original.some(
              (old) => old["id"] === item["id"] || old["name"] === item["name"],
            ),
        );
        if (item) {
          source = { id: text(item["id"]), library: text(library["id"]) };
          break;
        }
      }
      assert.ok(
        source,
        "No loaded library has a safe physical material to copy; no edit attempted",
      );
      const name = "FMCAD_Material_" + session.report.owner.runId + "_" + index;
      const copy = await call("material.create", { ...source, name });
      const localId = text(copy["id"] || record(copy["created"])["id"]);
      assert.equal(copy["id"], localId);
      assert.equal(copy["copiedFrom"], source.id);
      const editedName = name + "_Edited";
      const edited = await call("material.edit", {
        id: localId,
        name: editedName,
      });
      assert.equal(record(edited["after"])["id"], localId);
      assert.equal(record(edited["after"])["name"], editedName);
      assert.equal(edited["changed"], true);
      assert.ok(
        Array.isArray(edited["changedFields"]) &&
          edited["changedFields"].includes("name"),
      );
      const collisionName = name + "_Collision";
      const second = await call("material.create", {
        ...source,
        name: collisionName,
      });
      const secondId = text(second["id"] || record(second["created"])["id"]);
      assert.equal(second["id"], secondId);
      await call(
        "material.edit",
        { id: localId, name: collisionName },
        /material name already exists in the Design/iu,
      );
      const listed = rows((await call("material.list", {}))["items"]);
      const readback = listed.find((item) => item["id"] === localId),
        secondReadback = listed.find((item) => item["id"] === secondId);
      assert.ok(readback && secondReadback);
      assert.equal(readback["name"], editedName);
      assert.equal(secondReadback["name"], collisionName);
      const beforeSave = await session.execute(
        "materials-independent",
        materialReadback(session.document),
      );
      const independent = rows(beforeSave["materials"]);
      assert.equal(independent.length, original.length + 2);
      assert.equal(
        independent.find((item) => item["id"] === localId)?.["name"],
        editedName,
      );
      assert.equal(
        independent.find((item) => item["id"] === secondId)?.["name"],
        collisionName,
      );
      await session.saveRevision();
      await session.reopen();
      const reopened = await session.execute(
        "materials-reopened",
        materialReadback(session.document),
      );
      assert.deepEqual(reopened["materials"], beforeSave["materials"]);
    },
  }));
}

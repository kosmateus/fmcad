import assert from "node:assert/strict";
import type { Scenario } from "./runner";
import { record, text, type FixtureFolder, type Document } from "./contracts";
import { cadCommand } from "./cad-programs";
import { emit, guard, program } from "./programs";

function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
export function appearanceReadback(document: Document): string {
  return program(`${guard(document)}
${emit("dict(creationId=doc.creationId, appearances=[dict(id=item.id, name=item.name) for item in design.appearances])")}`);
}
export function appearanceScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "appearance-metadata-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "saved-reopen",
      "saved-revisions",
      "appearance-metadata",
    ],
    async run(session) {
      let step = 0;
      const call = async (operation: string, data: Record<string, unknown>) => {
        const output = await session.execute(
          "appearance-" + step++ + "-" + operation,
          cadCommand(session.document, operation, data),
          session.document,
          "cad-v1",
        );
        assert.equal(output["error"], null, String(output["error"]));
        const result = record(output["result"]);
        assert.ok(Object.keys(result).length > 0);
        return result;
      };
      const local = await call("appearance.list", {});
      const original = rows(local["items"]),
        libraries = rows(local["libraries"]);
      let source: { id: string; library: string } | undefined;
      for (const library of libraries) {
        if (!library["id"]) continue;
        const items = rows(
          (await call("appearance.list", { library: library["id"] }))["items"],
        );
        const item = items.find(
          (item) =>
            typeof item["id"] === "string" &&
            item["id"] &&
            !original.some((old) => old["id"] === item["id"]),
        );
        if (item) {
          source = { id: text(item["id"]), library: text(library["id"]) };
          break;
        }
      }
      assert.ok(
        source,
        "No loaded library has a safe appearance to copy; no edit attempted",
      );
      const name =
        "FMCAD_Appearance_" + session.report.owner.runId + "_" + index;
      const copy = await call("appearance.create", { ...source, name });
      const localId = text(copy["id"]);
      assert.equal(copy["id"], localId);
      assert.equal(copy["copiedFrom"], source.id);
      const editedName = name + "_Edited";
      const edited = await call("appearance.edit", {
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
      const projection = await call("appearance.projection", { id: localId });
      assert.equal(projection["id"], localId);
      assert.equal(projection["changed"], false);
      assert.ok(
        projection["projection"] === null ||
          ["string", "number", "object"].includes(
            typeof projection["projection"],
          ),
      );
      const beforeSave = await session.execute(
        "appearances-independent",
        appearanceReadback(session.document),
      );
      const independent = rows(beforeSave["appearances"]);
      assert.equal(independent.length, original.length + 1);
      assert.equal(
        independent.find((item) => item["id"] === localId)?.["name"],
        editedName,
      );
      await session.saveRevision();
      await session.reopen();
      const reopened = await session.execute(
        "appearances-reopened",
        appearanceReadback(session.document),
      );
      assert.deepEqual(reopened["appearances"], beforeSave["appearances"]);
    },
  }));
}

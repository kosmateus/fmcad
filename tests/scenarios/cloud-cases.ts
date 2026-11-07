import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import type { Scenario } from "./runner";
import { record, text, type Document, type FixtureFolder } from "./contracts";
import { emit, guard, program } from "./programs";

const root = path.resolve(__dirname, "../../..");
const { buildOpScript } = createRequire(path.join(root, "package.json"))(
  "./src/ops",
) as typeof import("../../packages/node-adapters/src/python/legacy-operations");

export function cloudCommand(document: Document, operation: string): string {
  const source = buildOpScript(operation, []).replace(
    "def run(_context: str) -> None:",
    "def _legacy_run(_context: str) -> None:",
  );
  return (
    source +
    "\n" +
    program(`${guard(document)}
import contextlib, io
file = doc.dataFile
assert file is not None
folder = file.parentFolder
project = file.parentProject
assert folder is not None
parts: list[str] = []
current = cast("adsk.core.DataFolder | None", folder)
while current is not None and current.id != project.rootFolder.id:
    assert len(parts) < 256, 'Folder hierarchy exceeds 256 levels'
    parts.append(current.name)
    current = cast("adsk.core.DataFolder | None", current.parentFolder)
assert current is not None, 'Fixture folder is outside the selected project'
folder_path = '/'.join(reversed(parts))
args: list[str] = ${operation === "file_editability_list" ? "[project.id]" : ["folder_list", "tree"].includes(operation) ? "[project.name, folder_path]" : "[]"}
output = io.StringIO()
with contextlib.redirect_stdout(output):
    dispatch_cloud(${JSON.stringify(operation)}, args)
assert doc.dataFile is not None and doc.dataFile.id == file.id
${emit("dict(creationId=doc.creationId, output=output.getvalue(), fileId=file.id, fileName=file.name, projectId=project.id, folderId=folder.id)")}`)
  );
}

export function cloudScenarios(folder: FixtureFolder): Scenario[] {
  return [
    {
      id: "cloud-inventory",
      fixture: folder,
      requires: [
        "documents",
        "saved-fixtures",
        "fixture-export",
        "cloud-inventory",
      ],
      async run(session) {
        for (const operation of [
          "projects",
          "folder_list",
          "tree",
          "file_editability_list",
        ]) {
          const result = await session.execute(
            operation,
            cloudCommand(session.document, operation),
          );
          const output = text(result["output"]);
          assert.doesNotMatch(output, /^ERROR /m);
          assert.match(output, /DONE\n$/);
          assert.equal(result["fileId"], session.document.file?.fileId);
          assert.equal(result["projectId"], folder.projectId);
          assert.equal(result["folderId"], folder.folderId);
          if (operation === "file_editability_list") {
            const line = output
              .split("\n")
              .find((s) => s.startsWith("FILE_EDITABILITY_LIST "));
            assert.ok(line);
            const inventory = record(
              JSON.parse(line.slice("FILE_EDITABILITY_LIST ".length)),
            );
            assert.equal(inventory["complete"], true);
            assert.deepEqual(inventory["errors"], []);
            assert.ok(Array.isArray(inventory["files"]));
            const matches = inventory["files"]
              .map(record)
              .filter((f) => f["id"] === result["fileId"]);
            assert.equal(matches.length, 1);
            assert.equal(matches[0]?.["name"], result["fileName"]);
            assert.equal(matches[0]?.["projectId"], folder.projectId);
            assert.equal(matches[0]?.["folderId"], folder.folderId);
            assert.equal(matches[0]?.["isReadOnly"], false);
          } else {
            const identity =
              operation === "projects"
                ? folder.projectId
                : text(result["fileId"]);
            assert.ok(output.includes(" id=" + identity));
          }
        }
      },
    },
  ];
}

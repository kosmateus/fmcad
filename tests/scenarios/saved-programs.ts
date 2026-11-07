import type { Document, FixtureFolder, Owner } from "./contracts";
import { emit, program, select } from "./programs";

const q = (value: string): string => JSON.stringify(value);

/** Resolve the configured folder inside the exact project, never by display name. */
function folderSource(folder: FixtureFolder): string {
  return `project = cast('adsk.core.DataProject | None', app.data.dataProjects.itemById(${q(folder.projectId)}))
assert project is not None and project.id == ${q(folder.projectId)}, 'Fixture project unavailable'
pending = [project.rootFolder]
folder_matches: list[adsk.core.DataFolder] = []
visited: set[str] = set()
while pending:
    candidate = pending.pop()
    assert candidate.id not in visited, 'Repeated folder identity'
    visited.add(candidate.id)
    if candidate.id == ${q(folder.folderId)}:
        folder_matches.append(candidate)
    pending.extend(candidate.dataFolders)
assert len(folder_matches) == 1, 'Exact fixture folder unavailable'
folder = folder_matches[0]
assert folder.parentProject.id == project.id`;
}

export function save(
  document: Document,
  folder: FixtureFolder,
  owner: Owner,
  requestId: string,
  receipt: string,
): string {
  return program(`${select(document)}
assert not doc.isSaved, 'Fixture save must be submitted only once'
${folderSource(folder)}
identity: dict[str, object] = dict(creationId=doc.creationId, name=doc.name, projectId=project.id, folderId=folder.id, clientId=${q(owner.clientId)}, requestId=${q(requestId)})
with open(${q(receipt)}, 'x', encoding='utf-8') as stream:
    _ = stream.write(json.dumps(identity))
assert doc.saveAs(doc.name, folder, 'fmcad isolated scenario', ''), 'Save was not accepted'
${emit("dict(identity, accepted=True)")}`);
}

export function observeSave(document: Document, folder: FixtureFolder): string {
  return program(`${select(document)}
${folderSource(folder)}
file = cast('adsk.core.DataFile | None', doc.dataFile)
if file is None:
    ${emit("dict(creationId=doc.creationId, saved=doc.isSaved, complete=False)")}
else:
    assert doc.isSaved and file.name == doc.name
    assert file.parentProject.id == project.id and file.parentFolder.id == folder.id, 'Foreign saved fixture'
    assert file.versionNumber > 0
    ${emit("dict(creationId=doc.creationId, saved=True, complete=file.isComplete, fileId=file.id, version=file.versionNumber, projectId=project.id, folderId=folder.id)")}`);
}

export function fileOperation(document: Document, remove: boolean): string {
  if (!document.file) throw new Error("Missing owned file identity");
  const file = document.file;
  return program(`import adsk.core, json
from typing import cast
app = adsk.core.Application.get()
${folderSource(file)}
matches = [f for f in folder.dataFiles if f.id == ${q(file.fileId)}]
assert len(matches) <= 1, 'Ambiguous file identity'
assert not any(d.dataFile is not None and d.dataFile.id == ${q(file.fileId)} for d in app.documents), 'Owned file is still open'
if matches:
    file = matches[0]
    assert file.parentProject.id == ${q(file.projectId)} and file.parentFolder.id == ${q(file.folderId)}
    assert file.name == ${q(document.name)} and file.versionNumber == ${file.version} and file.latestVersionNumber == ${file.version}, 'Saved fixture version changed'
    ${remove ? "assert file.isComplete and not file.isReadOnly\n    assert file.deleteMe(), 'Deletion was refused'" : "pass"}
${emit(`dict(creationId=${q(document.creationId)}, fileId=${q(file.fileId)}, version=${file.version}, projectId=${q(file.projectId)}, folderId=${q(file.folderId)}, absent=not matches, accepted=${remove ? "True" : "False"})`)}`);
}

export function inventory(folder: FixtureFolder): string {
  return program(`import adsk.core, json
from typing import cast
app = adsk.core.Application.get()
${folderSource(folder)}
${emit("dict(projectId=project.id, folderId=folder.id, files=[dict(fileId=f.id, name=f.name, version=f.versionNumber, complete=f.isComplete) for f in folder.dataFiles])")}`);
}

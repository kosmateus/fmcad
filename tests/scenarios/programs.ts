import { createRequire } from "node:module";
import path from "node:path";
import type { Document } from "./contracts";

const root = path.resolve(__dirname, "../../..");
const { pythonLiteral } = createRequire(path.join(root, "package.json"))(
  "./src/python",
) as typeof import("../../packages/node-adapters/src/python/artifact");

export const marker = "FMCAD_SCENARIO ";
const quoted = (value: string): string => JSON.stringify(value);
export function program(body: string, modulePrelude = ""): string {
  return (
    // The public run command requires this slot when --doc is supplied.
    // Identity remains pinned separately by --doc-id and the in-script guard.
    "DOC_NAME = None\n" +
    (modulePrelude ? modulePrelude + "\n" : "") +
    "def run(context: str) -> None:\n" +
    body
      .split("\n")
      .map((line) => "    " + line)
      .join("\n") +
    "\n"
  );
}
export function emit(expression: string): string {
  return `print(${quoted(marker)} + json.dumps(${expression}))`;
}
export function select(document: Document): string {
  return `import adsk.core, adsk.fusion, json
from typing import cast
app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${quoted(document.creationId)}]
assert len(matches) == 1, 'Owned creationId is unavailable'
doc = matches[0]
assert doc.name == ${quoted(document.name)}, 'Owned document identity changed'
assert sum(d.name == ${quoted(document.name)} for d in app.documents) == 1, 'Ambiguous owned name'
assert doc.activate()
assert app.activeDocument is not None and app.activeDocument.creationId == doc.creationId`;
}
export function savedGuard(document: Document): string {
  return document.file
    ? `assert doc.isSaved
file = cast('adsk.core.DataFile | None', doc.dataFile)
assert file is not None
assert file.id == ${quoted(document.file.fileId)} and file.versionNumber == ${document.file.version}
assert file.parentProject.id == ${quoted(document.file.projectId)} and file.parentFolder.id == ${quoted(document.file.folderId)}`
    : "assert not doc.isSaved, 'Owned document unexpectedly became saved'\nassert doc.dataFile is None, 'Unsaved owned document unexpectedly has a cloud file'";
}
export function guard(document: Document): string {
  return `${select(document)}
${savedGuard(document)}
design = cast(adsk.fusion.Design, doc.products.itemByProductType('DesignProductType'))
assert design is not None`;
}
export function create(
  name: string,
  receipt: string,
  binding: { requestId: string; clientId: string },
): string {
  return program(`import adsk.core, json
from typing import cast
app = adsk.core.Application.get()
assert not any(d.name == ${quoted(name)} for d in app.documents)
assert app.userInterface.activeCommand in (None, '', 'SelectCommand'), 'Fusion interactive command must be idle before creating a fixture'
doc = app.documents.add(cast(adsk.core.DocumentTypes, adsk.core.DocumentTypes.FusionDesignDocumentType))
doc.name = ${quoted(name)}
identity: dict[str, object] = dict(creationId=doc.creationId, name=doc.name, activeCreationId=app.activeDocument.creationId if app.activeDocument else None, requestId=${quoted(binding.requestId)}, clientId=${quoted(binding.clientId)})
with open(${quoted(receipt)}, 'x', encoding='utf-8') as stream:
    _ = stream.write(json.dumps(identity))
${emit("identity")}`);
}
export function exportFile(document: Document, filename: string): string {
  return program(`${guard(document)}
options = design.exportManager.createFusionArchiveExportOptions(${quoted(filename)})
assert design.exportManager.execute(options)
assert not doc.isSaved, 'Export must not change the unsaved fixture precondition'
${emit("dict(creationId=doc.creationId, exported=True)")}`);
}
export function parameter(document: Document, valueMm?: number): string {
  return program(`${guard(document)}
${
  valueMm === undefined
    ? "p = design.userParameters.itemByName('OwnedCounter')"
    : `assert design.userParameters.count == 0
p = design.userParameters.add('OwnedCounter', adsk.core.ValueInput.createByString('${valueMm} mm'), 'mm', 'scenario ownership')`
}
assert p is not None
${emit("dict(creationId=doc.creationId, count=design.userParameters.count, value=p.value, expression=p.expression)")}`);
}
export function inspect(document: Document): string {
  return program(`${guard(document)}
${emit("dict(creationId=doc.creationId, count=design.userParameters.count, saved=doc.isSaved)")}`);
}
export function close(document: Document): string {
  return program(
    `import adsk.core, json
from collections.abc import Sequence
from typing import cast
app = adsk.core.Application.get()
def _fmcad_close_inventory() -> list[_FmcadCloseInventoryDocument]:
    rows: list[_FmcadCloseInventoryDocument] = []
    for d in app.documents:
        rows.append({
            'creationId': d.creationId,
            'name': d.name,
            'fileId': d.dataFile.id if d.dataFile else None,
            'saved': d.isSaved,
            'modified': d.isModified,
            'active': d == app.activeDocument,
        })
    return rows
def _fmcad_close_stable(rows: Sequence[_FmcadCloseInventoryDocument]) -> list[tuple[str, str, str | None, bool, bool]]:
    return sorted((row['creationId'], row['name'], row['fileId'], row['saved'], row['modified']) for row in rows)
_fmcad_before = _fmcad_close_inventory()
matches = [d for d in app.documents if d.creationId == ${quoted(document.creationId)}]
assert len(matches) == 1, 'Owned fixture identity is missing or duplicated'
doc = matches[0]
assert doc.name == ${quoted(document.name)}
assert app.userInterface.activeCommand in (None, '', 'SelectCommand'), 'Fusion interactive command must be idle before closing a fixture'
${savedGuard(document)}
assert doc.close(False)
_fmcad_after = _fmcad_close_inventory()
assert not any(d.creationId == ${quoted(document.creationId)} for d in app.documents)
assert _fmcad_close_stable([d for d in _fmcad_before if d['creationId'] != ${quoted(document.creationId)}]) == _fmcad_close_stable(_fmcad_after), 'A non-target document changed during owned cleanup'
${emit(`dict(creationId=${quoted(document.creationId)}, closed=True, inventoryFence=dict(version=1, before=_fmcad_before, after=_fmcad_after))`)}`,
    `from typing import TypedDict
class _FmcadCloseInventoryDocument(TypedDict):
    creationId: str
    name: str
    fileId: str | None
    saved: bool
    modified: bool
    active: bool`,
  );
}
export function snapshot(): string {
  return program(`import adsk.core, json
app = adsk.core.Application.get()
${emit("dict(active=app.activeDocument.creationId if app.activeDocument else None, documents=[dict(creationId=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified,fileId=d.dataFile.id if d.dataFile else None) for d in app.documents])")}`);
}
/** Original unsaved fixture guard; deliberately observes before any activation. */
export function unsavedState(document: Document): string {
  if (document.file)
    throw new Error("Unsaved observation received a saved fixture");
  return program(`import adsk.core, json
app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${quoted(document.creationId)}]
assert len(matches) == 1, 'Owned creationId is unavailable'
doc = matches[0]
assert doc.name == ${quoted(document.name)}, 'Owned document identity changed'
assert sum(d.name == ${quoted(document.name)} for d in app.documents) == 1, 'Ambiguous owned name'
assert not doc.isSaved and doc.dataFile is None, 'Owned fixture unexpectedly became saved'
${emit("dict(creationId=doc.creationId, active=app.activeDocument.creationId, documents=[dict(creationId=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified,fileId=d.dataFile.id if d.dataFile else None) for d in app.documents])")}`);
}
/** Run one canonical helper operation between same-turn foreign inventory snapshots. */
export function cadFence(
  document: Document,
  operation: string,
  data: Record<string, unknown>,
  baseline: readonly Record<string, unknown>[],
  peers: readonly Document[],
  closedPeerCreationIds: readonly string[],
  component = "root",
): string {
  if (document.file)
    throw new Error("CAD inventory fence received a saved fixture");
  const expected = pythonLiteral(
      baseline.map((row) => ({
        creationId: row["creationId"],
        name: row["name"],
        fileId: row["fileId"] ?? null,
        saved: row["saved"],
        modified: row["modified"],
      })),
    ),
    peerIdentities = pythonLiteral(
      peers.map(({ creationId, name }) => ({ creationId, name })),
    ),
    closedPeers = pythonLiteral([...closedPeerCreationIds]),
    scope = component === "root" ? "None" : pythonLiteral(component);
  return program(
    `import adsk.core, json
from collections.abc import Sequence
from typing import TypedDict

class _FmcadStableDocument(TypedDict):
    creationId: str
    name: str
    fileId: str | None
    saved: bool
    modified: bool

class _FmcadInventoryDocument(_FmcadStableDocument):
    active: bool

class _FmcadPeerIdentity(TypedDict):
    creationId: str
    name: str

app = adsk.core.Application.get()
_fmcad_expected_baseline: list[_FmcadStableDocument] = ${expected}
_fmcad_expected_peers: list[_FmcadPeerIdentity] = ${peerIdentities}
_fmcad_closed_peers: list[str] = ${closedPeers}
def _fmcad_inventory() -> list[_FmcadInventoryDocument]:
    rows: list[_FmcadInventoryDocument] = []
    for d in app.documents:
        rows.append({
            'creationId': d.creationId,
            'name': d.name,
            'fileId': d.dataFile.id if d.dataFile else None,
            'saved': d.isSaved,
            'modified': d.isModified,
            'active': d == app.activeDocument,
        })
    return rows
def _fmcad_stable(rows: Sequence[_FmcadStableDocument]) -> list[tuple[str, str, str | None, bool, bool]]:
    return sorted((d['creationId'], d['name'], d['fileId'], d['saved'], d['modified']) for d in rows)
def _fmcad_check_inventory(rows: Sequence[_FmcadInventoryDocument]) -> None:
    ids: list[str] = [d['creationId'] for d in rows]
    assert len(set(ids)) == len(ids), 'Duplicate document identity in fenced inventory'
    for expected in _fmcad_expected_baseline:
        matches = [d for d in rows if d['creationId'] == expected['creationId']]
        assert len(matches) == 1, 'Coordinator baseline document is missing or duplicated'
        assert _fmcad_stable(matches) == _fmcad_stable([expected]), 'Coordinator baseline identity or file provenance changed'
    for expected in _fmcad_expected_peers:
        matches = [d for d in rows if d['creationId'] == expected['creationId']]
        assert len(matches) == 1, 'Receipt-proven open peer is missing or duplicated'
        peer = matches[0]
        assert peer['name'] == expected['name'] and not peer['saved'] and peer['fileId'] is None, 'Receipt-proven peer identity or file provenance changed'
    for creation_id in _fmcad_closed_peers:
        assert not any(d['creationId'] == creation_id for d in rows), 'A receipt-closed peer fixture remains open'
    allowed = {d['creationId'] for d in _fmcad_expected_baseline}
    allowed.update(d['creationId'] for d in _fmcad_expected_peers)
    allowed.add(${quoted(document.creationId)})
    assert all(identity in allowed for identity in ids), 'Unproven non-baseline document in fenced inventory'
def _fmcad_json_inventory(rows: Sequence[_FmcadInventoryDocument]) -> list[_FmcadJsonValue]:
    encoded: list[_FmcadJsonValue] = []
    for row in rows:
        encoded_row: dict[str, _FmcadJsonValue] = {
            'creationId': row['creationId'],
            'name': row['name'],
            'fileId': row['fileId'],
            'saved': row['saved'],
            'modified': row['modified'],
            'active': row['active'],
        }
        encoded.append(encoded_row)
    return encoded
_fmcad_before = _fmcad_inventory()
_fmcad_check_inventory(_fmcad_before)
_fmcad_targets = [d for d in _fmcad_before if d['creationId'] == ${quoted(document.creationId)}]
assert len(_fmcad_targets) == 1, 'Owned fixture identity is missing or duplicated'
assert _fmcad_targets[0]['name'] == ${quoted(document.name)}, 'Owned fixture name changed'
_fmcad_native_targets = [d for d in app.documents if d.creationId == ${quoted(document.creationId)}]
assert len(_fmcad_native_targets) == 1, 'Owned native fixture identity is missing or duplicated'
doc = _fmcad_native_targets[0]
assert doc.name == ${quoted(document.name)}, 'Owned fixture name changed'
assert sum(d.name == ${quoted(document.name)} for d in app.documents) == 1, 'Owned fixture name is ambiguous'
assert not doc.isSaved and doc.dataFile is None, 'Owned fixture unexpectedly became saved'
_fmcad_result = FMCAD.call(${quoted(operation)}, ${pythonLiteral(data)}, ${scope})
_fmcad_after = _fmcad_inventory()
_fmcad_check_inventory(_fmcad_after)
_fmcad_after_targets = [d for d in _fmcad_after if d['creationId'] == ${quoted(document.creationId)}]
assert len(_fmcad_after_targets) == 1, 'Owned fixture identity changed during the SDK turn'
assert _fmcad_after_targets[0]['name'] == ${quoted(document.name)}, 'Owned fixture name changed during the SDK turn'
assert not _fmcad_after_targets[0]['saved'] and _fmcad_after_targets[0]['fileId'] is None, 'Owned fixture was saved during the SDK turn'
_fmcad_other_before = [d for d in _fmcad_before if d['creationId'] != ${quoted(document.creationId)}]
_fmcad_other_after = [d for d in _fmcad_after if d['creationId'] != ${quoted(document.creationId)}]
assert _fmcad_stable(_fmcad_other_before) == _fmcad_stable(_fmcad_other_after), 'A non-target document changed during the SDK turn'
_fmcad_payload: dict[str, _FmcadJsonValue] = {
    'success': True,
    'operation': ${quoted(operation)},
    'document': doc.name,
    'creationId': doc.creationId,
    'result': _fmcad_result,
    'inventoryFence': {
        'version': 1,
        'before': _fmcad_json_inventory(_fmcad_before),
        'after': _fmcad_json_inventory(_fmcad_after),
    },
}
FMCAD.emit(_fmcad_payload)`,
    `from types import NoneType
from typing import TypeAlias
_FmcadJsonValue: TypeAlias = NoneType | bool | int | float | str | list["_FmcadJsonValue"] | dict[str, "_FmcadJsonValue"]`,
  );
}
export function restoreActive(creationId: string): string {
  return program(`import adsk.core, json
app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${quoted(creationId)}]
assert len(matches) == 1, 'Original active document is unavailable'
assert matches[0].activate()
assert app.activeDocument is not None and app.activeDocument.creationId == ${quoted(creationId)}, 'Original active document was not restored'
${emit("dict(active=app.activeDocument.creationId)")}`);
}

import type { Document } from "./contracts";

export const marker = "FMCAD_SCENARIO ";
const quoted = (value: string): string => JSON.stringify(value);
export function program(body: string): string {
  return (
    // The public run command requires this slot when --doc is supplied.
    // Identity remains pinned separately by --doc-id and the in-script guard.
    "DOC_NAME = None\n" +
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
export function guard(document: Document): string {
  return `import adsk.core, adsk.fusion, json
from typing import cast
app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${quoted(document.creationId)}]
assert len(matches) == 1, 'Owned creationId is unavailable'
doc = matches[0]
assert doc.name == ${quoted(document.name)} and not doc.isSaved, 'Owned document identity changed'
assert doc.activate()
assert app.activeDocument is not None and app.activeDocument.creationId == doc.creationId
design = cast(adsk.fusion.Design, doc.products.itemByProductType('DesignProductType'))
assert design is not None`;
}
export function create(name: string, receipt: string): string {
  return program(`import adsk.core, json
from typing import cast
app = adsk.core.Application.get()
assert not any(d.name == ${quoted(name)} for d in app.documents)
doc = app.documents.add(cast(adsk.core.DocumentTypes, adsk.core.DocumentTypes.FusionDesignDocumentType))
doc.name = ${quoted(name)}
identity: dict[str, object] = dict(creationId=doc.creationId, name=doc.name)
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
  return program(`import adsk.core, json
app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${quoted(document.creationId)}]
assert len(matches) <= 1
if matches:
    doc = matches[0]
    assert doc.name == ${quoted(document.name)} and not doc.isSaved
    assert doc.close(False)
assert not any(d.creationId == ${quoted(document.creationId)} for d in app.documents)
${emit(`dict(creationId=${quoted(document.creationId)}, closed=True)`)}`);
}
export function snapshot(): string {
  return program(`import adsk.core, json
app = adsk.core.Application.get()
${emit("dict(active=app.activeDocument.creationId if app.activeDocument else None, documents=[dict(creationId=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified) for d in app.documents])")}`);
}
export function restoreActive(creationId: string): string {
  return program(`import adsk.core, json
app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${quoted(creationId)}]
assert len(matches) == 1, 'Original active document is unavailable'
assert matches[0].activate()
${emit(`dict(active=${quoted(creationId)})`)}`);
}

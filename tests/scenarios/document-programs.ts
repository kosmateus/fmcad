import path from "node:path";
import { createRequire } from "node:module";
import type { Document } from "./contracts";
import { emit, guard, program } from "./programs";

const root = path.resolve(__dirname, "../../..");
const { buildOpScript } = createRequire(path.join(root, "package.json"))(
  "./src/ops",
) as typeof import("../../packages/node-adapters/src/python/legacy-operations");

export function documentCommand(
  document: Document,
  operation: string,
  args: readonly string[] = [],
): string {
  const source = buildOpScript(operation, [...args, document.name]);
  const signature = "def run(_context: str) -> None:";
  if (!source.includes(signature))
    throw new Error("Unexpected document command entrypoint");
  return (
    source.replace(signature, "def _legacy_run(_context: str) -> None:") +
    "\n" +
    program(`${guard(document)}
import contextlib, io
output = io.StringIO()
failure: str | None = None
with contextlib.redirect_stdout(output):
    try:
        _legacy_run("")
    except Exception as error:
        failure = type(error).__name__ + ': ' + str(error)
assert app.activeDocument is not None and app.activeDocument.creationId == doc.creationId
components: list[dict[str, str | None]] = []
def visit(component: adsk.fusion.Component, parent: str | None) -> None:
    components.append(dict(name=component.name, parent=parent))
    for occurrence in component.occurrences:
        visit(occurrence.component, component.name)
visit(design.rootComponent, None)
planes = [dict(name=p.name, origin=p.geometry.origin.asArray(), normal=p.geometry.normal.asArray()) for p in design.rootComponent.constructionPlanes]
${emit("dict(creationId=doc.creationId, output=output.getvalue(), error=failure, planes=planes, components=components, units=design.unitsManager.defaultLengthUnits, marker=design.timeline.markerPosition, timelineCount=design.timeline.count)")}`)
  );
}

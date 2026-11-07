import path from "node:path";
import { createRequire } from "node:module";
import type { Document } from "./contracts";
import { emit, guard, program } from "./programs";

const root = path.resolve(__dirname, "../../..");
const operations = createRequire(path.join(root, "package.json"))(
  "./src/ops",
) as typeof import("../../packages/node-adapters/src/python/legacy-operations");
const { pythonLiteral } = createRequire(path.join(root, "package.json"))(
  "./src/python",
) as typeof import("../../packages/node-adapters/src/python/artifact");

export interface ParameterCommand {
  readonly operation: string;
  readonly args?: readonly string[];
}

/** Execute the shipped handler, then independently read the owned design. */
export function parameterCommand(
  document: Document,
  operation: string,
  args: readonly string[] = [],
): string {
  return parameterBatch(document, [{ operation, args }]);
}

export function parameterBatch(
  document: Document,
  commands: readonly ParameterCommand[],
): string {
  if (!commands.length) throw new Error("Expected parameter commands");
  const steps = commands.map(({ operation, args = [] }) => {
    if (
      ![
        "param_add",
        "param_list",
        "param_set",
        "param_rename",
        "param_delete",
      ].includes(operation)
    )
      throw new Error("Unsupported parameter operation");
    const positional = [...args];
    if (operation === "param_add")
      while (positional.length < 4) positional.push("");
    return { operation, args: [...positional, document.name] };
  });
  const source = operations.buildOpScript("param_list", [document.name]);
  const signature = "def run(_context: str) -> None:";
  if (!source.includes(signature))
    throw new Error("Unexpected parameter entrypoint");
  return (
    source.replace(signature, "def _legacy_run(_context: str) -> None:") +
    "\n" +
    program(`${guard(document)}
import contextlib, io
steps: list[tuple[str, list[str]]] = [${steps.map((step) => `(${pythonLiteral(step.operation)}, ${pythonLiteral(step.args)})`).join(", ")}]
results: list[dict[str, object]] = []
for operation, arguments in steps:
    output = io.StringIO()
    failure: str | None = None
    with contextlib.redirect_stdout(output):
        try:
            dispatch_parameter(operation, arguments)
        except Exception as error:
            failure = type(error).__name__ + ': ' + str(error)
    assert app.activeDocument is not None and app.activeDocument.creationId == doc.creationId
    results.append(dict(output=output.getvalue(), error=failure, parameters=[dict(name=p.name, expression=p.expression, value=p.value, unit=p.unit, comment=p.comment) for p in design.userParameters]))
${emit("dict(creationId=doc.creationId, commands=results)")}`)
  );
}

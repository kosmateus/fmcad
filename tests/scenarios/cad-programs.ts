import path from "node:path";
import { createRequire } from "node:module";
import type { Document } from "./contracts";
import { emit, guard, program } from "./programs";

const root = path.resolve(__dirname, "../../..");
const { pythonLiteral } = createRequire(path.join(root, "package.json"))(
  "./src/python",
) as typeof import("../../packages/node-adapters/src/python/artifact");

/** Execute real handlers through the public cad-v1 facade and retain negative results. */
export function cadCommand(
  document: Document,
  operation: string,
  data: Record<string, unknown>,
): string {
  return program(`${guard(document)}
failure: str | None = None
result: object = None
try:
    result = FMCAD.call(${JSON.stringify(operation)}, ${pythonLiteral(data)})
except Exception as error:
    failure = type(error).__name__ + ': ' + str(error)
${emit("dict(creationId=doc.creationId, error=failure, result=result)")}`);
}

export function cadSequence(
  document: Document,
  calls: readonly {
    operation: string;
    data: Record<string, unknown>;
    rejection?: string;
    /** Epistemic result states of a completed declaration, never SDK settlement. */
    statuses?: readonly string[];
    success?: boolean;
  }[],
): string {
  const steps = calls.map(
    ({ operation, data, rejection, statuses, success }) => {
      const call = `FMCAD.call(${JSON.stringify(operation)}, ${pythonLiteral(data)})`;
      return rejection
        ? `try:\n    _ = ${call}\nexcept ValueError as error:\n    assert str(error).startswith(${JSON.stringify(rejection)})\n    rows.append(dict(error=str(error), result=None))\nelse:\n    raise AssertionError('Expected declaration rejection was accepted')`
        : `value = ${call}\nassert isinstance(value, dict) and value.get('success') is ${success === false ? "False" : "True"} and value.get('status') in ${pythonLiteral(statuses ?? ["pass"])}, 'CAD result is not an expected completed declaration'\nrows.append(dict(error=None, result=value))`;
    },
  );
  return program(`${guard(document)}
rows: list[dict[str, object]] = []
${steps.join("\n")}
${emit("dict(creationId=doc.creationId, rows=rows)")}`);
}

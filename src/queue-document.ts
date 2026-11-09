import { createRequire } from "node:module";
import type { DocumentIntent } from "../packages/core/src/domain/document";
const load = createRequire(__filename);
const { parseFlags } = load(
  "./cli",
) as typeof import("./entrypoints/cli/parser");
const { findCommand } = load("./commands") as {
  findCommand(argv: string[]): { kind: string; target?: string } | undefined;
};
const { selectDocument, compareDocumentState } = load(
  "./dist/core/domain/document",
) as typeof import("../packages/core/src/domain/document");
export { compareDocumentState };
export function documentSelector(job: {
  kind: string;
  request: { argv: string[]; payload?: { method?: string } };
}) {
  if (job.kind === "rpc")
    return selectDocument({
      kind: "rpc",
      rpcMethod: job.request.payload?.method,
    });
  const { rest } = parseFlags(job.request.argv);
  const entry = findCommand(rest);
  const intent: DocumentIntent = {
    kind: entry?.kind || "command",
    target: entry?.target,
  };
  for (const [flag, key] of [
    ["--doc", "name"],
    ["--doc-id", "creationId"],
    ["--doc-file-id", "fileId"],
  ] as const) {
    const index = rest.indexOf(flag);
    if (index >= 0 && rest[index + 1]) intent[key] = rest[index + 1];
  }
  return selectDocument(intent);
}

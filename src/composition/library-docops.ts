import { createRequire } from "node:module";
import type {
  DocumentCommand,
  DocumentCommandPorts,
} from "../../packages/core/src/application/documents/commands";
const load = createRequire(__filename);
const { executeDocumentCommand } = load(
  "../core/application/documents/commands",
) as typeof import("../../packages/core/src/application/documents/commands");
const { documentCommandPorts } = load(
  "../node-adapters/persistence/document-commands",
) as typeof import("../../packages/node-adapters/src/persistence/document-commands");
export const { shotCmd } = load(
  "../../shot",
) as typeof import("./library-shot");
export interface DocumentClient {
  callTool: DocumentCommandPorts["call"];
}
type PathMapper = (value: string) => string;
export function createDocumentService(
  client: DocumentClient,
  toWindowsPath: PathMapper = (value) => value,
) {
  const ports = documentCommandPorts(
    (data, tool) => client.callTool(data, tool),
    toWindowsPath,
  );
  return {
    execute: (command: DocumentCommand) =>
      executeDocumentCommand(command, ports),
  };
}
async function run(
  client: DocumentClient,
  command: DocumentCommand,
  toWindowsPath?: PathMapper,
) {
  const out = await createDocumentService(client, toWindowsPath).execute(
    command,
  );
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  return out.code;
}
export function docSearchCmd(client: DocumentClient, args: string[]) {
  let name: string | null = null,
    project: string | null = null;
  for (let i = 0; i < args.length; i++) {
    // Preserve the retained parser's permissive missing-value behavior. Public
    // CLI validation owns argument arity; this composition does not reinterpret it.
    if (args[i] === "--project") project = args[++i]!;
    else name = args[i]!;
  }
  return run(client, { kind: "search", name, project });
}
export const docListCmd = (client: DocumentClient) =>
  run(client, { kind: "list" });
export const docRecentCmd = (client: DocumentClient) =>
  run(client, { kind: "recent" });
export const docOpenCmd = (client: DocumentClient, args: string[]) =>
  run(client, { kind: "open", name: args[0]! });
export const docSaveCmd = (client: DocumentClient) =>
  run(client, { kind: "save" });
export const docCloseCmd = (client: DocumentClient, args: string[]) =>
  run(client, {
    kind: "close",
    save: args.includes("--save"),
    discard: args.includes("--discard"),
  });
export const undoRedoCmd = (client: DocumentClient, which: "undo" | "redo") =>
  run(client, { kind: which });
export const licensingCmd = (client: DocumentClient) =>
  run(client, { kind: "licensing" });
export const activeCmd = (client: DocumentClient) =>
  run(client, { kind: "active" });
export function docNewCmd(client: DocumentClient, args: string[]) {
  let name = "";
  for (let i = 0; i < args.length; i++)
    if (args[i] === "--name") name = args[++i] || "";
  return run(client, { kind: "new", name });
}
export function fileDownloadCmd(
  client: DocumentClient,
  args: string[],
  toWindowsPath?: PathMapper,
) {
  let output: string | null = null;
  for (let i = 1; i < args.length; i++)
    if (args[i] === "--out") output = args[++i] || "";
  return run(
    client,
    { kind: "download", name: args[0]!, output },
    toWindowsPath,
  );
}

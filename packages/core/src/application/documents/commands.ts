export interface DocumentReply {
  data?: unknown;
  text: string;
  failed?: boolean;
}
export interface DocumentFile {
  name?: unknown;
  id?: unknown;
  [key: string]: unknown;
}
export type DocumentCommand =
  | { kind: "search"; name: string | null; project: string | null }
  | { kind: "list" | "recent" | "save" | "licensing" | "active" }
  | { kind: "open"; name: string | null }
  | { kind: "close"; save: boolean; discard: boolean }
  | { kind: "new"; name: string }
  | { kind: "download"; name: string | null; output: string | null }
  | { kind: "undo" | "redo" };
export interface DocumentCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface DocumentCommandPorts {
  call(data: Record<string, unknown>, tool: string): Promise<DocumentReply>;
  newDocument(name: string): Promise<DocumentReply>;
  download(file: DocumentFile, output: string | null): Promise<DocumentReply>;
}
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function body(out: DocumentReply): Record<string, unknown> | null {
  return object(out.data || parseJson(out.text));
}
function files(out: DocumentReply): DocumentFile[] {
  const results = body(out)?.["results"];
  return Array.isArray(results) ? (results as DocumentFile[]) : [];
}
function printedResults(out: DocumentReply, prefix: string): string {
  return (
    files(out)
      .map((row) => {
        const parts = [
          "name",
          "id",
          "creationId",
          "isActive",
          "isModified",
          "isSaved",
        ]
          .filter((key) => row[key] !== undefined)
          .map((key) => key + "=" + String(row[key]));
        if (row["dataFileError"])
          parts.push("dataFileError=" + JSON.stringify(row["dataFileError"]));
        return prefix + " " + parts.join(" ") + "\n";
      })
      .join("") + "DONE\n"
  );
}
const failure = (stderr: string): DocumentCommandResult => ({
  code: 1,
  stdout: "",
  stderr,
});
const success = (
  out: DocumentReply,
  stdout = out.text + "\n",
): DocumentCommandResult => ({ code: out.failed ? 1 : 0, stdout, stderr: "" });
/** Typed command service, usable by CLI/MCP without argv parsing or a second validator. */
export async function executeDocumentCommand(
  command: DocumentCommand,
  ports: DocumentCommandPorts,
): Promise<DocumentCommandResult> {
  switch (command.kind) {
    case "search": {
      if (!command.name)
        return failure("usage: fmcad doc search <name> [--project <name>]\n");
      const out = await ports.call(
        {
          queryType: "document",
          operation: "search",
          name: command.name,
          ...(command.project ? { project: command.project } : {}),
        },
        "fusion_mcp_read",
      );
      return success(out, printedResults(out, "FILE"));
    }
    case "list":
    case "recent": {
      const out = await ports.call(
        {
          queryType: "document",
          operation: command.kind === "list" ? "open" : "recent",
        },
        "fusion_mcp_read",
      );
      return success(
        out,
        printedResults(out, command.kind === "list" ? "DOC" : "FILE"),
      );
    }
    case "open":
    case "download": {
      const download = command.kind === "download";
      if (!command.name)
        return failure(
          download
            ? "usage: fmcad file_download <name> [--out <wsl_path|dir>]\n"
            : "usage: fmcad doc open <name>\n",
        );
      const out = await ports.call(
        { queryType: "document", operation: "search", name: command.name },
        "fusion_mcp_read",
      );
      if (out.failed)
        return failure(
          "ERROR " +
            (download ? "file" : "document") +
            " search failed: " +
            out.text +
            "\n",
        );
      const first = files(out)[0];
      if (!first)
        return failure("ERROR no document matching: " + command.name + "\n");
      if (command.kind === "download")
        return success(await ports.download(first, command.output));
      const opened = await ports.call(
        {
          featureType: "document",
          object: { operation: "open", fileId: first.id },
        },
        "fusion_mcp_execute",
      );
      return success(
        opened,
        "OPENED name=" + String(first.name) + " id=" + String(first.id) + "\n",
      );
    }
    case "save": {
      const out = await ports.call(
        { featureType: "document", object: { operation: "save" } },
        "fusion_mcp_execute",
      );
      const json = object(parseJson(out.text)),
        value = json?.["message"] || json?.["error"];
      return success(
        out,
        String(value || out.text || "") +
          (!value ? out.text + "\n" : "") +
          "\nDONE\n",
      );
    }
    case "close": {
      if (!command.save && !command.discard)
        return failure("ERROR doc close requires --save or --discard\n");
      return success(
        await ports.call(
          {
            featureType: "document",
            object: {
              operation: "close",
              ...(command.save ? { userConfirmedSaveAndClose: true } : {}),
              ...(command.discard
                ? { userConfirmedCloseWithoutSave: true }
                : {}),
            },
          },
          "fusion_mcp_execute",
        ),
      );
    }
    case "new":
      return success(await ports.newDocument(command.name));
    case "undo":
    case "redo":
      return success(
        await ports.call({ featureType: command.kind }, "fusion_mcp_update"),
      );
    case "licensing": {
      const out = await ports.call(
          { queryType: "licensing" },
          "fusion_mcp_read",
        ),
        json = body(out);
      return success(
        out,
        json?.["summary"]
          ? JSON.stringify(json["summary"], null, 2) + "\n"
          : out.text + "\n",
      );
    }
    case "active": {
      const out = await ports.call(
          { queryType: "activeCommand" },
          "fusion_mcp_read",
        ),
        json = body(out);
      return success(
        out,
        json?.["activeCommand"] === null
          ? "NONE\n"
          : JSON.stringify(json, null, 2) + "\n",
      );
    }
  }
}

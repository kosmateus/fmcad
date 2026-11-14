import path from "node:path";
import { createRequire } from "node:module";
import type { ScriptRequest, Execution, Protocol } from "./contracts";
import type { CadClient } from "../../src/composition/cad-execution";

/** Real Node CAD orchestration; only the physical SDK turn is supplied by the backend. */
export async function componentCommand(
  root: string,
  request: ScriptRequest,
  callTool: CadClient["callTool"],
  protocol: Protocol,
  pathMapper: (file: string) => string,
): Promise<Execution> {
  if (!request.command || !request.target)
    throw new Error("Owned CAD command required");
  if (request.command.spelling) {
    const { findCommand } = createRequire(path.join(root, "package.json"))(
      "./src/commands",
    ) as typeof import("../../src/composition/library-commands");
    if (
      !request.command.spelling.length ||
      request.command.spelling.some(
        (word) => !/^[a-z][a-z0-9-]*$/u.test(word),
      ) ||
      findCommand([...request.command.spelling])?.target !==
        request.command.operation
    )
      throw new Error(
        "CLI alias does not resolve to the expected canonical operation",
      );
  }
  const { executeCad } = createRequire(path.join(root, "package.json"))(
    "./src/cad",
  ) as typeof import("../../src/composition/cad-execution");
  let unsettled = false;
  const client: CadClient = {
    server: { timeoutMs: 180000 },
    capabilities: { backend: protocol },
    async callTool(...args) {
      try {
        return await callTool(...args);
      } catch (error) {
        unsettled = true;
        throw error;
      }
    },
  };
  try {
    const output = await executeCad(
      client,
      request.command.operation,
      structuredClone(request.command.data),
      {
        doc: request.target.name,
        docId: request.target.creationId,
        ...(request.target.file
          ? { docFileId: request.target.file.fileId }
          : {}),
        component: request.command.component ?? "root",
      },
      {
        fusionPath: (value) => {
          if (typeof value !== "string")
            throw new Error("File path must be a string");
          return pathMapper(value);
        },
      },
    );
    return {
      requestId: request.requestId,
      state: unsettled
        ? "unknown"
        : output["success"] === false
          ? "failed"
          : "succeeded",
      sdkSettled: !unsettled,
      mayHaveMutated: true,
      stdout: JSON.stringify(output),
    };
  } catch (error) {
    return {
      requestId: request.requestId,
      state: unsettled ? "unknown" : "failed",
      sdkSettled: !unsettled,
      mayHaveMutated: true,
      stdout: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

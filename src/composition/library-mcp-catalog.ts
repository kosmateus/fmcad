import { description, redactDiagnostic } from "@fmcad/core";
import type {
  CatalogServices,
  CatalogMcpTool,
  OperationContract,
} from "../api/contracts";
import type { JsonRpcRequest, McpResponse } from "./library-mcp-protocol";
import { executeInvocation, invocationFailed } from "./catalog-execution";
import { queueTools } from "./library-mcp-tools";
import { queueMetadata } from "./library-mcp-metadata";
export interface McpCatalogState {
  tools: readonly CatalogMcpTool[];
  contracts: Record<string, OperationContract>;
  fromMcp: CatalogServices["fromMcp"];
  isLocal: CatalogServices["isLocal"];
}
export type CatalogPost = (
  request: JsonRpcRequest,
  session?: string,
  version?: string,
) => Promise<McpResponse>;
export interface CatalogPostOptions {
  queued?: boolean;
  cfg?: { backend?: string; headers?: Record<string, string>; url?: string };
  execute?: (
    invocation: ReturnType<CatalogServices["fromMcp"]>["invocation"],
    client: null,
  ) => Promise<unknown>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function errorMessage(error: unknown): unknown {
  return error instanceof Error
    ? error.message
    : (error as { message?: unknown }).message;
}

export function catalogResult(
  result: unknown,
  operation: string,
  failed = false,
) {
  if (!object(result)) throw new Error("Invalid catalog application result");
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: failed || invocationFailed(result, operation),
  };
}

/** Application catalog routes are local metadata and typed CAD requests. Raw
 * backend requests retain the transport path, sessions and owned-artifact reads. */
export function createCatalogPost(
  post: CatalogPost,
  { queued, cfg = {}, execute = executeInvocation }: CatalogPostOptions = {},
  getCatalog: () => McpCatalogState,
) {
  return async (
    request: JsonRpcRequest,
    session?: string,
    version?: string,
  ): Promise<McpResponse> => {
    const {
      tools: mcpTools,
      contracts,
      fromMcp: mcpInvocation,
      isLocal: localInvocation,
    } = getCatalog();
    const reply = (result: unknown): McpResponse => ({
      status: 200,
      raw: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    });
    if (request.method === "tools/list")
      return Object.hasOwn(request, "id")
        ? reply({ tools: [...mcpTools, ...(queued ? queueTools : [])] })
        : { status: 204, raw: "" };
    const name = request.params?.["name"];
    if (
      request.method !== "tools/call" ||
      typeof name !== "string" ||
      !name.startsWith("fmcad_cad_")
    )
      return post(request, session, version);
    let call: ReturnType<CatalogServices["fromMcp"]>,
      options: ReturnType<typeof queueMetadata>["options"];
    try {
      if (!Object.hasOwn(request, "id"))
        throw new Error("Catalog calls require a request id");
      options = queueMetadata(request).options;
      const rawArgs = request.params!["arguments"];
      const args = rawArgs as Record<string, unknown> | undefined;
      if (
        options.description !== undefined &&
        args?.["purpose"] !== undefined &&
        description(args["purpose"]) !== options.description
      )
        throw new Error("Conflicting purpose and metadata description");
      call = mcpInvocation(name, {
        ...args,
        ...(options.description !== undefined
          ? { purpose: options.description }
          : {}),
      });
      if (!localInvocation(call.invocation)) {
        if (
          !contracts[call.operation]!.requirements.backends.some(
            (backend) => backend === (cfg.backend || "mcp"),
          )
        )
          throw new Error(
            call.operation + " requires the addin backend; no fallback",
          );
        if (queued && call.operation === "animation.play")
          throw new Error(
            "unsupported_queue_route: asynchronous animation.play has no terminal queue receipt",
          );
      }
    } catch (error) {
      if (!Object.hasOwn(request, "id")) throw error;
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: redactDiagnostic(errorMessage(error), cfg),
          },
        }),
      };
    }
    if (queued && !localInvocation(call.invocation)) {
      return post(
        {
          ...request,
          params: {
            ...request.params,
            arguments: {
              ...(request.params!["arguments"] as Record<string, unknown>),
              ...(call.invocation.purpose !== undefined
                ? { purpose: call.invocation.purpose }
                : {}),
            },
          },
        },
        session,
        version,
      );
    }
    if (options.sequence || options.expectedRevision !== undefined) {
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message:
              "Local/direct catalog execution does not accept queue sequence or revision metadata",
          },
        }),
      };
    }
    try {
      if (!localInvocation(call.invocation)) {
        throw new Error(
          "unsupported_queue_route: MCP SDK execution requires the broker",
        );
      }
      return reply(
        catalogResult(await execute(call.invocation, null), call.operation),
      );
    } catch (error) {
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: redactDiagnostic(errorMessage(error), cfg),
          },
        }),
      };
    }
  };
}

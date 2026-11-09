import { createHash, randomUUID } from "node:crypto";
import { redactDiagnostic, formatJsonError } from "@fmcad/core";
import { parseMcpResponseMessages } from "../entrypoints/mcp-framing";
import { queueTools } from "./library-mcp-tools";
import type { CatalogPost } from "./library-mcp-catalog";
import type {
  JsonRpcRequest,
  JsonRpcMessage,
  McpResponse,
} from "./library-mcp-protocol";
export interface ForwarderConfiguration {
  backend?: string;
  routing?: string;
  headers?: Record<string, string>;
  url?: string;
}
// This compatibility path retains upstream payloads and its historical checks.
// The public bounded stdio transport performs its own stronger wire validation.
interface CompatibilityMessage extends JsonRpcMessage {
  result?: {
    resourceTemplates?: unknown[];
    tools?: { name?: string }[];
    _meta?: Record<string, unknown>;
    protocolVersion?: string;
  };
  error?: { code?: number; data?: Record<string, unknown> };
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const SIZE_DIAGNOSTIC_THRESHOLD_BYTES = 8 * 1024 * 1024;
const MAX_SIZE_DIAGNOSTICS = 20;
const SAFE_DIAGNOSTIC_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "prompts/list",
  "prompts/get",
]);
// Framing only: preserve responses from the catalog/application or physical post.
// Do not initialize a second session, adapt Python, or retry a failed request.
export function createForwarder(
  post: CatalogPost,
  send: (message: JsonRpcMessage, frame?: string) => void,
  log: (message: string) => void = () => {},
  cfg: ForwarderConfiguration = {},
) {
  let session: string | undefined;
  let version: string | undefined;
  // startStdio constructs one forwarder for each stdio process.
  let sizeDiagnosticCount = 0;
  const clientInstanceId = randomUUID();
  const requestIdSalt = randomUUID();
  return async (line: string) => {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON" },
      });
      return;
    }
    if (
      !request ||
      Array.isArray(request) ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string" ||
      (Object.hasOwn(request, "id") &&
        request.id !== null &&
        typeof request.id !== "string" &&
        (typeof request.id !== "number" || !Number.isFinite(request.id)))
    ) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "Expected a JSON-RPC request or notification",
        },
      });
      return;
    }
    const hasId = Object.hasOwn(request, "id");
    let response: McpResponse | undefined;
    try {
      response = await post(request, session, version);
      if (response.status < 200 || response.status >= 300)
        throw new Error("HTTP " + response.status);
      if (response.sessionId) session = response.sessionId;
      let messages = parseMcpResponseMessages(
        response.raw,
      ) as CompatibilityMessage[];
      if (
        request.method === "resources/templates/list" &&
        hasId &&
        messages.length === 1 &&
        messages[0]!.jsonrpc === "2.0" &&
        messages[0]!.id === request.id &&
        messages[0]!.error?.code === -32601 &&
        !Object.hasOwn(messages[0]!, "result")
      ) {
        messages = [
          {
            jsonrpc: "2.0",
            id: request.id!,
            result: { resourceTemplates: [] },
          },
        ];
      }
      if (
        hasId &&
        !messages.some(
          (message) =>
            message.id === request.id &&
            (Object.hasOwn(message, "result") ||
              Object.hasOwn(message, "error")),
        )
      ) {
        throw new Error("Missing matching MCP response");
      }
      for (const message of messages) {
        if (message.jsonrpc !== "2.0")
          throw new Error("Invalid upstream JSON-RPC message");
      }
      for (const message of messages) {
        if (message.id !== request.id) continue;
        if (
          response.queueTools &&
          request.method === "tools/list" &&
          Array.isArray(message.result?.tools)
        ) {
          message.result.tools = [
            ...message.result.tools.filter(
              (tool) => !queueTools.some((local) => local.name === tool.name),
            ),
            ...queueTools,
          ];
        }
        if (response.queueReceipt && object(message.result))
          message.result._meta = {
            ...message.result._meta,
            fmcad: response.queueReceipt,
          };
        if (response.queueReceipt && object(message.error))
          message.error.data = {
            ...message.error.data,
            fmcad: response.queueReceipt,
          };
      }
      if (request.method === "initialize") {
        version = messages.find((message) => message.id === request.id)?.result
          ?.protocolVersion;
      }
      let stdoutFrameBytes;
      for (const message of messages) {
        const isMatchingResponse =
          message.id === request.id &&
          (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
        const frame = JSON.stringify(message) + "\n";
        send(message, frame);
        if (isMatchingResponse)
          stdoutFrameBytes = Buffer.byteLength(frame, "utf8");
      }
      if (
        hasId &&
        stdoutFrameBytes !== undefined &&
        sizeDiagnosticCount < MAX_SIZE_DIAGNOSTICS
      ) {
        const upstreamResponseBytes = Buffer.byteLength(
          response.raw || "",
          "utf8",
        );
        if (
          upstreamResponseBytes >= SIZE_DIAGNOSTIC_THRESHOLD_BYTES ||
          stdoutFrameBytes >= SIZE_DIAGNOSTIC_THRESHOLD_BYTES
        ) {
          sizeDiagnosticCount++;
          const requestIdHash = createHash("sha256")
            .update(requestIdSalt)
            .update("\0")
            .update(JSON.stringify(request.id)!)
            .digest("hex")
            .slice(0, 24);
          const toolName =
            request.method === "tools/call" &&
            typeof request.params?.["name"] === "string" &&
            /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(request.params!["name"])
              ? request.params!["name"]
              : undefined;
          const event = {
            event: "mcp_response_size",
            pid: process.pid,
            clientInstanceId,
            // `fusion` and `fusion_addin` share this command without alias-specific args or env.
            serverAlias: null,
            backend: ["mcp", "addin"].includes(cfg.backend!)
              ? cfg.backend
              : "unknown",
            routing: cfg.routing === "queue" ? "queue" : "unknown",
            requestIdHash,
            method: SAFE_DIAGNOSTIC_METHODS.has(request.method)
              ? request.method
              : "other",
            ...(toolName ? { toolName } : {}),
            upstreamResponseBytes,
            stdoutFrameBytes,
            thresholdBytes: SIZE_DIAGNOSTIC_THRESHOLD_BYTES,
          };
          try {
            log("[fmcad-mcp-size] " + JSON.stringify(event));
          } catch {
            /* Diagnostics must not affect MCP output. */
          }
        }
      }
    } catch (caught) {
      const error = caught as Error;
      const detail =
        error instanceof SyntaxError &&
        /^\s+at JSON\.parse \(/m.test(error.stack || "")
          ? formatJsonError(error)
          : redactDiagnostic(error.message, cfg);
      const message =
        "Fusion MCP connection error; no retry was performed. An operation may have run: " +
        detail;
      if (hasId)
        send({
          jsonrpc: "2.0",
          id: request.id!,
          error: {
            code: -32000,
            message,
            ...(response?.queueReceipt
              ? { data: { fmcad: response.queueReceipt } }
              : {}),
          },
        });
      else log(message);
    }
  };
}

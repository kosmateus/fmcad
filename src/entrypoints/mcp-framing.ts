import { createHash, randomUUID } from "node:crypto";
import type { ConsoleTelemetryOwnedResultInput } from "@fmcad/node-adapters";
import type { OwnedResultReference } from "../../packages/core/src/ports/execution-store";

export const MCP_MAX_INPUT_FRAME_BYTES = 1024 * 1024;
export const MCP_MAX_STDOUT_FRAME_BYTES = 8 * 1024 * 1024;
export const MCP_MAX_PENDING_REQUESTS = 4;
export const MCP_MAX_SIZE_DIAGNOSTICS = 20;
const SAFE_DIAGNOSTIC_CODES = new Set([
  "HTTP_STATUS",
  "ARTIFACT_OWNER_UNAVAILABLE",
  "ARTIFACT_UNAVAILABLE",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "QUEUE_RESULT_UNAVAILABLE",
  "PROTOCOL_ERROR",
]);

export type JsonRpcId = string | number | null;
export type JsonObject = Record<string, unknown>;

export type OwnedMcpArtifactReference = OwnedResultReference;

export interface JsonRpcRequest extends JsonObject {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: JsonObject;
}

export interface JsonRpcMessage extends JsonObject {
  jsonrpc: "2.0";
  id?: JsonRpcId;
}

export interface McpResponse {
  status: number;
  raw: string;
  sessionId?: string;
  queueReceipt?: unknown;
  queueTools?: boolean;
  artifactOwner?: { jobId: string; cwd?: string };
  /** Existing broker-owned rpc-result.json, when the queue already externalized it. */
  ownedArtifact?: OwnedMcpArtifactReference;
}

export interface ExternalizedResponse {
  status: "EXTERNALIZED";
  complete: true;
  originalHttpStatus: number;
  responseBytes: number;
  artifact: OwnedMcpArtifactReference;
}

export interface ExternalizeContext {
  request: JsonRpcRequest;
  response: McpResponse;
}

/** Passive, pathless notification after an owned result descriptor is verified. */
export type OwnedMcpResultReporter = (
  input: ConsoleTelemetryOwnedResultInput,
) => void;

export type OwnedResponseWriter = (
  contents: { status: number; raw: string },
  context: ExternalizeContext,
) => Promise<OwnedMcpArtifactReference> | OwnedMcpArtifactReference;

function shortStatus(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" && value.length <= 128) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return undefined;
}

function smallJson(value: unknown, maxBytes: number): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
  } catch {
    return false;
  }
}

export interface FrameSendContext {
  request: JsonRpcRequest;
  response?: McpResponse;
}

export interface McpFrameSink {
  send(message: JsonRpcMessage, context: FrameSendContext): Promise<void>;
}

export type InputFrame =
  | { kind: "line"; text: string }
  | { kind: "invalid-utf8" }
  | { kind: "too-large" };

export type JsonRequestParse =
  { request: JsonRpcRequest } | { error: JsonRpcMessage };

const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function validJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function parseUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Incremental LF framing; only one bounded, incomplete UTF-8 frame is retained. */
export class JsonLineDecoder {
  readonly #maxFrameBytes: number;
  #partial = Buffer.alloc(0);
  #discarding = false;

  constructor(maxFrameBytes = MCP_MAX_INPUT_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0)
      throw new Error("maxFrameBytes must be a positive safe integer");
    this.#maxFrameBytes = maxFrameBytes;
  }

  async push(
    chunk: Uint8Array,
    consume: (frame: InputFrame) => void | Promise<void>,
  ): Promise<void> {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let cursor = 0;
    while (cursor < bytes.length) {
      const newline = bytes.indexOf(0x0a, cursor);
      const end = newline < 0 ? bytes.length : newline;
      const segment = bytes.subarray(cursor, end);
      if (this.#discarding) {
        if (newline < 0) return;
        this.#discarding = false;
        this.#partial = Buffer.alloc(0);
        await consume({ kind: "too-large" });
        cursor = newline + 1;
        continue;
      }

      if (this.#partial.length + segment.length > this.#maxFrameBytes) {
        this.#partial = Buffer.alloc(0);
        if (newline < 0) {
          this.#discarding = true;
          return;
        }
        await consume({ kind: "too-large" });
        cursor = newline + 1;
        continue;
      }

      if (newline < 0) {
        if (segment.length)
          this.#partial = this.#partial.length
            ? Buffer.concat([this.#partial, segment])
            : Buffer.from(segment);
        return;
      }

      const line = this.#partial.length
        ? Buffer.concat([this.#partial, segment])
        : segment;
      this.#partial = Buffer.alloc(0);
      await this.#consumeLine(line, consume);
      cursor = newline + 1;
    }
  }

  async end(
    consume: (frame: InputFrame) => void | Promise<void>,
  ): Promise<void> {
    if (this.#discarding) {
      this.#discarding = false;
      this.#partial = Buffer.alloc(0);
      await consume({ kind: "too-large" });
      return;
    }
    if (!this.#partial.length) return;
    const line = this.#partial;
    this.#partial = Buffer.alloc(0);
    await this.#consumeLine(line, consume);
  }

  discard(): void {
    this.#partial = Buffer.alloc(0);
    this.#discarding = false;
  }

  get bufferedBytes(): number {
    return this.#partial.length;
  }

  async #consumeLine(
    bytes: Buffer,
    consume: (frame: InputFrame) => void | Promise<void>,
  ): Promise<void> {
    const line = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
    const text = parseUtf8(line);
    await consume(
      text === undefined ? { kind: "invalid-utf8" } : { kind: "line", text },
    );
  }
}

export function parseJsonRpcRequest(line: string): JsonRequestParse {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return {
      error: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON" },
      },
    };
  }
  if (
    !object(value) ||
    value["jsonrpc"] !== "2.0" ||
    typeof value["method"] !== "string" ||
    (Object.hasOwn(value, "id") && !validJsonRpcId(value["id"])) ||
    (Object.hasOwn(value, "params") && !object(value["params"]))
  ) {
    return {
      error: {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "Expected a JSON-RPC request or notification",
        },
      },
    };
  }
  return { request: value as JsonRpcRequest };
}

export function parseMcpResponseMessages(raw: string): JsonRpcMessage[] {
  const text = raw.trim();
  if (!text) return [];
  if (
    !text.startsWith("data:") &&
    !text.startsWith("event:") &&
    text.startsWith("{")
  ) {
    return [parseResponseMessage(JSON.parse(text) as unknown)];
  }

  const messages: JsonRpcMessage[] = [];
  for (const block of text.split(/\r\n\r\n|\r\r|\n\n/)) {
    const data = block
      .split(/\r\n|\r|\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) messages.push(parseResponseMessage(JSON.parse(data) as unknown));
  }
  return messages;
}

function parseResponseMessage(value: unknown): JsonRpcMessage {
  if (!object(value) || value["jsonrpc"] !== "2.0")
    throw new Error("Invalid upstream JSON-RPC message");
  if (Object.hasOwn(value, "id") && !validJsonRpcId(value["id"]))
    throw new Error("Invalid upstream JSON-RPC id");
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult && hasError)
    throw new Error("Invalid upstream JSON-RPC response");
  if ((hasResult || hasError) && !Object.hasOwn(value, "id"))
    throw new Error("Upstream JSON-RPC response is missing its id");
  if (hasError) {
    const error = value["error"];
    if (
      !object(error) ||
      !Number.isInteger(error["code"]) ||
      typeof error["message"] !== "string"
    )
      throw new Error("Invalid upstream JSON-RPC error");
  }
  if (!hasResult && !hasError && typeof value["method"] !== "string")
    throw new Error("Invalid upstream JSON-RPC message");
  return value as JsonRpcMessage;
}

export function serializeMcpFrame(message: JsonRpcMessage): Buffer {
  return Buffer.from(JSON.stringify(message) + "\n", "utf8");
}

function requestIdHash(id: JsonRpcId, salt: string): string {
  return createHash("sha256")
    .update(salt)
    .update("\0")
    .update(JSON.stringify(id))
    .digest("hex")
    .slice(0, 24);
}

function safeToolName(request: JsonRpcRequest): string | undefined {
  const params = request["params"];
  const name = object(params) ? params["name"] : undefined;
  return typeof name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)
    ? name
    : undefined;
}

function safeMethod(request: JsonRpcRequest): string {
  const safe = new Set([
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
  return safe.has(request.method) ? request.method : "other";
}

function externalizedContent(
  request: JsonRpcRequest,
  message: JsonRpcMessage,
  descriptor: ExternalizedResponse,
): JsonRpcMessage {
  const id = Object.hasOwn(message, "id") ? message["id"] : request["id"];
  if (Object.hasOwn(message, "error")) {
    const originalError = message["error"] as JsonObject;
    return {
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id: id as JsonRpcId }),
      error: {
        code: originalError["code"],
        message:
          "MCP error response externalized; the complete response is in its owned artifact.",
        data: {
          status: descriptor.status,
          complete: descriptor.complete,
          originalHttpStatus: descriptor.originalHttpStatus,
          originalCode: originalError["code"],
          retry: false,
          ...(object(originalError["data"]) &&
          smallJson(originalError["data"]["fmcad"], 4096)
            ? { fmcad: originalError["data"]["fmcad"] }
            : {}),
          artifact: descriptor.artifact,
          responseBytes: descriptor.responseBytes,
        },
      },
    };
  }

  const result = message["result"];
  if (request.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id: id as JsonRpcId }),
      result: {
        tools: [],
        _meta: { fmcad: { ...descriptor, listComplete: false } },
      },
    };
  }

  if (request.method === "tools/call" && object(result)) {
    const candidateFmcad = object(result["_meta"])
      ? result["_meta"]["fmcad"]
      : undefined;
    const priorFmcad = smallJson(candidateFmcad, 4096)
      ? candidateFmcad
      : undefined;
    const structured = object(result["structuredContent"])
      ? result["structuredContent"]
      : undefined;
    const priorStatus = structured
      ? shortStatus(structured["status"])
      : undefined;
    return {
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id: id as JsonRpcId }),
      result: {
        content: [
          {
            type: "text",
            text: "MCP response externalized; the complete response is in its owned artifact.",
          },
        ],
        structuredContent: {
          status: descriptor.status,
          complete: descriptor.complete,
          originalHttpStatus: descriptor.originalHttpStatus,
          artifact: descriptor.artifact,
          responseBytes: descriptor.responseBytes,
          ...(priorStatus === undefined ? {} : { resultStatus: priorStatus }),
          ...(priorFmcad === undefined ? {} : { queueReceipt: priorFmcad }),
        },
        ...(typeof result["isError"] === "boolean"
          ? { isError: result["isError"] }
          : {}),
      },
    };
  }

  return {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id: id as JsonRpcId }),
    result: {
      status: descriptor.status,
      complete: descriptor.complete,
      originalHttpStatus: descriptor.originalHttpStatus,
      artifact: descriptor.artifact,
      responseBytes: descriptor.responseBytes,
    },
  };
}

export interface McpForwarderOptions {
  sink: McpFrameSink;
  queueTools?: readonly JsonObject[];
  log?(record: JsonObject): void;
  backend?: "mcp" | "addin" | "unknown";
  routing?: "queue" | "unknown";
  pid?: number;
  clientInstanceId?: string;
}

/** A stateful one-process forwarder. It never initializes or retries a session. */
export function createMcpProtocolForwarder(
  post: (
    request: JsonRpcRequest,
    session?: string,
    version?: string,
  ) => Promise<McpResponse>,
  options: McpForwarderOptions,
): (frame: InputFrame) => Promise<void> {
  let session: string | undefined;
  let version: string | undefined;
  let diagnosticCount = 0;
  const instanceId = options.clientInstanceId ?? randomUUID();
  const idSalt = randomUUID();

  const send = (
    message: JsonRpcMessage,
    request: JsonRpcRequest,
    response?: McpResponse,
  ) =>
    options.sink.send(message, { request, ...(response ? { response } : {}) });
  const log = (record: JsonObject) => {
    if (diagnosticCount >= MCP_MAX_SIZE_DIAGNOSTICS) return;
    diagnosticCount++;
    try {
      options.log?.(record);
    } catch {
      // Diagnostics cannot change a protocol result.
    }
  };

  return async (input) => {
    if (input.kind === "too-large") {
      await send(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Input frame exceeds the configured byte limit",
          },
        },
        { jsonrpc: "2.0", id: null, method: "" },
      );
      return;
    }
    if (input.kind === "invalid-utf8") {
      await send(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid UTF-8" },
        },
        { jsonrpc: "2.0", id: null, method: "" },
      );
      return;
    }
    if (!input.text.trim()) return;

    const parsed = parseJsonRpcRequest(input.text);
    if ("error" in parsed) {
      await send(parsed.error, { jsonrpc: "2.0", id: null, method: "" });
      return;
    }
    const request = parsed.request;
    const hasId = Object.hasOwn(request, "id");
    let response: McpResponse | undefined;
    try {
      response = await post(request, session, version);
      if (response.status < 200 || response.status >= 300)
        throw Object.assign(
          new Error("Upstream HTTP status is not successful"),
          {
            code: "HTTP_STATUS",
          },
        );
      if (response.sessionId) session = response.sessionId;
      let messages = parseMcpResponseMessages(response.raw);
      if (
        request.method === "resources/templates/list" &&
        hasId &&
        messages.length === 1 &&
        messages[0]?.["id"] === request.id &&
        object(messages[0]?.["error"]) &&
        messages[0]?.["error"]["code"] === -32601 &&
        !Object.hasOwn(messages[0]!, "result")
      ) {
        messages = [
          {
            jsonrpc: "2.0",
            id: request.id as JsonRpcId,
            result: { resourceTemplates: [] },
          },
        ];
      }
      const matchingResponses = messages.filter(
        (message) =>
          message["id"] === request.id &&
          (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")),
      );
      if (hasId && matchingResponses.length !== 1)
        throw new Error(
          matchingResponses.length
            ? "Duplicate matching MCP response IDs"
            : "Missing matching MCP response",
        );
      for (const message of messages) {
        if (
          (Object.hasOwn(message, "result") ||
            Object.hasOwn(message, "error")) &&
          (!hasId || message["id"] !== request.id)
        )
          throw new Error("Mismatched upstream JSON-RPC response id");
      }

      if (request.method === "initialize") {
        const initialized = messages.find(
          (message) => message["id"] === request.id,
        );
        const result = initialized?.["result"];
        if (object(result) && typeof result["protocolVersion"] === "string")
          version = result["protocolVersion"];
      }

      for (const original of messages) {
        if (original["jsonrpc"] !== "2.0")
          throw new Error("Invalid upstream JSON-RPC version");
        let message = original;
        if (message["id"] === request.id) {
          if (response.queueTools && request.method === "tools/list") {
            const result = message["result"];
            if (object(result) && Array.isArray(result["tools"])) {
              const helperNames = new Set(
                (options.queueTools ?? []).map((tool) => tool["name"]),
              );
              const tools = result["tools"].filter(
                (tool) => !object(tool) || !helperNames.has(tool["name"]),
              );
              message = {
                ...message,
                result: {
                  ...result,
                  tools: [...tools, ...(options.queueTools ?? [])],
                },
              };
            }
          }
          if (response.queueReceipt && object(message["result"])) {
            const result = message["result"];
            message = {
              ...message,
              result: {
                ...result,
                _meta: {
                  ...(object(result["_meta"]) ? result["_meta"] : {}),
                  fmcad: response.queueReceipt,
                },
              },
            };
          }
          if (response.queueReceipt && object(message["error"])) {
            const error = message["error"];
            message = {
              ...message,
              error: {
                ...error,
                data: {
                  ...(object(error["data"]) ? error["data"] : {}),
                  fmcad: response.queueReceipt,
                },
              },
            };
          }
        }

        const frame = serializeMcpFrame(message);
        if (
          hasId &&
          message["id"] === request.id &&
          (Object.hasOwn(message, "result") ||
            Object.hasOwn(message, "error")) &&
          frame.length >= MCP_MAX_STDOUT_FRAME_BYTES
        ) {
          log({
            event: "mcp_response_size",
            pid: options.pid ?? process.pid,
            clientInstanceId: instanceId,
            requestIdHash: requestIdHash(request.id as JsonRpcId, idSalt),
            method: safeMethod(request),
            ...(safeToolName(request)
              ? { toolName: safeToolName(request) }
              : {}),
            upstreamResponseBytes: Buffer.byteLength(response.raw, "utf8"),
            stdoutFrameBytes: frame.length,
            thresholdBytes: MCP_MAX_STDOUT_FRAME_BYTES,
            backend: options.backend ?? "unknown",
            routing: options.routing ?? "unknown",
          });
        }
        await send(message, request, response);
      }
    } catch (error) {
      const code =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error["code"] === "string" &&
        SAFE_DIAGNOSTIC_CODES.has(error["code"])
          ? error["code"]
          : "PROTOCOL_ERROR";
      log({ event: "mcp_forward_error", code, method: safeMethod(request) });
      if (!hasId) return;
      await send(
        {
          jsonrpc: "2.0",
          id: request.id as JsonRpcId,
          error: {
            code: -32000,
            message:
              "MCP response could not be forwarded; the accepted operation was not retried. Inspect its existing receipt or owned artifact.",
            ...(response?.queueReceipt
              ? { data: { fmcad: response.queueReceipt, retry: false } }
              : { data: { retry: false } }),
          },
        },
        request,
        response,
      );
    }
  };
}

/** Replaces an oversized serialized response with a small, explicit owned-artifact pointer. */
export async function externalizeMcpResponse(
  request: JsonRpcRequest,
  message: JsonRpcMessage,
  response: McpResponse,
  writeOwnedResponse?: OwnedResponseWriter,
): Promise<JsonRpcMessage> {
  let reference: unknown = response.ownedArtifact;
  if (
    !reference &&
    response.queueReceipt !== undefined &&
    response.artifactOwner === undefined
  )
    throw Object.assign(
      new Error("Queue response must reuse its existing owned artifact"),
      {
        code: "ARTIFACT_OWNER_UNAVAILABLE",
      },
    );
  if (!reference && writeOwnedResponse) {
    const params = request["params"];
    const toolName = object(params) ? params["name"] : undefined;
    if (typeof toolName === "string" && toolName.startsWith("fmcad_queue_"))
      throw Object.assign(
        new Error(
          "Queue helper response cannot create a second owned artifact",
        ),
        { code: "ARTIFACT_OWNER_UNAVAILABLE" },
      );
    reference = await writeOwnedResponse(
      { status: response.status, raw: response.raw },
      { request, response },
    );
  }
  if (!validOwnedReference(reference) || reference.name !== "rpc-result.json")
    throw Object.assign(
      new Error("No owned MCP response artifact is available"),
      {
        code: "ARTIFACT_UNAVAILABLE",
      },
    );
  const descriptor: ExternalizedResponse = {
    status: "EXTERNALIZED",
    complete: true,
    originalHttpStatus: response.status,
    responseBytes: Buffer.byteLength(response.raw, "utf8"),
    artifact: reference,
  };
  return externalizedContent(request, message, descriptor);
}

function validOwnedReference(
  value: unknown,
): value is OwnedMcpArtifactReference {
  if (!object(value)) return false;
  const expected = [
    "bytes",
    "jobId",
    "name",
    "scope",
    "sha256",
    "storage",
    "version",
  ];
  if (Object.keys(value).sort().join(",") !== expected.join(",")) return false;
  return (
    value["version"] === 1 &&
    typeof value["jobId"] === "string" &&
    /^[A-Za-z0-9_-]+$/.test(value["jobId"]) &&
    typeof value["scope"] === "string" &&
    /^[a-f0-9]{64}$/.test(value["scope"]) &&
    ["project", "legacy"].includes(String(value["storage"])) &&
    ["stdout.txt", "stderr.txt", "rpc-result.json"].includes(
      String(value["name"]),
    ) &&
    Number.isSafeInteger(value["bytes"]) &&
    Number(value["bytes"]) >= 0 &&
    typeof value["sha256"] === "string" &&
    /^[a-f0-9]{64}$/.test(value["sha256"])
  );
}

export function reportOwnedMcpResult(
  reporter: OwnedMcpResultReporter | undefined,
  value: unknown,
  response: McpResponse,
): value is OwnedMcpArtifactReference {
  if (!validOwnedReference(value)) return false;
  const ownerId = response.artifactOwner?.jobId;
  const receipt = object(response.queueReceipt)
    ? response.queueReceipt
    : undefined;
  const receiptJobId = receipt?.["jobId"];
  if (
    !receipt ||
    receiptJobId !== value.jobId ||
    (ownerId !== undefined && ownerId !== value.jobId)
  )
    return false;
  const rawReceiptContext = receipt?.["context"];
  const receiptContext = object(rawReceiptContext)
    ? rawReceiptContext
    : undefined;
  const state = boundedIdentity(receipt["state"], 128);
  if (!state) return false;
  const job: ConsoleTelemetryOwnedResultInput["job"] = {
    id: value.jobId,
    requestId: boundedIdentity(receipt["requestId"], 256),
    clientId: boundedIdentity(receiptContext?.["clientId"], 256),
    projectId: boundedIdentity(receiptContext?.["projectId"], 256),
    turnId: boundedIdentity(receiptContext?.["turnId"], 256),
    sessionId: boundedIdentity(receiptContext?.["sessionId"], 256),
    documentId: boundedIdentity(receiptContext?.["docId"], 256),
    documentFileId: boundedIdentity(receiptContext?.["docFileId"], 256),
    purpose: boundedIdentity(receiptContext?.["purpose"], 1000),
    state,
    transport: "mcp-stdio",
    agentId: boundedIdentity(receiptContext?.["agentId"], 256),
    agent: boundedIdentity(receiptContext?.["agent"], 256),
    model: boundedIdentity(receiptContext?.["model"], 256),
    role: boundedIdentity(receiptContext?.["role"], 256),
    physicalTurns: null,
    physicalTurnOrdinal: null,
    revision: Number.isSafeInteger(receipt["revision"])
      ? (receipt["revision"] as number)
      : null,
  };
  try {
    reporter?.({ job, reference: value });
  } catch {
    // Passive telemetry cannot affect protocol delivery or accepted work.
  }
  return true;
}

function boundedIdentity(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
    ? value
    : null;
}

export function isObject(value: unknown): value is JsonObject {
  return object(value);
}

export function boundedDiagnosticLine(record: JsonObject): string {
  const allowed = new Set([
    "event",
    "pid",
    "clientInstanceId",
    "requestIdHash",
    "method",
    "toolName",
    "upstreamResponseBytes",
    "stdoutFrameBytes",
    "thresholdBytes",
    "backend",
    "routing",
    "code",
  ]);
  const safe = Object.fromEntries(
    Object.entries(record).filter(([key, value]) => {
      if (!allowed.has(key)) return false;
      if (typeof value === "number")
        return (
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= 256 * 1024 * 1024
        );
      if (
        typeof value !== "string" ||
        value.length > 128 ||
        /[\r\n\x00-\x1f\x7f]/.test(value)
      )
        return false;
      switch (key) {
        case "event":
          return [
            "mcp_response_size",
            "mcp_forward_error",
            "mcp_frame_error",
            "mcp_input_closed",
            "mcp_output_closed",
          ].includes(value);
        case "clientInstanceId":
          return /^[a-f0-9-]{36}$/i.test(value);
        case "requestIdHash":
          return /^[a-f0-9]{24}$/.test(value);
        case "method":
          return [
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
            "other",
          ].includes(value);
        case "toolName":
          return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
        case "backend":
          return ["mcp", "addin", "unknown"].includes(value);
        case "routing":
          return ["direct", "queue", "unknown"].includes(value);
        case "code":
          return (
            SAFE_DIAGNOSTIC_CODES.has(value) ||
            ["FRAME_HANDLER_FAILED", "OUTPUT_CLOSED", "INPUT_ERROR"].includes(
              value,
            )
          );
        default:
          return false;
      }
    }),
  );
  let line = JSON.stringify(safe);
  if (Buffer.byteLength(line, "utf8") > 2048)
    line = JSON.stringify({ event: "mcp_diagnostic_dropped" });
  return line;
}

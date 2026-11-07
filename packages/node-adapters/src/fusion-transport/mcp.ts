import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Dependencies,
  ObjectValue,
  RequestOptions,
  RequestOverrides,
  Server,
  ToolResult,
  PreparedPost,
  PreparedToolCall,
} from "./contracts.js";
import { object, parse, unknownOutcome } from "./contracts.js";
import { postHttp } from "./http.js";
import { postCurl } from "./curl.js";
import type { PythonArtifactManifest } from "@fmcad/core";
import { bindPythonArtifactManifest } from "../python/context-binding.js";

const CONTROL_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
]);
export function isDiscoveryMethod(method: unknown): method is string {
  return typeof method === "string" && CONTROL_METHODS.has(method);
}
const PROTOCOLS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

function post(
  server: Server,
  dependencies: Dependencies,
  payload: ObjectValue,
  sessionId: string | undefined,
  options: RequestOptions,
) {
  const requestServer = {
    ...server,
    timeoutMs: dependencies.requestTimeout(server),
  };
  const request = { ...options, sessionId };
  if (server.transport === "windows-curl")
    return postCurl(requestServer, payload, request, dependencies.spawn);
  if (server.transport && !["http", "node"].includes(server.transport))
    throw new Error("Unknown physical transport");
  return postHttp(requestServer, payload, request);
}

export class McpDiscoveryClient {
  readonly server: Server;
  serverInfo: Record<string, string> | undefined;
  negotiatedProtocolVersion: string | undefined;
  constructor(
    server: Server,
    protected readonly dependencies: Dependencies,
  ) {
    this.server = Object.freeze({
      ...server,
      headers: Object.freeze({ ...server.headers }),
    });
  }

  _parse(raw: string): unknown {
    return parse(raw);
  }

  _post(
    payload: ObjectValue,
    sessionId?: string,
    options: RequestOptions = {},
  ) {
    if (!isDiscoveryMethod(payload["method"])) {
      return Promise.reject(
        Object.assign(
          new Error(
            "SDK access requires a broker turn; direct execution is unavailable",
          ),
          { code: "QUEUE_REQUIRED" },
        ),
      );
    }
    return post(this.server, this.dependencies, payload, sessionId, {
      ...options,
      protocolVersion:
        options.protocolVersion ?? this.negotiatedProtocolVersion,
    });
  }

  controlPost(
    payload: ObjectValue,
    sessionId?: string,
    protocolVersion?: string,
  ) {
    if (!isDiscoveryMethod(payload["method"])) {
      return Promise.reject(
        Object.assign(
          new Error("Only local MCP discovery methods are allowed"),
          { code: "CONTROL_METHOD_DENIED" },
        ),
      );
    }
    return this._post(payload, sessionId, { protocolVersion });
  }

  async _openSession(): Promise<string | undefined> {
    this.serverInfo = undefined;
    this.negotiatedProtocolVersion = undefined;
    const protocolVersion = this.server.protocolVersion ?? "2024-11-05";
    const init = await this._post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "fmcad", version: this.dependencies.version },
      },
    });
    if (init.status !== 200)
      throw unknownOutcome(`initialize failed: HTTP ${init.status}`, "EPROTO");
    const response = object(this._parse(init.raw));
    if (
      response["id"] !== 1 ||
      response["jsonrpc"] !== "2.0" ||
      response["error"]
    )
      throw unknownOutcome("Invalid MCP initialize response", "EPROTO");
    const result = object(response["result"]);
    const negotiated = result["protocolVersion"];
    if (
      typeof negotiated !== "string" ||
      (!PROTOCOLS.has(negotiated) && negotiated !== protocolVersion)
    ) {
      throw unknownOutcome("Unsupported MCP protocol version", "EPROTO");
    }
    this.negotiatedProtocolVersion = negotiated;
    const info = object(result["serverInfo"]);
    const projected: Record<string, string> = {};
    for (const key of ["name", "version"]) {
      const value = info[key];
      if (typeof value === "string" && value.trim()) projected[key] = value;
    }
    if (Object.keys(projected).length) this.serverInfo = projected;
    const notification = await this._post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      init.sessionId,
    );
    if (notification.status < 200 || notification.status >= 300)
      throw unknownOutcome("MCP initialized notification rejected", "EPROTO");
    return init.sessionId;
  }

  callTool(
    _argumentsObj: ObjectValue,
    _toolName?: string,
  ): Promise<ToolResult> {
    void _argumentsObj;
    void _toolName;
    return Promise.reject(
      Object.assign(
        new Error(
          "SDK access requires a broker turn; direct execution is unavailable",
        ),
        { code: "QUEUE_REQUIRED" },
      ),
    );
  }

  async listTools(): Promise<unknown[]> {
    const sid = await this._openSession();
    const res = await this._post(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      sid,
    );
    if (res.status < 200 || res.status >= 300)
      throw unknownOutcome(`tools/list failed: HTTP ${res.status}`, "EPROTO");
    const response = object(this._parse(res.raw));
    if (response["id"] !== 2 || response["error"])
      throw unknownOutcome("Invalid MCP tools/list response", "EPROTO");
    const tools = object(response["result"])["tools"];
    return Array.isArray(tools) ? tools : [];
  }
}

/** Private executor: never re-exported by the adapter workspace barrel. */
export class BrokerMcpClient extends McpDiscoveryClient {
  override async listTools(): Promise<unknown[]> {
    return (await this.prepareListTools())();
  }
  async prepareListTools(): Promise<
    (() => Promise<unknown[]>) & { fence(): void }
  > {
    const prepared = await this.preparePost({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    let consumed = false;
    const execute = async (): Promise<unknown[]> => {
      if (consumed) throw new Error("Prepared tools/list was already consumed");
      consumed = true;
      prepared.fence();
      const response = await prepared.send(await this._openSession());
      if (response.status < 200 || response.status >= 300)
        throw unknownOutcome(
          `tools/list failed: HTTP ${response.status}`,
          "EPROTO",
        );
      const reply = object(this._parse(response.raw));
      if (reply["id"] !== 2 || reply["error"])
        throw unknownOutcome("Invalid MCP tools/list response", "EPROTO");
      const tools = object(reply["result"])["tools"];
      return Array.isArray(tools) ? tools : [];
    };
    return Object.assign(execute, { fence: () => prepared.fence() });
  }
  /** Broker composition supplies final-byte preparation/checking here. The
   * returned one-shot operation is created before MCP session admission. */
  async preparePost(
    payload: ObjectValue,
    _origin?: PythonArtifactManifest,
  ): Promise<PreparedPost> {
    void _origin;
    const snapshot = structuredClone(payload);
    let consumed = false;
    return {
      fence() {},
      send: (sessionId) => {
        if (consumed) throw new Error("Prepared RPC was already consumed");
        consumed = true;
        return this._post(snapshot, sessionId);
      },
    };
  }
  readonly #requestScope = new AsyncLocalStorage<RequestOverrides>();
  withRequest<T>(overrides: RequestOverrides, action: () => T): T {
    const parent = this.#requestScope.getStore();
    const timeoutMs =
      overrides.timeoutMs === undefined
        ? parent?.timeoutMs
        : Math.min(overrides.timeoutMs, parent?.timeoutMs ?? Infinity);
    const headers =
      overrides.headers === undefined
        ? undefined
        : Object.freeze({ ...overrides.headers });
    return this.#requestScope.run(
      Object.freeze({
        ...parent,
        ...overrides,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(headers === undefined ? {} : { headers }),
      }),
      action,
    );
  }
  override _post(
    payload: ObjectValue,
    sessionId?: string,
    options: RequestOptions = {},
  ) {
    const scope = this.#requestScope.getStore();
    const { protocolVersion: scopedProtocolVersion, ...serverOverrides } =
      scope ?? {};
    return post(
      { ...this.server, ...serverOverrides },
      this.dependencies,
      payload,
      sessionId,
      {
        ...options,
        protocolVersion:
          options.protocolVersion ??
          (scope && Object.hasOwn(scope, "protocolVersion")
            ? scopedProtocolVersion
            : this.negotiatedProtocolVersion),
      },
    );
  }
  override async callTool(
    argumentsObj: ObjectValue,
    toolName?: string,
    origin?: PythonArtifactManifest,
  ): Promise<ToolResult> {
    return (await this.prepareCallTool(argumentsObj, toolName, origin))();
  }
  async prepareCallTool(
    argumentsObj: ObjectValue,
    toolName?: string,
    origin?: PythonArtifactManifest,
  ): Promise<PreparedToolCall> {
    const name = toolName ?? this.server.tool;
    if (origin) {
      const source =
        name === "execute_python"
          ? argumentsObj["code"]
          : name === "fusion_mcp_execute" &&
              argumentsObj["featureType"] === "script"
            ? object(argumentsObj["object"])["script"]
            : undefined;
      if (typeof source !== "string")
        throw new Error("Source inventory requires a Python tool payload");
      origin = bindPythonArtifactManifest(source, origin);
    }
    return this.prepareWireCall(argumentsObj, name, origin);
  }
  /** The add-in calls this only after validating the original inventory and
   * applying its actual guard/entrypoint transformation. */
  protected async prepareWireCall(
    argumentsObj: ObjectValue,
    toolName: string | undefined,
    origin?: PythonArtifactManifest,
  ): Promise<PreparedToolCall> {
    const prepared = await this.preparePost(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: toolName ?? this.server.tool,
          arguments: argumentsObj,
        },
      },
      origin,
    );
    let consumed = false;
    const execute = async (): Promise<ToolResult> => {
      if (consumed) throw new Error("Prepared tool call was already consumed");
      consumed = true;
      prepared.fence();
      const sid = await this._openSession();
      prepared.fence();
      const res = await prepared.send(sid);
      if (res.status < 200 || res.status >= 300)
        throw unknownOutcome(`tools/call failed: HTTP ${res.status}`, "EPROTO");
      const response = object(this._parse(res.raw));
      if (response["id"] !== 2 || response["jsonrpc"] !== "2.0")
        throw unknownOutcome("Invalid MCP tool response", "EPROTO");
      if (response["error"])
        throw Object.assign(
          unknownOutcome("MCP_ERROR: native JSON-RPC failure", "MCP_ERROR"),
          { nativeError: response["error"] },
        );
      const result = object(response["result"]);
      let text = "";
      for (const value of Array.isArray(result["content"])
        ? result["content"]
        : []) {
        const item = object(value);
        if (item["type"] === "text" && typeof item["text"] === "string")
          text += item["text"];
      }
      if (!text)
        text =
          typeof result["message"] === "string"
            ? result["message"]
            : JSON.stringify(result);
      let failed = Boolean(result["isError"]);
      let data: unknown = result["structuredContent"] ?? null;
      try {
        const decoded: unknown = JSON.parse(text);
        const parsed = object(decoded);
        if (parsed["success"] === false || parsed["error"]) failed = true;
        if (typeof parsed["message"] === "string") text = parsed["message"];
        if (!data && parsed["success"] !== undefined) data = decoded;
      } catch {
        /* Plain text is a valid result. */
      }
      const structured = object(data);
      if (
        /^ERROR /m.test(text) ||
        (typeof structured["message"] === "string" &&
          /^ERROR /m.test(structured["message"])) ||
        structured["success"] === false ||
        structured["error"] ||
        structured["isError"]
      )
        failed = true;
      return { text, failed, data };
    };
    return Object.assign(execute, { fence: () => prepared.fence() });
  }
}

import { randomUUID } from "node:crypto";
import {
  createInvocationContext,
  type InvocationContext,
} from "../../packages/core/src";

const CONTROL_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
]);
function queueRequired(): Error & { code: string } {
  return Object.assign(
    new Error(
      "Fusion access requires an admitted broker turn; direct execution is unavailable",
    ),
    { code: "QUEUE_REQUIRED" },
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
export interface CompatibilityServer extends Record<string, unknown> {
  headers?: Readonly<Record<string, unknown>>;
  clientId?: unknown;
}

/** Metadata-only public compatibility client. Physical execution belongs to the broker. */
export class McpClient {
  readonly server: Readonly<CompatibilityServer>;
  serverInfo: undefined;
  negotiatedProtocolVersion: undefined;
  invocationContext:
    InvocationContext | Record<string, unknown> | null | undefined;
  invocationMetadata: unknown = {};

  constructor(server: CompatibilityServer = {}) {
    this.server = Object.freeze({
      ...server,
      headers: Object.freeze({ ...(server.headers || {}) }),
    });
    this.invocationContext = createInvocationContext({
      clientId:
        typeof server.clientId === "string" &&
        server.clientId.trim() &&
        server.clientId.length <= 256 &&
        !/[\x00-\x1f\x7f]/u.test(server.clientId)
          ? server.clientId
          : "mcp-stdio:" + randomUUID(),
      instanceId: randomUUID(),
      source: "mcp",
    });
  }
  setInvocationContext(
    context: InvocationContext | Record<string, unknown> | null | undefined,
  ): void {
    this.invocationContext = context;
    this.invocationMetadata = record(context) ? context["metadata"] || {} : {};
  }
  _parse(raw: string): unknown {
    return JSON.parse(raw) as unknown;
  }
  _post(...args: unknown[]): Promise<never> {
    void args; // Historical callers may pass transport arguments; none can authorize dispatch.
    return Promise.reject(queueRequired());
  }
  controlPost(payload: unknown, ...args: unknown[]): Promise<never> {
    void args; // Historical callers may pass transport arguments; none can authorize dispatch.
    if (
      !record(payload) ||
      typeof payload["method"] !== "string" ||
      !CONTROL_METHODS.has(payload["method"])
    ) {
      return Promise.reject(
        Object.assign(
          new Error("Only local MCP discovery methods are supported"),
          { code: "CONTROL_METHOD_DENIED" },
        ),
      );
    }
    return this._post(payload);
  }
  _openSession(...args: unknown[]): Promise<never> {
    void args; // Historical callers may pass transport arguments; none can authorize dispatch.
    return Promise.reject(queueRequired());
  }
  callTool(...args: unknown[]): Promise<never> {
    void args; // Historical callers may pass transport arguments; none can authorize dispatch.
    return Promise.reject(queueRequired());
  }
  listTools(...args: unknown[]): Promise<never> {
    void args; // Historical callers may pass transport arguments; none can authorize dispatch.
    return Promise.reject(queueRequired());
  }
  async close(): Promise<void> {}
}

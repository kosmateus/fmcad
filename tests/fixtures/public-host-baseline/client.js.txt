"use strict";

const { randomUUID } = require("node:crypto");
const { createInvocationContext } = require("./dist/core");

const CONTROL_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
]);

function queueRequired() {
  return Object.assign(
    new Error(
      "Fusion access requires an admitted broker turn; direct execution is unavailable",
    ),
    {
      code: "QUEUE_REQUIRED",
    },
  );
}

// Transitional compatibility facade. It retains client metadata for old
// consumers, but intentionally has no physical transport or discovery path.
class McpClient {
  constructor(server = {}) {
    this.server = Object.freeze({
      ...server,
      headers: Object.freeze({ ...(server.headers || {}) }),
    });
    this.serverInfo = undefined;
    this.negotiatedProtocolVersion = undefined;
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
    this.invocationMetadata = {};
  }

  setInvocationContext(context) {
    this.invocationContext = context;
    this.invocationMetadata = context?.metadata || {};
  }

  _parse(raw) {
    return JSON.parse(raw);
  }

  _post() {
    return Promise.reject(queueRequired());
  }

  controlPost(payload) {
    if (!CONTROL_METHODS.has(payload?.method)) {
      return Promise.reject(
        Object.assign(
          new Error("Only local MCP discovery methods are supported"),
          {
            code: "CONTROL_METHOD_DENIED",
          },
        ),
      );
    }
    return this._post(payload);
  }

  _openSession() {
    return Promise.reject(queueRequired());
  }

  callTool() {
    return Promise.reject(queueRequired());
  }

  listTools() {
    return Promise.reject(queueRequired());
  }

  async close() {}
}

module.exports = { McpClient };

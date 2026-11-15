"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const pythonSource = `import adsk.core
import adsk.fusion
import json
from typing import cast

DOC_NAME = None

def run(context: str) -> None:
    app = adsk.core.Application.get()
    document = app.activeDocument
    assert document is not None
    assert document.name == DOC_NAME
    product = document.products.itemByProductType("DesignProductType")
    assert product is not None
    design = cast(adsk.fusion.Design, product)
    assert design is not None
    assert design.userParameters.count == 0
    design.userParameters.add(
        "OwnedCounter",
        adsk.core.ValueInput.createByString("2 mm"),
        "mm",
        "synthetic generic native write contract",
    )
    print("FMCAD_RESULT " + json.dumps({"success": True, "parameter": "OwnedCounter"}))
`;

const historical = Object.freeze({
  commit: "e4994e96d6dbf4fdb975bf66dba3e45c05b33a93",
  runBlob: "c9fc25d138cf028e446963539eb7b51d3f728e94",
  cadServiceBlob: "788495997a5703261e426c38ddacc76ff6bb5e15",
  toolName: "fusion_mcp_execute",
  featureType: "script",
  readOnly: false,
  writeReadOnlyField: "omitted",
});

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected))
    throw new Error(`${label} keys differ from the native MCP contract`);
}

function response(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function writeSyntheticReceipt(script, root, instance) {
  let source = script;
  for (let depth = 0; depth < 8; depth++) {
    const binding = source.match(
      /_qr_binding_value = _qr_cast\(object, _qr_json\.loads\(("(?:\\.|[^"\\])*")\)/,
    );
    const filename = source.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
    if (binding && filename && binding[1] && filename[1]) {
      const record = JSON.parse(JSON.parse(binding[1]));
      const target = path.resolve(JSON.parse(filename[1]));
      if (!target.startsWith(root + path.sep))
        throw new Error("Synthetic receipt escaped the isolated test root");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        JSON.stringify({
          ...record,
          terminal: true,
          outcome: "succeeded",
          instance,
        }),
        { mode: 0o600 },
      );
    }
    const wrapped = source.match(/exec\(compile\(("(?:\\.|[^"\\])*")/);
    if (!wrapped) return;
    source = JSON.parse(wrapped[1]);
  }
  throw new Error("Unexpected nested generic-write script wrapper");
}

function createNativeContractEndpoint({
  root,
  instance,
  token,
  protocolVersion,
}) {
  const sessions = new Set();
  const requests = [];
  const responses = [];
  const violations = [];
  let sessionNumber = 0;
  let writeCount = 0;
  const respond = (res, status, body) => {
    responses.push({
      status,
      ...(body === undefined ? {} : { body }),
    });
    response(res, status, body);
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let payload;
      try {
        if (req.method !== "POST") throw new Error("Expected POST");
        if (req.headers.authorization !== token)
          throw new Error("Unexpected synthetic authorization header");
        payload = object(JSON.parse(body), "JSON-RPC request");
        if (payload.jsonrpc !== "2.0") throw new Error("Expected JSON-RPC 2.0");
        const method = payload.method;
        const session = req.headers["mcp-session-id"];
        if (method === "initialize") {
          exactKeys(
            payload,
            ["jsonrpc", "id", "method", "params"],
            "initialize",
          );
          exactKeys(
            payload.params,
            ["protocolVersion", "capabilities", "clientInfo"],
            "initialize params",
          );
          if (payload.params.protocolVersion !== protocolVersion)
            throw new Error("Unexpected initialize protocol version");
          if (JSON.stringify(payload.params.capabilities) !== "{}")
            throw new Error("Unexpected initialize capabilities");
          if (
            payload.params.clientInfo?.name !== "fmcad" ||
            typeof payload.params.clientInfo.version !== "string"
          )
            throw new Error("Unexpected initialize client information");
          const sessionId = `synthetic-session-${++sessionNumber}`;
          sessions.add(sessionId);
          requests.push({ method, id: payload.id, sessionId });
          res.setHeader("Mcp-Session-Id", sessionId);
          respond(res, 200, {
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion,
              capabilities: {},
              serverInfo: { name: "synthetic-native-contract", version: "1" },
            },
          });
          return;
        }
        if (method === "notifications/initialized") {
          exactKeys(payload, ["jsonrpc", "method"], "initialized notification");
          if (!sessions.has(session))
            throw new Error("Initialized notification used an unknown session");
          requests.push({ method, sessionId: session });
          respond(res, 202);
          return;
        }
        if (method !== "tools/call")
          throw new Error(`Unexpected MCP method: ${String(method)}`);
        exactKeys(payload, ["jsonrpc", "id", "method", "params"], "tools/call");
        exactKeys(payload.params, ["name", "arguments"], "tools/call params");
        if (!sessions.has(session))
          throw new Error("tools/call used an unknown MCP session");
        if (req.headers["mcp-protocol-version"] !== protocolVersion)
          throw new Error("tools/call omitted the negotiated protocol version");
        if (payload.params.name !== historical.toolName)
          throw new Error(
            "Generic write did not use the historical native tool",
          );
        const args = object(payload.params.arguments, "tools/call arguments");
        exactKeys(args, ["featureType", "object"], "native execute arguments");
        if (args.featureType !== historical.featureType)
          throw new Error("Generic write did not use featureType=script");
        const nativeObject = object(args.object, "native script object");
        if (typeof nativeObject.script !== "string" || !nativeObject.script)
          throw new Error("Native script must be nonempty text");
        const readOnly = nativeObject.readOnly === true;
        if (
          Object.hasOwn(nativeObject, "readOnly") &&
          nativeObject.readOnly !== true
        )
          throw new Error("Mutable call must omit readOnly");
        exactKeys(
          nativeObject,
          readOnly ? ["script", "readOnly"] : ["script"],
          "native script object",
        );

        const record = {
          jsonrpc: payload.jsonrpc,
          id: payload.id,
          method,
          params: {
            name: payload.params.name,
            arguments: {
              featureType: args.featureType,
              object: {
                script: nativeObject.script,
                ...(Object.hasOwn(nativeObject, "readOnly")
                  ? { readOnly: nativeObject.readOnly }
                  : {}),
              },
            },
          },
        };
        requests.push({
          method,
          id: payload.id,
          sessionId: session,
          readOnly,
          readOnlyField: nativeObject.readOnly,
          script: nativeObject.script,
          wire: record,
        });

        writeSyntheticReceipt(nativeObject.script, root, instance);
        const probe = nativeObject.script.includes("FMCAD_QUEUE_INSTANCE");
        let text;
        if (probe) {
          if (!readOnly)
            throw new Error("Instance probe must be classified read-only");
          text = "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance);
        } else {
          if (readOnly !== historical.readOnly)
            throw new Error("Generic write must be classified as mutable");
          if (!nativeObject.script.includes("OwnedCounter"))
            throw new Error("Final script omitted the owned counter write");
          writeCount++;
          if (writeCount !== 1)
            throw new Error("Generic write was submitted more than once");
          text = 'FMCAD_RESULT {"success":true,"parameter":"OwnedCounter"}';
        }
        respond(res, 200, {
          jsonrpc: "2.0",
          id: payload.id,
          result: { content: [{ type: "text", text }] },
        });
      } catch (error) {
        violations.push(error instanceof Error ? error.message : String(error));
        respond(
          res,
          payload &&
            (typeof payload.id === "string" || typeof payload.id === "number")
            ? 200
            : 400,
          {
            jsonrpc: "2.0",
            id:
              payload &&
              (typeof payload.id === "string" || typeof payload.id === "number")
                ? payload.id
                : null,
            error: {
              code: -32600,
              message: "Synthetic native MCP contract rejected",
            },
          },
        );
      }
    });
  });

  return {
    requests,
    responses,
    violations,
    get writeCount() {
      return writeCount;
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error(
          "Synthetic endpoint did not bind an ephemeral TCP port",
        );
      return `http://127.0.0.1:${address.port}/mcp`;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

module.exports = {
  historical,
  pythonSource,
  createNativeContractEndpoint,
};

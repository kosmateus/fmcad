import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import type { FmcadConfiguration } from "../../packages/core/src/domain/config";
import type { ObjectValue } from "../../packages/node-adapters/src/fusion-transport/contracts";
import type {
  LegacyBackend,
  LegacyRequest,
} from "../../src/composition/library-legacy-worker";
import type { main as CliMain } from "../../src/entrypoints/cli";
import type { prepareRequest as PrepareRequest } from "../../src/composition/execution-request";
import type { BrokerMcpClient as McpClientType } from "../../packages/node-adapters/src/fusion-transport/mcp";

interface DiagnosticResult {
  code: number;
  calls: unknown[];
  stdout: string;
  stderr: string;
  loads: number;
}

const root = path.resolve(__dirname, "../../..");
const load = createRequire(path.join(root, "package.json"));
const { main } = load("./src/cli") as { main: typeof CliMain };
const { prepareRequest } = load("./src/composition/execution-request") as {
  prepareRequest: typeof PrepareRequest;
};
const { execute } = load(
  "./src/composition/legacy-worker",
) as typeof import("../../src/composition/library-legacy-worker");
const { BrokerMcpClient } = load(
  "./packages/node-adapters/dist/fusion-transport/mcp",
) as typeof import("../../packages/node-adapters/src/fusion-transport/mcp");
const { BrokerAddinClient } = load(
  "./packages/node-adapters/dist/fusion-transport/addin",
) as typeof import("../../packages/node-adapters/src/fusion-transport/addin");

// Replace only the wire endpoint. CLI admission, worker dispatch and response
// parsing remain production code; the removed direct-client CLI hooks are unused.
export default async function invoke(
  argv: string[],
  backend: "mcp" | "addin" = "mcp",
  text = "DONE",
): Promise<DiagnosticResult> {
  const calls: unknown[] = [];
  const wireCalls: ObjectValue[] = [];
  let stdout = "",
    stderr = "",
    loads = 0,
    submissions = 0;
  const Base: typeof McpClientType =
    backend === "addin" ? BrokerAddinClient : BrokerMcpClient;
  const cfg: FmcadConfiguration = {
    backend,
    routing: "queue",
    url: "http://offline.invalid/mcp",
    headers: {},
    timeoutMs: 100,
    tool: "fusion_mcp_execute",
    transport: "node",
    protocolVersion: "2025-06-18",
    queue: { autoStart: false },
    controlCenter: { port: 4748 },
  };
  class Client extends Base {
    override readonly server: FmcadConfiguration;

    constructor(server: FmcadConfiguration) {
      super(server, {
        version: "test",
        requestTimeout: () => 100,
        bridgeSource: () => "",
      });
      this.server = server;
    }
    override async _openSession(): Promise<string> {
      return "offline";
    }
    override async callTool(request: ObjectValue, name?: string) {
      calls.push(request);
      return super.callTool(request, name);
    }
    override async _post(payload: ObjectValue) {
      wireCalls.push(payload);
      const result =
        backend === "addin"
          ? { structuredContent: { success: true, stdout: text }, content: [] }
          : { content: [{ type: "text", text }] };
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload["id"],
          result,
        }),
      };
    }
  }
  const code = await main(argv, {
    loadConfig() {
      loads++;
      return { cfg };
    },
    async runQueued(rawArgv, commandConfig) {
      submissions += 1;
      assert.equal(commandConfig.backend, backend);
      const prepared = prepareRequest({
        request: { argv: rawArgv, cwd: process.cwd(), backend },
      });
      const preparedPayload = (prepared as unknown as { payload?: unknown })
        .payload;
      assert.ok(
        preparedPayload &&
          typeof preparedPayload === "object" &&
          !Array.isArray(preparedPayload),
      );
      assert.equal(
        (preparedPayload as Record<string, unknown>)["kind"],
        "legacy-command",
      );
      const original = process.stdout.write;
      process.stdout.write = ((value: string | Uint8Array) => {
        stdout += String(value);
        return true;
      }) as typeof process.stdout.write;
      try {
        const client = new Client(commandConfig);
        const backendClient: LegacyBackend = {
          server: commandConfig,
          async listTools() {
            return [];
          },
          callTool(argumentsObj, tool) {
            if (
              !argumentsObj ||
              typeof argumentsObj !== "object" ||
              Array.isArray(argumentsObj)
            )
              throw new Error("Expected object-shaped diagnostic request");
            return client
              .callTool(argumentsObj as ObjectValue, tool)
              .then((result) => ({
                text: result.text,
                failed: result.failed,
                data: result.data,
                ...(typeof result.stderr === "string"
                  ? { stderr: result.stderr }
                  : {}),
              }));
          },
        };
        return await execute(
          prepared as unknown as LegacyRequest,
          backendClient,
          () => {},
        );
      } finally {
        process.stdout.write = original;
      }
    },
    stdout: {
      write: (value) => {
        stdout += value;
      },
    },
    stderr: {
      write: (value) => {
        stderr += value;
      },
    },
    setExitCode() {},
  });
  assert.equal(
    wireCalls.length,
    submissions,
    "One wire execution per admitted diagnostic",
  );
  for (const payload of wireCalls) {
    const params = payload["params"];
    assert.ok(params && typeof params === "object" && !Array.isArray(params));
    assert.equal(
      (params as Record<string, unknown>)["name"],
      backend === "addin" ? "execute_python" : "fusion_mcp_execute",
    );
  }
  return { code, calls, stdout, stderr, loads };
}

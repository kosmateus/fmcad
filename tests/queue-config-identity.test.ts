import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const load = createRequire(
  path.join(process.cwd(), "tests", "queue-config-identity.test.js"),
);
const { brokerConfigHash } = load("../src/queue-instance") as {
  brokerConfigHash(config: Record<string, unknown>): string;
};
const { brokerConfigHash: brokerCompositionHash } = load(
  "../src/queue-broker",
) as { brokerConfigHash(config: Record<string, unknown>): string };

const config = {
  backend: "addin",
  url: "http://127.0.0.1:8765/mcp",
  headers: {},
  timeoutMs: 180000,
  tool: "execute_python",
  transport: "windows-curl",
  curlPath: "/mnt/c/Windows/System32/curl.exe",
  protocolVersion: "2025-06-18",
  routing: "queue",
  queue: { autoStart: true },
  controlCenter: { port: 4748 },
};

test("broker configuration identity preserves the historical physical backend hash", () => {
  const historical = {
    backend: config.backend,
    url: config.url,
    headers: config.headers,
    timeoutMs: config.timeoutMs,
    tool: config.tool,
    transport: config.transport,
    curlPath: config.curlPath,
    protocolVersion: config.protocolVersion,
    routing: "direct",
    queue: {},
  };
  const expected = createHash("sha256")
    .update(JSON.stringify(historical))
    .digest("hex");

  assert.equal(brokerConfigHash(config), expected);
  assert.equal(brokerCompositionHash, brokerConfigHash);
  for (const local of [
    { routing: "direct", queue: {}, controlCenter: { port: 5391 } },
    {
      routing: "queue",
      queue: {
        autoStart: false,
        startupTimeoutMs: 45000,
        client: "test-client",
      },
      controlCenter: { port: 6000 },
    },
  ] as const) {
    assert.equal(brokerConfigHash({ ...config, ...local }), expected);
  }
});

test("broker configuration identity still fences changes to physical backend settings", () => {
  const baseline = brokerConfigHash(config);
  for (const [key, value] of [
    ["backend", "mcp"],
    ["url", "http://127.0.0.1:8766/mcp"],
    ["headers", { Authorization: "Bearer changed" }],
    ["timeoutMs", 120000],
    ["tool", "other_tool"],
    ["transport", "node"],
    ["curlPath", "/custom/curl"],
    ["protocolVersion", "2026-01-01"],
  ] as const) {
    assert.notEqual(
      brokerConfigHash({ ...config, [key]: value }),
      baseline,
      key,
    );
  }
});

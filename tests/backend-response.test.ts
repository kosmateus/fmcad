import { createRequire } from "node:module";
const testRoot = process.cwd();
const runtimeRequire = createRequire(
  testRoot + "/tests/backend-response.test.js",
);
import test from "node:test";
import assert from "node:assert/strict";
const { McpClient } = runtimeRequire(
  "../src/client",
) as typeof import("../src/composition/library-client");

test("JSON script output mentioning event: is not mistaken for an SSE stream", () => {
  const value = {
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            stdout: "event: diagnostic\ndata: plain text\n",
          }),
        },
      ],
    },
  };
  assert.deepEqual(McpClient.prototype._parse(JSON.stringify(value)), value);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { postHttp } from "../packages/node-adapters/src/fusion-transport/http.js";
import { postCurl } from "../packages/node-adapters/src/fusion-transport/curl.js";

test("test log matches the exact HTTP and curl request bodies, including wrappers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fmcad-wire-"));
  const previous = process.env["FMCAD_TEST_WIRE_DIRECTORY"];
  const received: Buffer[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push(Buffer.concat(chunks));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"jsonrpc":"2.0","id":2,"result":{}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const target = {
    url: `http://127.0.0.1:${address.port}/mcp`,
    curlPath: "curl",
    headers: { authorization: "secret-not-in-log" },
  };
  try {
    delete process.env["FMCAD_TEST_WIRE_DIRECTORY"];
    await postHttp(
      target,
      {
        method: "tools/call",
        params: {
          name: "execute_python",
          arguments: { code: 'print("not logged")' },
        },
      },
      {},
    );
    assert.deepEqual(readdirSync(directory), []);
    process.env["FMCAD_TEST_WIRE_DIRECTORY"] = directory;
    await postHttp(target, { method: "ping" }, {});
    assert.deepEqual(readdirSync(directory), []);
    for (const send of [postHttp, postCurl]) {
      const code = `# wrapper\nprint("zażółć ${received.length}")\nrun("")\n`;
      await send(
        target,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "execute_python",
            arguments: { code, persistent: false },
          },
        },
        {},
      );
      const body = received.at(-1)!;
      const hash = createHash("sha256").update(body).digest("hex");
      assert.deepEqual(readFileSync(join(directory, `${hash}.json`)), body);
      assert.equal(readFileSync(join(directory, `${hash}.py`), "utf8"), code);
      assert.equal(body.includes(Buffer.from("secret-not-in-log")), false);
    }
    assert.equal(readdirSync(directory).length, 4);
  } finally {
    if (previous === undefined) delete process.env["FMCAD_TEST_WIRE_DIRECTORY"];
    else process.env["FMCAD_TEST_WIRE_DIRECTORY"] = previous;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

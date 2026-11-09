import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(path.resolve(__dirname, "../../package.json"));
const { postHttp } = load(
  "./src/dist/fusion-transport/http",
) as typeof import("../packages/node-adapters/dist/fusion-transport/http");
const { McpClient } = load(
  "./src/client",
) as typeof import("../src/composition/library-client");

test(
  "existing backend timeout bounds a continuously streaming fake response",
  { timeout: 3000 },
  async () => {
    const child = spawn(process.execPath, [
      "-e",
      `const http=require('http');
    const s=http.createServer((q,r)=>{r.writeHead(200);r.write('data: {}\\n');
      const t=setInterval(()=>r.write('data: {}\\n'),5);r.on('close',()=>clearInterval(t));});
    s.listen(0,'127.0.0.1',()=>console.log(s.address().port));setTimeout(()=>process.exit(),2000);`,
    ]);
    try {
      const [data] = await once(child.stdout, "data");
      const server = {
        url: `http://127.0.0.1:${Number(String(data))}`,
        timeoutMs: 60,
      };
      const payload = { jsonrpc: "2.0", id: 1, method: "ping" };
      // The public facade intentionally rejects direct execution. Exercise the
      // broker's actual HTTP adapter against this isolated fake stream instead.
      await assert.rejects(new McpClient(server).controlPost(payload), {
        code: "QUEUE_REQUIRED",
      });
      const start = performance.now();
      await assert.rejects(
        postHttp(server, payload, {}),
        /timeout.*outcome unknown.*inspect/,
      );
      assert.ok(performance.now() - start < 1000);
    } finally {
      child.kill();
      await once(child, "close");
    }
  },
);

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { McpClient } = require('../src/client');

test('existing backend timeout bounds a continuously streaming fake response', { timeout: 3000 }, async () => {
  const child = spawn(process.execPath, ['-e', `const http=require('http');
    const s=http.createServer((q,r)=>{r.writeHead(200);r.write('data: {}\\n');
      const t=setInterval(()=>r.write('data: {}\\n'),5);r.on('close',()=>clearInterval(t));});
    s.listen(0,'127.0.0.1',()=>console.log(s.address().port));setTimeout(()=>process.exit(),2000);`]);
  let client;
  try {
    const [data] = await once(child.stdout, 'data');
    client = new McpClient({ url: `http://127.0.0.1:${Number(String(data))}`, timeoutMs: 60 });
    const start = performance.now();
    await assert.rejects(client.controlPost({ jsonrpc: '2.0', id: 1, method: 'ping' }), /timeout.*outcome unknown.*inspect/);
    assert.ok(performance.now() - start < 1000);
  } finally {
    child.kill();
    await once(child, 'close');
  }
});

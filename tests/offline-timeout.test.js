const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { postHttp } = require('../packages/node-adapters/dist/fusion-transport/http');

test('existing backend timeout bounds a continuously streaming fake response', async () => {
  const child = spawn(process.execPath, ['-e', `const http=require('http');
    const s=http.createServer((q,r)=>{r.writeHead(200);r.write('data: {}\\n');
      const t=setInterval(()=>r.write('data: {}\\n'),5);r.on('close',()=>clearInterval(t));});
    s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`]);
  try {
    const [data] = await once(child.stdout, 'data');
    await assert.rejects(postHttp(
      { url: `http://127.0.0.1:${Number(String(data))}`, timeoutMs: 60 },
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      {},
    ), /Backend timeout.*outcome unknown.*inspect before retry/);
  } finally {
    child.kill();
    await once(child, 'close');
  }
});

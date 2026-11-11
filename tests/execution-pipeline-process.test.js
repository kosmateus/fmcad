'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('process crash/restart retains unresolved fake SDK ownership and never reconstructs abandoned local work', async t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'execution-crash-'));
  const stateModule = require.resolve('../src/queue-state');
  const trace = path.join(dir, 'fake-physical-send.txt');
  const script = `
const {QueueState}=require(${JSON.stringify(stateModule)});
const fs=require('node:fs');
const state=new QueueState(${JSON.stringify(dir)});
const submit=id=>state.submit({kind:'command',phased:true,requestId:id,clientId:'client',argv:['run','fake.py'],cwd:${JSON.stringify(dir)},timeoutMs:10000});
const preparing=submit('preparing');
const offline=submit('offline');state.readyTurn(offline.id);state.next();state.releaseTurn(offline.id,9000);
const active=submit('active');state.readyTurn(active.id);state.next();
state.markDispatch(active.id,{rpcCount:1,completedCount:0,rpcId:'original-send'});
fs.writeFileSync(${JSON.stringify(trace)},'original-send\\n',{flag:'wx'});
process.send({preparing:preparing.id,offline:offline.id,active:active.id});
setInterval(()=>{},1000);
`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const [ids] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => { throw new Error('Fake broker exited before crash boundary: ' + stderr); }),
  ]);
  const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  const recover = spawn(process.execPath, ['-e', `
const {QueueState}=require(${JSON.stringify(stateModule)});
const state=new QueueState(${JSON.stringify(dir)});
const ids=${JSON.stringify(ids)};
process.stdout.write(JSON.stringify({preparing:state.status(ids.preparing),offline:state.status(ids.offline),active:state.status(ids.active),next:state.next()}));
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', recoveryError = '';
  recover.stdout.on('data', bytes => { output += bytes; });
  recover.stderr.on('data', bytes => { recoveryError += bytes; });
  const [code] = await once(recover, 'close');
  assert.equal(code, 0, recoveryError);
  const result = JSON.parse(output);
  assert.equal(result.preparing.code, 'LOCAL_WORKER_INTERRUPTED');
  assert.equal(result.offline.code, 'LOCAL_WORKER_INTERRUPTED');
  assert.equal(result.active.state, 'needs_reconciliation');
  assert.equal(result.active.dispatch.rpcCount, 1);
  assert.equal(result.next, null);
  assert.equal(fs.readFileSync(trace, 'utf8'), 'original-send\n', 'restart never repeats the fake physical dispatch');
});

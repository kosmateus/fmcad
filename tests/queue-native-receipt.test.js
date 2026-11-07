'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { wrapScript, fusionPath, readJson, workflowNonterminal, workflowOutputNonterminal } = require('../src/queue-instance');
const native = require('../src/queue-native-receipt');

const identity = { commandId: 'fmcad_atomic_' + 'a'.repeat(32), runId: 'native-receipt-test',
  requestHash: 'b'.repeat(64), sessionNonce: 'c'.repeat(32), backend: 'addin',
  resolvedIdentity: { creationId: 'owned-document' } };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receipt = path.join(dir, 'remote.json');
  const binding = { jobId: 'job', rpcId: 'rpc', requestHash: 'request', buildHash: 'build' };
  const instance = { pid: 1, birth: 'birth', version: 'version', activeCommand: 'SelectCommand' };
  const record = { binding, instance, receipt };
  const declared = { ...binding, instance, terminal: false, stage: 'native-start', native: { kind: 'atomic-batch', identity } };
  const completed = { ...binding, instance, terminal: true, stage: 'native-completion', outcome: 'succeeded',
    native: { kind: 'atomic-batch', identity, state: { destroyed: true, completed: true, outcome: 'committed', notStarted: false } } };
  return { dir, record, declared, completed };
}

test('native declaration and termination are distinct from a synchronous script receipt', t => {
  const f = setup(t);
  fs.writeFileSync(f.record.receipt, JSON.stringify({ ...f.record.binding, terminal: true, outcome: 'succeeded', instance: f.record.instance }));
  assert.equal(native.start(f.record), null);
  fs.writeFileSync(f.record.receipt + '.native-start.json', JSON.stringify(f.declared));
  assert.deepEqual(native.start(f.record), f.declared);
  assert.equal(native.completion(f.record), null, 'script success cannot certify native termination');
  fs.writeFileSync(f.record.receipt + '.native-end.json', JSON.stringify(f.completed));
  assert.deepEqual(native.completion(f.record), f.completed);
});

test('native proof refuses foreign bindings, native identities and nonterminal events', t => {
  const f = setup(t);
  fs.writeFileSync(f.record.receipt + '.native-start.json', JSON.stringify(f.declared));
  for (const mutate of [v => { v.rpcId = 'foreign'; }, v => { v.instance.birth = 'foreign'; },
    v => { v.native.identity.commandId = 'fmcad_atomic_' + 'd'.repeat(32); },
    v => { v.native.state.destroyed = false; }, v => { v.terminal = false; }]) {
    const value = structuredClone(f.completed); mutate(value);
    fs.writeFileSync(f.record.receipt + '.native-end.json', JSON.stringify(value));
    assert.throws(() => native.completion(f.record), { code: 'NATIVE_RECEIPT_MISMATCH' });
  }
});

test('a correlated destroyed native command can have a failed model outcome without remaining active', () => {
  assert.equal(workflowNonterminal({ identity, destroyed: true, completed: false, outcome: 'aborted' }), false);
  assert.equal(workflowNonterminal({ identity, destroyed: false, completed: false, outcome: 'unknown' }), true);
  assert.equal(workflowNonterminal({ destroyed: true, completed: false, outcome: 'unknown' }), true, 'unidentified destruction is not proof');
  assert.equal(workflowOutputNonterminal({ content: [{ type: 'text', text: JSON.stringify({ success: true,
    stdout: 'FMCAD_RESULT ' + JSON.stringify({ result: { status: 'pending', completed: false } }) }) }] }), true);
});

test('wrapped Python publishes an original-bound native completion after the script already returned', t => {
  const f = setup(t);
  const bootstrap = `import sys, types, os, json
app = types.SimpleNamespace(version='fake-version',userInterface=types.SimpleNamespace(activeCommand='SelectCommand'))
adsk=types.ModuleType('adsk'); core=types.ModuleType('adsk.core')
core.Application=types.SimpleNamespace(get=lambda:app);adsk.core=core
sys.modules.update({'adsk':adsk,'adsk.core':core})
`;
  const code = `import adsk.core
a=adsk.core.Application.get()
a.lifecycle=globals()['__fmcad_native_lifecycle__']
a.native_identity=${JSON.stringify(identity)}
a.lifecycle['start']('atomic-batch',a.native_identity)`;
  const after = `
assert os.path.isfile(${JSON.stringify(f.record.receipt)})
assert not os.path.exists(${JSON.stringify(f.record.receipt + '.native-end.json')})
# A nonpersistent MCP host may clear/reuse its execution globals after reply.
# The deferred event must retain its original writer, binding and identity.
for _name in list(globals()):
    if _name.startswith(('_qi_', '_qr_')):
        globals().pop(_name)
app.lifecycle['complete']('atomic-batch',app.native_identity,dict(destroyed=True,completed=True,outcome='committed',accepted=True,createdCount=1,executeCount=1))
`;
  // This unit host is Linux; production Fusion receives the Windows/WSL UNC
  // spelling. Adapt only that filesystem binding, not the receipt writer.
  const wrapped = wrapScript(code, false, f.record.receipt, f.record.binding).replace(
    '_qr_path = ' + JSON.stringify(fusionPath(f.record.receipt)), '_qr_path = ' + JSON.stringify(f.record.receipt));
  const result = spawnSync('python3', ['-B', '-c', bootstrap + wrapped + after], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const script = readJson(f.record.receipt);
  const actual = { ...f.record, instance: script.instance };
  assert.equal(native.start(actual).native.identity.commandId, identity.commandId);
  assert.equal(native.completion(actual).native.state.destroyed, true);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { documentSelector, compareDocumentState } = require('../src/queue-document');
const { serve } = require('../src/queue-broker');
const { request } = require('../src/queue-connection');

const snapshot = (name, revision, value = 1) => ({ status: 'complete', fingerprint: `${name}-${revision}`,
  state: { identity: { creationId: name, fileId: name + '-file', isModified: true }, parameters: [{ name: 'length', value }] } });

test('document selection and comparison are file scoped, not queue-revision scoped', () => {
  assert.deepEqual(documentSelector({ kind: 'command', request: { argv: ['stats', '--doc', 'A'] } }), { name: 'A' });
  assert.deepEqual(documentSelector({ kind: 'command', request: { argv: ['run', 'x.py', '--doc-id', 'editor'] } }), { creationId: 'editor' });
  assert.equal(compareDocumentState(snapshot('A', 1), snapshot('A', 1)), null);
  assert.equal(compareDocumentState(snapshot('A', 1), snapshot('A', 2)), 'DOCUMENT_CHANGED');
  assert.equal(compareDocumentState(snapshot('A', 1), snapshot('B', 1)), 'DOCUMENT_TARGET_CHANGED');
  assert.equal(compareDocumentState(null, snapshot('A', 1)), 'DOCUMENT_BASELINE_REQUIRED');
  assert.equal(compareDocumentState(snapshot('A', 1), { status: 'unavailable' }), 'DOCUMENT_STATE_UNAVAILABLE');
});

test('broker admits unchanged A after B, and returns changed A data in the same turn without original execution', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-'));
  const states = { A: snapshot('A', 1), B: snapshot('B', 1) };
  let productCalls = 0;
  const instance = { pid: 99, birth: 'mock:99', version: 'mock', activeCommand: 'SelectCommand', documents: [] };
  function execute(script) {
    const bindingMatch = script.match(/_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/);
    const receiptMatch = script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
    if (bindingMatch) {
      assert.ok(receiptMatch, 'A bound physical request must declare its receipt path');
      const binding = JSON.parse(JSON.parse(bindingMatch[1]));
      fs.writeFileSync(JSON.parse(receiptMatch[1]), JSON.stringify({ ...binding, terminal: true, outcome: 'succeeded', instance }));
    }
    if (script.includes('FMCAD_QUEUE_INSTANCE')) {
      const wrapped = script.match(/exec\(compile\(("(?:\\.|[^"\\])*")/);
      const source = wrapped ? JSON.parse(wrapped[1]) : script;
      const match = source.match(/_qd_capture\(_app, _qi_cast\(dict\[str, object\] \| None, _qi_json.loads\(("(?:\\.|[^"\\])*")\)\)\)/);
      if (source.includes("_value['documentState']")) assert.ok(match, 'Read the requested selector rather than returning an unscoped probe');
      const selector = match ? JSON.parse(JSON.parse(match[1])) : undefined;
      const documentState = selector?.metadataOnly ? { status: 'metadata-only' } : selector ? states[selector.name] : undefined;
      return 'FMCAD_QUEUE_INSTANCE ' + JSON.stringify({ ...instance, ...(documentState ? { documentState } : {}) });
    }
    productCalls++;
    return '{}';
  }
  const physical = { server: { timeoutMs: 2000 }, _parse: JSON.parse,
    async _post(payload) {
      const args = payload.params.arguments;
      const text = execute(args.object?.script || args.code || '');
      return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text }] } }) };
    },
    async callTool(value) {
      return { failed: false, text: execute(value.object?.script || '') };
    } };
  const broker = await serve({ backend: 'addin', timeoutMs: 2000 }, { dir, confirmOwnership: true,
    createBackend: () => physical, nativePath: file => file, pollMs: 5 });
  t.after(async () => { await broker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const a = { clientId: 'a', clientToken: 'private-a' }, b = { clientId: 'b', clientToken: 'private-b' };
  await request(dir, { action: 'register', ...a }); await request(dir, { action: 'register', ...b });
  const call = (auth, action, values = {}) => request(dir, { auth, action, ...values });
  async function run(auth, name, sequence) {
    const job = await call(auth, 'submit', { request: { requestId: randomUUID(), kind: 'command', cwd: dir,
      argv: ['stats', '--doc', name], timeoutMs: 2000, ...(sequence ? { sequence } : {}) } });
    // Offline admission has its own preparation budget, separate from the SDK turn.
    const deadline = Date.now() + 180000 + 2000 + 10000;
    while (Date.now() < deadline) {
      const result = await call(auth, 'result', { jobId: job.id });
      if (['succeeded', 'failed', 'needs_reconciliation'].includes(result.job.state)) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Controlled command did not finish');
  }
  const first = await run(a, 'A', { action: 'begin' });
  assert.equal(first.job.state, 'succeeded', JSON.stringify(first));
  assert.equal(first.job.sequenceState, 'yielded');
  states.B = snapshot('B', 2);
  assert.equal((await run(b, 'B')).job.state, 'succeeded');
  const continued = await run(a, 'A', { action: 'continue', id: first.job.sequenceId });
  assert.equal(continued.job.state, 'succeeded', JSON.stringify(continued));
  assert.equal(productCalls, 3, 'Each successful observation executes once');
  states.A = snapshot('A', 2, 9);
  const before = productCalls;
  const changed = await run(a, 'A', { action: 'end', id: first.job.sequenceId });
  assert.equal(changed.job.code, 'DOCUMENT_CHANGED');
  assert.equal(changed.job.userScriptSubmitted, false);
  assert.equal(productCalls, before, 'The original operation must not run');
  const fresh = JSON.parse(changed.stdout);
  assert.equal(fresh.automaticallyRefreshed, true);
  assert.equal(fresh.currentState.state.parameters[0].value, 9);
  assert.ok(fs.existsSync(fresh.refreshedStatePath));
  assert.equal(broker.status().blocked, null);
  assert.equal(broker.status().lease, null);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dispatchPrepared, completeSdkTurn, executionFailed, reconciledExecution,
  executeWorker } = require('../packages/core/dist');
const { runWorker } = require('../packages/node-adapters/dist/execution/worker');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('read and mutation use prepared/check/admission/send/settle ports without CLI or retry', async () => {
  for (const operation of ['document.status', 'model.create_box']) {
    const trace = [];
    const result = await dispatchPrepared({
      prepare() { trace.push('prepare'); return { operation, bytes: 'checked bytes' }; },
      check(prepared) { assert.equal(prepared.bytes, 'checked bytes'); trace.push('check'); },
      admit(send) { trace.push('grant'); return send(); },
      fence() { trace.push('fence'); queueMicrotask(() => trace.push('microtask')); },
      async send(prepared) { trace.push('send'); return prepared.operation; },
      settle(_, reply) { trace.push('settle'); return reply; },
      unknown() { assert.fail('known execution'); },
    });
    assert.equal(result, operation);
    assert.deepEqual(trace, ['prepare', 'check', 'grant', 'fence', 'send', 'microtask', 'settle']);
  }
});

test('checker refusal is before admission and an actual-send fence rejects paused/reset stale work', async () => {
  let admitted = 0, submitted = 0, unknown = 0;
  const refusals = [];
  const paused = deferred();
  let generation = 0;
  const ports = {
    prepare: () => ({ generation }), check() {},
    async admit(send) { admitted++; await paused.promise; return send(); },
    fence(prepared) { if (prepared.generation !== generation) throw new Error('DOCUMENT_CHANGED'); },
    async send() { submitted++; return true; }, settle: (_, reply) => reply,
    unknown() { unknown++; },
    notSubmitted(error) { refusals.push(error.message); },
  };
  await assert.rejects(dispatchPrepared({ ...ports, check() { throw new Error('CHECK_FAILED'); } }), /CHECK_FAILED/);
  assert.equal(admitted, 0);
  const pending = dispatchPrepared(ports);
  await Promise.resolve(); await Promise.resolve();
  generation++; paused.resolve();
  await assert.rejects(pending, /DOCUMENT_CHANGED/);
  assert.equal(submitted, 0);
  assert.equal(unknown, 0);
  assert.deepEqual(refusals, ['CHECK_FAILED', 'DOCUMENT_CHANGED']);
});

test('lost reply or settle evidence is unknown and never retries the physical send', async () => {
  for (const failAt of ['send', 'settle']) {
    let submitted = 0, unknown = 0;
    await assert.rejects(dispatchPrepared({
      prepare: () => 1, check() {}, admit: send => send(), fence() {},
      async send() { submitted++; if (failAt === 'send') throw new Error('ACK_LOST'); return 1; },
      settle() { throw new Error('RECEIPT_MISSING'); }, unknown() { unknown++; },
    }));
    assert.equal(submitted, 1); assert.equal(unknown, 1);
  }
});

test('native settle and postflight precede release; slow local finalize does not retain SDK ownership', async () => {
  const native = deferred(), postflight = deferred(), finalize = deferred();
  const trace = [];
  const pending = completeSdkTurn({
    async settle() { await native.promise; trace.push('native-ended'); return { mayHaveMutated: true }; },
    async postflight() { trace.push('postflight-start'); await postflight.promise; trace.push('postflight-end'); },
    release() { trace.push('release'); },
    async finalize(result) { trace.push('finalize'); await finalize.promise; return result; },
  });
  await Promise.resolve(); assert.deepEqual(trace, []);
  native.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(trace, ['native-ended', 'postflight-start']);
  postflight.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(trace, ['native-ended', 'postflight-start', 'postflight-end', 'release', 'finalize']);
  finalize.resolve(); assert.deepEqual(await pending, { mayHaveMutated: true });
});

test('positive synchronous transport cannot overwrite failed native execution', () => {
  assert.equal(executionFailed({ receiptOutcome: 'succeeded', nativeOutcome: 'failed' }), true);
  assert.equal(reconciledExecution({ outputAvailable: true, adapterUnknown: false,
    receipts: [{ outcome: 'succeeded' }], records: [{ failed: false }], nativeEnds: [{ outcome: 'failed' }] }), 'failed');
});

test('typed worker service can issue multiple turns and persists nonterminal outcomes before terminal publication', async () => {
  const records = [], calls = [];
  const backend = { async callTool(value) { calls.push(value); return value; } };
  const envelope = { id: 'job', deadline: 1, buildHash: 'build', request: { cwd: '/project', argv: [] } };
  assert.equal(await executeWorker(envelope, {
    verify() {}, backend,
    async execute(request, port, onOutcome) {
      assert.equal(request, envelope.request);
      onOutcome({ pending: true });
      await port.callTool({ readOnly: true });
      await port.callTool({ mutation: true });
      onOutcome({ pending: false }); return 0;
    }, nonterminal: value => !!value?.pending, persist: value => records.push(value),
  }), 0);
  assert.deepEqual(calls, [{ readOnly: true }, { mutation: true }]);
  assert.deepEqual(records.map(value => [value.terminal, value.nonterminal]), [[false, true], [false, false], [true, false]]);
});

test('node worker rejects an invalid build/capability before calling its typed service', async () => {
  let executed = false;
  const envelope = { id: 'job', deadline: 1, buildHash: 'original', request: { cwd: '/project', argv: [] } };
  await assert.rejects(runWorker(envelope, {
    jobId: 'job', token: 'token', buildHash: () => 'changed', configuration: { timeoutMs: 100 },
    request() { assert.fail('must not send'); }, execute() { executed = true; },
    persist() { assert.fail('must not publish'); }, nonterminal: () => false,
  }), { code: 'BUILD_CHANGED' });
  assert.equal(executed, false);
});

test('broker CAD input planning retains file pins while projecting canonical worker metadata', t => {
  const fs = require('node:fs'), path = require('node:path');
  const { createHash } = require('node:crypto');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'execution-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'input.json');
  fs.writeFileSync(file, '{}');
  const original = { argv: ['cad', 'entity', 'list', '--doc', 'Model', '--file', 'input.json'], cwd: dir,
    inputFiles: [{ path: file, sha256: createHash('sha256').update('{}').digest('hex') }] };
  const { prepareRequest } = require('../src/composition/execution-request');
  const prepared = prepareRequest({ request: original });
  assert.equal(prepared.payload.kind, 'cad-command');
  assert.equal(prepared.argv.includes('--file'), false);
  assert.deepEqual(prepared.inputFiles, original.inputFiles);
  assert.equal(original.payload, undefined);
  assert.equal(original.argv.includes('--file'), true);
  fs.writeFileSync(file, '{"different":true}');
  assert.throws(() => prepareRequest({ request: original }), { code: 'INPUT_CHANGED' });
});

'use strict';
const test = require('node:test');
// Only these synthetic physical/checker fixtures emulate WSL path spelling.
test.beforeEach(t => t.after(require('./fixtures/fake-wsl-platform.cjs')()));
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareReceiptScript } = require('../src/queue-instance');

for (const mode of ['matching-process', 'wrong-pid', 'wrong-birth', 'full-version-still-required']) {
  test('FAKE adsk, real Python: successor read guard before body: ' + mode, t => {
    const dir = fs.mkdtempSync('/tmp/opencode/successor-process-guard-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const receipt = path.join(dir, 'receipt.json'), body = path.join(dir, 'body-ran.txt');
    const expected = { pid: mode === 'wrong-pid' ? 0 : 2147483644,
      birth: mode === 'wrong-birth' ? 'wrong-birth' : '__SYNTHETIC_EXPECTED_BIRTH__' };
    const artifact = prepareReceiptScript(`with open(${JSON.stringify(body)}, 'w') as stream:\n    stream.write('ran')\n`, false,
      receipt, { jobId: 'synthetic-read', rpcId: 'synthetic-rpc', requestHash: 'a'.repeat(64), buildHash: 'synthetic-build',
        auditExpectedProcess: expected,
        ...(mode === 'full-version-still-required' ? { auditExpectedInstance: { ...expected, version: 'wrong-version' } } : {}) },
      { mapPath: value => value });
    const bootstrap = `import sys, types, os\n` +
      `core = types.ModuleType('adsk.core')\napp = types.SimpleNamespace(version='synthetic-version', userInterface=types.SimpleNamespace(activeCommand='SelectCommand'))\n` +
      `core.Application = types.SimpleNamespace(get=lambda: app)\nadsk = types.ModuleType('adsk')\nadsk.core = core\n` +
      `sys.modules['adsk'] = adsk\nsys.modules['adsk.core'] = core\n` +
      `with open('/proc/self/stat') as stream: stat = stream.read()\nwith open('/proc/sys/kernel/random/boot_id') as stream: boot = stream.read().strip()\n` +
      `birth = boot + ':' + stat[stat.rfind(')') + 2:].split()[19]\n` +
      // Only synthetic binding literals are adapted to this local Python process.
      // This is a guard-order unit test, not a prepared-artifact/SDK qualification.
      `script = ${JSON.stringify(artifact.script)}\nscript = script.replace('2147483644', str(os.getpid())).replace('__SYNTHETIC_EXPECTED_BIRTH__', birth)\nexec(compile(script, '<synthetic-receipt>', 'exec'))\n`;
    const result = spawnSync('python3', ['-B', '-c', bootstrap], { encoding: 'utf8', timeout: 10000 });
    const record = JSON.parse(fs.readFileSync(receipt));
    assert.equal(record.terminal, true);
    if (mode === 'matching-process') {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(record.outcome, 'succeeded');
      assert.equal(fs.readFileSync(body, 'utf8'), 'ran');
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(record.outcome, 'failed');
      assert.match(record.error.message, /endpoint (process|instance) changed/);
      assert.equal(fs.existsSync(body), false, 'The read body is never reached on a wrong endpoint');
    }
  });
}

test('production checker qualifies the exact successor read wire with a PID/birth guard and rejects changed final bytes', { timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync('/tmp/opencode/successor-read-admission-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '..');
  const wire = require('../src/queue-atomic-recovery-audit');
  const binding = { purpose: 'atomic-recovery-audit-v1', expectedProcess: { pid: 123, birth: 'synthetic-selected-process' },
    successorAuthorityHash: 'a'.repeat(64) };
  const identity = { commandId: 'fmcad_atomic_' + 'a'.repeat(32),
    resolvedIdentity: { name: 'Historical synthetic fixture', creationId: 'old-synthetic-id', fileId: null } };
  const reader = wire.prepareRecoveryAudit(root, identity, binding);
  const prepared = wire.prepareRecoveryAuditWire({ reader, receipt: path.join(dir, 'never-sent.json'),
    instance: { ...binding.expectedProcess, version: 'unknown-until-receipt' }, buildHash: require('../src/queue-instance').buildHash(),
    jobId: 'synthetic-read-only', auditBinding: binding, payload: { jsonrpc: '2.0', id: 'read', method: 'tools/call',
      params: { name: 'execute_python', arguments: { code: reader.artifact.script + '\n\nrun("")\n', persistent: false } } } });
  assert.deepEqual(prepared.record.binding.auditExpectedProcess, binding.expectedProcess);
  assert.equal(prepared.record.binding.auditExpectedInstance, undefined);
  const runtime = require('../src/dist/config-platform').resolveRuntimePaths({ anchor: __filename }).runtime;
  const checker = require('../src/queue-admission').createProductionQueueAdmission(runtime);
  const certificate = await checker.admission.check(prepared.outgoing, prepared.artifact);
  assert.equal(certificate.report.status, 'passed');
  assert.equal(certificate.report.provenance.checker, 'basedpyright');
  certificate.fence(prepared.outgoing);
  const changed = structuredClone(prepared.outgoing); changed.params.arguments.code += '\n# unapproved bytes';
  assert.throws(() => certificate.fence(changed));
  assert.equal(fs.existsSync(path.join(dir, 'never-sent.json')), false, 'This is checker qualification, not an SDK observation');
});

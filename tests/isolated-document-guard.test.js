'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareReceiptScript } = require('../src/queue-instance');

for (const mode of ['valid', 'missing', 'duplicate', 'saved', 'linked', 'renamed', 'invalid', 'expected-saved-file'])
test('FAKE adsk, real Python: isolated document guard before model body: ' + mode, t => {
  const dir = fs.mkdtempSync('/tmp/opencode/isolated-document-guard-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const body = path.join(dir, 'body-ran'), receipt = path.join(dir, 'receipt.json');
  const expected = { name: 'OWNED_FIXTURE', creationId: 'owned-id', fileId: mode === 'expected-saved-file' ? 'cloud-file' : null };
  const prepared = prepareReceiptScript(`with open(${JSON.stringify(body)}, 'w') as stream:\n    stream.write('ran')\n`, false, receipt,
    { jobId: 'synthetic-job', rpcId: 'synthetic-rpc', buildHash: 'synthetic-build', auditExpectedDocument: expected }, { mapPath: value => value });
  const bootstrap = `import sys, types\n` +
    `core=types.ModuleType('adsk.core')\nadsk=types.ModuleType('adsk')\nadsk.core=core\n` +
    `doc=types.SimpleNamespace(name=${JSON.stringify(mode === 'renamed' ? 'USER_RENAMED' : expected.name)},creationId='owned-id',isValid=${mode === 'invalid' ? 'False' : 'True'},isSaved=${mode === 'saved' ? 'True' : 'False'},dataFile=None,allDocumentReferences=types.SimpleNamespace(count=${mode === 'linked' ? 1 : 0}))\n` +
    `rows=${mode === 'missing' ? '[]' : mode === 'duplicate' ? '[doc,doc]' : '[doc]'}\n` +
    `app=types.SimpleNamespace(version='fixture',userInterface=types.SimpleNamespace(activeCommand='SelectCommand'),documents=types.SimpleNamespace(count=len(rows),item=lambda i:rows[i]))\n` +
    `core.Application=types.SimpleNamespace(get=lambda:app)\nsys.modules.update({'adsk':adsk,'adsk.core':core})\n` +
    prepared.script;
  const result = spawnSync('python3', ['-B', '-c', bootstrap], { encoding: 'utf8', timeout: 10000 });
  const record = JSON.parse(fs.readFileSync(receipt));
  assert.equal(record.terminal, true);
  assert.equal(record.outcome, mode === 'valid' ? 'succeeded' : 'failed');
  assert.equal(fs.existsSync(body), mode === 'valid');
  if (mode === 'valid') assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0);
});

test('production checker qualifies the actual unsaved-document guard without suppressing nullable getter diagnostics', { timeout: 180000 }, async t => {
  const dir = fs.mkdtempSync('/tmp/opencode/isolated-document-admission-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const api = require('../src/queue-instance'), wire = require('../src/queue-atomic-recovery-audit');
  const document = { name: 'FMCAD_OFFLINE_FIXTURE', creationId: 'offline-owned-document', fileId: null };
  const instance = { pid: process.pid, birth: api.processBirth(), version: 'offline-fixture' };
  const artifact = require('../src/cad').prepareCadScript('snapshot', {}, { doc: document.name, docId: document.creationId });
  const prepared = wire.prepareRecoveryAuditWire({ reader: { artifact }, receipt: path.join(dir, 'never-sent.json'),
    instance, buildHash: api.buildHash(), jobId: 'offline-only',
    auditBinding: { purpose: 'isolated-epoch-modeling-v1', currentInstance: instance, expectedDocument: document },
    payload: { jsonrpc: '2.0', id: 'offline', method: 'tools/call', params: { name: 'execute_python',
      arguments: { code: artifact.script + '\n\nrun("")\n', persistent: false } } } });
  const runtime = require('../src/dist/config-platform').resolveRuntimePaths({ anchor: __filename }).runtime;
  const certificate = await require('../src/queue-admission').createProductionQueueAdmission(runtime).admission.check(prepared.outgoing, prepared.artifact);
  assert.equal(certificate.report.status, 'passed');
  assert.equal(certificate.report.provenance.checker, 'basedpyright');
  assert.deepEqual(prepared.record.binding.auditExpectedDocument, document);
  certificate.fence(prepared.outgoing);
  const changed = structuredClone(prepared.outgoing); changed.params.arguments.code += '\n# unapproved final bytes';
  assert.throws(() => certificate.fence(changed));
  assert.equal(fs.existsSync(path.join(dir, 'never-sent.json')), false);
});

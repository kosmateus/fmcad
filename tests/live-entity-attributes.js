'use strict';

// Native coverage for the existing namespaced Fusion Attributes API, confined
// to one body in one newly-created unsaved document.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const nonce = randomUUID().replaceAll('-', '_');
const name = 'FMCAD_ATTRIBUTE_' + nonce;
const group = 'FMCAD_COVERAGE_' + nonce;
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_CLIENT ||= 'live:entity-attributes:' + randomUUID();
process.env.FMCAD_LIVE_SUITE = 'entity-attributes';

const { spawnSync, fixture } = require('./helpers/live-broker');
const { catalog, validateCad } = require('../src/cad');
const reportPath = path.join(__dirname, 'live-entity-attributes-report.json');
const report = {
  suite: 'entity-attributes', sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT },
  name, group, startedAt: new Date().toISOString(),
  scope: 'Single exact body ref in a fresh unsaved document; no save, user-document edit, or cross-document attribute access.',
  commands: [], methodResults: [], assertions: [], tests: [], ownedDocuments: [], remainingOwnedDocuments: 'unknown',
};
let baseline;
let identity;
let blockedReason;
let uncertain = false;
let failure;

function persist() { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }

function unknownIn(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.status === 'unknown' || value.executionOutcome === 'unknown' || value.completed === false ||
      ['started', 'running', 'pending'].includes(value.status)) return true;
  return Object.values(value).some(unknownIn);
}

function cli(args) {
  const result = spawnSync(process.execPath, ['bin/fmcad.js', ...args, '--timeout', '60000'], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
  });
  const row = { args, exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '',
    error: result.error?.message, status: 'not-validated' };
  report.commands.push(row);
  const text = row.stdout + row.stderr.split(/\r?\n/)
    .filter(line => !line.startsWith('FMCAD_QUEUE_') && !line.startsWith('QUEUE ')).join('\n');
  if (result.error || result.signal || result.status === null || !text.trim() ||
      /empty response|timeout|timed?\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|MCP_ERROR|HTTP [45]\d\d/i.test(text)) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Indeterminate broker result; stop and inspect before retry.');
  }
  if (/EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(text)) {
    blockedReason = text.trim();
    row.status = 'blocked';
    persist();
    throw new Error('Client/epoch preflight blocked before Fusion SDK execution.');
  }
  row.status = result.status === 0 ? 'transport-returned' : 'command-failed';
  persist();
  return row;
}

function script(body, readOnly = true) {
  if (!readOnly && uncertain) throw new Error('Mutation stopped after an unknown result.');
  const source = 'import adsk.core, adsk.fusion, json\n\ndef run(_context: str):\n' +
    body.split('\n').map(line => '    ' + line).join('\n');
  const row = cli(['call', 'fusion_mcp_execute', JSON.stringify({ featureType: 'script', object: { script: source, readOnly } })]);
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_ATTRIBUTE '));
  if (lines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Fixture probe returned no unambiguous result.');
  }
  let value;
  try { value = JSON.parse(lines[0].slice('LIVE_ATTRIBUTE '.length)); }
  catch {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Fixture probe returned malformed JSON.');
  }
  assert.equal(row.exitCode, 0, row.stderr || row.stdout);
  if (unknownIn(value)) {
    uncertain = true;
    row.status = 'unknown';
    row.parsed = value;
    persist();
    throw new Error('Fixture probe is unknown/pending; do not replay.');
  }
  row.parsed = value;
  row.status = 'validated';
  persist();
  return value;
}

function state() {
  return script(`app = adsk.core.Application.get()
docs = [{"name": d.name, "creationId": d.creationId, "fileId": d.dataFile.id if d.dataFile else None, "saved": d.isSaved, "modified": d.isModified, "active": d == app.activeDocument} for d in app.documents]
print('LIVE_ATTRIBUTE ' + json.dumps({"version": app.version, "documents": docs}))`);
}

const stable = docs => docs.map(({ active, ...doc }) => doc)
  .sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));

function unchangedOthers(current) {
  assert.deepEqual(stable(current.documents.filter(doc => doc.creationId !== identity?.creationId)), stable(baseline.documents),
    'A non-fixture document changed during attribute coverage.');
}

function guard() {
  assert.ok(identity?.creationId, 'No verified owned fixture ID.');
  const current = state();
  unchangedOthers(current);
  const matches = current.documents.filter(doc => doc.name === name);
  assert.equal(matches.length, 1, 'Fixture name is ambiguous or missing.');
  assert.equal(matches[0].creationId, identity.creationId, 'Fixture name now refers to another document.');
  assert.equal(matches[0].fileId, null, 'Fixture unexpectedly has a cloud file ID.');
  assert.equal(matches[0].saved, false, 'Fixture unexpectedly saved.');
  assert.equal(matches[0].active, true, 'Fixture is not active.');
}

function cad(operation, data) {
  assert.ok(catalog[operation], 'Unknown canonical operation: ' + operation);
  const spec = validateCad(operation, data);
  if (!spec.readOnly) guard();
  const resultRow = cli([...operation.replaceAll('.', ' ').split(' '), '--doc', name, '--doc-id', identity.creationId,
    '--component', 'root', '--data', JSON.stringify(data), '--json']);
  let output;
  try { output = JSON.parse(resultRow.stdout); }
  catch {
    if (resultRow.exitCode !== 0) throw new Error(operation + ': ' + (resultRow.stderr || resultRow.stdout));
    uncertain = true;
    resultRow.status = 'unknown';
    persist();
    throw new Error(operation + ' returned success without valid JSON.');
  }
  resultRow.parsed = output;
  if (unknownIn(output)) {
    uncertain = true;
    resultRow.status = 'unknown';
    persist();
    throw new Error(operation + ' returned unknown/pending; do not replay.');
  }
  assert.equal(resultRow.exitCode, 0, resultRow.stderr || resultRow.stdout);
  assert.equal(output.success, true, resultRow.stdout);
  assert.equal(output.operation, operation);
  assert.equal(output.document, name);
  assert.ok(output.result && typeof output.result === 'object' && Object.keys(output.result).length,
    operation + ' returned an empty result object.');
  resultRow.status = 'native-result';
  report.methodResults.push({ operation, status: output.result.status && output.result.status !== 'pass' ? output.result.status : 'invoked', result: output.result });
  persist();
  return output.result;
}

function check(operation, label, actual, expected, tolerance = 0) {
  const passed = tolerance ? Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance : actual === expected;
  report.assertions.push({ operation, label, actual, expected, tolerance, status: passed ? 'pass' : 'fail' });
  const method = report.methodResults.findLast(item => item.operation === operation && item.status === 'invoked');
  if (method) method.assertions = [...(method.assertions || []), label];
  persist();
  assert.ok(passed, label + ': ' + JSON.stringify({ actual, expected, tolerance }));
}

function validated(operation, allInvocations = false) {
  const methods = report.methodResults.filter(item => item.operation === operation && item.status === 'invoked');
  assert.ok(methods.length, operation + ' has no native invocation result to validate.');
  for (const method of allInvocations ? methods : [methods.at(-1)]) method.status = 'pass';
  persist();
}

function closeOwned() {
  if (!identity || uncertain || blockedReason) return false;
  guard();
  const result = script(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.name == ${JSON.stringify(name)} and d.creationId == ${JSON.stringify(identity.creationId)}]
assert len(matches) == 1, 'Fixture identity ambiguous; leave open'
doc = matches[0]
assert doc.dataFile is None and not doc.isSaved, 'Saved/cloud fixture; leave open'
assert doc.close(False), 'Owned unsaved close failed'
print('LIVE_ATTRIBUTE ' + json.dumps({"closedCreationId": ${JSON.stringify(identity.creationId)}}))`, false);
  assert.equal(result.closedCreationId, identity.creationId);
  fixture(name);
  return true;
}

async function main() {
  persist();
  await require('./run-live').prepareBroker();
  fixture(name);
  baseline = state();
  report.fusionVersion = baseline.version;
  report.before = baseline;
  assert.ok(!baseline.documents.some(doc => doc.name === name), 'Fixture name already exists.');

  const created = cli(['doc', 'new', '--name', name, '--json']);
  assert.equal(created.exitCode, 0, created.stderr || created.stdout);
  const afterCreate = state();
  const added = afterCreate.documents.filter(doc => !baseline.documents.some(old => old.creationId === doc.creationId));
  assert.equal(added.length, 1, 'Document creation did not create exactly one fixture.');
  assert.equal(added[0].name, name);
  assert.equal(added[0].fileId, null);
  assert.equal(added[0].saved, false);
  identity = { name, creationId: added[0].creationId };
  fixture(name, identity.creationId);
  report.ownedDocuments.push(identity);
  persist();

  try {
    guard();
    const body = cad('shape.box', { name: 'AttributeBody', width: '10 mm', depth: '10 mm', height: '10 mm' }).bodies[0];
    check('shape.box', 'one isolated native body created', Boolean(body.token), true);
    validated('shape.box');

    const first = cad('entity.attribute.set', { ref: body, group, name: 'source', value: 'first' });
    check('entity.attribute.set', 'first write changes the new attribute', first.changed, true);
    check('entity.attribute.set', 'first write records no previous value', first.previousValue, null);
    check('entity.attribute.set', 'write result identifies the body owner', first.resourceIdentity.kind, 'body');
    validated('entity.attribute.set');

    const updated = cad('entity.attribute.set', { ref: body, group, name: 'source', value: 'second' });
    check('entity.attribute.set', 'same namespaced key updates in place', updated.changed, true);
    check('entity.attribute.set', 'update returns the old string value', updated.previousValue, 'first');
    check('entity.attribute.set', 'updated string value returned', updated.value, 'second');
    validated('entity.attribute.set');

    const unchanged = cad('entity.attribute.set', { ref: body, group, name: 'source', value: 'second' });
    check('entity.attribute.set', 'same-value write reports no change', unchanged.changed, false);
    validated('entity.attribute.set');

    const exact = cad('entity.attribute.get', { ref: body, group, name: 'source' });
    check('entity.attribute.get', 'exact name lookup returns one attribute', exact.count, 1);
    check('entity.attribute.get', 'exact name lookup returns updated value', exact.attributes[0].value, 'second');
    check('entity.attribute.get', 'read result identifies the same body owner', exact.resourceIdentity.token, body.token);
    validated('entity.attribute.get');

    const groupRead = cad('entity.attribute.get', { ref: body, group });
    check('entity.attribute.get', 'group read returns one attribute', groupRead.count, 1);
    check('entity.attribute.get', 'group read returns the stored name', groupRead.attributes[0].name, 'source');
    check('entity.attribute.get', 'group read returns the stored value', groupRead.attributes[0].value, 'second');
    validated('entity.attribute.get');
    report.tests = [{ name: 'native-namespaced-attribute-write-update-and-readback', status: 'pass',
      operations: ['entity.attribute.set', 'entity.attribute.get'] }];
  } catch (error) {
    failure = error;
    report.tests = [{ name: 'native-namespaced-attribute-write-update-and-readback',
      status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
      ...(blockedReason ? { blocker: blockedReason } : {}) }];
  }

  if (!uncertain && !blockedReason && identity) {
    try { report.fixtureClosed = closeOwned(); }
    catch (error) { failure ||= error; report.cleanupError = error.message; }
  }
  if (!uncertain && !blockedReason) {
    try {
      const after = state();
      report.after = after;
      report.remainingOwnedDocuments = after.documents.filter(doc => doc.creationId === identity?.creationId || doc.name === name);
      unchangedOthers(after);
      if (report.fixtureClosed) {
        assert.deepEqual(report.remainingOwnedDocuments, [], 'Owned attribute fixture remains open.');
        const expectedActive = baseline.documents.find(doc => doc.active)?.creationId || null;
        const actualActive = after.documents.find(doc => doc.active)?.creationId || null;
        assert.equal(actualActive, expectedActive, 'Original active document was not restored.');
      }
    } catch (error) { failure ||= error; report.finalAuditError = error.message; }
  } else if (blockedReason) {
    report.finalAuditStatus = 'NOTRUN-after-explicit-broker-block';
    report.cleanupStatus = identity ? 'NOTRUN-to-avoid-retrying-blocked-owner-client' : 'not-needed-no-fixture-created';
  }

  report.operationCoverage = ['shape.box', 'entity.attribute.set', 'entity.attribute.get'].map(operation => {
    const outcomes = report.methodResults.filter(row => row.operation === operation).map(row => row.status);
    return { operation, canonical: true, test: 'tests/live-entity-attributes.js',
      status: outcomes.includes('pass') ? 'pass' : outcomes.includes('fail') ? 'fail' :
        outcomes.includes('blocked') ? 'blocked' : uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run' };
  });
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  if (failure || report.tests?.[0]?.status !== 'pass' || report.finalAuditError || (!report.fixtureClosed && !blockedReason)) {
    console.error('FAIL entity attributes: ' + (failure?.message || report.finalAuditError || 'suite did not complete and clean up'));
    process.exitCode = 1;
  } else console.log('PASS entity.attribute.set/get native roundtrip');
}

main().catch(error => {
  if (/Shared broker build differs|EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(error.message))
    blockedReason = error.message;
  report.tests = [{ name: 'attribute-suite-setup', status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail',
    error: error.message, ...(blockedReason ? { blocker: blockedReason } : {}) }];
  report.operationCoverage = ['shape.box', 'entity.attribute.set', 'entity.attribute.get'].map(operation => ({
    operation, canonical: true, test: 'tests/live-entity-attributes.js',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run',
  }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL entity attributes: ' + error.stack);
  process.exitCode = 1;
});

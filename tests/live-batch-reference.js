'use strict';

// Small real-kernel regression for the broker's code-vs-RPC-reference guard.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadConfig } = require('../src/config');
const { executeCad } = require('../src/cad');
const { createBackend, fixture } = require('./helpers/live-broker');

async function main() {
  assert.ok(process.argv.includes('--run'), 'Explicit --run required');
  const id = randomUUID();
  const name = 'FMCAD_BATCH_REF_' + id.replaceAll('-', '_');
  process.env.FMCAD_LIVE_ROUTING = 'queue';
  process.env.FMCAD_LIVE_CLIENT = 'live:batch-reference:' + id;
  process.env.FMCAD_LIVE_SUITE = 'batch-reference';
  fixture(name);
  const { cfg } = loadConfig({ routing: 'queue' });
  const client = createBackend({ ...cfg, timeoutMs: 60000 }, { command: true });
  const directory = path.resolve(__dirname, '../.test-artifacts/live-batch-reference', id);
  fs.mkdirSync(directory, { recursive: true });
  const report = { name, realFusion: true, startedAt: new Date().toISOString(), controlOutcomes: [] };
  const persist = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  const call = client.callTool.bind(client);
  client.callTool = async (...args) => {
    const out = await call(...args);
    for (const line of out.text.split(/\r?\n/).filter(line => line.startsWith('FMCAD_RESULT '))) {
      const value = JSON.parse(line.slice('FMCAD_RESULT '.length));
      report.controlOutcomes.push({ status: value.status, completed: value.completed, destroyed: value.destroyed,
        outcome: value.outcome, executeCount: value.executeCount });
    }
    return out;
  };
  const script = async body => {
    const out = await client.callTool({ featureType: 'script', object: { script:
      'import adsk.core, json\ndef run(context):\n' + body.split('\n').map(line => '    ' + line).join('\n') } });
    assert.equal(out.failed, false, out.text);
    return JSON.parse(out.text);
  };
  const state = () => script('a=adsk.core.Application.get()\nprint(json.dumps(sorted([dict(id=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified,active=d==a.activeDocument) for d in a.documents],key=lambda d:d["id"])))');
  try {
    report.before = await state();
    report.identity = await script(`a=adsk.core.Application.get()
assert not any(d.name == ${JSON.stringify(name)} for d in a.documents)
previous=a.activeDocument.creationId if a.activeDocument else None
d=a.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
d.name=${JSON.stringify(name)}
print(json.dumps(dict(creationId=d.creationId,previous=previous)))`);
    fixture(name, report.identity.creationId);
    const context = { doc: name, docId: report.identity.creationId, component: 'root' };
    report.batch = await executeCad(client, 'batch.run', { runId: 'ref_' + id.replaceAll('-', '_'),
      reportPath: path.join(directory, 'batch'), operations: [
        { id: 'seed', operation: 'shape.box', data: { name: 'OwnedRefBox', width: '2 mm', depth: '3 mm', height: '4 mm' } },
        { id: 'gate', operation: 'check', data: { measurement: { operation: 'measure.volume',
          data: { ref: { $ref: 'seed.result.bodies.0' }, units: 'mm3' } }, expected: '24 mm^3', tolerance: '0.001 mm^3' } },
      ] }, context);
    persist();
    assert.equal(report.batch.success, true, JSON.stringify(report.batch));
    assert.equal(report.batch.atomic.effective, true);
    assert.deepEqual(report.batch.steps.map(step => step.status), ['success', 'success']);
    assert.ok(Math.abs(report.batch.steps[1].output.result.actual.value - 24) <= 0.001);
    report.closed = await script(`a=adsk.core.Application.get()
owned=[d for d in a.documents if d.creationId == ${JSON.stringify(report.identity.creationId)}]
assert len(owned)==1 and owned[0].name==${JSON.stringify(name)} and not owned[0].isSaved
assert owned[0].close(False)
previous=[d for d in a.documents if d.creationId==${report.identity.previous ? JSON.stringify(report.identity.previous) : 'None'}]
if previous: assert previous[0].activate()
print(json.dumps(dict(closed=True)))`);
    fixture(name);
    report.after = await state();
    assert.deepEqual(report.after, report.before, 'Original documents/active state changed');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack;
    throw error; // Retain failed/uncertain fixture; never blindly close/replay.
  } finally {
    client.reqOpts.agent.destroy();
    report.finishedAt = new Date().toISOString(); persist();
    console.log('BATCH_REFERENCE_REPORT ' + path.join(directory, 'report.json'));
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });

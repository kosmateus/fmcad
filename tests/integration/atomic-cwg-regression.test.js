'use strict';

// Live integration regression test (contract §5 scenario 10): the CWG recipes
// and the modeling skeleton run in the default ATOMIC mode, an explicit
// atomic:false preserves the legacy stop-after-error semantics with a correct
// non-atomic report, and old (legacy) reports remain readable.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { docName, fmcad, cad, resetDoc, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; resetDoc(); });
afterEach(function () { if (!hasDoc()) return; resetDoc(); });

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-cwg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('S10 CWG skeleton batch runs in the default atomic mode', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  // Representative CWG skeleton operations (frame metadata + parameter + health
  // check) without any atomic:false opt-out. The full CWG recipes in
  // tests/fixtures/recipes/ are exercised via recipes.test.js; this asserts the
  // default atomic path a CWG-style batch must take.
  const report = fmcad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'cwg-atomic', operations: [
      { id: 'frame', operation: 'datum.frame', data: { name: 'CWG_Skeleton',
        origin: ['0 mm', '0 mm', '0 mm'], xAxis: [1, 0, 0], yAxis: [0, 1, 0] } },
      { id: 'params', operation: 'param.apply', data: { parameters: [{ name: 'bodyHeight', expression: '250 mm', unit: 'mm' }] } },
      { id: 'health', operation: 'history.check', data: {} },
    ] }),
    '--report-path', path.join(dir, 'run')]);
  assert.equal(report.outcome, 'committed', JSON.stringify(report));
  assert.equal(report.success, true);
  assert.equal(report.atomic.effective, true);
  assert.equal(report.steps.length, 3);
  assert.ok(report.steps.every((s) => s.status === 'success'), JSON.stringify(report.steps));
  const params = fmcad(['param', 'inspect', '--doc', doc]).result;
  assert.ok(params.parameters.some((p) => p.name === 'bodyHeight'), 'parameter must be committed');
});

test('S10 explicit atomic:false preserves legacy stop-after-error semantics', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const reportPath = path.join(dir, 'legacy');
  // Step 1 mutates, step 2 references a field step 1 does not export; under the
  // legacy non-atomic path this fails AFTER the seed, which must remain.
  const result = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'legacy-partial', atomic: false, operations: [
      { id: 'comp', operation: 'component.create', data: { name: 'Legacy_Component' } },
      { id: 'bad', operation: 'entity.inspect', data: { ref: { $ref: 'comp.result.componentx' } } },
    ] }),
    '--report-path', reportPath]);
  assert.notEqual(result.code, 0, 'legacy failed batch must exit nonzero');
  const report = result.json;
  assert.ok(report, result.stderr);
  assert.equal(report.atomic.requested, false);
  assert.equal(report.atomic.effective, false);
  assert.equal(report.success, false);
  assert.equal(report.status, 'failed');
  assert.equal(report.outcome, undefined, 'legacy reports carry no atomic outcome');
  // Legacy semantics: step 1 durably completed (retained), step 2 failed.
  assert.equal(report.steps[0].status, 'success', JSON.stringify(report.steps));
  assert.equal(report.steps[0].mutationStatus, 'completed');
  assert.equal(report.steps[1].status, 'failed');
  // The component is NOT rolled back in non-atomic mode.
  const comps = fmcad(['entity', 'list', '--doc', doc, '--data', JSON.stringify({ kind: 'component' })]).result;
  assert.ok(comps.entities.some((e) => e.name === 'Legacy_Component'), 'legacy must retain the seed');

  // The legacy report remains readable via batch summary (which exits nonzero
  // because the summarized batch failed, so use cad() and parse its JSON).
  const summaryResult = cad(['batch', 'summary', '--report-path', reportPath]);
  const summary = summaryResult.json;
  assert.ok(summary, summaryResult.stderr);
  assert.equal(summary.historical, true);
  assert.equal(summary.modelValidated, false);
  assert.equal(summary.success, false);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.steps.length, 2);
  assert.equal(summary.steps[0].status, 'success');
  assert.equal(summary.steps[1].status, 'failed');
});

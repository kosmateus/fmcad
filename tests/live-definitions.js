// Opt-in addin-only live test. Owns only its verified, unsaved scratch document.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('./helpers/live-broker');
const { loadConfig } = require('../src/config');
const { createBackend, disposeBackend } = require('./helpers/live-broker');
const { executeCad } = require('../src/cad');

async function main() {
  const root = path.resolve(__dirname, '..');
  const reportFile = path.join(__dirname, 'live-definitions-report.json');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-live-definitions-'));
  const name = 'FMCAD_DEFINITIONS_' + randomUUID().replaceAll('-', '_');
  const { fixture } = require('./helpers/live-broker');
  fixture(name);
  const { cfg } = loadConfig({ backend: 'addin' });
  const client = createBackend({ ...cfg, timeoutMs: 60000 }, { command: true });
  const report = { startedAt: new Date().toISOString(), name, tempDir, backend: cfg.backend,
    transport: cfg.transport, automaticFallback: client.capabilities.automaticFallback,
    tests: [], calls: [], measurements: [], status: 'running' };
  const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  let identity;
  let context;
  let unsafe = false;
  const rawCall = client.callTool.bind(client);
  function guardCode() {
    assert.ok(identity?.creationId, 'No verified ownership');
    return `    import adsk.core\n    app = adsk.core.Application.get()\n    owned = [d for d in app.documents if d.creationId == ${JSON.stringify(identity.creationId)}]\n    assert len(owned) == 1 and owned[0].name == ${JSON.stringify(name)} and not owned[0].isSaved, 'Owned document identity changed'\n    assert len([d for d in app.documents if d.name == ${JSON.stringify(name)}]) == 1, 'Ambiguous owned name'\n`;
  }
  client.callTool = async (request, tool) => {
    assert.equal(request.featureType, 'script');
    const copy = structuredClone(request);
    assert.ok(copy.object.script.includes('def run(_context: str):\n'));
    copy.object.script = copy.object.script.replace('def run(_context: str):\n',
      'def run(_context: str):\n' + guardCode());
    const row = { readOnly: copy.object.readOnly, guardedCreationId: identity.creationId };
    report.calls.push(row);
    save();
    try {
      const out = await rawCall(copy, tool);
      row.output = out;
      if (/timeout|timed out|ETIMEDOUT/i.test(out.text || '')) unsafe = true;
      return out;
    } catch (error) {
      row.error = error.stack;
      unsafe = true;
      throw error;
    } finally { save(); }
  };
  async function script(body, guarded = false, readOnly = true) {
    const request = { featureType: 'script', object: { readOnly,
      script: 'import adsk.core, json\ndef run(_context: str):\n' + body.split('\n').map(s => '    ' + s).join('\n') } };
    const out = await (guarded ? client.callTool(request) : rawCall(request));
    assert.equal(out.failed, false, out.text);
    return JSON.parse(out.text);
  }
  const state = () => script(`app = adsk.core.Application.get()\nprint(json.dumps({'documents': sorted([{'creationId': d.creationId, 'name': d.name, 'isSaved': d.isSaved, 'isModified': d.isModified} for d in app.documents if _fmcad_live_visible(d)], key=lambda d: d['creationId']), 'activeCreationId': app.activeDocument.creationId if app.activeDocument else None}))`);
  const cad = (op, data = {}) => executeCad(client, op, data, context);
  const audit = async () => (await cad('audit')).result;
  const normalized = value => JSON.parse(JSON.stringify(value, (key, v) => key === 'token' ? undefined : v));
  async function test(label, fn) {
    const row = { name: label, status: 'running' };
    report.tests.push(row);
    save();
    try { row.evidence = await fn(); row.status = 'passed'; }
    catch (error) { row.status = 'failed'; row.error = error.stack; throw error; }
    finally { save(); console.log(`${row.status.toUpperCase()} ${label}`); }
  }
  const step = (id, operation, data) => ({ id, operation, data, onExisting: 'reuse' });
  const batch = (id, operations, parameters = {}) => ({ runId: id, reportPath: path.join(tempDir, id), parameters, operations });
  function near(actual, expected, tolerance, label) {
    report.measurements.push({ label, actual, expected, tolerance });
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
      `${label}: actual ${actual}, expected ${expected} +/- ${tolerance}`);
  }
  function matching(out, request) {
    const savedRequest = structuredClone(request);
    delete savedRequest.reportPath;
    delete savedRequest.mode;
    assert.equal(out.runId, request.runId);
    assert.deepEqual(out.context, context);
    assert.deepEqual(out.request, savedRequest);
    const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' :
      v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
    assert.equal(out.requestHash, createHash('sha256').update(canonical({ request: savedRequest, context })).digest('hex'));
    const files = fs.readdirSync(request.reportPath).filter(f => /^\d{8}\.json$/.test(f)).sort();
    const last = JSON.parse(fs.readFileSync(path.join(request.reportPath, files.at(-1)), 'utf8'));
    assert.equal(last.requestHash, out.requestHash);
    assert.deepEqual(last.steps, out.steps);
    assert.equal(fs.existsSync(path.join(request.reportPath, 'run.lock')), false);
  }
  try {
    assert.equal(cfg.backend, 'addin');
    assert.equal(client.capabilities.automaticFallback, false);
    await test('CLI doc new and creationId ownership', async () => {
      report.before = await state();
      assert.ok(!report.before.documents.some(d => d.name === name));
      const args = ['bin/fmcad.js', '--backend', 'addin', 'doc', 'new', '--name', name, '--timeout', '60000'];
      const out = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 75000 });
      report.creation = { args, status: out.status, stdout: out.stdout, stderr: out.stderr, error: out.error?.message };
      assert.equal(out.status, 0, JSON.stringify(report.creation));
      const after = await state();
      const added = after.documents.filter(d => !report.before.documents.some(b => b.creationId === d.creationId));
      assert.equal(added.length, 1);
      assert.equal(added[0].name, name);
      assert.equal(added[0].isSaved, false);
      identity = added[0];
      fixture(name, identity.creationId);
      report.owned = identity;
      context = { doc: name, creationId: identity.creationId };
      assert.equal((await audit()).counts.bodyDefinitions, 0);
      return identity;
    });
    let request;
    let initial;
    await test('definition literal parameters and feature/body refs with numeric geometry', async () => {
      request = batch('literal', [
        step('box', 'shape.box', { name: { $param: 'name' }, width: { $param: 'width' }, depth: { $param: 'depth' }, height: { $param: 'height' } }),
        step('feature', 'entity.inspect', { ref: { $ref: 'box.result.feature' } }),
        step('bounds', 'measure.bounds', { ref: { $ref: 'box.result.bodies.0' }, units: 'mm' }),
        step('volume', 'measure.volume', { ref: { $ref: 'box.result.bodies.0' }, units: 'mm3' }),
      ], { name: 'LiteralBox', width: '23 mm', depth: '11 mm', height: '7 mm' });
      initial = await cad('definition.instantiate', request);
      report.literal = initial;
      assert.equal(initial.success, true, JSON.stringify(initial));
      matching(initial, request);
      assert.deepEqual(initial.steps[0].request.data, { name: 'LiteralBox', width: '23 mm', depth: '11 mm', height: '7 mm' });
      assert.deepEqual(initial.steps[1].request.data.ref, initial.steps[0].output.result.feature);
      assert.deepEqual(initial.steps[2].request.data.ref, initial.steps[0].output.result.bodies[0]);
      const bounds = initial.steps[2].output.result;
      assert.equal(bounds.units, 'mm');
      [23, 11, 7].forEach((v, i) => near(bounds.size[i], v, 0.001, 'literal xyz'[i] + i));
      near(initial.steps[3].output.result.value, 1771, 0.02, 'literal volume mm3');
      const observed = await audit();
      assert.equal(observed.counts.bodyDefinitions, 1);
      assert.deepEqual(observed.issues, []);
      return { counts: observed.counts, requestHash: initial.requestHash };
    });
    await test('exact successful replay reuses originally declared steps without calls or bodies', async () => {
      const before = await audit();
      const calls = report.calls.length;
      const out = await cad('definition.instantiate', request);
      assert.equal(report.calls.length, calls, 'Replay contacted Fusion');
      assert.equal(out.replayed, true);
      assert.equal(out.success, true);
      matching(out, request);
      assert.deepEqual(out.steps, initial.steps);
      const after = await audit();
      assert.deepEqual(normalized(after), normalized(before));
      return { replayed: out.replayed, callsDuringReplay: 0, counts: after.counts };
    });
    await test('same runId with different non-idempotent data rejected before mutations', async () => {
      const before = await audit();
      const changed = structuredClone(request);
      changed.parameters.name = 'MustNotExist';
      changed.parameters.width = '31 mm';
      const calls = report.calls.length;
      let rejection;
      await assert.rejects(cad('definition.instantiate', changed), e => {
        rejection = e.message;
        return /Saved request\/context hash differs; replay refused/.test(e.message);
      });
      assert.equal(report.calls.length, calls);
      assert.deepEqual(normalized(await audit()), normalized(before));
      return { rejection, callsDuringRejectedRequest: 0 };
    });
    await test('negative check stops batch and skips later box mutation', async () => {
      const before = await audit();
      const req = batch('negative', [
        step('check', 'check', { measurement: { operation: 'measure.volume', data: { ref: initial.steps[0].output.result.bodies[0], units: 'mm3' } }, expected: '1 mm^3', tolerance: '0.001 mm^3' }),
        step('later', 'shape.box', { name: 'SkippedBox', width: '5 mm', depth: '6 mm', height: '7 mm' }),
      ]);
      // This case checks the per-step non-atomic output and skip contract, not
      // atomic rollback (which reports a failed check through step.error).
      req.atomic = false;
      const out = await cad('batch.run', req);
      report.negative = out;
      assert.equal(out.success, false);
      assert.equal(out.status, 'failed');
      assert.equal(out.steps[0].output.result.passed, false);
      assert.equal(out.steps[1].status, 'skipped');
      assert.equal(out.steps[1].request, undefined);
      matching(out, req);
      assert.deepEqual(normalized(await audit()), normalized(before));
      return out.steps;
    });
    await test('Fusion numeric parameters drive measured box dimensions', async () => {
      const req = batch('numeric', [
        step('parameters', 'param.apply', { parameters: [
          { name: 'test_width', expression: { $param: 'width' }, unit: 'mm' },
          { name: 'test_depth', expression: 'test_width / 2', unit: 'mm' },
          { name: 'test_height', expression: 'test_depth + 3 mm', unit: 'mm' },
        ] }),
        step('box', 'shape.box', { name: 'ParameterBox', width: 'test_width', depth: 'test_depth', height: 'test_height' }),
        step('bounds', 'measure.bounds', { ref: { $ref: 'box.result.bodies.0' }, units: 'mm' }),
        step('volume', 'measure.volume', { ref: { $ref: 'box.result.bodies.0' }, units: 'mm3' }),
      ], { width: '18 mm' });
      const out = await cad('definition.instantiate', req);
      report.numeric = out;
      assert.equal(out.success, true, JSON.stringify(out));
      matching(out, req);
      [18, 9, 12].forEach((v, i) => near(out.steps[2].output.result.size[i], v, 0.001, 'parameter bounds ' + i));
      near(out.steps[3].output.result.value, 1944, 0.02, 'parameter volume mm3');
      const observed = await audit();
      assert.equal(observed.counts.bodyDefinitions, 2);
      assert.deepEqual(observed.issues, []);
      return observed.counts;
    });
    await test('unsupported definition syntax rejected and code-like strings remain literal', async () => {
      const before = await audit();
      const cases = [
        { label: 'missing parameter', parameters: {}, width: { $param: 'missing' }, error: /Unknown parameter: missing/ },
        { label: 'expression placeholder', parameters: { width: '3 mm' }, width: { $param: 'width + 1' }, error: /Unknown parameter: width \+ 1/ },
        { label: 'mixed placeholder', parameters: { width: '3 mm' }, width: { $param: 'width', eval: true }, error: /\$param must be the sole key/ },
      ];
      const evidence = [];
      for (const item of cases) {
        const req = batch('unsupported_' + evidence.length, [step('box', 'shape.box', { name: 'UnsupportedBox', width: item.width, depth: '2 mm', height: '3 mm' })], item.parameters);
        const calls = report.calls.length;
        const out = await cad('definition.instantiate', req);
        assert.equal(out.success, false);
        assert.match(out.errors.join('\n'), item.error);
        assert.equal(report.calls.length, calls);
        evidence.push({ label: item.label, output: out });
      }
      const literal = '__import__("builtins").str(23) + " mm"';
      const req = batch('no_eval', [
        step('box', 'shape.box', { name: 'NoEvalBox', width: { $param: 'width' }, depth: '2 mm', height: '3 mm' }),
        step('later', 'shape.box', { name: 'NoEvalLater', width: '2 mm', depth: '2 mm', height: '2 mm' }),
      ], { width: literal });
      const preview = await cad('definition.instantiate', { ...req, mode: 'preview' });
      assert.equal(preview.operations[0].data.width, literal);
      const out = await cad('definition.instantiate', req);
      assert.equal(out.success, false);
      assert.equal(out.steps[0].request.data.width, literal);
      assert.match(out.steps[0].error.message, /Invalid or incompatible expression/);
      assert.equal(out.steps[1].status, 'skipped');
      evidence.push({ label: 'code-like dimension rejected, not evaluated to 23 mm', output: out });
      assert.deepEqual(normalized(await audit()), normalized(before));
      return evidence;
    });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack;
    process.exitCode = 1;
    console.error(error.stack);
  } finally {
    if (identity && !unsafe && report.status === 'passed') {
      try {
        report.finalAudit = await audit();
        report.cleanup = await script("assert owned[0].close(False), 'Owned close failed'\nprint(json.dumps({'closed': True}))", true, false);
        fixture(name);
        report.after = await state();
        assert.deepEqual(report.after.documents, report.before.documents, 'User documents changed');
        assert.equal(report.after.activeCreationId, report.before.activeCreationId, 'Original active document not restored');
        report.userDocumentsPreserved = true;
      } catch (error) {
        report.status = 'failed';
        report.cleanupError = error.stack;
        process.exitCode = 1;
      }
    } else {
      report.cleanup = { closed: false, reason: 'Failure evidence retained; no automatic retry or uncertain close' };
    }
    disposeBackend(client);
    report.finishedAt = new Date().toISOString();
    save();
    console.log(`Report: ${reportFile}\nBatch evidence: ${tempDir}\nOverall: ${report.status}`);
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });

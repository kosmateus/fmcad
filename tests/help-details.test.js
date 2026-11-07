const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { detail } = require('../src/help');
const { commands, findCommand } = require('../src/commands');
const { catalog, validateCad, executeCad } = require('../src/cad');
const { parseCadInput } = require('../src/cad-input');
const { validateBatch, expandDefinition, resolveReferences, runBatch } = require('../src/batch');
const { main } = require('../src/cli');
const example = require('../src/help-batch-example.json');

test('every CAD detail retains catalog inputs and adds shared CLI conventions', () => {
  for (const entry of commands.filter(c => c.kind === 'cad')) {
    const text = detail(...entry.key.split(' '));
    if (entry.requiresDoc) {
      assert.match(text, /--project-id/);
      assert.match(text, /NOT JSON-decoded/);
      assert.match(text, /--json makes it compact/);
    } else if (entry.target === 'batch.summary') {
      assert.match(text, /historical:true/);
      assert.match(text, /modelValidated:false/);
    }
    for (const [field, description] of Object.entries(catalog[entry.target].inputs)) {
      assert.ok(text.includes(`${field}: ${description}`), `${entry.target}.${field}`);
    }
    assert.ok(text.includes(entry.example), entry.key);
  }
});

test('modeling, sketch, document and export aliases resolve to the same offline preview contract', async () => {
  for (const entry of commands.filter(c => c.kind === 'cad' && /^(model|sketch|document|export)\./.test(c.target))) {
    const outputs = [];
    for (const spelling of [entry.key, ...(entry.aliases || [])]) {
      assert.equal(findCommand(spelling.split(' ')), entry);
      assert.equal(detail(...spelling.split(' ')), detail(...entry.key.split(' ')));
      let output = '';
      assert.equal(await main([...spelling.split(' '), '--doc', 'Model', '--data',
        JSON.stringify(catalog[entry.target].example), '--preview'], {
        loadConfig: () => assert.fail('Preview must stay offline'),
        stdout: { write: text => { output += text; } }, stderr: { write: text => assert.fail(text) },
      }), 0, spelling);
      const preview = JSON.parse(output);
      assert.equal(preview.operation, entry.target);
      assert.equal(preview.mutation, false);
      outputs.push(preview);
    }
    for (const output of outputs) assert.deepEqual(output, outputs[0]);
  }
});

test('contextual sections are not blindly copied to unrelated help', () => {
  assert.doesNotMatch(detail('simulation', 'capabilities'), /Sketch workflow:|Entity references and scope:|Files and safety:|Step schema:/);
  assert.doesNotMatch(detail('model', 'extrude'), /Modes and reports:|Save workflow:|Worked JSON payload/);
  assert.doesNotMatch(detail('projects'), /CLI input and output:|Sketch workflow:/);
});

test('all catalog example outer structures pass the existing offline validators', () => {
  for (const [operation, spec] of Object.entries(catalog)) {
    assert.doesNotThrow(() => validateCad(operation, spec.example), operation);
    if (spec.nodeOnly && !spec.offline && spec.example?.runId && Array.isArray(spec.example?.operations)) {
      const checked = validateBatch(spec.example, catalog);
      assert.equal(checked.success, true, `${operation}: ${checked.errors}`);
    }
  }
  const validation = validateBatch(example, catalog);
  assert.equal(validation.success, true, validation.errors.join('\n'));
  assert.equal(validation.operations.length, 6);
  assert.equal(validation.operations[3].data.expression, '40 mm');
  for (const step of validation.operations) assert.doesNotThrow(() => validateCad(step.operation, step.data));
});

test('documented direct flags parse with real CLI types and optional empty cloud folder', () => {
  const input = parseCadInput(['--doc', 'Model', '--name', 'Housing', '--project', 'ProductProject',
    '--folder', '', '--confirm', 'true'], catalog['document.save_as'].inputs);
  assert.deepEqual(input.data, { name: 'Housing', project: 'ProductProject', folder: '', confirm: true });
  assert.doesNotThrow(() => validateCad('document.save_as', input.data));
  const parsed = parseCadInput(['--doc', 'Model', '--component', 'Part:1', '--input-component',
    '{"kind":"component","name":"Part"}'], catalog['component.inspect'].inputs);
  assert.equal(parsed.component, 'Part:1');
  assert.deepEqual(parsed.data.component, { kind: 'component', name: 'Part' });
});

test('worked example resolves actual handler-shaped output paths and exact replay with a mock executor', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcad-help-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const data = { ...structuredClone(example), reportPath: directory };
  const component = { kind: 'component', token: 'component-token', name: 'HelpBracket' };
  const sketch = { kind: 'sketch', token: 'sketch-token', component };
  const circle = { kind: 'SketchCircle', token: 'circle-token', component };
  const body = { kind: 'body', token: 'body-token', component };
  // Mirrors result keys in assembly.py, model.py and core.py; does not emulate geometry or the solver.
  const results = [{ component }, { sketch }, { entities: [circle], refs: { rim: circle } },
    { dimension: { token: 'dimension-token' }, parameter: 'd1', expression: '40 mm' },
    { feature: { token: 'feature-token' }, bodies: [body], healthState: 0, message: '' }, body];
  let calls = 0;
  const context = { doc: 'Model', component: 'root', projectId: null, preview: false };
  const report = await runBatch(null, data, context, async (_client, operation, payload, scope) => {
    assert.doesNotThrow(() => validateCad(operation, payload));
    assert.deepEqual(scope.component, calls === 0 ? 'root' : component);
    if (calls === 2 || calls === 3) assert.deepEqual(payload.sketch, sketch);
    if (calls === 3) {
      assert.deepEqual(payload.entities, [circle]);
      assert.equal(payload.expression, '40 mm');
    }
    if (calls === 4) assert.deepEqual(payload.profile, { kind: 'profile', sketch });
    if (calls === 5) assert.deepEqual(payload.ref, body);
    return { success: true, operation, document: 'Model', result: results[calls++], created: [] };
  }, catalog);
  assert.equal(calls, 6);
  assert.equal(report.success, true);
  assert.equal((await runBatch(null, data, context, () => assert.fail('Replay must not execute'), catalog)).replayed, true);
});

test('documented substitution limits preserve strings and replace whole values', () => {
  const expanded = expandDefinition({ parameters: { size: '40 mm' }, operations: [
    { component: { $param: 'size' }, data: { text: 'prefix $param', expression: { $param: 'size' } } },
  ] });
  assert.equal(expanded.operations[0].component, '40 mm');
  assert.equal(expanded.operations[0].data.text, 'prefix $param');
  assert.equal(expanded.operations[0].data.expression, '40 mm');
  assert.deepEqual(resolveReferences({ a: { $ref: 'base.result.bodies.0' }, b: 'base.result.bodies.0' },
    { base: { result: { bodies: [{ token: 'body' }] } } }), { a: { token: 'body' }, b: 'base.result.bodies.0' });
});

test('worked payload previews and detailed help aliases never load a backend or write reports', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcad-help-preview-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const reportPath = path.join(directory, 'must-not-exist');
  const data = { ...example, reportPath };
  for (const operation of ['batch.validate', 'batch.preview', 'batch.run', 'definition.instantiate']) {
    const result = await executeCad(null, operation, data, { doc: 'Model', preview: true });
    assert.equal(result.success, true);
    assert.equal(result.mutation, false);
  }
  for (const argv of [['batch', 'validate', '--doc', 'Model', '--data', JSON.stringify(data)],
    ['definition', 'instantiate', '--doc', 'Model', '--data', JSON.stringify(data), '--preview'],
    ['help', 'batch', 'run'], ['cad', 'export', 'step', '--help'], ['doc', 'save-as', '-h']]) {
    let stdout = '';
    assert.equal(await main(argv, { loadConfig: () => assert.fail('Must stay offline'),
      stdout: { write: text => { stdout += text; } }, stderr: { write: text => assert.fail(text) },
      setExitCode: code => assert.fail(`Unexpected exit ${code}`) }), 0);
    assert.ok(stdout.length > 0);
  }
  await assert.rejects(fs.access(reportPath), { code: 'ENOENT' });
  assert.equal(findCommand(['cad', 'export', 'step']).target, 'export.step');
});

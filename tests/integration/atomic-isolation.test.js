'use strict';

// Live integration tests for document isolation, transport timeout, queuing/
// conflict, and external-effect rejection (contract §5 scenarios 6-9). As with
// the other atomic suites, every test skips cleanly when FMCAD_TEST_DOC is
// unset and every hook guards clear().

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { docName, fmcad, cad, resetDoc, hasDoc, skipLive } = require('./helper');

const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'fmcad.js');

beforeEach(function () { if (!hasDoc()) return; resetDoc(); });
afterEach(function () { if (!hasDoc()) return; resetDoc(); });

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-iso-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function snapshot(doc) {
  const out = fmcad(['audit', '--doc', doc]);
  assert.equal(out.success, true, JSON.stringify(out));
  return out.result;
}

function assertModelUnchanged(doc, baseline, label) {
  const after = snapshot(doc);
  assert.deepEqual(after.counts, baseline.counts, `${label}: counts must be identical`);
  const d = fmcad(['diff', '--doc', doc, '--data', JSON.stringify({ before: baseline, after })]).result;
  const real = (d.changes || []).filter((c) => !c.path.startsWith('/document/isModified'));
  assert.deepEqual(real, [], `${label}: only isModified may differ, got ${JSON.stringify(real)}`);
  return after;
}

// Run the CLI with a caller-controlled transport --timeout (the helper's
// fmcad/cad pin a 60 s timeout, so a short timeout needs its own spawn).
function runWithTimeout(args, timeoutMs) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--json', '--timeout', String(timeoutMs)], {
    cwd: ROOT, encoding: 'utf8', timeout: 75000, maxBuffer: 32 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* refused/transport errors print diagnostics */ }
  return { code: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

// Invoke an addin tool directly (e.g. execute_python) without the --json/--timeout
// flags that CAD commands require. Returns { code, stdout, stderr }.
function callTool(tool, jsonArgs) {
  const result = spawnSync(process.execPath, [BIN, 'call', tool, JSON.stringify(jsonArgs)], {
    cwd: ROOT, encoding: 'utf8', timeout: 75000, maxBuffer: 32 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Read the current active command id via "fmcad active".
function activeCommandId() {
  const result = spawnSync(process.execPath, [BIN, 'active'], {
    cwd: ROOT, encoding: 'utf8', timeout: 75000, maxBuffer: 32 * 1024 * 1024,
  });
  try { return JSON.parse(result.stdout).activeCommand.id; } catch { return null; }
}

const seedSteps = (name) => [
  { id: 'comp', operation: 'component.create', data: { name } },
  { id: 'section', operation: 'sketch.create', data: { name: 'Section', plane: 'XY' } },
  { id: 'circle', operation: 'sketch.geometry', data: { sketch: { $ref: 'section.result.sketch' },
    geometry: [{ type: 'circle', name: 'rim', center: ['0 mm', '0 mm', '0 mm'], radius: '10 mm' }] } },
  { id: 'solid', operation: 'model.extrude', data: { name: 'Body',
    profile: { kind: 'profile', sketch: { $ref: 'section.result.sketch' } },
    distance: '10 mm', operation: 'newBody' } },
];

test('S6 wrong/absent document is rejected with no wrong-target mutation', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const baseline = snapshot(doc);

  // Wrong document name: the pinned doc cannot be resolved/activated, so the
  // batch fails before mutating anything.
  const wrong = cad(['batch', 'run', '--doc', 'DefinitelyNotOpen v999',
    '--data', JSON.stringify({ runId: 'iso-wrong-doc', operations: seedSteps('WrongDoc') }),
    '--report-path', path.join(dir, 'wrong')]);
  assert.notEqual(wrong.code, 0, 'wrong-document batch must fail');

  // Absent document: the CLI refuses before dispatching.
  const absent = cad(['batch', 'run',
    '--data', JSON.stringify({ runId: 'iso-absent-doc', operations: seedSteps('AbsentDoc') }),
    '--report-path', path.join(dir, 'absent')]);
  assert.notEqual(absent.code, 0, 'absent --doc batch must fail');

  // Neither attempt may touch the real test document.
  assertModelUnchanged(doc, baseline, 'S6 document isolation');
});

test('S6 active open command: atomic batch is refused without mutating the document', async (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const baseline = snapshot(doc);

  // Open an interactive command (a button command with a text input keeps the
  // dialog open, so the addin reports a non-idle active command). Persistent
  // mode keeps the command definition + handler alive so the dialog stays open.
  callTool('execute_python', { code: [
    'import adsk.core',
    'app = adsk.core.Application.get()',
    'ui = app.userInterface',
    'class Created(adsk.core.CommandCreatedEventHandler):',
    '    def notify(self, event):',
    "        event.command.commandInputs.addTextBoxCommandInput('s6text', 'S6', '', 1, True)",
    "cmdDef = ui.commandDefinitions.addButtonDefinition('fmcad_s6_test', 'S6 Test', 'S6 active command test')",
    'onCreated = Created()',
    'cmdDef.commandCreated.add(onCreated)',
    's6_cmddef = cmdDef',
    's6_oncreated = onCreated',
    'cmdDef.execute()',
    "print('OPENED')",
  ].join('\n'), persistent: true, session_id: 'fmcad-s6' });
  t.after(() => callTool('execute_python', { code: [
    'import adsk.core',
    'app = adsk.core.Application.get()',
    "app.executeTextCommand('Commands.Cancel')",
    "app.executeTextCommand('Commands.Start SelectCommand')",
    'try:',
    "    d = app.userInterface.commandDefinitions.itemById('fmcad_s6_test')",
    '    if d is not None and not d.isNative:',
    '        d.deleteMe()',
    'except Exception:',
    '    pass',
    "print('CLOSED')",
  ].join('\n'), persistent: true, session_id: 'fmcad-s6' }));

  // The command open is asynchronous; wait until the addin reports it active.
  let active = null;
  for (let i = 0; i < 30; i++) {
    active = activeCommandId();
    if (active && active !== 'SelectCommand') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(active && active !== 'SelectCommand', `expected an open command, got ${active}`);

  // The atomic batch must be refused while the command is open (no mutation).
  const result = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 's6-active', operations: seedSteps('S6_Active') }),
    '--report-path', path.join(dir, 'run')]);
  assert.notEqual(result.code, 0, 'atomic batch must be refused while a command is open');
  const report = result.json;
  assert.ok(report, result.stderr);
  assert.match(report.error && report.error.message || result.stderr + result.stdout,
    /command is open|interactive|idle|atomic_start failed/i);
  assertModelUnchanged(doc, baseline, 'S6 active command');
});

test('S7 transport timeout stays unknown with no replay and no second mutation', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const baseline = snapshot(doc);
  const reportPath = path.join(dir, 'run');
  // A 1 ms transport timeout fires before the atomic script returns; the client
  // must NOT retry or fabricate a success, and Fusion is not cancelled.
  const result = runWithTimeout(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'iso-timeout', operations: seedSteps('Timeout') }),
    '--report-path', reportPath], 1);
  assert.notEqual(result.code, 0, 'a timed-out batch must exit nonzero');
  if (result.json && result.json.outcome) {
    assert.equal(result.json.outcome, 'unknown', JSON.stringify(result.json));
  } else {
    assert.match(result.stderr + result.stdout, /timeout|timed out|ETIMEDOUT|unknown/i, result.stderr);
  }
  // No automatic replay: the same identity is refused (lock/report exists).
  const again = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'iso-timeout', operations: seedSteps('Timeout') }),
    '--report-path', reportPath]);
  assert.notEqual(again.code, 0, 'replay under the same identity must be refused');
  // The model may only differ by isModified (no second mutation applied); the
  // validator reconciles the final model state by runId before cleanup.
  assertModelUnchanged(doc, baseline, 'S7 timeout');
});

test('S8 pre-existing run.lock blocks a mutating batch (queue/conflict)', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const baseline = snapshot(doc);
  const reportPath = path.join(dir, 'locked');
  fs.mkdirSync(reportPath, { recursive: true });
  fs.writeFileSync(path.join(reportPath, 'run.lock'), '');
  const result = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify({ runId: 'iso-locked', operations: seedSteps('Locked') }),
    '--report-path', reportPath]);
  assert.notEqual(result.code, 0, 'a locked run must be refused');
  assert.match(result.stderr + result.stdout, /Run is locked|inspect/i, result.stderr);
  assertModelUnchanged(doc, baseline, 'S8 lock guard');
});

test('S8 same runId run twice is refused (no mix, no replay)', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const data = { runId: 'iso-twice', operations: seedSteps('Twice') };
  const first = fmcad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify(data), '--report-path', path.join(dir, 'run')]);
  assert.equal(first.outcome, 'committed', JSON.stringify(first));
  // A second execution under the same identity is refused, never silently mixed
  // into a single session.
  const again = cad(['batch', 'run', '--doc', doc,
    '--data', JSON.stringify(data), '--report-path', path.join(dir, 'run')]);
  assert.notEqual(again.code, 0, 're-executing the same runId must be refused');
});

test('S9 external-effect operations are rejected before any mutation', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const dir = tmpdir(t);
  const baseline = snapshot(doc);
  // save / export / checkpoint lifecycle are rejected inside an atomic batch
  // before the first mutation (contract §1, §5 scenario 9).
  const cases = [
    ['document.save_as', { name: 'Never', project: 'x', folder: '', confirm: true }],
    ['export.native', { path: 'C:/never/export.f3d', ref: 'root' }],
    ['checkpoint.create', { path: 'C:/never/checkpoint.f3d' }],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [operation, data] = cases[i];
    const result = cad(['batch', 'run', '--doc', doc,
      '--data', JSON.stringify({ runId: `iso-external-${i}`, operations: [
        { id: 'seed', operation: 'component.create', data: { name: `ExternalSeed${i}` } },
        { id: 'ext', operation, data },
      ] }),
      '--report-path', path.join(dir, `ext-${i}`)]);
    const report = result.json;
    assert.ok(report, `${operation}: ${result.stderr}`);
    assert.notEqual(result.code, 0, `${operation} must exit nonzero (rejected)`);
    // All external-effect operations (save/export/checkpoint lifecycle) are
    // rejected before the first mutation with a consistent outcome:'rejected',
    // whether rejected at batch validation (batchAllowed:false) or the atomic
    // preflight.
    assert.equal(report.outcome, 'rejected', `${operation} must report rejected`);
    assert.equal(report.mutated, false, `${operation} must not mutate`);
    assert.ok(report.errors && report.errors.some((e) => /external-effect|external effect|save|export|checkpoint|invoked separately/.test(e)),
      `${operation}: ${JSON.stringify(report.errors)}`);
    assertModelUnchanged(doc, baseline, `S9 ${operation}`);
  }
});

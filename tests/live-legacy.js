// Opt-in live migration gate. Never run this as part of the mock suite.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('./helpers/live-broker');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_MIGRATION_TEST_' + new Date().toISOString().replace(/[:.]/g, '_');
const { fixture } = require('./helpers/live-broker');
fixture(name);
const reportPath = path.join(__dirname, 'live-legacy-report.json');
const exportParent = process.env.FMCAD_LIVE_EXPORT_DIR || os.tmpdir();
const exportDir = path.join(exportParent, name);
const shotPath = path.join(os.tmpdir(), name + '.png');
const report = { name, startedAt: new Date().toISOString(), scope: 'Legacy local document commands only; no cloud or licensing approval', tests: [], commands: [], files: [], testDocumentRemainsOpen: 'unknown' };
report.backend = require('../src/config').loadConfig({}).cfg.backend;
let baseline;
let owned = false;
function persist() {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}
function cli(args) {
  const result = spawnSync(process.execPath, ['bin/fmcad.js', ...args, '--timeout', '30000'], {
    cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 16 * 1024 * 1024,
  });
  report.commands.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  persist();
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result.stdout;
}
function snapshot(requireOwned = false) {
  const script = `import adsk.core, adsk.fusion, json
def run(_context: str):
    app = adsk.core.Application.get()
    docs = [{"name": d.name, "creationId": d.creationId, "modified": d.isModified, "saved": d.isSaved, "active": d == app.activeDocument} for d in app.documents if _fmcad_live_visible(d)]
    state = {"documents": docs, "active": app.activeDocument.name if app.activeDocument else None}
    if state["active"] == ${JSON.stringify(name)}:
        design = adsk.fusion.Design.cast(app.activeProduct)
        state["designType"] = int(design.designType)
        state["timelineCount"] = design.timeline.count
        state["marker"] = design.timeline.markerPosition
        state["bodies"] = design.rootComponent.bRepBodies.count
        state["units"] = design.unitsManager.defaultLengthUnits
        state["parameters"] = [{"name": p.name, "expression": p.expression, "value": p.value} for p in design.userParameters]
        state["planes"] = [{"name": p.name, "origin": p.geometry.origin.asArray(), "normal": p.geometry.normal.asArray()} for p in design.rootComponent.constructionPlanes]
    print("LIVE_STATE " + json.dumps(state))
`;
  const text = cli(['call', 'fusion_mcp_execute', JSON.stringify({ featureType: 'script', object: { readOnly: true, script } })]);
  const line = text.split('\n').find((s) => s.startsWith('LIVE_STATE '));
  assert.ok(line, text);
  const state = JSON.parse(line.slice(11));
  if (requireOwned) {
    assert.ok(owned, 'Test document ownership not established');
    assert.equal(state.active, name, 'Active document is not the owned test');
    assert.equal(state.documents.filter((d) => d.name === name).length, 1);
  }
  return state;
}
function doc(...args) {
  snapshot(true);
  const text = cli([...args, '--doc', name]);
  assert.ok(text.includes('DOC name=' + name), text);
  return text;
}
function group(label, fn, enabled = true) {
  if (!enabled) {
    report.tests.push({ name: label, status: 'not-tested', reason: 'Prerequisite failed' });
    persist();
    return false;
  }
  try {
    fn();
    report.tests.push({ name: label, status: 'passed' });
    console.log('PASS ' + label);
    persist();
    return true;
  } catch (error) {
    report.tests.push({ name: label, status: 'failed', error: error.message, stack: error.stack });
    console.error('FAIL ' + label + ': ' + error.message);
    persist();
    return false;
  }
}

const listed = group('doc list and baseline', () => {
  cli(['doc', 'list']);
  baseline = snapshot();
  report.before = baseline;
  assert.ok(!baseline.documents.some((d) => d.name === name));
});
const created = group('doc new and ownership', () => {
  cli(['doc', 'new', '--name', name]);
  const state = snapshot();
  assert.equal(state.documents.length, baseline.documents.length + 1);
  assert.equal(state.documents.filter((d) => d.name === name).length, 1);
  owned = true;
  fixture(name, state.documents.find(d => d.name === name).creationId);
  report.created = state;
  assert.ok(cli(['doc', 'list']).includes(name));
}, listed);
group('param_add/list/set/rename/delete', () => {
  doc('param_add', 'migration_width', '10 mm', 'mm', 'live migration test');
  assert.match(doc('param_list'), /PARAM name=migration_width expr=10 mm/);
  doc('param_set', 'migration_width', '20 mm');
  assert.equal(snapshot(true).parameters.find((p) => p.name === 'migration_width').value, 2);
  doc('param_rename', 'migration_width', 'migration_width_renamed');
  assert.match(doc('param_list'), /PARAM name=migration_width_renamed/);
  doc('param_delete', 'migration_width_renamed');
  assert.doesNotMatch(doc('param_list'), /PARAM name=migration_width/);
}, created);
const offset = group('plane_add offset/list', () => {
  doc('plane_add', 'MigrationOffset', 'offset', 'XY', '10 mm');
  assert.match(doc('plane_list'), /PLANE name=MigrationOffset/);
  assert.equal(snapshot(true).planes.find((p) => p.name === 'MigrationOffset').origin[2], 1);
}, created);
const mid = group('plane_add mid parallel planes', () => {
  doc('plane_add', 'MigrationMid', 'mid', 'XY', 'MigrationOffset');
  assert.equal(snapshot(true).planes.find((p) => p.name === 'MigrationMid').origin[2], 0.5);
}, offset);
group('plane_rename/delete/list', () => {
  doc('plane_rename', 'MigrationMid', 'MigrationMidRenamed');
  assert.match(doc('plane_list'), /PLANE name=MigrationMidRenamed/);
  doc('plane_delete', 'MigrationMidRenamed');
  assert.doesNotMatch(doc('plane_list'), /PLANE name=MigrationMid/);
}, mid);
group('plane_add angle in default design', () => {
  doc('plane_add', 'MigrationAngle', 'angle', 'XY', 'X', '30 deg');
  assert.match(doc('plane_list'), /PLANE name=MigrationAngle/);
}, created);
group('comp_add/list', () => {
  doc('comp_add', 'MigrationComponent');
  assert.match(doc('comp_list'), /COMP name=MigrationComponent parent=/);
}, created);
group('units cm/mm/in', () => {
  for (const unit of ['cm', 'mm', 'in']) {
    doc('units', unit);
    assert.equal(snapshot(true).units, unit);
  }
}, created);
const box = group('run box 10 mm; stats/bbox/bodies', () => {
  doc('run', 'box', '--args', '[10]');
  const stats = doc('stats');
  assert.match(stats, /BODIES=1 /);
  assert.doesNotMatch(stats, /TIMELINE_ISSUE/);
  assert.match(doc('bbox'), /size=\(10\.0 x 10\.0 x 10\.0\) mm/);
  assert.match(doc('bodies'), /volume=1000\.00 mm3/);
}, created);
const rollback = group('rollback and restore end', () => {
  const before = snapshot(true);
  assert.ok(before.timelineCount > 0);
  doc('rollback', String(before.timelineCount - 1));
  assert.equal(snapshot(true).bodies, 0);
  doc('rollback', String(before.timelineCount));
  const after = snapshot(true);
  assert.equal(after.marker, before.timelineCount);
  assert.equal(after.bodies, 1);
}, box);
group('shot PNG', () => {
  snapshot(true);
  assert.ok(fs.statSync(path.dirname(shotPath)).isDirectory());
  cli(['shot', '--out', shotPath, '--dir', 'iso-top-right', '--width', '800', '--height', '600']);
  assert.equal(fs.readFileSync(shotPath).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  report.files.push({ path: shotPath, bytes: fs.statSync(shotPath).size });
}, box && rollback);
for (const format of ['step', 'stl']) {
  group('export ' + format.toUpperCase(), () => {
    assert.ok(fs.statSync(exportParent).isDirectory());
    fs.mkdirSync(exportDir, { recursive: true });
    const out = path.join(exportDir, name + '.' + format);
    assert.ok(!fs.existsSync(out));
    doc('export', format, '--out', out);
    const bytes = fs.statSync(out).size;
    assert.ok(bytes > 0);
    report.files.push({ path: out, bytes });
  }, box && rollback);
}
report.tests.push({ name: 'undo/redo', status: 'not-tested', reason: 'Optional; omitted to avoid global undo-stack effects' });
group('doc close --discard with immediate owned identity assertion', () => {
  snapshot(true);
  cli(['doc', 'close', '--discard']);
  fixture(name);
}, owned);
group('existing documents preserved and no test remains', () => {
  const after = snapshot();
  report.after = after;
  report.testDocumentRemainsOpen = after.documents.some((d) => d.name === name);
  assert.equal(report.testDocumentRemainsOpen, false);
  assert.deepEqual(after.documents, baseline.documents);
  cli(['doc', 'list']);
}, !!baseline);
report.finishedAt = new Date().toISOString();
persist();
console.log('REPORT ' + reportPath);
process.exitCode = report.tests.some((t) => t.status === 'failed') ? 1 : 0;

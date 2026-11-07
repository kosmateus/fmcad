// Opt-in test of an independent server; does not import fmcad or change its config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const curl = process.env.CURL_BIN || 'curl';
const url = process.env.THIRDPARTY_MCP_URL || 'http://127.0.0.1:8765/mcp';
const reportFile = path.join(__dirname, 'thirdparty-smoke-report.json');
const report = { version: '1.4.0', pinnedCommit: '35124471380bdc967150808752cc3a428c09b61f',
  startedAt: new Date().toISOString(), endpoint: url, tests: [], userDocumentsModified: false };
let session;
let requestId = 1;
let owned;
let before;
function save() { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n'); }

function post(method, params, notify = false) {
  const id = notify ? undefined : requestId++;
  const args = ['--silent', '--show-error', '--max-time', '20', '--include', '--request', 'POST',
    '--header', 'Content-Type: application/json', '--header', 'Accept: application/json, text/event-stream',
    '--header', 'MCP-Protocol-Version: 2025-06-18'];
  if (session) args.push('--header', 'Mcp-Session-Id: ' + session);
  args.push('--data-binary', '@-', url);
  const output = spawnSync(curl, args, { input: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(output.status, 0, output.stderr || output.error?.message);
  const separator = output.stdout.search(/\r?\n\r?\n/);
  assert.ok(separator >= 0, 'Missing HTTP header separator');
  const headers = output.stdout.slice(0, separator);
  const body = output.stdout.slice(separator).trim();
  assert.match(headers, /^HTTP\/\S+ 2\d\d/m, headers);
  const sid = headers.match(/^Mcp-Session-Id:\s*(.+)$/im);
  if (sid) session = sid[1].trim();
  if (notify) return;
  let response;
  if (body.startsWith('{')) response = JSON.parse(body);
  else response = body.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/)
    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n'))
    .filter(Boolean).map(text => JSON.parse(text)).find(value => value.id === id);
  assert.ok(response && response.id === id, 'Missing corresponding JSON-RPC result');
  assert.ok(!response.error, JSON.stringify(response.error));
  return response.result;
}

function execute(code, options = {}) {
  const result = post('tools/call', { name: 'execute_python', arguments: {
    code, persistent: !!options.persistent, session_id: options.sessionId || 'fmcad-thirdparty-smoke',
  } });
  const payload = JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
  if (options.expectError) {
    assert.equal(result.isError, true);
    assert.equal(payload.success, false);
    assert.match(payload.error, /THIRD_PARTY_EXPECTED_ERROR/);
  } else {
    assert.equal(result.isError, false, JSON.stringify(payload));
    assert.equal(payload.success, true, JSON.stringify(payload));
  }
  return payload;
}
function jsonValue(code) {
  const payload = execute('import json, adsk.core, adsk.fusion\n' + code);
  return JSON.parse(payload.stdout.trim());
}
function documents() {
  return jsonValue('print(json.dumps([{ "id": d.creationId, "name": d.name, "saved": d.isSaved, "modified": d.isModified } for d in app.documents]))');
}
function guarded(code) {
  assert.ok(owned);
  return jsonValue(`assert app.activeDocument.creationId == ${JSON.stringify(owned.id)}\n` +
    `assert app.activeDocument.name == ${JSON.stringify(owned.name)}\n` + code);
}
function passed(name, details = {}) {
  report.tests.push({ name, status: 'passed', ...details }); save(); console.log('PASS ' + name);
}

try {
  report.server = post('initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'independent-fmcad-compatibility-probe', version: '1.0' } });
  post('notifications/initialized', {}, true);
  const tools = post('tools/list', {}).tools;
  assert.ok(tools.some(t => t.name === 'execute_python'));
  passed('handshake and tools', { count: tools.length });
  before = documents(); report.before = before; save();

  for (let i = 1; i <= 450; i++) {
    const payload = execute(`import sys, json\nprint(json.dumps({"probe":${i},"stdoutType":type(sys.stdout).__name__}))`);
    const value = JSON.parse(payload.stdout.trim());
    assert.equal(value.probe, i);
    assert.equal(value.stdoutType, 'StringIO');
    if (i % 100 === 0) console.log('PROGRESS independent execute_python ' + i);
    report.stressCompleted = i;
  }
  passed('450 consecutive Python executions', { emptyResponses: 0 });
  const text = 'Zażółć_日本語_🙂';
  const encoded = JSON.stringify(text).replace(/[^\x00-\x7f]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const unicode = execute('import sys, json\nprint(json.loads(' + JSON.stringify(encoded) +
    '))\nprint("stderr-marker", file=sys.stderr)');
  assert.equal(unicode.stdout.trim(), text);
  assert.equal(unicode.stderr.trim(), 'stderr-marker');
  passed('Unicode and stderr');
  execute('print("before-error")\nraise RuntimeError("THIRD_PARTY_EXPECTED_ERROR")', { expectError: true });
  assert.equal(execute('print("after-error")').stdout.trim(), 'after-error');
  passed('exception followed by successful execution');
  const persistentId = randomUUID();
  for (let i = 1; i <= 25; i++) {
    assert.equal(Number(execute('counter = globals().get("counter", 0) + 1\nprint(counter)',
      { persistent: true, sessionId: persistentId }).stdout.trim()), i);
  }
  passed('25 persistent-session executions');

  const testName = 'FMCAD_THIRDPARTY_TEST_' + randomUUID();
  owned = jsonValue(`doc=app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)\ndoc.name=${JSON.stringify(testName)}\nprint(json.dumps({"id":doc.creationId,"name":doc.name}))`);
  report.owned = owned; save();
  const created = guarded(`design=adsk.fusion.Design.cast(app.activeProduct)
root=design.rootComponent
design.userParameters.add('trial_radius',adsk.core.ValueInput.createByString('10 mm'),'mm','isolated backend test')
design.userParameters.add('trial_height',adsk.core.ValueInput.createByString('15 mm'),'mm','isolated backend test')
sk=root.sketches.add(root.xYConstructionPlane)
circle=sk.sketchCurves.sketchCircles.addByCenterRadius(adsk.core.Point3D.create(0,0,0),1)
dimension=sk.sketchDimensions.addRadialDimension(circle,adsk.core.Point3D.create(2,2,0))
dimension.parameter.expression='trial_radius'
assert sk.profiles.count == 1
inp=root.features.extrudeFeatures.createInput(sk.profiles.item(0),adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
inp.setDistanceExtent(False,adsk.core.ValueInput.createByString('trial_height'))
root.features.extrudeFeatures.add(inp)
assert design.computeAll()
b=root.bRepBodies.item(0)
print(json.dumps({'bodies':root.bRepBodies.count,'volumeMm3':b.volume*1000,'widthMm':(b.boundingBox.maxPoint.x-b.boundingBox.minPoint.x)*10,'heightMm':(b.boundingBox.maxPoint.z-b.boundingBox.minPoint.z)*10}))`);
  assert.equal(created.bodies, 1);
  assert.ok(Math.abs(created.volumeMm3 - Math.PI * 100 * 15) < 0.01);
  const updated = guarded(`design=adsk.fusion.Design.cast(app.activeProduct)
design.userParameters.itemByName('trial_radius').expression='12 mm'
design.userParameters.itemByName('trial_height').expression='20 mm'
assert design.computeAll()
b=design.rootComponent.bRepBodies.item(0)
print(json.dumps({'bodies':design.rootComponent.bRepBodies.count,'volumeMm3':b.volume*1000,'widthMm':(b.boundingBox.maxPoint.x-b.boundingBox.minPoint.x)*10,'heightMm':(b.boundingBox.maxPoint.z-b.boundingBox.minPoint.z)*10}))`);
  assert.equal(updated.bodies, 1);
  assert.ok(Math.abs(updated.volumeMm3 - Math.PI * 144 * 20) < 0.01);
  assert.ok(Math.abs(updated.widthMm - 24) < 0.001);
  assert.ok(Math.abs(updated.heightMm - 20) < 0.001);
  passed('isolated cylinder creation and parametric rebuild', { created, updated });
} catch (error) {
  report.tests.push({ name: 'smoke sequence', status: 'failed', error: error.stack });
  process.exitCode = 1; console.error(error.message);
} finally {
  try {
    if (owned) {
      const closed = jsonValue(`matches=[d for d in app.documents if d.creationId==${JSON.stringify(owned.id)} and d.name==${JSON.stringify(owned.name)}]
assert len(matches)==1 and not matches[0].isSaved
assert matches[0].close(False)
print(json.dumps({'closed':True}))`);
      assert.equal(closed.closed, true);
    }
    if (before) {
      report.after = documents();
      assert.deepEqual(report.after, before);
      passed('original documents preserved');
    }
  } catch (error) {
    report.cleanupError = error.message; process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString(); save();
  console.log('REPORT ' + reportFile);
}

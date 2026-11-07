'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { capturePng } = require('./capture-png');
const { decodeReviewPng } = require('../packages/node-adapters/dist/review/pixels');
const { CAPTURE_PIXEL_THRESHOLDS, evaluateReviewPixels } = require('../packages/core/dist/application/review/pixels');
const { reviewCmd, parseReviewArgs, buildReviewScript, views, manual } = require('../src/review');
const reportContract = require('./fixtures/review-report-contract.json');

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-review-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const out = path.join(parent, 'new');
  const args = ['--doc', 'Part α', '--doc-id', 'creation-1', '--out', out];
  let text = '', calls = 0, mapped;
  const io = { stdout: { write: value => { text += value; } } };
  const mapper = value => { mapped = value; return value; };
  const client = callback => ({ callTool: async (request, tool) => {
    calls++;
    assert.equal(tool, 'fusion_mcp_execute');
    assert.equal(request.featureType, 'script');
    assert.equal(request.object.readOnly, undefined);
    assert.match(request.object.script, /def _document_target/);
    assert.match(request.object.script, /def capture_review/);
    return callback(JSON.parse(fs.readFileSync(path.join(out, 'request.json'))));
  } });
  return { parent, out, args, io, mapper, client, get text() { return text; }, get calls() { return calls; }, get mapped() { return mapped; } };
}

function reply(request, { failed = false, restore = 'restored', count = 8 } = {}) {
  const vectors = {
    front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
    top: [0, 0, 1], bottom: [0, 0, -1], 'iso-top-left': [-1, -1, 1],
    'iso-bottom-right': [1, -1, -1],
  };
  const recipes = request.recipes || views.slice(0, count).map(name => ({ name, kind: 'orientation', orientation: name }));
  const rows = recipes.map((recipe, index) => {
    const { name } = recipe;
    const bytes = capturePng(request.width, request.height, index + 1);
    fs.writeFileSync(path.join(request.out, name + '.png'), bytes, { flag: 'wx' });
    const direction = vectors[recipe.orientation];
    const target = recipe.target || [0, 0, 0];
    const row = { name, file: name + '.png', status: 'captured', recipeKind: recipe.kind,
      requestedOrientation: recipe.orientation, camera: { cameraType: 'OrthographicCameraType',
        eye: target.map((value, axis) => value + direction[axis] * 10), target, up: [0, 0, 1], extents: [40, 30] },
      width: request.width, height: request.height, sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    if (recipe.kind === 'roi')
      row.framingReadback = { kind: 'roi', target, direction, extents: recipe.extents };
    if (recipe.kind === 'detail')
      row.framingReadback = { kind: 'detail', target, direction, scale: recipe.scale,
        fittedExtents: [40, 30], extents: [40 * recipe.scale, 30 * recipe.scale] };
    if (recipe.kind === 'section')
      row.sectionReadback = { status: 'verified', name: recipe.sectionName, visible: recipe.visible };
    return row;
  });
  const pixelIntegrity = evaluateReviewPixels(rows.map((row, index) => {
      const direction = vectors[row.requestedOrientation];
    const length = Math.hypot(...direction);
    return { name: row.name,
      pixels: decodeReviewPng(fs.readFileSync(path.join(request.out, row.file)), request.width, request.height,
        CAPTURE_PIXEL_THRESHOLDS),
      cameraDirection: direction.map(value => value / length) };
  }));
  const captureRecipes = recipes;
  const report = { schemaVersion: 1, operation: 'review', requestId: request.requestId,
    success: !failed, status: failed ? 'failed' : 'captured', requiresVisualReview: true,
    documentIdentity: { name: request.doc, creationId: request.docId, fileId: request.docFileId, version: 4, isSaved: true, isModified: true },
    fusionBuild: 'stub-build', restoration: { status: restore }, orientationVerification: { status: 'verified' }, views: rows,
    captureRecipes, pixelIntegrity,
    errors: failed ? [{ stage: 'capture', message: 'stub failure' }] : [] };
  fs.writeFileSync(path.join(request.out, 'backend-report.json'), JSON.stringify(report), { flag: 'wx' });
  return { text: 'FMCAD_RESULT ' + JSON.stringify(report), failed: false };
}

test('strict arguments and dimensions; both pins allowed; defaults and relative paths', () => {
  const base = ['--doc', 'Model', '--doc-file-id', 'cloud-1', '--out', './new'];
  assert.deepEqual(parseReviewArgs(base), { doc: 'Model', docId: null, docFileId: 'cloud-1', out: path.resolve('new'), width: 1600, height: 1200 });
  assert.equal(parseReviewArgs([...base, '--doc-id', 'creation']).docId, 'creation');
  const recipes = [{ name: 'front-roi', kind: 'roi', orientation: 'front', target: [1, 2, 3], extents: [4, 5] }];
  assert.deepEqual(parseReviewArgs([...base, '--recipes', JSON.stringify(recipes)]).recipes, recipes);
  for (const extra of [['--width', '0'], ['--height', '31'], ['--width', '4097'], ['--width', '2.5'], ['--width', '1e3'],
    ['--width', 'NaN'], ['--height'], ['--doc-file-id', 'duplicate'], ['--width', '4096', '--height', '4096'],
    ['--recipes', 'not-json'], ['--recipes', '{}'], ['--unknown', 'x'], ['positional'], ['--doc-id', 'a b']]) {
    assert.throws(() => parseReviewArgs([...base, ...extra]));
  }
  for (const args of [[], ['--doc', 'X', '--out', 'new'], ['--doc-id', 'x', '--out', 'new'], ['--doc', 'X', '--doc-id', 'x']]) {
    assert.throws(() => parseReviewArgs(args));
  }
});

test('Python payload uses shared JSON injection and identity helpers', () => {
  const script = buildReviewScript({ doc: 'x\"\n☃', docId: 'a', docFileId: null, flag: true });
  assert.match(script, /ARGS = \{/);
  assert.match(script, /def _document_activate_target/);
  assert.equal((script.match(/^def run\(/gm) || []).length, 1);
  assert.equal(manual.audit.tests.includes('tests/review_test.py'), true);
});

test('one invocation, full PNG readback and manifest; no CAD acceptance', async t => {
  const f = fixture(t);
  assert.equal(await reviewCmd(f.client(reply), f.args, f.mapper, f.io), 0);
  assert.equal(f.calls, 1);
  assert.equal(f.mapped, path.resolve(f.out));
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json')));
  assert.equal(manifest.status, 'captured');
  assert.equal(manifest.schemaVersion, reportContract.schemaVersion);
  assert.equal(manifest.operation, reportContract.operation);
  assert.equal(manifest.requiresVisualReview, reportContract.requiresVisualReview);
  assert.match(manifest.sourceArtifact.sha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.sourceArtifact.sourceMap.length > 0);
  assert.ok(manifest.sourceArtifact.units.some(unit => unit.id === 'legacy-review'));
  assert.equal(manifest.restoration.status, reportContract.restoration);
  assert.equal(manifest.documentIdentity.isModified, true);
  assert.deepEqual(Object.keys(manifest.documentIdentity).sort(), reportContract.identityFields);
  assert.deepEqual(manifest.views.map(v => v.name), reportContract.views);
  assert.deepEqual(views, reportContract.views);
  const output = JSON.parse(f.text);
  assert.equal(output.transportStatus, 'completed');
  assert.equal(output.artifactStatus, 'complete');
  assert.equal(output.cadAcceptance, 'not-evaluated');
  assert.doesNotMatch(f.text, /PASS/);
});

test('pinned public CLI review preserves selectable ROI/detail/section recipes end to end', async t => {
  const f = fixture(t);
  const recipes = [
    { name: 'front-roi', kind: 'roi', orientation: 'front', target: [1.5, 1, 0.5], extents: [4, 3] },
    { name: 'front-detail', kind: 'detail', orientation: 'front', target: [1.5, 1, 0.5], scale: 0.25 },
    { name: 'section-left', kind: 'section', orientation: 'left', sectionName: 'NativeSection', visible: true },
  ];
  const args = [...f.args, '--recipes', JSON.stringify(recipes)];
  assert.equal(await reviewCmd(f.client(reply), args, f.mapper, f.io), 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json')));
  assert.deepEqual(manifest.captureRecipes, recipes);
  assert.deepEqual(manifest.views.map(row => row.recipeKind), ['roi', 'detail', 'section']);
  assert.equal(manifest.views[2].sectionReadback.status, 'verified');
  assert.equal(manifest.views[0].framingReadback.kind, 'roi');
  assert.equal(manifest.views[1].framingReadback.kind, 'detail');
  assert.equal(manifest.documentIdentity.creationId, 'creation-1');
  assert.ok(manifest.sourceArtifact.sha256);
  assert.equal(f.calls, 1);
});

test('registered CLI validates pins and submits selectable recipes through the existing broker adapter', async t => {
  const { main } = require('../src/cli');
  const f = fixture(t);
  let brokerSubmissions = 0;
  let configReads = 0;
  const recipes = [{ name: 'front-roi', kind: 'roi', orientation: 'front',
    target: [1, 2, 3], extents: [4, 5] }];
  const recipeArgs = [...f.args, '--recipes', JSON.stringify(recipes)];
  const config = { backend: 'mcp', routing: 'queue', url: 'http://127.0.0.1:1/mcp', headers: {},
    timeoutMs: 1000, tool: 'execute_python', transport: 'node', protocolVersion: '2025-06-18',
    queue: { autoStart: false }, controlCenter: { port: 4748 } };
  const deps = { stdout: f.io.stdout, stderr: { write() {} }, setExitCode() {},
    loadConfig: () => { configReads++; return { cfg: config }; },
    createBackend: () => assert.fail('CLI must not construct a direct backend'),
    async runQueued(argv, cfg) {
      brokerSubmissions++;
      assert.equal(cfg.routing, 'queue');
      assert.deepEqual(argv, ['review', ...(brokerSubmissions === 1 ? f.args : recipeArgs)]);
      return 0;
    } };
  assert.equal(await main(['review', ...f.args.filter((_, i) => i !== 2 && i !== 3)], deps), 1);
  assert.equal(brokerSubmissions, 0);
  assert.equal(configReads, 0, 'invalid pins must fail before configuration or admission');
  assert.equal(await main(['review', ...f.args, '--recipes', 'not-json'], deps), 1);
  assert.equal(brokerSubmissions, 0, 'invalid recipe JSON must fail before admission');
  assert.equal(configReads, 0, 'invalid recipe JSON must not load configuration');
  assert.equal(await main(['review', ...f.args], deps), 0);
  assert.equal(brokerSubmissions, 1);
  assert.equal(configReads, 1);
  assert.equal(await main(['review', ...recipeArgs], deps), 0);
  assert.equal(brokerSubmissions, 2);
  assert.equal(configReads, 2);
  assert.equal(f.calls, 0, 'CLI adapter must not call the physical review worker directly');
});

test('review detailed help is available without a backend', async () => {
  const { main } = require('../src/cli');
  let output = '';
  assert.equal(await main(['help', 'review'], {
    stdout: { write(text) { output += text; } },
    createBackend() { throw new Error('Help must remain offline'); },
  }), 0);
  assert.match(output, /--recipes/);
  assert.match(output, /requiresVisualReview=true/);
});

test('existing empty directory, file, dangling symlink are rejected without dispatch or overwrite', async t => {
  for (const kind of ['directory', 'file', 'symlink']) {
    const f = fixture(t);
    if (kind === 'directory') fs.mkdirSync(f.out);
    if (kind === 'file') fs.writeFileSync(f.out, 'keep');
    if (kind === 'symlink') fs.symlinkSync(path.join(f.parent, 'absent'), f.out);
    await assert.rejects(reviewCmd(f.client(reply), f.args, f.mapper, f.io), /EEXIST/);
    assert.equal(f.calls, 0);
    if (kind === 'file') assert.equal(fs.readFileSync(f.out, 'utf8'), 'keep');
  }
});

test('concurrent claims allow exactly one dispatch', async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([reviewCmd(f.client(reply), f.args, f.mapper, f.io), reviewCmd(f.client(reply), f.args, f.mapper, f.io)]);
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value === 0).length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.calls, 1);
});

test('partial capture and restoration failure survive as failed reports', async t => {
  const f = fixture(t);
  assert.equal(await reviewCmd(f.client(r => reply(r, { failed: true, restore: 'failed', count: 2 })), f.args, f.mapper, f.io), 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json')));
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.restoration.status, 'failed');
  assert.equal(manifest.views.length, 2);
  assert.ok(fs.existsSync(path.join(f.out, 'front.png')));
});

test('timeout never retries, deletes partial evidence or claims restoration', async t => {
  const f = fixture(t);
  const client = f.client(r => { fs.writeFileSync(path.join(r.out, 'partial.png'), 'partial'); throw new Error('timeout'); });
  assert.equal(await reviewCmd(client, f.args, f.mapper, f.io), 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json')));
  assert.equal(manifest.status, 'unknown');
  assert.equal(manifest.restoration.status, 'unknown');
  assert.equal(f.calls, 1);
  assert.equal(fs.readFileSync(path.join(f.out, 'partial.png'), 'utf8'), 'partial');
});

test('malformed, mismatched, incomplete and corrupted successful evidence fails closed', async t => {
  for (const mode of ['terminal', 'nonce', 'restore', 'missing', 'corrupt', 'transport']) {
    const f = fixture(t);
    const client = f.client(r => {
      const result = reply(r, { restore: mode === 'restore' ? 'failed' : 'restored', count: mode === 'missing' ? 7 : 8 });
      if (mode === 'terminal') result.text = '{}';
      if (mode === 'nonce') {
        const report = JSON.parse(result.text.slice('FMCAD_RESULT '.length));
        report.requestId = 'wrong';
        fs.writeFileSync(path.join(r.out, 'backend-report.json'), JSON.stringify(report));
        result.text = JSON.stringify(report);
      }
      if (mode === 'corrupt') fs.appendFileSync(path.join(r.out, 'front.png'), 'tampered');
      if (mode === 'transport') result.failed = true;
      return result;
    });
    assert.equal(await reviewCmd(client, f.args, f.mapper, f.io), 1, mode);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json'))).success, false);
    assert.ok(fs.existsSync(path.join(f.out, 'front.png')));
    assert.equal(f.calls, 1);
  }
});

test('backend UI rejection is distinguished from an unknown submitted capture', async t => {
  const f = fixture(t);
  assert.equal(await reviewCmd(f.client(() => ({ failed: true, uiGuard: { notStarted: true } })), f.args, f.mapper, f.io), 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json')));
  assert.equal(manifest.status, 'rejected-before-capture');
  assert.equal(manifest.restoration.status, 'not-needed');
});

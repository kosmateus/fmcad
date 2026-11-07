'use strict';

// Native coverage for deterministic frame planning and bounded joint sampling.
// Joint motion is restored in a fresh unsaved fixture, then only that fixture closes.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const name = 'FMCAD_ANIMATION_METHODS_' + randomUUID().replaceAll('-', '_');
process.env.FMCAD_LIVE_ROUTING = 'queue';
process.env.FMCAD_LIVE_CLIENT ||= 'live:animation-methods:' + randomUUID();
process.env.FMCAD_LIVE_SUITE = 'animation-methods';

const { spawnSync, fixture } = require('./helpers/live-broker');
const { catalog, validateCad } = require('../src/cad');
const reportPath = path.join(__dirname, 'live-animation-methods-report.json');
const report = {
  suite: 'animation-methods',
  sourceCommit: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  backend: require('../src/config').loadConfig({ routing: 'queue' }).cfg.backend,
  broker: { routing: 'queue', client: process.env.FMCAD_LIVE_CLIENT },
  name, startedAt: new Date().toISOString(),
  scope: 'Fresh unsaved fixture; joint sampling restores native motion, and only exact temporary frame/video paths are removed before close.',
  commands: [], assertions: [], methodResults: [], tests: [], ownedDocuments: [], ownedFrameFiles: [], remainingOwnedDocuments: 'unknown',
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
  const source = 'import adsk.core, adsk.fusion, json, os, tempfile, struct, zlib, hashlib\n\ndef run(_context: str):\n' +
    body.split('\n').map(line => '    ' + line).join('\n');
  const row = cli(['call', 'fusion_mcp_execute', JSON.stringify({ featureType: 'script', object: { script: source, readOnly } })]);
  const lines = row.stdout.split(/\r?\n/).filter(line => line.startsWith('LIVE_ANIM_SEQ '));
  if (lines.length !== 1) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error('Fixture probe returned no unambiguous result.');
  }
  let value;
  try { value = JSON.parse(lines[0].slice('LIVE_ANIM_SEQ '.length)); }
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
    throw new Error('Fixture probe returned unknown/pending; do not replay.');
  }
  row.parsed = value;
  row.status = 'validated';
  persist();
  return value;
}

function state() {
  return script(`app = adsk.core.Application.get()
docs = [{"name": d.name, "creationId": d.creationId, "fileId": d.dataFile.id if d.dataFile else None, "saved": d.isSaved, "modified": d.isModified, "active": d == app.activeDocument} for d in app.documents]
print('LIVE_ANIM_SEQ ' + json.dumps({"version": app.version, "tempDir": tempfile.gettempdir(), "documents": docs}))`);
}

function stable(docs) {
  return docs.map(({ active, ...doc }) => doc).sort((a, b) => String(a.creationId).localeCompare(String(b.creationId)));
}

function unchangedOthers(current) {
  assert.deepEqual(stable(current.documents.filter(doc => doc.creationId !== identity?.creationId)), stable(baseline.documents),
    'A non-fixture document changed during animation method coverage.');
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
  assert.equal(matches[0].active, true, 'Fixture is not the active document.');
}

function cad(operation, data, allowBlocked = false) {
  assert.ok(catalog[operation], 'Unknown canonical operation: ' + operation);
  validateCad(operation, data);
  guard();
  const row = cli([...operation.replaceAll('.', ' ').split(' '), '--doc', name, '--doc-id', identity.creationId,
    '--data', JSON.stringify(data), '--json']);
  let output;
  try { output = JSON.parse(row.stdout); }
  catch {
    if (row.exitCode !== 0) throw new Error(operation + ': ' + (row.stderr || row.stdout));
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error(operation + ' returned no valid JSON.');
  }
  row.parsed = output;
  if (unknownIn(output)) {
    uncertain = true;
    row.status = 'unknown';
    persist();
    throw new Error(operation + ' returned an unknown/pending result; do not replay.');
  }
  const methodStatus = output.result?.status;
  const expectedBlocked = allowBlocked && output.success === false && methodStatus === 'blocked';
  report.methodResults.push({ operation,
    status: expectedBlocked ? 'blocked' : methodStatus && methodStatus !== 'pass' ? methodStatus : 'invoked',
    result: output.result });
  assert.equal(row.exitCode, expectedBlocked ? 1 : 0, row.stderr || row.stdout);
  assert.equal(output.success, !expectedBlocked, row.stdout);
  assert.equal(output.operation, operation);
  assert.equal(output.document, name);
  assert.ok(output.result && typeof output.result === 'object' && Object.keys(output.result).length,
    operation + ' returned an empty result object.');
  row.status = expectedBlocked ? 'native-blocked' : 'native-result';
  persist();
  return output.result;
}

function check(operation, label, actual, expected, tolerance = 0) {
  const passed = tolerance ? Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance : actual === expected;
  report.assertions.push({ operation, label, actual, expected, tolerance, status: passed ? 'pass' : 'fail' });
  const method = report.methodResults.findLast(item => item.operation === operation && ['invoked', 'blocked'].includes(item.status));
  if (method) method.assertions = [...(method.assertions || []), label];
  persist();
  assert.ok(passed, label + ': ' + JSON.stringify({ actual, expected, tolerance }));
}

function validated(operation, allInvocations = false) {
  const methods = report.methodResults.filter(item => item.operation === operation && item.status === 'invoked');
  assert.ok(methods.length, operation + ' has no native invocation to validate.');
  for (const method of allInvocations ? methods : [methods.at(-1)]) method.status = 'pass';
  persist();
}

function closeOwned() {
  if (!identity || uncertain) return false;
  guard();
  const result = script(`app = adsk.core.Application.get()
matches = [d for d in app.documents if d.name == ${JSON.stringify(name)} and d.creationId == ${JSON.stringify(identity.creationId)}]
assert len(matches) == 1, 'Fixture identity ambiguous; leave open'
doc = matches[0]
assert doc.dataFile is None and not doc.isSaved, 'Saved/cloud fixture; leave open'
assert doc.close(False), 'Owned unsaved close failed'
print('LIVE_ANIM_SEQ ' + json.dumps({"closedCreationId": ${JSON.stringify(identity.creationId)}}))`, false);
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

  const created = cli(['doc', 'new', '--name', name]);
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

  const runCase = (name, operations, fn) => {
    try {
      const outcome = fn() || {};
      report.tests.push({ name, status: outcome.status || 'pass', operations,
        ...(outcome.blockedOperations?.length ? { blockedOperations: outcome.blockedOperations } : {}) });
    } catch (error) {
      failure ||= error;
      report.tests.push({ name, status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail',
        error: error.message, operations, ...(blockedReason ? { blocker: blockedReason } : {}) });
    }
  };

  runCase('deterministic-camera-frame-manifest', ['animation.sequence'], () => {
    const sequence = cad('animation.sequence', {
      schemaVersion: 1,
      tracks: [{ type: 'camera', phase: 'camera-move',
        from: { eye: ['0 cm', '0 cm', '30 cm'], target: ['0 cm', '0 cm', '0 cm'], up: [0, 0, 1] },
        to: { eye: ['10 cm', '0 cm', '30 cm'], target: ['0 cm', '0 cm', '0 cm'], up: [0, 0, 1] } }],
      phases: ['camera-move'], duration: '1 s', fps: 2, easing: 'linear',
    });
    check('animation.sequence', 'three evaluated frames for one second at 2 fps', sequence.frameCount, 3);
    check('animation.sequence', 'declared track count', sequence.trackCount, 1);
    check('animation.sequence', 'fps preserved', sequence.fps, 2);
    check('animation.sequence', 'no native storyboard action authored', sequence.nativeStoryboardActionsCreated, false);
    check('animation.sequence', 'frame indices are deterministic', sequence.frames.map(frame => frame.index).join(','), '0,1,2');
    [0, 0.5, 1].forEach((time, index) => check('animation.sequence', 'frame ' + index + ' time seconds', sequence.frames[index].timeSeconds, time, 1e-9));
    [0, 5, 10].forEach((eyeX, index) => check('animation.sequence', 'frame ' + index + ' interpolated camera eye x cm',
      sequence.frames[index].camera.eye[0], eyeX, 1e-9));
    check('animation.sequence', 'camera eye z remains 30 cm', sequence.frames[1].camera.eye[2], 30, 1e-9);
    check('animation.sequence', 'camera target remains at origin', sequence.frames[1].camera.target.join(','), '0,0,0');
    check('animation.sequence', 'camera up vector remains stable', sequence.frames[1].camera.up.join(','), '0,0,1');
    check('animation.sequence', 'read-only operation has no affected entities', sequence.affected.length, 0);
    validated('animation.sequence');
  });

  if (!uncertain && !blockedReason) runCase('native-joint-track-sampling-frame-export-and-restoration',
    ['component.create', 'assembly.ground', 'joint.revolute', 'joint.inspect', 'animation.joints', 'animation.export'], () => {
      const anchor = cad('component.create', { name: 'AnimationAnchor' }).occurrence;
      const arm = cad('component.create', { name: 'AnimationArm' }).occurrence;
      check('component.create', 'anchor occurrence reference returned', anchor.kind, 'occurrence');
      check('component.create', 'arm occurrence reference returned', arm.kind, 'occurrence');
      validated('component.create', true);

      const grounded = cad('assembly.ground', { occurrence: anchor });
      check('assembly.ground', 'anchor occurrence is grounded', grounded.grounded, true);
      validated('assembly.ground');

      const made = cad('joint.revolute', { name: 'AnimationHinge', occurrenceOne: anchor,
        occurrenceTwo: arm, point: 'origin', axis: 'Z' });
      check('joint.revolute', 'revolute as-built joint returned', made.asBuilt, true);
      check('joint.revolute', 'revolute motion type returned', made.type, 'revolute');
      const joint = made.joint;
      validated('joint.revolute');

      const before = cad('joint.inspect', { joint });
      check('joint.inspect', 'native joint inspection reports revolute motion', before.motionType, 'RevoluteJointMotion');
      check('joint.inspect', 'native initial rotation is zero radians', before.rotationValue, 0, 1e-9);
      validated('joint.inspect');

      assert.ok(path.win32.isAbsolute(baseline.tempDir), 'Fusion temp directory must be an absolute native path.');
      const framePaths = Array.from({ length: 3 }, (_, index) => path.win32.join(baseline.tempDir,
        `${name}_animation_frame_${String(index).padStart(3, '0')}.png`));
      const videoPath = path.win32.join(baseline.tempDir, `${name}_animation_film.mp4`);
      report.ownedFrameFiles = [...framePaths, videoPath];
      const targetCheck = script(`targets = ${JSON.stringify([...framePaths, videoPath])}
existing = [path for path in targets if os.path.lexists(path)]
print('LIVE_ANIM_SEQ ' + json.dumps({"targets": targets, "existing": existing}))`);
      assert.deepEqual(targetCheck.existing, [], 'A unique animation output path unexpectedly exists.');

      let samplingSettled = false;
      try {
      const sampled = cad('animation.joints', { tracks: [{ joint, rotation: { from: '0 deg', to: '90 deg' } }],
        frameCount: 3, confirm: true, restore: true, frameFiles: framePaths, width: 64, height: 64 });
      samplingSettled = true;
      check('animation.joints', 'sampler status is pass', sampled.status, 'pass');
      check('animation.joints', 'sampler passed flag is true', sampled.passed, true);
      check('animation.joints', 'three requested frames were measured', sampled.samples.length, 3);
      [0, 0.5, 1].forEach((fraction, index) => check('animation.joints', 'sample ' + index + ' fraction',
        sampled.samples[index].fraction, fraction, 1e-9));
      [0, Math.PI / 4, Math.PI / 2].forEach((rotation, index) => check('animation.joints',
        'sample ' + index + ' actual joint rotation radians', sampled.samples[index].joints[0].rotationValue, rotation, 1e-8));
      check('animation.joints', 'joint values restored in finally', sampled.restored, true);
      check('animation.joints', 'joint restore has no errors', sampled.restoreErrors.length, 0);
      check('animation.joints', 'no storyboard actions are authored', sampled.nativeStoryboardActionsCreated, false);
      check('animation.joints', 'exact native frame target list returned',
        sampled.frameFiles.map(file => path.win32.normalize(file)).join('\n'),
        framePaths.map(file => path.win32.normalize(file)).join('\n'));
      validated('animation.joints');

      const frameProof = script(`paths = ${JSON.stringify(framePaths)}
rows = []
for filename in paths:
    assert os.path.dirname(os.path.abspath(filename)) == os.path.abspath(${JSON.stringify(baseline.tempDir)})
    with open(filename, 'rb') as stream:
        content = stream.read()
    assert content[:8] == b'\\x89PNG\\r\\n\\x1a\\n' and content[12:16] == b'IHDR'
    width, height = struct.unpack('>II', content[16:24])
    assert (width, height) == (64, 64) and len(content) > 24
    rows.append(dict(path=filename, bytes=len(content), width=width, height=height, sha256=hashlib.sha256(content).hexdigest()))
print('LIVE_ANIM_SEQ ' + json.dumps({"frames": rows}))`);
      report.frameReadback = frameProof.frames;
      check('animation.joints', 'three nonempty 64×64 native PNG frames read back', frameProof.frames.length, 3);

      const exported = cad('animation.export', { schemaVersion: 1, frames: sampled.frameFiles,
        output: videoPath, encoder: { name: 'ffmpeg' }, fps: 3, confirm: true }, true);
      if (exported.status === 'pass') {
        check('animation.export', 'encoded film frame count', exported.frameCount, 3);
        check('animation.export', 'encoded film fps', exported.fps, 3);
        check('animation.export', 'encoded film duration seconds', exported.durationSeconds, 1, 1e-9);
        check('animation.export', 'film file is written and nonempty', exported.fileWritten && exported.playable, true);
        check('animation.export', 'reported film path matches the exact target', path.win32.normalize(exported.film), path.win32.normalize(videoPath));
        validated('animation.export');
      } else {
        check('animation.export', 'missing optional ffmpeg returns explicit blocked', exported.status, 'blocked');
        check('animation.export', 'blocked export does not claim a file', exported.fileWritten, false);
        check('animation.export', 'blocked export is not marked playable', exported.playable, false);
        check('animation.export', 'blocked export records no film path', exported.film, null);
        check('animation.export', 'blocked export reports the input frame count', exported.frameCount, 3);
      }
      const videoProof = script(`filename = ${JSON.stringify(videoPath)}
exists = os.path.isfile(filename)
size = os.path.getsize(filename) if exists else 0
prefix = open(filename, 'rb').read(12) if exists else b''
print('LIVE_ANIM_SEQ ' + json.dumps({"exists": exists, "size": size, "prefix": prefix.hex()}))`);
      if (exported.status === 'pass') {
        check('animation.export', 'native film exists after pass', videoProof.exists, true);
        check('animation.export', 'native MP4 contains an ftyp box', videoProof.prefix.slice(8, 16), '66747970');
        check('animation.export', 'native film file is nonempty', videoProof.size > 24, true);
      } else check('animation.export', 'blocked encode leaves no film file', videoProof.exists, false);

      const after = cad('joint.inspect', { joint });
      check('joint.inspect', 'native joint readback matches pre-sample rotation', after.rotationValue, before.rotationValue, 1e-9);
      validated('joint.inspect');

      } catch (error) {
        const sampleMethod = report.methodResults.findLast(row => row.operation === 'animation.joints');
        const settled = sampleMethod && !['invoked', 'blocked', 'unknown'].includes(sampleMethod.status);
        samplingSettled = samplingSettled || settled;
        throw error;
      } finally {
        if (samplingSettled && !uncertain && !report.frameFileCleanup) {
          const cleanup = script(`owned = ${JSON.stringify([...framePaths, videoPath])}
root = os.path.abspath(${JSON.stringify(baseline.tempDir)})
for filename in owned:
    assert os.path.dirname(os.path.abspath(filename)) == root
    assert os.path.basename(filename).startswith(${JSON.stringify(name + '_animation_')})
    if os.path.lexists(filename):
        assert os.path.isfile(filename) and not os.path.islink(filename), 'Owned frame path is not a regular file'
        os.remove(filename)
remaining = [filename for filename in owned if os.path.lexists(filename)]
assert not remaining
print('LIVE_ANIM_SEQ ' + json.dumps({"removed": owned, "remaining": remaining}))`, false);
          report.frameFileCleanup = cleanup;
        }
      }
      const exportResult = report.methodResults.findLast(item => item.operation === 'animation.export');
      return exportResult?.status === 'blocked' ? { status: 'pass-with-expected-block', blockedOperations: ['animation.export'] } : {};
    });

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
        assert.deepEqual(report.remainingOwnedDocuments, [], 'Owned animation fixture remains open.');
        const expectedActive = baseline.documents.find(doc => doc.active)?.creationId || null;
        const actualActive = after.documents.find(doc => doc.active)?.creationId || null;
        assert.equal(actualActive, expectedActive, 'Original active document was not restored.');
      }
    } catch (error) { failure ||= error; report.finalAuditError = error.message; }
  } else if (blockedReason) {
    report.finalAuditStatus = 'NOTRUN-after-explicit-broker-block';
    report.cleanupStatus = identity ? 'NOTRUN-to-avoid-retrying-blocked-owner-client' : 'not-needed-no-fixture-created';
  }

  const covered = new Set(['animation.sequence', 'animation.joints', ...report.tests.flatMap(row => row.operations || [])]);
  report.operationCoverage = [...covered].sort().map(operation => {
    const outcomes = report.methodResults.filter(row => row.operation === operation).map(row => row.status);
    return { operation, canonical: true, test: 'tests/live-animation-methods.js',
      status: outcomes.includes('pass') ? 'pass' : outcomes.includes('fail') ? 'fail' :
        outcomes.includes('blocked') ? 'blocked' : uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run' };
  });
  report.finishedAt = new Date().toISOString();
  persist();
  console.log('REPORT ' + reportPath);
  const completedStatuses = ['pass', 'pass-with-expected-block'];
  if (failure || report.tests.some(row => !completedStatuses.includes(row.status)) || report.finalAuditError ||
      (!report.fixtureClosed && !blockedReason)) {
    console.error('FAIL animation methods: ' + (failure?.message || report.finalAuditError || 'suite did not complete and clean up'));
    process.exitCode = 1;
  } else if (report.tests.some(row => row.status === 'pass-with-expected-block'))
    console.log('PARTIAL animation methods; animation.export reported documented encoder-unavailable block');
  else console.log('PASS animation.sequence and animation.joints native readbacks');
}

main().catch(error => {
  if (/Shared broker build differs|EPOCH_CLIENT_NOT_GRANTED|no modeling grant for the isolated scratch|Unsupported fmcad configuration contract/i.test(error.message))
    blockedReason = error.message;
  report.tests = [{ name: 'animation-method-suite-setup',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'fail', error: error.message,
    ...(blockedReason ? { blocker: blockedReason } : {}) }];
  report.operationCoverage = ['animation.sequence', 'animation.joints', 'animation.export'].map(operation => ({
    operation, canonical: true, test: 'tests/live-animation-methods.js',
    status: uncertain ? 'unknown' : blockedReason ? 'blocked' : 'not-run',
  }));
  report.finishedAt = new Date().toISOString();
  persist();
  console.error('FAIL animation methods: ' + error.stack);
  process.exitCode = 1;
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'generic-controls');
const HARNESS_PATH = path.join(__dirname, 'generic-controls', 'harness.ts');

function loadFixtures() {
  return fs.readdirSync(FIXTURE_DIR)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')));
}

function runBenchmark(iterations, preload = []) {
  const result = spawnSync(process.execPath, [
    ...preload, '--experimental-strip-types', HARNESS_PATH, '--iterations', String(iterations),
  ], { encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('generic-control fixtures have isolated identities and good/bad expected cases', () => {
  const identities = new Set();
  const fixtureIds = new Set();
  const families = new Set();

  for (const fixture of loadFixtures()) {
    assert.equal(fixture.schemaVersion, 1);
    assert.ok(fixture.fixtureId && !fixtureIds.has(fixture.fixtureId));
    fixtureIds.add(fixture.fixtureId);
    assert.ok(fixture.identity && !identities.has(fixture.identity));
    identities.add(fixture.identity);
    families.add(fixture.family);
    assert.ok(fixture.readPaths.length > 1);
    assert.equal(new Set(fixture.readPaths).size, fixture.readPaths.length);

    const variants = new Set();
    for (const row of fixture.cases) {
      assert.ok(row.identity && !identities.has(row.identity), `${row.identity} must be unique`);
      identities.add(row.identity);
      assert.ok(!variants.has(row.id), `${fixture.fixtureId}/${row.id} must be unique`);
      variants.add(row.id);
      assert.ok(['good', 'bad'].includes(row.variant));
      assert.ok(['pass', 'fail'].includes(row.expected.status));
      assert.equal(row.expected.status === 'pass', row.expected.failedChecks.length === 0);
    }
    assert.ok(fixture.cases.some(row => row.variant === 'good' && row.expected.status === 'pass'));
    assert.ok(fixture.cases.some(row => row.variant === 'bad' && row.expected.status === 'fail'));
  }

  assert.deepEqual([...families].sort(), [
    'arcSketch', 'branchedChannel', 'enclosure', 'gearPair', 'shaftSocket',
  ]);
});

test('offline fake baseline and bundled reads return each declared expected control result', () => {
  const report = runBenchmark(25);
  assert.equal(report.qualification, 'offline-fake-only');
  assert.equal(report.nativeFusionExecuted, false);
  assert.ok(Number.isFinite(report.elapsedMs));
  assert.ok(report.cases.length >= 10);

  const { individual, bundled } = report.cases[0];
  for (const strategy of [individual, bundled]) {
    const syntax = spawnSync('python3', ['-B', '-c',
      'import sys; compile(sys.stdin.read(), "caller.py", "exec")'], {
      input: strategy.pythonCallerSource,
      encoding: 'utf8',
    });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.equal(strategy.pythonPayloadBytes, Buffer.byteLength(strategy.pythonCallerSource, 'utf8'));
    assert.equal(strategy.pythonGlueLoc, strategy.pythonCallerSource.split('\n').length);
  }

  for (const row of report.cases) {
    assert.equal(row.equivalentResult, true, `${row.fixtureId}/${row.caseId}`);
    assert.equal(row.individual.result.status, row.expected.status);
    assert.deepEqual(row.individual.result.failedChecks, row.expected.failedChecks);
    assert.deepEqual(row.bundled.result, row.individual.result);
    assert.equal(row.individual.fakeRpcCount, row.individual.result.coverage.requestedReadPaths.length);
    assert.equal(row.bundled.fakeRpcCount, 1);
    assert.equal(row.budget.passed, true, `${row.fixtureId}/${row.caseId} bundled budget`);
    assert.equal(row.individual.result.source, 'offline-fake');
    assert.equal(row.individual.result.coverage.complete, true);
    assert.ok(row.individual.resultBytes > 0);
    assert.ok(row.individual.pythonPayloadBytes > 0);
    assert.ok(row.individual.pythonGlueLoc > 0);
  }
});

test('benchmark timings are diagnostic even when a synthetic clock exceeds the old speed limits', t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'generic-controls-clock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'clock.cjs');
  fs.writeFileSync(preload, 'let tick = 0n; process.hrtime.bigint = () => (tick += 60_000_000_000n);');
  const report = runBenchmark(10, ['--require', preload]);
  assert.ok(report.elapsedMs > 30000);
  assert.equal(Object.hasOwn(report, 'elapsedBudgetPassed'), false);
  for (const row of report.cases) {
    assert.ok(row.bundled.firstCallMs > 2000);
    assert.ok(row.bundled.warmP95Ms > 250);
    assert.equal(row.budget.passed, true);
  }
});

test('native generator is isolated and syntax-valid but never imported or executed by this test', () => {
  const sourcePath = path.join(__dirname, 'native', 'generic-controls', 'generate.py');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const { spawnSync } = require('node:child_process');
  const syntax = spawnSync('python3', ['-B', '-c',
    'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec")', sourcePath],
  { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(source, /confirmNativeFixtureGeneration/);
  assert.match(source, /projectId.*folderId.*fileId.*creationId/s);
  assert.match(source, /ownedOccurrences/);
  assert.match(source, /deleteMe\(\)/);
  assert.doesNotMatch(source, /\brequests\.|urllib\.request|socket\./);
});

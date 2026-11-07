const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fit, definition, check } = require('../src/engineering-fit');
const { scalar } = require('../src/engineering-common');
const base = () => ({ schemaVersion: 1, identity: { model: 'fixture', revision: '1' }, frame: 'datum:A', assumptions: ['Independent bounded dimensions in a common datum.'] });
const term = (id, sign, nominal, minus = '0 mm', plus = '0 mm') => ({ id, sign, nominal, minus, plus });
const input = () => ({ ...base(), terms: [term('a', 1, '5 mm'), ...[.4, .3, .15, .15, .5].map((n, i) => term(`b${i}`, -1, `${n} mm`))], minimum: '3.5 mm' });
function cli(key, args) { return spawnSync(process.execPath, ['bin/fmcad.js', ...key.split(' '), ...args], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, FMCAD_BACKEND: 'unavailable' } }); }
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
test('signed analytic stack and asymmetric negative contribution', () => {
  const independent = input();
  [.4, .3, .15, .15, .5].forEach((n, i) => {
    independent.terms[i + 1].minus = `${n} mm`;
    independent.terms[i + 1].plus = `${n} mm`;
  });
  const independentFixture = fit(independent);
  near(independentFixture.result.nominal.value, .0035);
  assert.deepEqual(independentFixture.result.sensitivity.ranking.map(x => x.id), ['b4', 'b0', 'b1', 'b2', 'b3', 'a']);
  assert.deepEqual(independentFixture.result.sensitivity.ranking.map(x => x.rank), [1, 2, 3, 4, 4, 6]);
  const r = fit({ ...base(), terms: [term('a', 1, '10 mm', '1 mm', '2 mm'), term('b', -1, '3 mm', '0.2 mm', '0.7 mm')] });
  near(r.result.minimum.value, .0053); near(r.result.maximum.value, .0092);
  assert.equal(r.result.sensitivity.method, 'one-at-a-time-worst-case-range-v1');
  assert.equal(r.result.sensitivity.scope, 'worst-case');
  assert.deepEqual(r.result.sensitivity.ranking.map(x => x.id), ['a', 'b']);
  assert.deepEqual(r.result.sensitivity.ranking.map(x => x.rank), [1, 2]);
  near(r.result.sensitivity.ranking[0].minimumShift.value, -.001);
  near(r.result.sensitivity.ranking[0].maximumShift.value, .002);
  near(r.result.sensitivity.ranking[0].range.value, .003);
  near(r.result.sensitivity.ranking[0].rangeShare.value, .003 / .0039);
  near(r.result.sensitivity.ranking[1].minimumShift.value, -.0007);
  near(r.result.sensitivity.ranking[1].maximumShift.value, .0002);
  near(r.result.sensitivity.ranking[1].range.value, .0009);
});
test('thermal corner products, deflection, angular interior extrema', () => {
  const t = term('a', 1, '100 mm');
  t.thermal = { alpha: '10 ppm/K', delta: '10 deltaK', minimumDelta: '-20 deltaK', maximumDelta: '30 deltaK' };
  near(fit({ ...base(), terms: [t] }).result.maximum.value, .10003);
  delete t.thermal; t.angle = { nominal: '90 deg', minus: '20 deg', plus: '20 deg' };
  near(fit({ ...base(), terms: [t] }).result.maximum.value, .1);
  near(fit({ ...base(), terms: [t] }).result.minimum.value, .1 * Math.sin(70 * Math.PI / 180));
  delete t.angle; t.deflection = { nominal: '-1 mm', minimum: '-2 mm', maximum: '0 mm' };
  near(fit({ ...base(), terms: [t] }).result.minimum.value, .098);
});
test('separate correlated statistics and PSD rejection', () => {
  const d = { ...base(), terms: [term('a', 1, '5 mm'), term('b', -1, '1 mm')], statistics: { model: 'linear-normal', coverage: 3, correlation: [[1, 1], [1, 1]], assumptions: ['Identical systematic displacement; final contribution sigmas.'] } };
  d.terms.forEach(t => t.sigma = '0.1 mm'); near(fit(d).result.statistical.sigma.value, 0);
  const correlated = fit(d);
  assert.equal(correlated.result.statistical.method, 'correlated-linear-normal-covariance-v1');
  assert.equal(correlated.result.sensitivity.scope, 'worst-case');
  const worstCase = correlated.result.sensitivity.ranking;
  d.statistics.correlation = [[1, 0], [0, 1]]; near(fit(d).result.statistical.sigma.value, Math.sqrt(2) * .0001);
  assert.deepEqual(fit(d).result.sensitivity.ranking, worstCase, 'correlation changes statistics, not the independent worst-case ranking');
  d.statistics.correlation = [[1, 1], [0, 1]]; assert.throws(() => fit(d), /symmetric/);
  const missingSigma = { ...d, statistics: { ...d.statistics, correlation: [[1, 0], [0, 1]] }, terms: d.terms.map(({ sigma, ...t }) => t) };
  const partial = fit(missingSigma);
  assert.equal(partial.result.statistical, null);
  assert.equal(partial.result.sensitivity.status, 'evaluated');
  assert.equal(partial.status, 'unknown');
});

test('sensitivity ties, zero widths, and deterministic evaluation budget', () => {
  const tied = fit({ ...base(), terms: [term('z', 1, '10 mm', '1 mm', '2 mm'), term('a', -1, '10 mm', '2 mm', '1 mm')] }).result.sensitivity.ranking;
  assert.deepEqual(tied.map(x => x.id), ['a', 'z']);
  assert.deepEqual(tied.map(x => x.rank), [1, 1]);
  near(tied[0].range.value, .003); near(tied[1].range.value, .003);
  const zero = fit({ ...base(), terms: [term('b', 1, '10 mm'), term('a', -1, '10 mm')] }).result.sensitivity.ranking;
  assert.deepEqual(zero.map(x => x.rank), [1, 1]);
  assert.ok(zero.every(x => x.range.value === 0 && x.rangeShare === null));

  const budgeted = { ...base(), terms: [term('a', 1, '1 mm'), term('b', -1, '1 mm')], budget: { maxEvaluations: 4, timeMs: 2000 } };
  assert.throws(() => fit(budgeted), /budget exceeded/);
  budgeted.budget.maxEvaluations = 5;
  assert.equal(fit(budgeted).result.sensitivity.status, 'evaluated');
});
test('missing, units, provenance, finite budgets and unknown fields', () => {
  const d = input(); delete d.terms[0].minus;
  const missing = fit(d);
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.result.sensitivity.status, 'unknown');
  assert.equal(missing.result.sensitivity.ranking, null);
  const open = fit({ ...base(), terms: [{
    id: 'bore', sign: 1,
    nominal: { value: '10 mm', status: 'OPEN', source: 'measurement pending' },
    minus: '1 mm', plus: '2 mm',
  }] });
  assert.equal(open.result.sensitivity.status, 'unknown');
  assert.equal(open.result.sensitivity.ranking, null);
  assert.throws(() => scalar('1 N', 'energy', 'x'), /energy/);
  assert.throws(() => scalar('1 bar(g)', 'pressureAbsolute', 'x'), /pressureAbsolute/);
  assert.throws(() => scalar('1e999 mm', 'length', 'x'), /finite/);
  assert.throws(() => fit({ ...input(), typo: 1 }), /unknown field/);
  assert.throws(() => fit({ ...input(), terms: [{ ...input().terms[0], plus: '1 kg' }] }), /length units/);
  assert.throws(() => fit({ ...input(), budget: { maxEvaluations: 1, timeMs: 1000 } }), /budget/);
  assert.equal(fit(input()).provenance.status, 'ESTIMATED');
  const sourced = fit({ ...base(), terms: [{
    id: 'bore', sign: 1,
    nominal: { value: '10 mm', status: 'CONFIRMED', source: 'inspection report IR-4' },
    minus: { value: '1 mm', status: 'ESTIMATED', source: 'drawing tolerance' },
    plus: { value: '2 mm', status: 'ESTIMATED', source: 'drawing tolerance' },
  }] });
  const sources = sourced.result.sensitivity.ranking[0].provenance.sources;
  assert.ok(sources.some(x => x.status === 'CONFIRMED' && x.source === 'inspection report IR-4'));
  assert.ok(sources.some(x => x.status === 'ESTIMATED' && x.source === 'drawing tolerance'));
  const a = fit(input()).provenance.cacheIdentity; const b = input(); b.identity.revision = '2'; assert.notEqual(a, fit(b).provenance.cacheIdentity);
});
test('interface invalidates both mating parts and blocks native reference handoff', () => {
  const d = { ...base(), id: 'seat', revision: '1', parts: ['Root/A:1', 'Root/B:2'], datums: ['A'], requirements: [input()], representation: 'snapshot' };
  const prev = definition(d).result;
  assert.equal(check({ ...base(), definition: d }).status, 'pass');
  d.revision = '2';
  const r = check({ ...base(), definition: d, previous: { contract: prev.contract, fingerprint: prev.fingerprint } });
  assert.equal(r.status, 'blocked'); assert.deepEqual(r.result.invalidatedParts, d.parts);
  d.representation = 'nativeReference'; assert.equal(definition(d).status, 'blocked');
});
test('all GM21 commands run real CLI; help/schema and atomic output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-fit-'));
  try {
    const d = { ...base(), id: 'seat', revision: '1', parts: ['A:1', 'B:1'], datums: ['A'], requirements: [input()], representation: 'snapshot' };
    for (const [key, data] of [['fit stack', input()], ['interface define', d], ['interface check', { ...base(), definition: d }]]) {
      const r = cli(key, ['--data', JSON.stringify(data), '--json']);
      assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).associativity, 'snapshot');
      assert.match(cli(key, ['--help']).stdout, /Local/); assert.equal(cli(key, ['--schema']).status, 0);
    }
    assert.match(cli('fit stack', ['--help']).stdout, /one-at-a-time-worst-case-range-v1/);
    const file = path.join(dir, 'in.json'), out = path.join(dir, 'out.json'); fs.writeFileSync(file, JSON.stringify(input()));
    const r = cli('fit stack', ['--file', file, '--out', out, '--json']); assert.equal(r.status, 0, r.stderr); assert.equal(fs.readFileSync(out, 'utf8'), r.stdout);
    assert.equal(cli('fit stack', ['--file', file, '--out', out]).status, 1);
    assert.equal(cli('fit stack', ['--data', '{}', '--json']).status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

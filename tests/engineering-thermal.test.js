const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { thermal } = require('../src/engineering-thermal');
const base = () => ({ schemaVersion: 1, identity: { model: 'thermal-fixture', revision: '1' }, frame: 'contact-normal', assumptions: ['Steady series heat flow; nominal constant material properties; all loads at source.'],
  heatLoads: [{ id: 'chip', power: '4 W' }, { id: 'driver', power: '1 W' }], ambient: '25 degC', maximumTemperature: '50 degC',
  contacts: [{ id: 'pad', model: 'pad', contactPresent: true, area: '100 mm2', thickness: '1 mm', conductivity: '2 W/(m*K)', compression: { nominal: '20 %', minimum: '10 %', maximum: '30 %' }, allowableCompression: { minimum: '10 %', maximum: '30 %' }, interfaceResistance: '0 K/W' }],
  ambientPath: { model: 'resistance', resistance: '.5 K/W' } });
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
function cli(data, extra = []) { return spawnSync(process.execPath, ['bin/fmcad.js', 'thermal', 'contact-budget', '--data', JSON.stringify(data), '--json', ...extra], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, FMCAD_BACKEND: 'no-backend' } }); }
test('analytic pad resistance, compression extrema, balance and sensitivity', () => {
  const r = thermal(base()); assert.equal(r.status, 'pass');
  near(r.result.contactResistance.value, 4); near(r.result.totalResistance.value, 4.5);
  near(r.result.sourceTemperature.value, 320.65); near(r.result.maximumSourceTemperature.value, 323.15);
  near(r.result.minimumSourceTemperature.value, 318.15); near(r.result.heatRejected.value, 5);
  near(r.result.contacts[0].sensitivity.resistancePerCompression.value, -5);
  near(r.result.contacts[0].coldTemperature.value, 300.65);
  const d = base(); d.contacts[0].compression.nominal = '20.001 %';
  near((thermal(d).result.sourceTemperature.value - r.result.sourceTemperature.value) / .00001, -25, 1e-6);
});
test('gap variant, convection and explicit contact resistance', () => {
  const d = base(); delete d.contacts[0].compression;
  d.contacts[0].gap = { nominal: '.8 mm', minimum: '.7 mm', maximum: '.9 mm' };
  d.ambientPath = { model: 'convection', coefficient: '20 W/(m2*K)', area: '.1 m2' };
  near(thermal(d).result.totalResistance.value, 4.5);
  d.contacts.push({ id: 'joint', model: 'resistance', contactPresent: true, resistance: '1 K/W' });
  near(thermal(d).result.totalResistance.value, 5.5); assert.equal(thermal(d).status, 'fail');
});
test('missing ambient, sink, interface and contact never become zero', () => {
  for (const field of ['ambient', 'ambientPath']) { const d = base(); delete d[field]; const r = thermal(d); assert.equal(r.status, 'unknown'); assert.equal(r.result.sourceTemperature, null); near(r.result.contactResistance.value, 4); }
  for (const field of ['interfaceResistance', 'contactPresent', 'conductivity', 'allowableCompression']) { const d = base(); delete d.contacts[0][field]; assert.equal(thermal(d).status, 'unknown'); }
  const d = base(); delete d.heatLoads[0].power; assert.equal(thermal(d).status, 'unknown'); assert.equal(thermal(d).result.heatLoad, null);
});
test('physical contact, invalid compression, unit and schema bounds', () => {
  const d = base(); d.contacts[0].contactPresent = false; assert.equal(thermal(d).status, 'fail'); assert.equal(thermal(d).result.sourceTemperature, null);
  d.contacts[0].contactPresent = true; d.contacts[0].compression.maximum = '100 %'; assert.throws(() => thermal(d), /finite/);
  d.contacts[0].compression.maximum = '40 %'; assert.equal(thermal(d).status, 'fail');
  delete d.contacts[0].compression; d.contacts[0].gap = { nominal: '2 mm', minimum: '2 mm', maximum: '2 mm' }; assert.equal(thermal(d).status, 'fail'); assert.equal(thermal(d).result.sourceTemperature, null);
  const bad = base(); bad.ambient = '25 deltaK'; assert.throws(() => thermal(bad), /temperature/);
  bad.ambient = '-300 degC'; assert.throws(() => thermal(bad), /absolute zero/);
  assert.throws(() => thermal({ ...base(), budget: { maxEvaluations: 1, timeMs: 1000 } }), /budget/);
});
test('thermal real CLI variants, bad input, missing data, help and schema', () => {
  const gap = base(); delete gap.contacts[0].compression; gap.contacts[0].gap = { nominal: '.8 mm', minimum: '.7 mm', maximum: '.9 mm' };
  const convection = base(); convection.ambientPath = { model: 'convection', coefficient: '20 W/(m2*K)', area: '.1 m2' };
  const resistance = base(); resistance.contacts = [{ id: 'specified', model: 'resistance', contactPresent: true, resistance: '1 K/W' }];
  for (const d of [base(), gap, convection, resistance]) { const r = cli(d); assert.equal(r.status, 0, r.stderr + r.stdout); assert.equal(JSON.parse(r.stdout).operation, 'thermal.contact-budget'); }
  const missing = base(); delete missing.ambientPath; const r = cli(missing); assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).status, 'unknown');
  assert.equal(cli({ ...base(), typo: true }).status, 1);
  for (const flag of ['--help', '--schema']) { const r = spawnSync(process.execPath, ['bin/fmcad.js', 'thermal', 'contact-budget', flag], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /ambientPath/); }
});

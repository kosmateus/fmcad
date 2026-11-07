'use strict';

// Live integration tests for GM-24 (hydraulic network / valve / spring-piston /
// float). These are LOCAL methods: no --doc, no document clear, no backend.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { local } = require('./helper');

const base = () => ({
  schemaVersion: 1,
  identity: { model: 'hydraulic-live', revision: '1' },
  frame: 'hydraulicDatum',
  assumptions: ['Steady incompressible fluid; horizontal connections; specified losses.'],
});
const near = (actual, expected, tol = 1e-7) =>
  assert.ok(Math.abs(actual - expected) < tol, `expected ${actual} ~= ${expected} (tol ${tol})`);
const net = () => ({
  ...base(),
  density: '1000 kg/m3', viscosity: '1 mPa*s', atmosphere: '100 kPa(a)',
  flowTolerance: '0.000001 mL/s', pressureTolerance: '0.001 Pa',
  nodes: [
    { id: 'in', kind: 'source', externalFlow: '2 mL/s' },
    { id: 'junction', kind: 'junction', externalFlow: '0 mL/s' },
    { id: 'out', kind: 'outlet', externalFlow: '-1 mL/s' },
    { id: 'tank', kind: 'reservoir', externalFlow: '-1 mL/s', pressure: { reference: 'gauge', value: '0 Pa(g)' } },
  ],
  lines: [
    { id: 'feed', from: 'in', to: 'junction', kind: 'line', flow: '2 mL/s' },
    { id: 'delivery', from: 'junction', to: 'out', kind: 'valve', flow: '1 mL/s', crackingPressure: '100 Pa' },
    { id: 'relief', from: 'junction', to: 'tank', kind: 'relief', flow: '1 mL/s', crackingPressure: '100 Pa' },
  ].map((e) => ({ ...e, diameter: '10 mm', length: '100 mm', deadVolume: '1 mL', lossCoefficient: '2 1', frictionModel: 'laminar' })),
});
const piston = () => ({
  ...base(), bore: '10 mm', stroke: '10 mm', preload: '0 N', rate: '0.195821123 N/mm',
  initialCompression: '18 mm', friction: '0 N',
  backPressure: { reference: 'gauge', value: '0 Pa(g)' }, atmosphere: '100 kPa(a)', deadVolume: '0 mL',
});
const valve = () => ({
  ...base(), seatDiameter: '2 mm', preload: '1 N', rate: '1 N/mm', lift: '0.1 mm',
  friction: '0 N', flow: '1 mL/s', density: '1000 kg/m3', dischargeCoefficient: '0.7 1', flowArea: '1 mm2',
});
const float = () => ({
  ...base(), density: '1000 kg/m3', gravity: '10 m/s2', mass: '8 g', magnetMass: '2 g',
  displacedVolume: '10 mL', waterplaneArea: '1000 mm2', height: '20 mm', guideFriction: '0.01 N',
  level: '100 mm', lowerStop: '0 mm', upperStop: '100 mm',
});

test('G24-01: directed network continuity with relief return to reservoir', () => {
  const out = local(['hydraulic', 'network', '--data', JSON.stringify(net())]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.documentIdentity, null);
  const junction = out.result.nodes.find((n) => n.id === 'junction');
  assert.ok(junction.pressure.value > 100000, JSON.stringify(junction));
});

test('G24-02: dead volume and pressure budget with explicit loss coefficients', () => {
  const out = local(['hydraulic', 'network', '--data', JSON.stringify(net())]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const dp = 128 * 0.001 * 0.1 * 1e-6 / (Math.PI * 0.01 ** 4) + 2 * 500 * (1e-6 / (Math.PI * 0.01 ** 2 / 4)) ** 2 + 100;
  near(out.result.lines[2].pressureDrop.value, dp, 1e-4);
  near(out.result.deadVolume.value, 3 * (Math.PI * 0.01 ** 2 / 4 * 0.1 + 1e-6), 1e-12);
  near(out.result.nodes.find((n) => n.id === 'junction').pressure.value, 100000 + dp, 1e-4);
});

test('G24-03: valve cracking pressure is distinct from flowing loss', () => {
  const d = valve();
  const out = local(['engineering', 'valve', '--data', JSON.stringify(d)]);
  assert.equal(out.status, 'notEvaluated', JSON.stringify(out)); // no availablePressure: a lower bound, not an equilibrium pass
  near(out.result.crackingPressure.value, 1 / (Math.PI * 1e-6));
  near(out.result.flowPressureDrop.value, 1000 / 2 * (1 / 0.7) ** 2);
  assert.notEqual(out.result.crackingPressure.value, out.result.flowPressureDrop.value);
  d.availablePressure = '100 Pa'; // below the required lower bound
  const insufficient = local(['engineering', 'valve', '--data', JSON.stringify(d)]);
  assert.equal(insufficient.status, 'fail', JSON.stringify(insufficient));
});

test('G24-04: spring-piston displacement, work and gauge conversion', () => {
  const out = local(['engineering', 'spring-piston', '--data', JSON.stringify(piston())]);
  assert.equal(out.status, 'notEvaluated', JSON.stringify(out)); // pure calculation; no pass/fail criterion
  near(out.result.displacement.value * 1e6, Math.PI / 4);
  near(out.result.springWork.value * 1000, 25.45674599, 1e-4);
  near(out.result.fluidPressureEnd.value - out.result.differentialPressureEnd.value, 100000);
});

test('G24-05: Archimedes buoyancy with magnet mass and guide friction band', () => {
  const out = local(['float', 'evaluate', '--data', JSON.stringify(float())]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  near(out.result.buoyancy.value, 0.1);
  near(out.result.weight.value, 0.1);
  near(out.result.equilibrium.minimumBottom.value, 0.089);
  near(out.result.equilibrium.maximumBottom.value, 0.091);
});

test('G24-06: reference figures 0.785398 mL, 25.456746 mJ and Archimedes equilibrium', () => {
  const p = local(['engineering', 'spring-piston', '--data', JSON.stringify(piston())]);
  near(p.result.displacement.value * 1e6, 0.785398163397, 1e-9); // pi/4 mL
  near(p.result.springWork.value * 1000, 25.456746, 1e-4); // mJ
  const f = local(['float', 'evaluate', '--data', JSON.stringify(float())]);
  near(f.result.buoyancy.value, f.result.weight.value, 1e-9); // rho*g*V == (m + magnet)*g
  near(f.result.buoyancy.value, 0.1);
});

test('G24-07: local-only method, no CFD/dynamics/sealing claim', () => {
  const out = local(['hydraulic', 'network', '--data', JSON.stringify(net())]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.documentIdentity, null);
  assert.equal(out.units, 'SI');
  assert.equal(out.method, 'local-analytic-v1');
  assert.ok(out.limitations.some((l) => /not a flow solver|CFD|cavitation/i.test(l)), JSON.stringify(out.limitations));
});

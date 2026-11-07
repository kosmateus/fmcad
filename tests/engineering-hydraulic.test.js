const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { valve, piston, floating, network } = require('../src/engineering-hydraulic');
const base = () => ({ schemaVersion: 1, identity: { model: 'hydraulic-fixture', revision: '1' }, frame: 'hydraulicDatum', assumptions: ['Steady incompressible fluid; horizontal connections; specified losses.'] });
const near = (a, b, tol = 1e-10) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
const p = () => ({ ...base(), bore: '10 mm', stroke: '10 mm', preload: '0 N', rate: '0.195821123 N/mm', initialCompression: '18 mm', friction: '0 N', backPressure: { reference: 'gauge', value: '0 Pa(g)' }, atmosphere: '100 kPa(a)', deadVolume: '0 mL' });
const v = () => ({ ...base(), seatDiameter: '2 mm', preload: '1 N', rate: '1 N/mm', lift: '0.1 mm', friction: '0 N', flow: '1 mL/s', density: '1000 kg/m3', dischargeCoefficient: '0.7 1', flowArea: '1 mm2' });
const f = () => ({ ...base(), density: '1000 kg/m3', gravity: '10 m/s2', mass: '8 g', magnetMass: '2 g', displacedVolume: '10 mL', waterplaneArea: '1000 mm2', height: '20 mm', guideFriction: '0.01 N', level: '100 mm', lowerStop: '0 mm', upperStop: '100 mm' });
function net() {
  return { ...base(), density: '1000 kg/m3', viscosity: '1 mPa*s', atmosphere: '100 kPa(a)', flowTolerance: '0.000001 mL/s', pressureTolerance: '0.001 Pa',
    nodes: [{ id: 'in', kind: 'source', externalFlow: '2 mL/s' }, { id: 'junction', kind: 'junction', externalFlow: '0 mL/s' }, { id: 'out', kind: 'outlet', externalFlow: '-1 mL/s' }, { id: 'tank', kind: 'reservoir', externalFlow: '-1 mL/s', pressure: { reference: 'gauge', value: '0 Pa(g)' } }],
    lines: [{ id: 'feed', from: 'in', to: 'junction', kind: 'line', flow: '2 mL/s' }, { id: 'delivery', from: 'junction', to: 'out', kind: 'valve', flow: '1 mL/s', crackingPressure: '100 Pa' }, { id: 'relief', from: 'junction', to: 'tank', kind: 'relief', flow: '1 mL/s', crackingPressure: '100 Pa' }].map(e => ({ ...e, diameter: '10 mm', length: '100 mm', deadVolume: '1 mL', lossCoefficient: '2 1', frictionModel: 'laminar' })) };
}
function cli(key, data, extra = []) {
  return spawnSync(process.execPath, ['bin/fmcad.js', ...key.split(' '), '--data', JSON.stringify(data), '--json', ...extra], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, FMCAD_BACKEND: 'invalid-local-only' } });
}
test('piston independent displacement and energy fixtures, gauge conversion', () => {
  const r = piston(p()).result;
  near(r.displacement.value * 1e6, Math.PI / 4); near(r.displacement.value * 1e6, .785398163397);
  near(r.springWork.value * 1000, 25.45674599, 1e-7);
  near(r.fluidPressureEnd.value - r.differentialPressureEnd.value, 100000);
  const d = p(); d.friction = '0.5 N';
  near(piston(d).result.fluidWork.value, r.springWork.value - .005);
  d.friction = '100 N'; assert.equal(piston(d).status, 'fail');
  d.stroke = '20 mm'; assert.throws(() => piston(d), /initialCompression/);
  const missing = p(); delete missing.friction; assert.equal(piston(missing).status, 'unknown');
  const absolute = p(); absolute.backPressure = { reference: 'absolute', value: '100 kPa(a)' }; delete absolute.atmosphere;
  near(piston(absolute).result.fluidPressureStart.value, r.fluidPressureStart.value);
  absolute.backPressure.value = '100 kPa(g)'; assert.throws(() => piston(absolute), /pressureAbsolute/);
});
test('valve cracking is distinct from specified flow loss, missing nozzle data', () => {
  const d = v(), r = valve(d).result;
  near(r.crackingPressure.value, 1 / (Math.PI * 1e-6));
  near(r.flowPressureDrop.value, 1000 / 2 * (1 / .7) ** 2);
  assert.notEqual(r.crackingPressure.value, r.flowPressureDrop.value);
  d.availablePressure = '100 Pa'; assert.equal(valve(d).status, 'fail');
  delete d.availablePressure; delete d.flowArea; assert.equal(valve(d).status, 'unknown');
  d.flowArea = '0 mm2'; assert.throws(() => valve(d), /zero flowArea/);
  d.flowArea = '1 mm2'; d.lift = '0 mm'; assert.throws(() => valve(d), /Closed valve/);
});
test('Archimedes with magnet, guide friction equilibrium, stops and sinking', () => {
  const d = f(), r = floating(d).result;
  near(r.buoyancy.value, .1); near(r.weight.value, .1);
  near(r.equilibrium.minimumBottom.value, .089); near(r.equilibrium.maximumBottom.value, .091);
  d.mass = '100 g'; assert.equal(floating(d).status, 'fail');
  d.mass = '8 g'; d.upperStop = '80 mm'; assert.equal(floating(d).status, 'fail');
  delete d.magnetMass; assert.equal(floating(d).status, 'unknown');
  const neutral = f(); neutral.mass = '18 g'; neutral.guideFriction = '0 N';
  near(floating(neutral).result.equilibrium.minimumBottom.value, 0);
});
test('branched network continuity, analytic pipe losses, relief and dead volume', () => {
  const d = net(), r = network(d);
  assert.equal(r.status, 'pass', JSON.stringify(r.warnings));
  const dp = 128 * .001 * .1 * 1e-6 / (Math.PI * .01 ** 4) + 2 * 500 * (1e-6 / (Math.PI * .01 ** 2 / 4)) ** 2 + 100;
  near(r.result.lines[2].pressureDrop.value, dp);
  near(r.result.deadVolume.value, 3 * (Math.PI * .01 ** 2 / 4 * .1 + 1e-6));
  near(r.result.nodes.find(n => n.id === 'junction').pressure.value, 100000 + dp);
  d.nodes[0].externalFlow = '3 mL/s'; assert.equal(network(d).status, 'fail');
  d.lines[2].to = 'out'; assert.throws(() => network(d), /reservoir/);
});
test('Darcy, pump, closed relief inequality, missing laws, inconsistent loops', () => {
  const d = net(); d.lines.forEach(e => { e.frictionModel = 'darcy'; e.darcyFactor = '0.03 1'; });
  assert.equal(network(d).status, 'pass');
  d.lines[0].kind = 'pump'; d.lines[0].gain = '1 kPa'; assert.equal(network(d).status, 'pass');
  d.nodes[0].pressure = { reference: 'absolute', value: '200 kPa(a)' }; assert.equal(network(d).status, 'fail');
  const closed = net(); closed.lines[2].flow = '0 mL/s'; closed.lines[0].flow = '1 mL/s'; closed.nodes[0].externalFlow = '1 mL/s'; closed.nodes[3].externalFlow = '0 mL/s';
  closed.nodes[1].pressure = { reference: 'absolute', value: '100 kPa(a)' };
  assert.equal(network(closed).status, 'pass');
  closed.nodes[1].pressure.value = '101 kPa(a)'; assert.equal(network(closed).status, 'fail');
  const missing = net(); delete missing.lines[1].lossCoefficient; assert.equal(network(missing).status, 'unknown');
  const turbulent = net(); turbulent.viscosity = '0.00001 mPa*s'; assert.equal(network(turbulent).status, 'unknown');
  const noAnchor = net(); delete noAnchor.nodes[3].pressure; assert.equal(network(noAnchor).status, 'unknown');
  assert.throws(() => network({ ...net(), budget: { maxEvaluations: 2, timeMs: 1000 } }), /budget/);
});
test('all GM24 real CLI commands and local help/schema; missing and bad data', () => {
  for (const [key, data] of [['hydraulic network', net()], ['engineering valve', v()], ['engineering spring-piston', p()], ['float evaluate', f()]]) {
    const r = cli(key, data); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).documentIdentity, null);
    const help = spawnSync(process.execPath, ['bin/fmcad.js', 'help', ...key.split(' ')], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }); assert.match(help.stdout, /Local/);
    assert.equal(cli(key, { ...data, bogus: 0 }).status, 1);
    assert.equal(cli(key, { ...data, budget: { maxEvaluations: 0, timeMs: 1000 } }).status, 1);
  }
  const missing = p(); delete missing.rate; const r = cli('engineering spring-piston', missing); assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).status, 'unknown');
});
test('real CLI exercises each local hydraulic model variant', () => {
  const darcy = net(); darcy.lines.forEach(e => { e.frictionModel = 'darcy'; e.darcyFactor = '0.03 1'; });
  const pump = net(); pump.lines[0].kind = 'pump'; pump.lines[0].gain = '500 Pa';
  const closed = net(); closed.lines[2].flow = '0 mL/s'; closed.lines[0].flow = '1 mL/s'; closed.nodes[0].externalFlow = '1 mL/s'; closed.nodes[3].externalFlow = '0 mL/s'; closed.nodes[1].pressure = { reference: 'absolute', value: '100 kPa(a)' };
  const absolute = p(); absolute.backPressure = { reference: 'absolute', value: '100 kPa(a)' }; delete absolute.atmosphere;
  const noFlow = v(); noFlow.flow = '0 mL/s'; noFlow.flowArea = '0 mm2'; noFlow.lift = '0 mm';
  const neutral = f(); neutral.mass = '18 g'; neutral.guideFriction = '0 N';
  for (const [key, data] of [['hydraulic network', darcy], ['hydraulic network', pump], ['hydraulic network', closed], ['engineering spring-piston', absolute], ['engineering valve', noFlow], ['float evaluate', neutral]]) {
    const result = cli(key, data); assert.equal(result.status, 0, result.stderr + result.stdout);
  }
});

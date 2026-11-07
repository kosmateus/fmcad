'use strict';

// Live integration tests for GM16 (fasteners/details): mounts, fastener stacks,
// bearing stacks, shaft interfaces, bayonet retention, snap fits and hose barbs.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, cad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

const near = (actual, expected, tol = 1e-6, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected}, got ${actual}`);

test('G16-01: mount create locates a PCB with pin+slot without over-constraining', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['mount', 'create', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', name: 'PcbMount', scheme: 'pin-slot',
    pin: { x: '0 mm', y: '0 mm' }, slot: { x: '40 mm', y: '0 mm' },
    holes: { diameter: '3 mm', clearance: '0.5 mm',
      positions: [{ x: '10 mm', y: '10 mm' }, { x: '30 mm', y: '30 mm' }] },
    boss: { diameter: '6 mm', height: '8 mm' },
    support: { connector: true },
    material: 'FR-4', process: 'injection molded',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  assert.equal(body.locatingDofConstrained, 3, JSON.stringify(out));
  assert.equal(body.overConstrained, false, JSON.stringify(out));
  assert.equal(body.pin.kind, 'point', JSON.stringify(out));
  assert.equal(body.slot.kind, 'point', JSON.stringify(out));
  assert.equal(body.mateFit.connectorSupported, true, JSON.stringify(out));
});

test('G16-02: mount check flags over-constraint and requires connector support', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const ok = fmcad(['mount', 'check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', scheme: 'pin-slot',
    holes: [
      { diameter: '3 mm', clearance: '0.5 mm' },
      { diameter: '3 mm', clearance: '0.5 mm' },
    ],
    connector: { supported: true, supportPresent: true },
  })]);
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(ok.status, 'pass', JSON.stringify(ok));
  assert.equal(ok.result.overConstrained, false, JSON.stringify(ok));

  const { code, json: bad } = cad(['mount', 'check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', scheme: 'two-pin',
    holes: [{ diameter: '3 mm', clearance: '0 mm' }],
    connector: { supported: true },
  })]);
  assert.equal(code, 1, JSON.stringify(bad));
  assert.equal(bad.status, 'fail', JSON.stringify(bad));
});

test('G16-03: fastener stack computes clamped length, engagement and bottoming', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['fastener', 'stack', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    screw: { length: '12 mm', threadLength: '10 mm', headDiameter: '6 mm' },
    stack: [{ id: 'bracket', thickness: '4 mm' }, { id: 'pcb', thickness: '1.6 mm' }],
    receptacle: { kind: 'insert', depth: '8 mm' },
    torque: '0.5 N*m', tool: { diameter: '5 mm' },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  near(body.clampedLength.value, 5.6, 1e-6, 'clampedLength');
  near(body.engagement.value, 4.4, 1e-6, 'engagement');
  assert.equal(body.torqueStatus, 'declared', JSON.stringify(out));
  near(body.bottoming.clearance.value, 1.6, 1e-6, 'bottoming clearance');
  assert.equal(body.bottoming.bottomed, false, JSON.stringify(out));
});

test('G16-04: fastener check validates engagement, bottoming and tool access', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['fastener', 'check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    screw: { length: '12 mm', threadLength: '10 mm' },
    stack: [{ thickness: '4 mm' }, { thickness: '1.6 mm' }],
    minimumEngagement: '4 mm',
    receptacle: { kind: 'insert', depth: '8 mm' },
    tool: { diameter: '4 mm', recess: '5 mm' },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const statuses = Object.fromEntries(out.result.checks.map((c) => [c.check, c.status]));
  assert.equal(statuses.engagement, 'pass', JSON.stringify(out));
  assert.equal(statuses.bottoming, 'pass', JSON.stringify(out));
  assert.equal(statuses.access, 'pass', JSON.stringify(out));
});

test('G16-05: fastener schedule reports declared data and flags missing entries', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const complete = fmcad(['fastener', 'schedule', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    fasteners: [{ id: 'A', torque: '0.5 N*m', process: 'torque wrench', material: 'A2-70' }],
  })]);
  assert.equal(complete.success, true, JSON.stringify(complete));
  assert.equal(complete.status, 'pass', JSON.stringify(complete));
  assert.deepEqual(complete.result.missingData, [], JSON.stringify(complete));

  const incomplete = fmcad(['fastener', 'schedule', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    fasteners: [{ id: 'B', torque: '0.5 N*m' }],
  })]);
  assert.equal(incomplete.status, 'unknown', JSON.stringify(incomplete));
  assert.deepEqual(incomplete.result.missingData, ['B'], JSON.stringify(incomplete));
});

test('G16-06: bearing stack-check distinguishes the fixed ring and assumes no preload', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['bearing', 'stack-check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    rings: { inner: { bore: '10 mm' }, outer: { od: '26 mm' } },
    journal: '10 mm', seat: '26 mm',
    shaftClearance: '0.005 mm', housingClearance: '0.0 mm',
    shoulder: { inner: true }, arrangement: 'fixed-floating',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.fixedRing, 'inner', JSON.stringify(out));
  assert.match(out.result.preload, /none declared/, JSON.stringify(out));
});

test('G16-07: shaft interface mates a D-flat bore to a D-flat shaft', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['shaft', 'interface', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    shaft: { type: 'D-flat', d: '6 mm', flat: { depth: '0.5 mm' } },
    hub: { bore: '6 mm', boreType: 'D-flat', splitClampGap: '0.8 mm', shoulders: [{}] },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const statuses = Object.fromEntries(out.result.checks.map((c) => [c.check, c.status]));
  assert.equal(statuses['d-flat-mate'], 'pass', JSON.stringify(out));
});

test('G16-08: retention bayonet resolves the assembly and unlock path', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['retention', 'bayonet', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    lugs: { count: 3, width: '4 mm', height: '2 mm' },
    stroke: '6 mm', rotation: '30 deg',
    capture: { depth: '1.5 mm' },
    clearances: { radial: '0.2 mm' },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.assemblyPath, 'insert -> rotate -> capture', JSON.stringify(out));
  assert.equal(out.result.unlockPath, 'counter-rotate -> retract', JSON.stringify(out));
});

test('G16-09: snap define records geometry and material without a material default', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['snap', 'define', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    geometry: { length: '10 mm', width: '4 mm', thickness: '1 mm', engagementDepth: '0.6 mm' },
    material: { name: 'ABS', modulus: '2.1 GPa' },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.material.name, 'ABS', JSON.stringify(out));
  assert.match(out.result.shape, /cantilever beam snap/);
});

test('G16-10: shape hose_barb keeps channel continuity and barb seating interference', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['shape', 'hose_barb', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', name: 'Barb',
    tubeId: '4 mm', tubeOd: '6 mm', bore: '3 mm',
    barbs: [
      { crest: '7 mm', root: '6 mm', length: '3 mm' },
      { crest: '7 mm', root: '6 mm', length: '3 mm' },
    ],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  near(body.seating[0].radialInterference.value, 1.5, 1e-6, 'radial interference');
  const continuity = body.checks.find((c) => c.check === 'channel-continuity');
  assert.ok(continuity, JSON.stringify(out));
  assert.equal(continuity.status, 'pass', JSON.stringify(out));
  assert.match(body.opposingBarbCollision, /not detected/, JSON.stringify(out));
});

test('G16-11: snap evaluate reproduces the fixture cantilever beam model', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['snap', 'evaluate', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    geometry: { length: '10 mm', width: '4 mm', thickness: '1 mm', engagementDepth: '0.6 mm', deflection: '0.6 mm' },
    material: { name: 'ABS', modulus: '2.1 GPa', yieldStrength: '40 MPa' },
    support: { condition: 'cantilever' },
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  // I = w*t^3/12 = 1/3 mm^4; k = 3*E*I/L^3 = 3*2100*(1/3)/1000 = 2.1 N/mm.
  near(body.stiffness.value, 2.1, 1e-6, 'stiffness');
  near(body.engagementForce.value, 1.26, 1e-6, 'engagementForce');
  near(body.stress.value, 18.9, 1e-6, 'stress');
});

test('G16-12: a D-flat shaft refuses a round bore (non-interchangeable geometry)', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const { code, json: out } = cad(['shaft', 'interface', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    shaft: { type: 'D-flat', d: '6 mm', flat: { depth: '0.5 mm' } },
    hub: { bore: '6 mm', boreType: 'round' },
  })]);
  assert.equal(code, 1, JSON.stringify(out));
  assert.equal(out.status, 'fail', JSON.stringify(out));
  const statuses = Object.fromEntries(out.result.checks.map((c) => [c.check, c.status]));
  assert.equal(statuses['d-flat-mate'], 'fail', JSON.stringify(out));
});

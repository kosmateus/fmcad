'use strict';

// Live integration tests for GM17 (mechanism): coupling ratio/sign, screw lead,
// phase/zero, inspect residuals and stop checks. Read-only kinematic evaluation.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, cad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () { if (!hasDoc()) return; clear(); });
afterEach(function () { if (!hasDoc()) return; clear(); });

const near = (actual, expected, tol = 1e-6, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected}, got ${actual}`);

test('G17-01: mechanism couple resolves gear ratio/sign and screw lead', (t) => {
  if (skipLive(t)) return;
  const doc = docName();

  const gear = fmcad(['mechanism', 'couple', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    coupling: { type: 'rotation', driverTeeth: 20, drivenTeeth: 40, external: true },
    driverRange: { from: '0 deg', to: '720 deg' }, samples: 16,
  })]);
  assert.equal(gear.success, true, JSON.stringify(gear));
  assert.equal(gear.status, 'pass', JSON.stringify(gear));
  assert.equal(gear.result.sign, -1, JSON.stringify(gear));
  near(gear.result.ratio, -0.5, 1e-9, 'gear ratio');
  assert.equal(gear.result.evaluated.unwrapped, true, JSON.stringify(gear));
  near(gear.result.evaluated.track[gear.result.evaluated.track.length - 1].driven.value, -2 * Math.PI, 1e-5, 'driven at 720deg');

  const screw = fmcad(['mechanism', 'couple', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    coupling: { type: 'screw', lead: '5 mm' },
    driverRange: { from: '0 deg', to: '360 deg' }, samples: 16,
  })]);
  assert.equal(screw.status, 'pass', JSON.stringify(screw));
  assert.equal(screw.result.type, 'screw', JSON.stringify(screw));
  near(screw.result.lead, 0.5, 1e-9, 'screw lead cm');
  const track = screw.result.evaluated.track;
  near(track[track.length - 1].driven.value, 0.5, 1e-6, 'one revolution advance');
});

test('G17-02: mechanism couple honors zero phase and engagement from measured values', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['mechanism', 'couple', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    coupling: { type: 'rotation', ratio: -0.5, zeroPhase: '0 deg' },
    driverRange: { from: '0 deg', to: '90 deg' }, samples: 4,
    drivenMeasured: ['0 deg', '-15 deg', '-30 deg', '-45 deg'],
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.evaluated.engaged, true, JSON.stringify(out));
  near(out.result.evaluated.maxResidual.value, 0.0, 1e-9, 'max residual');
  near(out.result.zeroPhase.value, 0.0, 1e-9, 'zero phase');
});

test('G17-03: mechanism inspect reports the residual and engagement of actual values', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['mechanism', 'inspect', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    coupling: { type: 'rotation', ratio: -0.5, zeroPhase: '0 deg' },
    driverValue: '90 deg', drivenValue: '-45 deg', tolerance: '0.01 deg',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.engaged, true, JSON.stringify(out));
  near(out.result.residual.value, 0.0, 1e-9, 'residual');

  const { code, json: slipped } = cad(['mechanism', 'inspect', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    coupling: { type: 'rotation', ratio: -0.5, zeroPhase: '0 deg' },
    driverValue: '90 deg', drivenValue: '-30 deg', tolerance: '0.01 deg',
  })]);
  assert.equal(code, 1, JSON.stringify(slipped));
  assert.equal(slipped.status, 'fail', JSON.stringify(slipped));
  assert.equal(slipped.result.engaged, false, JSON.stringify(slipped));
});

test('G17-04: mechanism stop-check verifies program vs hard limits and engagement', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['mechanism', 'stop-check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    coupling: { type: 'rotation', ratio: -0.5 },
    limits: { working: { min: '0 deg', max: '200 deg' }, program: { max: '180 deg' }, hard: { max: '200 deg' } },
    stopSurfaces: [{ clearance: '0.2 mm' }],
    sensorWindow: { from: '0 deg', to: '170 deg' },
    tolerance: '0.01 deg', driverValue: '200 deg', drivenValue: '-100 deg',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.programLimitIsNotPhysicalStop, true, JSON.stringify(out));
  const statuses = Object.fromEntries(out.result.checks.map((c) => [c.check, c.status]));
  assert.equal(statuses['program-vs-hard'], 'pass', JSON.stringify(out));
  assert.equal(statuses.engagement, 'pass', JSON.stringify(out));
});

test('G17-05: native motion link is gated; the explicit evaluated track is always returned', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['mechanism', 'couple', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    coupling: { type: 'rotation', ratio: -0.5 },
    driverRange: { from: '0 deg', to: '360 deg' }, samples: 16,
    representation: 'native',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const body = out.result;
  // Whether or not the SDK exposes motion links, an explicit unwrapped track is returned.
  assert.equal(body.evaluated.unwrapped, true, JSON.stringify(out));
  assert.ok(Array.isArray(body.evaluated.track) && body.evaluated.track.length === 16, JSON.stringify(out));
});

test('G17-06: stop-check keeps counter engagement through an unwrapped >360deg hard stop', (t) => {
  if (skipLive(t)) return;
  const doc = docName();
  const out = fmcad(['mechanism', 'stop-check', '--doc', doc, '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    coupling: { type: 'rotation', ratio: -0.5 },
    limits: { working: { min: '0 deg', max: '720 deg' }, program: { max: '180 deg' }, hard: { max: '720 deg' } },
    stopSurfaces: [{ clearance: '0.2 mm' }],
    sensorWindow: { from: '0 deg', to: '700 deg' },
    tolerance: '0.01 deg', driverValue: '720 deg', drivenValue: '-360 deg',
  })]);
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const statuses = Object.fromEntries(out.result.checks.map((c) => [c.check, c.status]));
  assert.equal(statuses.engagement, 'pass', JSON.stringify(out));
  assert.equal(statuses['program-vs-hard'], 'pass', JSON.stringify(out));
});

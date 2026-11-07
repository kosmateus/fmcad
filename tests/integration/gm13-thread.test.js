'use strict';

// GM13 (thread) live integration tests. Each test invokes the real fmcad CLI
// against the coordinator-provided cloud document and asserts the SPEC's
// expected result. With FMCAD_TEST_DOC unset every test and hook skips cleanly.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { docName, fmcad, clear, hasDoc, skipLive } = require('./helper');

beforeEach(function () {
  if (!hasDoc()) return;
  clear();
});
afterEach(function () {
  if (!hasDoc()) return;
  clear();
});

test('G13-01: thread.catalog queries the curated ISO metric table with lead', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['thread', 'catalog', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', system: 'iso-metric-coarse', query: 'M10',
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.system, 'iso-metric-coarse');
  assert.equal(out.result.curated, true);
  assert.equal(out.result.entries.length, 1);
  const entry = out.result.entries[0];
  assert.equal(entry.designation, 'M10');
  assert.equal(entry.pitch.value, 1.5);
  assert.equal(entry.lead.value, 1.5);
  assert.equal(entry.majorDiameter.value, 10);
  assert.equal(entry.starts, 1);
  assert.equal(entry.hand, 'right');
});

test('G13-02: model.thread extension keeps representations distinct (custom profile is a recipe)', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['model', 'thread', '--doc', docName(), '--data', JSON.stringify({
    faces: [{ token: 'cylinder-face-token' }], internal: false,
    profile: { majorDiameter: '10 mm', pitch: '1.5 mm', starts: 2, hand: 'right' },
  })]);
  // A custom profile is a computational recipe, never a texture or a fake native feature.
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.representation, 'recipe');
  assert.equal(out.result.modeled, true);
  assert.equal(out.result.feature, null);
  assert.ok(Math.abs(out.result.lead.value - 3.0) < 1e-6, JSON.stringify(out.result.lead));
  assert.equal(out.result.starts, 2);
  assert.equal(out.result.hand, 'right');
});

test('G13-03: thread.custom-profile computes lead = starts * pitch and profile depth', (t) => {
  if (skipLive(t)) return;
  const out = fmcad(['thread', 'custom-profile', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    majorDiameter: '10 mm', pitch: '1.5 mm', starts: 3, hand: 'right',
    flankAngle: '60 deg', rootShape: 'flat', length: '20 mm', runout: '1.5 mm', clearance: '0.1 mm',
  })]);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.result.representation, 'recipe');
  const profile = out.result.profile;
  assert.equal(profile.majorDiameter.value, 10);
  assert.ok(Math.abs(profile.pitch.value - 1.5) < 1e-6, JSON.stringify(profile.pitch));
  assert.equal(profile.starts, 3);
  assert.ok(Math.abs(profile.lead.value - 4.5) < 1e-6, JSON.stringify(profile.lead));
  assert.equal(profile.hand, 'right');
  assert.ok(Math.abs(profile.turnsPerLength.value - 1 / 4.5) < 1e-9);
  // minorDiameter = major - 1.226869*pitch; depth = (major - minor) / 2.
  const expectedDepth = (1.226869 * 1.5) / 2;
  assert.ok(Math.abs(profile.depth.value - expectedDepth) < 1e-6, JSON.stringify(profile.depth));
});

test('G13-04: thread.pair-check verifies fit, engagement depth and hand mismatch', (t) => {
  if (skipLive(t)) return;
  const rh = fmcad(['thread', 'pair-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    external: { majorDiameter: '10 mm', minorDiameter: '8.16 mm', pitch: '1.5 mm', starts: 1, hand: 'right' },
    internal: { majorDiameter: '10 mm', minorDiameter: '8.38 mm', pitch: '1.5 mm', starts: 1, hand: 'right' },
  })]);
  assert.equal(rh.status, 'pass', JSON.stringify(rh));
  assert.equal(rh.result.pairFit, 'pass');
  assert.ok(Math.abs(rh.result.engagementDepth.value - (10 - 8.38) / 2) < 1e-6);

  // Hand mismatch fails (exits nonzero with the fail envelope on stdout).
  assert.throws(() => fmcad(['thread', 'pair-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    external: { majorDiameter: '10 mm', minorDiameter: '8.16 mm', pitch: '1.5 mm', starts: 1, hand: 'right' },
    internal: { majorDiameter: '10 mm', minorDiameter: '8.38 mm', pitch: '1.5 mm', starts: 1, hand: 'left' },
  })]), /hands must match/);
});

test('G13-05: contradictory profile and pair inputs are rejected', (t) => {
  if (skipLive(t)) return;
  // Both minorDiameter and pitchDiameter is contradictory.
  assert.throws(() => fmcad(['thread', 'custom-profile', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    majorDiameter: '10 mm', minorDiameter: '8 mm', pitchDiameter: '9 mm', pitch: '1.5 mm',
  })]), /minorDiameter or pitchDiameter/);
  // Equal lead but mismatched starts fails (lead equality alone is not enough).
  assert.throws(() => fmcad(['thread', 'pair-check', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component',
    external: { majorDiameter: '10 mm', minorDiameter: '8.16 mm', pitch: '1.5 mm', starts: 2, hand: 'right' },
    internal: { majorDiameter: '10 mm', minorDiameter: '8.38 mm', pitch: '3.0 mm', starts: 1, hand: 'right' },
  })]), /starts must match/);
});

test('G13-06: one-turn advance and multi-start lead are computed honestly (no geometry)', (t) => {
  if (skipLive(t)) return;
  // Single start: lead = starts * pitch = 1.5 mm/turn.
  const single = fmcad(['thread', 'custom-profile', '--doc', docName(), '--data', JSON.stringify({
    schemaVersion: 1, frame: 'component', majorDiameter: '10 mm', pitch: '1.5 mm', starts: 1, hand: 'right',
  })]);
  assert.equal(single.status, 'pass', JSON.stringify(single));
  assert.ok(Math.abs(single.result.profile.lead.value - 1.5) < 1e-6, JSON.stringify(single.result.profile.lead));

  // Two starts at 1.5 mm pitch: lead = 3 mm/turn, recipe-only (declared native gap).
  const multi = fmcad(['model', 'thread', '--doc', docName(), '--data', JSON.stringify({
    faces: [{ token: 'cylinder-face-token' }], internal: false,
    profile: { majorDiameter: '10 mm', pitch: '1.5 mm', starts: 2, hand: 'right' },
  })]);
  assert.equal(multi.status, 'pass', JSON.stringify(multi));
  assert.ok(Math.abs(multi.result.lead.value - 3.0) < 1e-6, JSON.stringify(multi.result.lead));
  assert.equal(multi.result.starts, 2);
  assert.equal(multi.result.feature, null);
  assert.match(multi.result.note, /declared native gap/);
});

// GM13 owner: thread catalog, custom profiles, pair checks and model.thread recipe extension.
'use strict';

const common = { schemaVersion: 'Required 1.', frame: 'Required component.' };
const profileInputs = {
  majorDiameter: 'Positive major diameter length expression.',
  minorDiameter: 'Positive minor diameter length expression, exclusive with pitchDiameter.',
  pitchDiameter: 'Positive pitch diameter length expression, exclusive with minorDiameter.',
  pitch: 'Positive thread pitch length expression.',
  starts: 'Positive integer number of starts; lead = starts * pitch.',
  hand: 'right (default) or left.',
  flankAngle: 'Flank angle expression, default 60 deg.',
  rootShape: 'flat (default) or rounded.',
  length: 'Optional threaded length expression.',
  runout: 'Optional runout length expression, default 0.',
  clearance: 'Optional clearance length expression, default 0.',
};
const descriptors = {
  'thread.catalog': {
    summary: 'List and query a curated ISO metric coarse thread table with pitch/minor diameters and lead (GM13 v1).',
    required: ['schemaVersion', 'frame'], readOnly: true, envelope: true,
    inputs: { ...common, system: 'iso-metric-coarse (only curated table available).', query: 'Optional exact designation filter (e.g. M10).', starts: 'Optional positive integer of starts applied to lead.', },
    example: { schemaVersion: 1, frame: 'component', system: 'iso-metric-coarse', query: 'M10' },
    limitations: ['Curated subset, not the full installed Fusion table.', 'lead = starts * pitch; turns-per-length is a separate quantity.'],
  },
  'thread.custom-profile': {
    summary: 'Define and validate a custom (non-tabular) thread profile with computed lead and depth (GM13 v1).',
    required: ['schemaVersion', 'frame', 'majorDiameter', 'pitch'], readOnly: true, envelope: true,
    inputs: { ...common, ...profileInputs },
    example: { schemaVersion: 1, frame: 'component', majorDiameter: '10 mm', pitch: '1.5 mm', starts: 1, hand: 'right', flankAngle: '60 deg', rootShape: 'flat', length: '20 mm', runout: '1.5 mm', clearance: '0.1 mm' },
    limitations: ['Custom profile is a BRep recipe, never a native tabular thread or visual texture.'],
  },
  'thread.pair-check': {
    summary: 'Check external/internal thread pair fit, cross-section, lead and engagement depth (GM13 v1).',
    required: ['schemaVersion', 'frame', 'external', 'internal'], readOnly: true, envelope: true,
    inputs: { ...common, external: 'External (bolt) thread profile: majorDiameter, pitch, minorDiameter?|pitchDiameter?, starts?, hand?.',
      internal: 'Internal (nut) thread profile with the same shape.', tolerance: 'Lead match tolerance, default 0.01 mm.' },
    example: { schemaVersion: 1, frame: 'component', external: { majorDiameter: '10 mm', minorDiameter: '8.16 mm', pitch: '1.5 mm', starts: 1, hand: 'right' }, internal: { majorDiameter: '10 mm', minorDiameter: '8.38 mm', pitch: '1.5 mm', starts: 1, hand: 'right' } },
    limitations: ['Lead and starts must both match; lead equality alone is not enough.', 'Geometric fit check, not a torque/preload or sealing certification.'],
  },
};

function validate(operation, data) {
  if (!descriptors[operation]) return;
  if (data.schemaVersion !== 1 || data.frame !== 'component') throw new Error(`${operation} requires schemaVersion:1 and frame:component`);
  if (operation === 'thread.custom-profile') {
    if (typeof data.majorDiameter !== 'string' || typeof data.pitch !== 'string') throw new Error('majorDiameter and pitch require length expressions');
    if ('minorDiameter' in data && 'pitchDiameter' in data) throw new Error('supply minorDiameter or pitchDiameter, not both');
  }
  if (operation === 'thread.catalog' && 'system' in data && data.system !== 'iso-metric-coarse') throw new Error('Only the iso-metric-coarse curated table is available');
  if (operation === 'thread.pair-check') {
    for (const key of ['external', 'internal']) if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) throw new Error(`${key} must be a thread profile object`);
  }
}
module.exports = { descriptors, validate };

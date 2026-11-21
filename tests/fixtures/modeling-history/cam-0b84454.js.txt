// GM14 owner: cam pitch/working profiles, pressure angle, curvature and cycle resolution.
'use strict';

const common = { schemaVersion: 'Required 1.', frame: 'Required component.' };
const camInputs = {
  schemaVersion: 'Required 1.', frame: 'Required component.',
  rise: 'Rise description: {law:halfCosine,lift,angle} or {samples:[{angle,lift},...]}.',
  baseRadius: 'Base circle radius length expression, default 15 mm.',
  rollerRadius: 'Roller radius length expression, default 5 mm.',
  followerLine: 'Follower direction as three unitless numbers, default [0,1,0] (+Y).',
  phase: 'Rotation angle expression applied to align the follower, default 0 deg.',
  direction: 'ccw (default) or cw.',
  minimumCurvatureRadius: 'Optional required minimum pitch curvature radius (cam evaluate).',
  maximumPressureAngle: 'Optional maximum pressure angle expression (cam evaluate).',
  release: 'Optional explicit release law; omitted means unresolved.',
  dwell: 'Optional explicit dwell law; omitted means unresolved.',
  returnLaw: 'Optional explicit return law (cam cycle-check).',
  followerCoupling: 'Optional spring-return, force-closed or form-closed.',
};
const descriptors = {
  'cam.profile': {
    summary: 'Compute pitch and roller working profiles (normal offset), pressure angle and curvature from a rise law (GM14 v1).',
    required: ['schemaVersion', 'frame', 'rise'], readOnly: true, envelope: true,
    inputs: camInputs,
    example: { schemaVersion: 1, frame: 'component', baseRadius: '15 mm', rollerRadius: '5 mm', rise: { law: 'halfCosine', lift: '10 mm', angle: '240 deg' }, followerLine: [0, 1, 0], phase: '0 deg', direction: 'ccw' },
    limitations: ['Rise-only sources stay open; no chord closure or eccentric substitution.', 'Normal offset, never radial substitution.'],
  },
  'cam.evaluate': {
    summary: 'Evaluate pressure angle and pitch curvature against declared limits (GM14 v1).',
    required: ['schemaVersion', 'frame', 'rise'], readOnly: true, envelope: true,
    inputs: camInputs,
    example: { schemaVersion: 1, frame: 'component', baseRadius: '15 mm', rollerRadius: '5 mm', rise: { law: 'halfCosine', lift: '10 mm', angle: '240 deg' }, maximumPressureAngle: '12 deg', minimumCurvatureRadius: '10 mm' },
    limitations: ['Evaluated against declared limits; missing limits are notEvaluated.'],
  },
  'cam.cycle-check': {
    summary: 'Resolve cam cycle intervals and flag unresolved release/dwell without forcing closure (GM14 v1).',
    required: ['schemaVersion', 'frame'], readOnly: true, envelope: true,
    inputs: camInputs,
    example: { schemaVersion: 1, frame: 'component', rise: { law: 'halfCosine', lift: '10 mm', angle: '240 deg' }, returnLaw: 'spring-return' },
    limitations: ['Drop edge and dynamics remain blocked until properly defined.', 'Release without an explicit law is unresolved, never auto-closed.'],
  },
};

function validate(operation, data) {
  if (!descriptors[operation]) return;
  if (data.schemaVersion !== 1 || data.frame !== 'component') throw new Error(`${operation} requires schemaVersion:1 and frame:component`);
  if ((operation === 'cam.profile' || operation === 'cam.evaluate') && (!data.rise || typeof data.rise !== 'object' || Array.isArray(data.rise))) throw new Error('rise must be an object');
  if (operation === 'cam.evaluate') {
    for (const key of ['minimumCurvatureRadius']) if (key in data && typeof data[key] !== 'string') throw new Error(`${key} requires a length expression`);
    for (const key of ['maximumPressureAngle']) if (key in data && typeof data[key] !== 'string') throw new Error(`${key} requires an angle expression`);
  }
}
module.exports = { descriptors, validate };

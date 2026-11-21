// GM12 owner: helix generation, spring recipes and spring engineering evaluations.
'use strict';

const common = { schemaVersion: 'Required 1.', frame: 'Required component.' };
const springInputs = {
  wireDiameter: 'Positive wire diameter length expression.',
  meanDiameter: 'Positive mean coil diameter length expression, strictly greater than wireDiameter.',
  activeCoils: 'Positive number of active coils; drives stiffness.',
  totalCoils: 'Positive number of total coils; drives mass and solid height (>= activeCoils).',
  freeLength: 'Positive free length expression, strictly greater than solid height.',
  shearModulus: 'Unit-bearing pressure quantity (N/mm^2, MPa, GPa, ...); default 79000 MPa.',
  density: 'Unit-bearing density quantity (kg/m^3, g/cm^3, ...); default 7850 kg/m^3.',
  material: 'Optional material name retained as provenance only.',
  endStyle: 'plain (default), ground or open; ground/plain ends are recipe representations only, no native end-coil geometry is cut or generated.',
  transition: 'Optional transition description between active and end coils.',
  hand: 'right (default) or left.',
  installedLength: 'Optional installed (rest) length expression.',
  compressedLength: 'Optional compressed (cocked) length expression.',
  deflection: 'Optional deflection expression, exclusive with compressedLength.',
  guide: 'Optional {kind:rod|tube,diameter} guide clearance check.',
  name: 'Optional feature name (shape spring only).', operation: 'newBody, join, cut or intersect.', section: 'Optional profile ref override for the wire section.',
};
const helixInputs = {
  schemaVersion: 'Required 1.', frame: 'Required component.',
  radius: 'Positive helix radius length expression.',
  axis: 'Optional axis {origin:[x,y,z],direction:[x,y,z]} or native axis/edge ref; default +Z at origin.',
  pitch: 'Positive length expression; exclusive with height.',
  turns: 'Positive number of turns; required with height when pitch is omitted.',
  height: 'Positive total axial length expression; exclusive with pitch.',
  hand: 'right (default) or left.',
  startPhase: 'Angular expression, default 0 deg.',
  tolerance: 'Positive curve tolerance length, default 0.01 mm.',
  maxSamples: 'Integer 4..100000, default 10000.',
  representation: 'recipe (default) or native (blocked; no persistent helix feature API).',
  section: 'Optional profile ref to sweep along the generated helix.',
  name: 'Optional feature name.', operation: 'newBody, join, cut or intersect.',
};
const descriptors = {
  'curve.helix': {
    summary: 'Generate a real helical centerline (BRep recipe, never native Coil) with optional section sweep (GM12 v1).',
    required: ['schemaVersion', 'frame', 'radius'], readOnly: false, envelope: true,
    inputs: helixInputs,
    example: { schemaVersion: 1, frame: 'component', radius: '4 mm', pitch: '5.75 mm', turns: 8, hand: 'right', startPhase: '0 deg', tolerance: '0.01 mm' },
    limitations: ['Sampled helix plus fitted NURBS recipe; native Coil is never claimed.', 'Native persistent 3D helical path insertion is a declared gap; see docs/HELIX_SPRING.md.'],
  },
  'shape.spring': {
    summary: 'Generate spring geometry (helix + wire section) with wire length, mass, solid height and stiffness; ground/plain ends are recipe representations only (GM12 v1).',
    required: ['schemaVersion', 'frame', 'name', 'wireDiameter', 'meanDiameter', 'activeCoils', 'totalCoils', 'freeLength'], readOnly: false, envelope: true,
    inputs: { ...common, ...springInputs },
    example: { schemaVersion: 1, frame: 'component', name: 'Spring', wireDiameter: '0.5 mm', meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm', endStyle: 'ground', hand: 'right' },
    limitations: ['Recipe is not atomic.', 'Ground-end geometry and the wire-section sweep require a persistent native 3D helical path (declared gap); see docs/HELIX_SPRING.md.'],
  },
  'spring.evaluate': {
    summary: 'Evaluate spring stiffness, forces, energy, wire length, mass and solid height (GM12 v1).',
    required: ['schemaVersion', 'frame', 'wireDiameter', 'meanDiameter', 'activeCoils', 'totalCoils', 'freeLength'], readOnly: true, envelope: true,
    inputs: { ...common, ...springInputs },
    example: { schemaVersion: 1, frame: 'component', wireDiameter: '0.5 mm', meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm', shearModulus: '77000 N/mm^2', density: '7850 kg/m^3', installedLength: '27 mm', compressedLength: '17 mm' },
    limitations: ['Linear spring model; no buckling or fatigue.', 'Active coils drive stiffness; total coils drive mass and solid height.'],
  },
  'spring.configure': {
    summary: 'Configure installed/compressed spring state with guide, solid-height and material-volume checks (GM12 v1).',
    required: ['schemaVersion', 'frame', 'wireDiameter', 'meanDiameter', 'activeCoils', 'totalCoils', 'freeLength'], readOnly: true, envelope: true,
    inputs: { ...common, ...springInputs },
    example: { schemaVersion: 1, frame: 'component', wireDiameter: '0.5 mm', meanDiameter: '8 mm', activeCoils: 6, totalCoils: 8, freeLength: '35 mm', shearModulus: '77000 N/mm^2', installedLength: '27 mm', compressedLength: '17 mm', guide: { kind: 'rod', diameter: '7.4 mm' } },
    limitations: ['Compressed config below solid height fails (material volume would change silently).', 'No buckling/fatigue/lateral-stability certification.'],
  },
};

function validate(operation, data) {
  if (!descriptors[operation]) return;
  if (data.schemaVersion !== 1 || data.frame !== 'component') throw new Error(`${operation} requires schemaVersion:1 and frame:component`);
  if (operation === 'curve.helix') {
    if ('pitch' in data && 'height' in data) throw new Error('pitch and height are contradictory; height equals pitch times turns');
    if (!('pitch' in data) && !('turns' in data && 'height' in data)) throw new Error('Supply pitch, or both turns and height');
  }
  for (const key of ['activeCoils', 'totalCoils']) if (key in data && !(Number.isFinite(Number(data[key])) && Number(data[key]) >= 0)) throw new Error(`${key} must be a nonnegative number`);
  if ('wireDiameter' in data && 'meanDiameter' in data) {
    for (const key of ['wireDiameter', 'meanDiameter', 'freeLength']) if (typeof data[key] !== 'string' || !data[key].trim()) throw new Error(`${key} must be a length expression`);
  }
  if ('compressedLength' in data && 'deflection' in data) throw new Error('compressedLength and deflection are exclusive');
  if (data.guide !== undefined && (!data.guide || typeof data.guide !== 'object' || Array.isArray(data.guide) || !data.guide.diameter)) throw new Error('guide requires a diameter');
}
module.exports = { descriptors, validate };

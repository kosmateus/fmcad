// GM16 owner: mount locating, fastener stacks, bearing stacks, shaft interfaces,
// bayonet retention, snap-fit evaluation and hose-barbs.
'use strict';

const common = { schemaVersion: 'Required 1.', frame: 'Required component.' };
const descriptors = {
  'mount.create': {
    summary: 'Define a PCB mount: pin+slot locating datums, clearance hole pattern, boss/insert support and mate fit (GM16 v1).',
    required: ['schemaVersion', 'frame', 'name', 'scheme', 'pin', 'slot', 'holes'], readOnly: false, envelope: true,
    inputs: { ...common, name: 'Mount name.', scheme: 'pin-slot, two-pin or 2-2-2.', pin: 'Primary locating datum {x,y} expressions.', slot: 'Secondary locating datum {x,y} expressions.', holes: 'Hole pattern {diameter,clearance?,positions:[{x,y},...]}.', boss: 'Optional {diameter,height} connector standoff.', insert: 'Optional {type,outerDiameter,innerDiameter,length}.', support: 'Optional {connector}.', material: 'Optional material name.', process: 'Optional process name.' },
    example: { schemaVersion: 1, frame: 'component', name: 'PcbMount', scheme: 'pin-slot', pin: { x: '0 mm', y: '0 mm' }, slot: { x: '40 mm', y: '0 mm' }, holes: { diameter: '3 mm', clearance: '0.5 mm', positions: [ { x: '10 mm', y: '10 mm' }, { x: '30 mm', y: '10 mm' }, { x: '10 mm', y: '30 mm' }, { x: '30 mm', y: '30 mm' } ] }, boss: { diameter: '6 mm', height: '8 mm' }, support: { connector: true }, material: 'FR-4 + brass insert', process: 'injection molded' },
    limitations: ['Locating datums are created; holes/boss are declared feature prescriptions (recipeRegeneration).', 'A PCB is located, not certified; thermal/material behaviour needs declared data.'],
  },
  'mount.check': {
    summary: 'Check a mount for over-constraint (PCB fixed through every hole) and connector support (GM16 v1).',
    required: ['schemaVersion', 'frame', 'scheme', 'holes'], readOnly: true, envelope: true,
    inputs: { ...common, scheme: 'pin-slot, two-pin or 2-2-2.', holes: 'Array of {diameter,clearance,x?,y?}.', connector: 'Optional {supported,supportPresent?,standoff?}.', pcb: 'Optional PCB data.', process: 'Optional process name.' },
    example: { schemaVersion: 1, frame: 'component', scheme: 'pin-slot', holes: [ { diameter: '3 mm', clearance: '0.5 mm' }, { diameter: '3 mm', clearance: '0.5 mm' }, { diameter: '3 mm', clearance: '0.5 mm' }, { diameter: '3 mm', clearance: '0.5 mm' } ], connector: { supported: true, supportPresent: true } },
    limitations: ['Over-constraint and connector support are evaluated from declared clearances and support presence.'],
  },
  'fastener.stack': {
    summary: 'Compute a fastener clamp stack: clamped length, thread engagement, bottoming and tool access from declared data (GM16 v1).',
    required: ['schemaVersion', 'frame', 'screw', 'stack'], readOnly: true, envelope: true,
    inputs: { ...common, screw: '{length,threadLength,majorDiameter?,pitch?,headDiameter?,driver?,material?}.', stack: 'Array of clamped parts {id?,thickness,material?}.', receptacle: 'Optional {kind:nut|tapped|insert,threadLength?,depth?}.', torque: 'Optional declared torque string (never derived from diameter).', tool: 'Optional {diameter,recess?,length?}.', chamfer: 'Optional entry chamfer data.', gap: 'Optional gap data.', material: 'Optional material.', process: 'Optional process.' },
    example: { schemaVersion: 1, frame: 'component', screw: { length: '12 mm', threadLength: '10 mm', majorDiameter: '3 mm', pitch: '0.5 mm', headDiameter: '6 mm' }, stack: [ { id: 'bracket', thickness: '4 mm' }, { id: 'pcb', thickness: '1.6 mm' } ], receptacle: { kind: 'insert', depth: '8 mm' }, torque: '0.5 N*m', tool: { diameter: '4 mm', recess: '5 mm' } },
    limitations: ['Engagement is threadLength minus clamped stack; torque is declared, never derived from diameter.', 'Bottoming/access reported only when receptacle depth / tool recess are declared.'],
  },
  'fastener.check': {
    summary: 'Validate a fastener stack: engagement, bottoming and tool access against declared requirements (GM16 v1).',
    required: ['schemaVersion', 'frame', 'screw', 'stack'], readOnly: true, envelope: true,
    inputs: { ...common, screw: '{length,threadLength,...}.', stack: 'Clamped parts.', minimumEngagement: 'Optional minimum engagement length (thread class provides it, not diameter).', receptacle: 'Optional {kind,threadLength?,depth?}.', tool: 'Optional {diameter,recess?,length?}.', torque: 'Optional declared torque.', material: 'Optional material.', process: 'Optional process.' },
    example: { schemaVersion: 1, frame: 'component', screw: { length: '12 mm', threadLength: '10 mm' }, stack: [ { thickness: '4 mm' }, { thickness: '1.6 mm' } ], minimumEngagement: '4 mm', receptacle: { kind: 'insert', depth: '8 mm' }, tool: { diameter: '4 mm', recess: '5 mm' } },
    limitations: ['Engagement/bottoming/access evaluated only from declared thread, receptacle and tool data.'],
  },
  'fastener.measured-check': {
    summary: 'Measure screw engagement, blind-hole bottoming, protrusion, alignment and tool access from versioned native references (GM16 v2).',
    required: ['schemaVersion', 'mode', 'native'], readOnly: true, envelope: true,
    inputs: {
      schemaVersion: 'Required 1.', mode: 'Required native; this operation never substitutes declared dimensions for native reads.',
      native: 'Versioned native refs: {schemaVersion:1,frame:{space,component},tolerance:{axisOffset,axisAngle,minimumEngagement?},screw:{axis?,headBearing?,tip?,threadStart?,threadEnd?},receptacle:{kind,axis?,threadStart?,threadEnd?,bottom?},layers?:[{id?,start?,end?}]}. Missing refs return unknown coverage.',
      declaredEvidence: 'Optional unchanged {operation:fastener.stack|fastener.check,...legacy input}; its component frame and units remain separate from native measurements.',
      toolAccess: 'Optional {tool:{diameter,length},target:{origin,axis,engagementDepth?},entry:{origin,direction},nativeObstacles:[{name?,body}],declaredObstacles?:[point/radius or box],minimumClearance?,samples?}. At least one native body ref is required for pass; only selected bodies are covered, by conservative bounds. Declared shapes remain separately labeled and no exhaustive scene scan is claimed.',
    },
    example: {
      schemaVersion: 1, mode: 'native',
      native: {
        schemaVersion: 1, frame: { space: 'assembly', component: { kind: 'component', name: 'root' } },
        tolerance: { axisOffset: '0.05 mm', axisAngle: '1 deg', minimumEngagement: '4 mm' },
        screw: { axis: { kind: 'axis', name: 'ScrewAxis' }, headBearing: { kind: 'point', name: 'HeadBearing' }, tip: { kind: 'point', name: 'ScrewTip' }, threadStart: { kind: 'point', name: 'ScrewThreadStart' }, threadEnd: { kind: 'point', name: 'ScrewThreadEnd' } },
        receptacle: { kind: 'blind', axis: { kind: 'axis', name: 'HoleAxis' }, threadStart: { kind: 'point', name: 'HoleThreadStart' }, threadEnd: { kind: 'point', name: 'HoleThreadEnd' }, bottom: { kind: 'point', name: 'HoleBottom' } },
        layers: [{ id: 'bracket', start: { kind: 'point', name: 'StackNear' }, end: { kind: 'point', name: 'StackFar' } }],
      },
      declaredEvidence: { operation: 'fastener.check', schemaVersion: 1, frame: 'component', screw: { length: '12 mm', threadLength: '10 mm' }, stack: [{ id: 'bracket', thickness: '5 mm' }], minimumEngagement: '4 mm' },
    },
    limitations: [
      'Axial thread-boundary overlap is not exact helical thread-flank contact or strength proof; source refs, sourceVersion, frame and coverage are reported.',
      'Missing or unsupported native reads remain unknown and never fall back to declaredEvidence.',
      'Native tool obstacles use conservative axis-aligned solid bounds and the existing sampled cylindrical tool.access calculation; this is not continuous collision proof. Declared point/box obstacles are a distinct evidence source.',
      'The legacy component-local calculator and its original units remain available through fastener.stack and fastener.check.',
      'Offline fixtures are not native Fusion qualification; live synthetic-document qualification and restoration require separate explicit approval.',
    ],
  },
  'fastener.schedule': {
    summary: 'Build a fastener schedule from declared torque/process/material/vendor data, reporting missing data (GM16 v1).',
    required: ['schemaVersion', 'frame', 'fasteners'], readOnly: true, envelope: true,
    inputs: { ...common, fasteners: 'Array of {id,torque?,process?,material?,vendor?,stack?,screw?}.' },
    example: { schemaVersion: 1, frame: 'component', fasteners: [ { id: 'M3-01', torque: '0.5 N*m', process: 'torque wrench', material: 'A2-70', vendor: 'VENDOR-A' }, { id: 'M3-02', torque: '0.5 N*m', process: 'torque wrench', material: 'A2-70', vendor: 'VENDOR-A' } ] },
    limitations: ['No torque or fit is derived from diameter; the schedule reports declared data only.'],
  },
  'bearing.stack-check': {
    summary: 'Check a bearing stack: ring/journal/seat fits, axial load chain and fixed/floating arrangement (GM16 v1).',
    required: ['schemaVersion', 'frame', 'rings', 'journal', 'seat'], readOnly: true, envelope: true,
    inputs: { ...common, rings: '{inner:{bore?,width?},outer:{od?,width?}}.', journal: 'Shaft diameter length.', seat: 'Housing bore length.', fits: 'Optional {shaft,housing} fit classes.', shaftClearance: 'Optional shaft clearance length (signed).', housingClearance: 'Optional housing clearance length (signed).', radialInternalClearance: 'Optional radial internal clearance.', shoulder: 'Optional {inner?,outer?} fixed-ring shoulder.', spacer: 'Optional spacer data.', retainer: 'Optional retainer data.', arrangement: 'fixed-floating (default), fixed-fixed or floating.', axialLoad: 'Optional axial load.' },
    example: { schemaVersion: 1, frame: 'component', rings: { inner: { bore: '10 mm' }, outer: { od: '26 mm' } }, journal: '10 mm', seat: '26 mm', shaftClearance: '0.005 mm', housingClearance: '0.0 mm', shoulder: { inner: true }, arrangement: 'fixed-floating' },
    limitations: ['No default preload is assumed; floating arrangement clearance is declared, not derived.', 'Fit classes are declared; clearance values are reported when given.'],
  },
  'shaft.interface': {
    summary: 'Check a shaft/hub interface: D-flat/key mate, split-clamp gap and axial retention (GM16 v1).',
    required: ['schemaVersion', 'frame', 'shaft', 'hub'], readOnly: true, envelope: true,
    inputs: { ...common, shaft: '{type:D-flat|keyed|round,d,flat?:{depth},key?:{width,height}}.', hub: '{bore,boreType?,splitClampGap?,shoulders?,retainer?}.', seatedLength: 'Optional seating length.', retainer: 'Optional retainer data.' },
    example: { schemaVersion: 1, frame: 'component', shaft: { type: 'D-flat', d: '6 mm', flat: { depth: '0.5 mm' } }, hub: { bore: '6 mm', boreType: 'D-flat', splitClampGap: '0.8 mm', shoulders: [ {} ] } },
    limitations: ['Mate profile consistency only; no torque transmission or strength claim.', 'A D-flat shaft must mate a D-flat bore, never a round hole.'],
  },
  'retention.bayonet': {
    summary: 'Resolve a bayonet retention: lugs, stroke/rotation, capture and the assembly/unlock path (GM16 v1).',
    required: ['schemaVersion', 'frame', 'lugs', 'stroke', 'rotation'], readOnly: true, envelope: true,
    inputs: { ...common, lugs: '{count,width,height}.', stroke: 'Insertion stroke length.', rotation: 'Bayonet rotation angle.', ramps: 'Optional ramp array.', stops: 'Optional stop array.', capture: 'Optional {depth}.', clearances: 'Optional {axial?,radial?}.' },
    example: { schemaVersion: 1, frame: 'component', lugs: { count: 3, width: '4 mm', height: '2 mm' }, stroke: '6 mm', rotation: '30 deg', capture: { depth: '1.5 mm' }, clearances: { radial: '0.2 mm' } },
    limitations: ['Assembly path is geometric; no retention force or release-safety certification.'],
  },
  'snap.define': {
    summary: 'Define a cantilever snap geometry and material (shape definition) (GM16 v1).',
    required: ['schemaVersion', 'frame', 'geometry', 'material'], readOnly: true, envelope: true,
    inputs: { ...common, geometry: '{length,width,thickness,engagementDepth,angle?}.', material: '{name,modulus?,yieldStrength?}.', retention: 'Optional retention style (default straight).', support: 'Optional support data.' },
    example: { schemaVersion: 1, frame: 'component', geometry: { length: '10 mm', width: '4 mm', thickness: '1 mm', engagementDepth: '0.6 mm' }, material: { name: 'ABS', modulus: '2.1 GPa', yieldStrength: '40 MPa' } },
    limitations: ['No material default; modulus and yield strength must be declared for evaluation.'],
  },
  'snap.evaluate': {
    summary: 'Estimate snap deflection/strain/force with a linear elastic beam model from declared geometry and material (GM16 v1).',
    required: ['schemaVersion', 'frame', 'geometry', 'material', 'support'], readOnly: true, envelope: true,
    inputs: { ...common, geometry: '{length,width,thickness,engagementDepth,angle?,deflection?}.', material: '{name,modulus,yieldStrength?}.', support: '{condition:cantilever|fixed-fixed}.' },
    example: { schemaVersion: 1, frame: 'component', geometry: { length: '10 mm', width: '4 mm', thickness: '1 mm', engagementDepth: '0.6 mm', deflection: '0.6 mm' }, material: { name: 'ABS', modulus: '2.1 GPa', yieldStrength: '40 MPa' }, support: { condition: 'cantilever' } },
    limitations: ['Linear elastic small-deflection beam estimate; no fatigue-life claim.', 'Material modulus/yield are declared, never defaulted.'],
  },
  'shape.hose_barb': {
    summary: 'Generate a hose barb (axisymmetric revolve) and check channel continuity and barb seating (GM16 v1).',
    required: ['schemaVersion', 'frame', 'name', 'tubeId', 'tubeOd', 'bore', 'barbs'], readOnly: false, envelope: true,
    inputs: { ...common, name: 'Feature name.', tubeId: 'Tube inner diameter length.', tubeOd: 'Tube outer diameter length (> tubeId).', bore: 'Through-bore diameter length (<= tubeId).', barbs: 'Array of {crest,root,length} (crest > root >= tubeOd).', blend: 'Optional blend radius.', clampZone: 'Optional clamp zone length.', axis: 'Revolve axis, default X.', plane: 'Section plane, default XY.', operation: 'newBody, join, cut or intersect.' },
    example: { schemaVersion: 1, frame: 'component', name: 'Barb', tubeId: '4 mm', tubeOd: '6 mm', bore: '3 mm', barbs: [ { crest: '7 mm', root: '6 mm', length: '3 mm' }, { crest: '7 mm', root: '6 mm', length: '3 mm' } ] },
    limitations: ['Axisymmetric revolve recipe; seating is geometric interference, not a leak-tightness proof.', 'Recipe is not atomic.'],
  },
};

const referenceKinds = {
  component: ['component'], axis: ['axis', 'edge'], point: ['point', 'vertex'],
  body: ['body'],
};

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  return value;
}

function exactKeys(value, allowed, required, label) {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new Error(label + ' has missing or unsupported fields');
  }
}

function reference(value, label, expected) {
  if (typeof value === 'string' && value.trim()) return;
  const input = record(value, label);
  const allowed = new Set(['token', 'kind', 'name', 'component', 'occurrence', 'path', 'query']);
  if (Object.keys(input).some(key => !allowed.has(key)) ||
      !['token', 'name', 'query'].some(key => Object.hasOwn(input, key)) ||
      (input.kind !== undefined && !referenceKinds[expected].includes(input.kind)) ||
      (input.token !== undefined && (typeof input.token !== 'string' || !input.token)) ||
      (input.name !== undefined && (typeof input.name !== 'string' || !input.name))) {
    throw new Error(label + ' must be an explicit ' + expected + ' reference');
  }
}

function expression(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be a dimensional expression');
}

function referenceIfSupplied(recordValue, key, label, kind) {
  if (Object.hasOwn(recordValue, key)) reference(recordValue[key], label, kind);
}

function pointExpressions(value, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(label + ' must contain three length expressions');
  value.forEach((item, index) => expression(item, label + '[' + index + ']'));
}

function validateMeasuredToolAccess(value) {
  const tool = record(value, 'toolAccess');
  exactKeys(tool, ['tool', 'target', 'entry', 'nativeObstacles', 'declaredObstacles', 'minimumClearance', 'samples'],
    ['tool', 'target', 'entry'], 'toolAccess');
  const toolSpec = record(tool.tool, 'toolAccess.tool');
  exactKeys(toolSpec, ['diameter', 'length'], ['diameter', 'length'], 'toolAccess.tool');
  expression(toolSpec.diameter, 'toolAccess.tool.diameter');
  expression(toolSpec.length, 'toolAccess.tool.length');
  const target = record(tool.target, 'toolAccess.target');
  exactKeys(target, ['origin', 'axis', 'engagementDepth'], ['origin', 'axis'], 'toolAccess.target');
  reference(target.origin, 'toolAccess.target.origin', 'point');
  reference(target.axis, 'toolAccess.target.axis', 'axis');
  if (target.engagementDepth !== undefined) expression(target.engagementDepth, 'toolAccess.target.engagementDepth');
  const entry = record(tool.entry, 'toolAccess.entry');
  exactKeys(entry, ['origin', 'direction'], ['origin', 'direction'], 'toolAccess.entry');
  reference(entry.origin, 'toolAccess.entry.origin', 'point');
  reference(entry.direction, 'toolAccess.entry.direction', 'axis');
  for (const [key, expected] of [['nativeObstacles', 'body'], ['declaredObstacles', null]]) {
    if (tool[key] === undefined) continue;
    if (!Array.isArray(tool[key])) throw new Error('toolAccess.' + key + ' must be an array');
    tool[key].forEach((item, index) => {
      const label = 'toolAccess.' + key + '[' + index + ']';
      const obstacle = record(item, label);
      if (expected) {
        exactKeys(obstacle, ['name', 'body'], ['body'], label);
        if (obstacle.name !== undefined && typeof obstacle.name !== 'string') throw new Error(label + '.name must be a string');
        reference(obstacle.body, label + '.body', expected);
        return;
      }
      exactKeys(obstacle, ['name', 'point', 'radius', 'box'], [], label);
      if (obstacle.name !== undefined && typeof obstacle.name !== 'string') throw new Error(label + '.name must be a string');
      const hasPoint = Object.hasOwn(obstacle, 'point');
      const hasBox = Object.hasOwn(obstacle, 'box');
      if (hasPoint === hasBox) throw new Error(label + ' requires exactly one point or box shape');
      if (hasPoint) {
        pointExpressions(obstacle.point, label + '.point');
        if (obstacle.radius !== undefined) expression(obstacle.radius, label + '.radius');
      } else {
        if (obstacle.radius !== undefined) throw new Error(label + '.radius is only valid with point');
        const box = record(obstacle.box, label + '.box');
        exactKeys(box, ['min', 'max'], ['min', 'max'], label + '.box');
        pointExpressions(box.min, label + '.box.min');
        pointExpressions(box.max, label + '.box.max');
      }
    });
  }
  if (tool.minimumClearance !== undefined) expression(tool.minimumClearance, 'toolAccess.minimumClearance');
  if (tool.samples !== undefined && (!Number.isSafeInteger(tool.samples) || tool.samples < 1)) {
    throw new Error('toolAccess.samples must be a positive integer');
  }
}

function validateMeasuredFastener(data) {
  exactKeys(data, ['schemaVersion', 'mode', 'native', 'declaredEvidence', 'toolAccess'],
    ['schemaVersion', 'mode', 'native'], 'fastener.measured-check');
  if (data.schemaVersion !== 1 || data.mode !== 'native') throw new Error('fastener.measured-check requires schemaVersion:1 and mode:native');
  const native = record(data.native, 'native');
  exactKeys(native, ['schemaVersion', 'frame', 'tolerance', 'screw', 'receptacle', 'layers'],
    ['schemaVersion', 'frame', 'tolerance', 'screw', 'receptacle'], 'native');
  if (native.schemaVersion !== 1) throw new Error('native requires schemaVersion:1');
  const frame = record(native.frame, 'native.frame');
  exactKeys(frame, ['space', 'component'], ['space', 'component'], 'native.frame');
  if (!['assembly', 'component local'].includes(frame.space)) throw new Error('native.frame.space must be assembly or component local');
  reference(frame.component, 'native.frame.component', 'component');
  const tolerance = record(native.tolerance, 'native.tolerance');
  exactKeys(tolerance, ['axisOffset', 'axisAngle', 'minimumEngagement'], ['axisOffset', 'axisAngle'], 'native.tolerance');
  expression(tolerance.axisOffset, 'native.tolerance.axisOffset');
  expression(tolerance.axisAngle, 'native.tolerance.axisAngle');
  if (tolerance.minimumEngagement !== undefined) expression(tolerance.minimumEngagement, 'native.tolerance.minimumEngagement');
  const screw = record(native.screw, 'native.screw');
  exactKeys(screw, ['axis', 'headBearing', 'tip', 'threadStart', 'threadEnd'], [], 'native.screw');
  referenceIfSupplied(screw, 'axis', 'native.screw.axis', 'axis');
  for (const key of ['headBearing', 'tip', 'threadStart', 'threadEnd']) referenceIfSupplied(screw, key, 'native.screw.' + key, 'point');
  const receptacle = record(native.receptacle, 'native.receptacle');
      exactKeys(receptacle, ['kind', 'axis', 'threadStart', 'threadEnd', 'bottom'], ['kind'], 'native.receptacle');
  if (!['blind', 'through', 'tapped', 'insert', 'nut'].includes(receptacle.kind)) throw new Error('native.receptacle.kind is unsupported');
  referenceIfSupplied(receptacle, 'axis', 'native.receptacle.axis', 'axis');
  for (const key of ['threadStart', 'threadEnd', 'bottom']) referenceIfSupplied(receptacle, key, 'native.receptacle.' + key, 'point');
  const layers = native.layers === undefined ? [] : native.layers;
  if (!Array.isArray(layers)) throw new Error('native.layers must be an array');
  layers.forEach((item, index) => {
    const label = 'native.layers[' + index + ']';
    const layer = record(item, label);
    exactKeys(layer, ['id', 'start', 'end'], [], label);
    if (layer.id !== undefined && typeof layer.id !== 'string') throw new Error(label + '.id must be a string');
    referenceIfSupplied(layer, 'start', label + '.start', 'point');
    referenceIfSupplied(layer, 'end', label + '.end', 'point');
  });
  if (data.declaredEvidence !== undefined) {
    const evidence = record(data.declaredEvidence, 'declaredEvidence');
    if (!['fastener.stack', 'fastener.check'].includes(evidence.operation)) throw new Error('declaredEvidence.operation must be fastener.stack or fastener.check');
    const legacyFields = evidence.operation === 'fastener.stack'
      ? ['schemaVersion', 'frame', 'screw', 'stack', 'receptacle', 'torque', 'tool', 'chamfer', 'gap', 'material', 'process']
      : ['schemaVersion', 'frame', 'screw', 'stack', 'minimumEngagement', 'receptacle', 'tool', 'torque', 'material', 'process'];
    exactKeys(evidence, ['operation', ...legacyFields], ['operation', 'schemaVersion', 'frame', 'screw', 'stack'], 'declaredEvidence');
    const legacy = { ...evidence };
    delete legacy.operation;
    validate(evidence.operation, legacy);
  }
  if (data.toolAccess !== undefined) validateMeasuredToolAccess(data.toolAccess);
}

function validate(operation, data) {
  if (!descriptors[operation]) return;
  if (operation === 'fastener.measured-check') {
    validateMeasuredFastener(data);
    return;
  }
  if (data.schemaVersion !== 1 || data.frame !== 'component') throw new Error(`${operation} requires schemaVersion:1 and frame:component`);
  if (operation === 'mount.create') {
    if (!['pin-slot', 'two-pin', '2-2-2'].includes(data.scheme)) throw new Error('scheme must be pin-slot, two-pin or 2-2-2');
  }
  if (operation === 'mount.check') {
    if (!Array.isArray(data.holes) || !data.holes.length) throw new Error('holes must be a nonempty array');
  }
  if (operation === 'fastener.stack' || operation === 'fastener.check') {
    if (!data.screw || typeof data.screw !== 'object' || Array.isArray(data.screw)) throw new Error('screw must be an object');
    if (!Array.isArray(data.stack) || !data.stack.length) throw new Error('stack must be a nonempty array');
    for (const key of ['length', 'threadLength']) if (typeof data.screw[key] !== 'string' || !data.screw[key].trim()) throw new Error(`screw.${key} must be a length expression`);
  }
  if (operation === 'fastener.schedule') {
    if (!Array.isArray(data.fasteners) || !data.fasteners.length) throw new Error('fasteners must be a nonempty array');
  }
  if (operation === 'bearing.stack-check') {
    if (!data.rings || typeof data.rings !== 'object' || Array.isArray(data.rings)) throw new Error('rings must be an object');
  }
  if (operation === 'shaft.interface') {
    if (!['D-flat', 'keyed', 'round'].includes(data.shaft.type)) throw new Error('shaft.type must be D-flat, keyed or round');
  }
  if (operation === 'snap.evaluate') {
    if (!data.material || typeof data.material.modulus !== 'string') throw new Error('snap.evaluate requires a declared material.modulus');
  }
  if (operation === 'shape.hose_barb') {
    if (!Array.isArray(data.barbs) || !data.barbs.length) throw new Error('barbs must be a nonempty array');
  }
}
module.exports = { descriptors, validate };

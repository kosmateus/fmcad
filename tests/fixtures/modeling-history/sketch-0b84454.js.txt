// GM06 nested input validation. Fusion remains responsible for expression evaluation.
const validates = operation => ['sketch.build', 'sketch.geometry', 'sketch.dimension', 'sketch.edit',
  'sketch.transform', 'sketch.dimension-plan', 'sketch.dimension-apply',
  'sketch.coordinate-check', 'sketch.profile-query'].includes(operation);
function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Sketch input must be an object');
  const missing = required.filter(k => !Object.hasOwn(value, k));
  const unknown = Object.keys(value).filter(k => !required.includes(k) && !optional.includes(k));
  if (missing.length || unknown.length) throw new Error(`Sketch missing inputs: ${missing}; unsupported inputs: ${unknown}`);
}
function expression(value) {
  if (typeof value !== 'string' || !value.trim() || /^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?$/i.test(value.trim())) {
    throw new Error('Sketch dimensions require expressions with explicit units or parameter references');
  }
}
function point(value) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error('Sketch point requires three length expressions');
  value.forEach(expression);
}
function array(value, label, nonempty = true) {
  if (!Array.isArray(value) || (nonempty && !value.length)) throw new Error(`${label} must be ${nonempty ? 'a nonempty' : 'an'} array`);
}
function reference(value, label) {
  if (typeof value === 'string' && value.trim()) return;
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) return;
  throw new Error(`${label} must be an explicit entity reference`);
}
function proofExpectation(value, brep = false) {
  object(value, ['entity'], ['frame', 'point', 'center', 'start', 'end', 'radius', 'diameter']);
  reference(value.entity, 'entity');
  if ('frame' in value && !(brep ? ['model'] : ['sketch', 'model', 'world']).includes(value.frame)) {
    throw new Error('Invalid expectation frame');
  }
  const requested = ['point', 'center', 'start', 'end', 'radius', 'diameter'].filter(key => key in value);
  if (!requested.length) throw new Error('An expectation needs a coordinate or dimension');
  for (const key of ['point', 'center', 'start', 'end']) if (key in value) point(value[key]);
  for (const key of ['radius', 'diameter']) if (key in value) expression(value[key]);
}
function proofExpectations(value, brep = false) {
  array(value, 'expectations');
  if (value.length > 256) throw new Error('expectations exceeds 256 entries');
  value.forEach(item => proofExpectation(item, brep));
}
function nonnegativeCount(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
}
function geometry(items, named = false) {
  array(items, 'geometry');
  const schemas = { point: ['point'], line: ['start', 'end'], rectangle: ['start', 'end'],
    circle: ['center', 'radius'], arc: ['center', 'start', 'sweep'], arc3: ['start', 'through', 'end'],
    spline: ['points'], bezier: ['controlPoints'] };
  const names = new Set(named ? ['origin'] : []);
  for (const item of items) {
    let required = schemas[item?.type];
    let optional = ['name', 'construction', 'fixed'];
    if (item?.type === 'ellipse') {
      required = Object.hasOwn(item, 'majorAxisPoint') || Object.hasOwn(item, 'minorAxisPoint')
        ? ['center', 'majorAxisPoint', 'minorAxisPoint'] : ['center', 'majorRadius', 'minorRadius'];
      if (!required.includes('majorAxisPoint')) optional.push('angle');
    }
    if (!required) throw new Error('Unsupported sketch primitive');
    object(item, ['type', ...required], optional);
    if (named && !/^[A-Za-z_]\w*$/.test(item.name || '')) throw new Error('Build primitives require ASCII identifier names');
    if (item.name !== undefined) {
      if (typeof item.name !== 'string' || !item.name.trim() || names.has(item.name)) throw new Error('Geometry names must be unique');
      names.add(item.name);
    }
    for (const key of ['construction', 'fixed']) if (key in item && typeof item[key] !== 'boolean') throw new Error(`${key} must be boolean`);
    if (item.type === 'point' && 'construction' in item) throw new Error('Points cannot be construction geometry');
    if (item.type === 'bezier' && item.fixed === false) throw new Error('Bezier is intrinsically fixed');
    for (const key of ['point', 'start', 'end', 'center', 'through', 'majorAxisPoint', 'minorAxisPoint']) if (key in item) point(item[key]);
    for (const key of ['radius', 'majorRadius', 'minorRadius', 'sweep', 'angle']) if (key in item) expression(item[key]);
    for (const key of ['points', 'controlPoints']) if (key in item) {
      array(item[key], key);
      if (key === 'points' ? item[key].length < 2 : item[key].length !== 4) throw new Error('Invalid spline point count');
      item[key].forEach(point);
    }
  }
}
function dimension(data, local = false) {
  object(data, local ? ['type', 'entities', 'expression'] : ['sketch', 'type', 'entities', 'text'],
    local ? ['text', 'orientation'] : ['expression', 'driving', 'orientation']);
  const counts = { distance: 2, angle: 2, radius: 1, diameter: 1, majorRadius: 1, minorRadius: 1 };
  array(data.entities, 'entities');
  if (!(data.type in counts) || data.entities.length !== counts[data.type]) throw new Error('Invalid sketch dimension type/entity count');
  if ('driving' in data && typeof data.driving !== 'boolean') throw new Error('driving must be boolean');
  if ((data.driving !== false) !== ('expression' in data)) throw new Error('Driving dimensions require expression; driven dimensions prohibit it');
  if ('expression' in data) expression(data.expression);
  if ('text' in data) point(data.text);
  if ('orientation' in data && (data.type !== 'distance' || !['aligned', 'horizontal', 'vertical'].includes(data.orientation))) throw new Error('Invalid distance orientation');
}
function validate(operation, data) {
  if (!operation.startsWith('sketch.')) return;
  if ('frame' in data && data.frame !== 'sketch') throw new Error('GM06 frame must be sketch');
  if ('schemaVersion' in data && data.schemaVersion !== 1) throw new Error('GM06 schemaVersion must be 1');
  if ('inferencePolicy' in data && !['explicit', 'native'].includes(data.inferencePolicy)) throw new Error('inferencePolicy must be explicit or native');
  if (operation === 'sketch.geometry' || operation === 'sketch.build') geometry(data.geometry, operation === 'sketch.build');
  if (operation === 'sketch.dimension') dimension(data);
  if (operation === 'sketch.build') {
    for (const key of ['constraints', 'dimensions', 'positions']) if (key in data) array(data[key], key, false);
    for (const d of data.dimensions || []) dimension(d, true);
    for (const c of data.constraints || []) { object(c, ['type', 'entities']); array(c.entities, 'entities'); }
    for (const p of data.positions || []) { object(p, ['name', 'point', 'coordinates']); point(p.coordinates); }
  }
  if (operation === 'sketch.transform') {
    array(data.entities, 'entities');
    if (!('translate' in data) && !('rotate' in data)) throw new Error('Transform needs translate and/or rotate');
    if ('translate' in data) point(data.translate);
    if ('rotate' in data) {
      object(data.rotate, ['angle'], ['center']); expression(data.rotate.angle);
      if ('center' in data.rotate) point(data.rotate.center);
    }
  }
  if (operation === 'sketch.edit' && ('movePoints' in data || 'dimensions' in data)) {
    object(data, ['sketch'], ['movePoints', 'dimensions', 'frame']);
    if (!data.movePoints?.length && !data.dimensions?.length) throw new Error('Empty sketch edit');
    if ('movePoints' in data) {
      array(data.movePoints, 'movePoints', false);
      for (const p of data.movePoints) { object(p, ['point', 'to']); point(p.to); }
    }
    if ('dimensions' in data) {
      array(data.dimensions, 'dimensions', false);
      for (const d of data.dimensions) { object(d, ['dimension', 'expression']); expression(d.expression); }
    }
  }
  if (operation === 'sketch.dimension-plan') {
    if ('entities' in data) array(data.entities, 'entities');
    if ('relations' in data) { array(data.relations, 'relations', false); for (const r of data.relations) { object(r, ['type', 'entities']); array(r.entities, 'entities'); } }
    if ('tolerance' in data) expression(data.tolerance);
    if ('maxEntities' in data && (!Number.isInteger(data.maxEntities) || data.maxEntities < 1 || data.maxEntities > 1000)) throw new Error('maxEntities must be 1..1000');
    if ('maxSeconds' in data && (typeof data.maxSeconds !== 'number' || !Number.isFinite(data.maxSeconds) || data.maxSeconds <= 0 || data.maxSeconds > 120)) throw new Error('maxSeconds must be positive and at most 120');
  }
  if (operation === 'sketch.dimension-apply') {
    const symbolic = data.plan && Object.keys(data.plan).length === 1 && typeof data.plan.$ref === 'string';
    if (!symbolic) object(data.plan, ['schemaVersion', 'documentIdentity', 'sketch', 'fingerprint', 'options', 'proposals']);
    array(data.accept, 'accept');
    if (data.accept.some(id => typeof id !== 'string') || new Set(data.accept).size !== data.accept.length) throw new Error('accept needs unique proposal IDs');
  }
  if (operation === 'sketch.coordinate-check') {
    object(data, ['schemaVersion', 'sketch', 'expectations'], ['tolerance', 'occurrence', 'featureBRep']);
    reference(data.sketch, 'sketch');
    proofExpectations(data.expectations);
    if ('tolerance' in data) expression(data.tolerance);
    if ('occurrence' in data) reference(data.occurrence, 'occurrence');
    if ('featureBRep' in data) {
      object(data.featureBRep, ['feature', 'expectations']);
      reference(data.featureBRep.feature, 'feature');
      proofExpectations(data.featureBRep.expectations, true);
    }
  }
  if (operation === 'sketch.profile-query') {
    object(data, ['schemaVersion', 'sketch'], ['query', 'expected', 'tolerance',
      'areaTolerance', 'maxSamples', 'budgetMs']);
    reference(data.sketch, 'sketch');
    if ('query' in data) {
      object(data.query, [], ['index', 'area', 'centroid', 'contains', 'outerLoops', 'innerLoops']);
      if ('index' in data.query) nonnegativeCount(data.query.index, 'index');
      if ('area' in data.query && (typeof data.query.area !== 'number' || !Number.isFinite(data.query.area) || data.query.area <= 0)) {
        throw new Error('area must be a positive finite cm^2 number');
      }
      for (const key of ['outerLoops', 'innerLoops']) if (key in data.query) nonnegativeCount(data.query[key], key);
      for (const key of ['centroid', 'contains']) if (key in data.query) point(data.query[key]);
    }
    if ('expected' in data) {
      object(data.expected, [], ['profiles', 'loops', 'outerLoops', 'innerLoops']);
      for (const [key, value] of Object.entries(data.expected)) nonnegativeCount(value, key);
    }
    if ('tolerance' in data) expression(data.tolerance);
    if ('areaTolerance' in data && (typeof data.areaTolerance !== 'number' || !Number.isFinite(data.areaTolerance) || data.areaTolerance <= 0)) {
      throw new Error('areaTolerance must be a positive finite cm^2 number');
    }
    if ('maxSamples' in data && (!Number.isInteger(data.maxSamples) || data.maxSamples < 2 || data.maxSamples > 10000)) {
      throw new Error('maxSamples must be 2..10000');
    }
    if ('budgetMs' in data && (!Number.isInteger(data.budgetMs) || data.budgetMs < 1 || data.budgetMs > 120000)) {
      throw new Error('budgetMs must be 1..120000');
    }
  }
}
module.exports = { validate, validates };

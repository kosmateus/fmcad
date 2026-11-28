// Structural preflight only. Fusion evaluates dimensional expressions and resolves refs.
const kinds = ['component', 'occurrence', 'body', 'face', 'edge', 'vertex', 'feature', 'sketch', 'profile', 'plane', 'axis', 'point', 'parameter'];
const geometries = ['plane', 'cylinder', 'cone', 'sphere', 'torus', 'circle', 'ellipse', 'line', 'point', 'nurbsCurve', 'nurbsSurface'];
const groups = ['kind', 'geometry', 'component', 'occurrence', 'body', 'radius', 'length', 'axis', 'level'];
function object(value, keys, label, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(value, k))) throw new Error(`Invalid ${label} fields`);
}
function expression(value) {
  if (typeof value !== 'string' || !value.trim() || !/[A-Za-z_]/.test(value.replace(/\d[eE][+-]?\d/g, ''))) throw new Error('Expected a dimension expression with units or parameter reference');
}
function reference(value) {
  if (typeof value === 'string' && value.trim()) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw new Error('Expected an entity reference');
  if ('query' in value) {
    object(value, ['query', 'kind'], 'query reference', ['query']);
    query(value.query);
    if ('kind' in value && (!kinds.includes(value.kind) || (value.query.kind && value.query.kind !== value.kind))) throw new Error('Conflicting query reference kind');
  }
}
function interval(value, count = false) {
  const scalar = v => {
    if (count) { if (!Number.isSafeInteger(v) || v < 0) throw new Error('expect requires nonnegative integer counts'); }
    else expression(v);
  };
  if (value && typeof value === 'object') {
    object(value, ['min', 'max'], 'interval');
    if (!Object.keys(value).length) throw new Error('Empty interval');
    Object.values(value).forEach(scalar);
    if (count && value.min > value.max) throw new Error('Reversed expect interval');
  } else scalar(value);
}
function vector(value, dimensioned = false) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error('Expected three coordinates');
  if (dimensioned) value.forEach(expression);
  else if (value.some(v => typeof v !== 'number' || !Number.isFinite(v)) || !Math.hypot(...value)) throw new Error('Expected a finite nonzero direction');
}
function frame(value) {
  if (['context', 'component', 'root'].includes(value)) return;
  object(value, ['component', 'occurrence', 'datum', 'sketch'], 'frame');
  if (!Object.keys(value).length || ('sketch' in value && Object.keys(value).length !== 1)) throw new Error('Invalid frame descriptor');
  for (const [k, v] of Object.entries(value)) {
    if (k === 'datum') { if (typeof v !== 'string' || !v.trim()) throw new Error('datum must be a name'); }
    else reference(v);
  }
}
function attributeFilters(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('filters.attributes must be a nonempty array');
  for (const predicate of value) {
    object(predicate, ['group', 'name', 'value', 'owner'], 'attribute predicate', ['group', 'name', 'value', 'owner']);
    for (const key of ['group', 'name']) if (typeof predicate[key] !== 'string' || !predicate[key].trim()) {
      throw new Error(`attribute ${key} must be nonempty text`);
    }
    if (typeof predicate.value !== 'string') throw new Error('attribute value must be text');
    if (!['native', 'proxy', 'occurrence'].includes(predicate.owner)) {
      throw new Error('attribute owner must be native, proxy, or occurrence');
    }
  }
}
function filters(value, adjacency = true) {
  object(value, ['name', 'geometry', 'radius', 'length', 'axis', 'position', 'bbox', 'level', 'adjacency', 'tolerance', 'angleTolerance', 'attributes'], 'filters');
  for (const [k, v] of Object.entries(value)) {
    if (k === 'name' && typeof v !== 'string') throw new Error('name must be text');
    if (k === 'geometry' && !geometries.includes(v)) throw new Error('Unsupported geometry');
    if (['radius', 'length'].includes(k)) interval(v);
    if (['tolerance', 'angleTolerance'].includes(k)) expression(v);
    if (k === 'axis') vector(v);
    if (k === 'position') vector(v, true);
    if (k === 'bbox') {
      object(v, ['min', 'max', 'mode'], 'bbox', ['min', 'max']);
      vector(v.min, true); vector(v.max, true);
      if ('mode' in v && !['inside', 'intersects'].includes(v.mode)) throw new Error('Unsupported bbox mode');
    }
    if (k === 'level') {
      object(v, ['axis', 'at', 'value'], 'level', ['axis', 'value']);
      if (!['x', 'y', 'z'].includes(v.axis) || ('at' in v && !['min', 'max', 'center'].includes(v.at))) throw new Error('Unsupported level axis/at');
      interval(v.value);
    }
    if (k === 'adjacency') {
      if (!adjacency) throw new Error('Nested adjacency is unsupported');
      object(v, ['kind', 'filters', 'expect', 'refs'], 'adjacency', ['kind']);
      if (!['body', 'face', 'edge', 'vertex'].includes(v.kind)) throw new Error('Unsupported adjacency kind');
      if ('filters' in v) filters(v.filters, false);
      if ('expect' in v) interval(v.expect, true);
      if ('refs' in v) { if (!Array.isArray(v.refs) || !v.refs.length) throw new Error('Expected nonempty adjacency refs'); v.refs.forEach(reference); }
    }
    if (k === 'attributes') attributeFilters(v);
  }
}
function attributePredicates(filtersValue, out = []) {
  if (!filtersValue) return out;
  if (filtersValue.attributes) out.push(...filtersValue.attributes);
  if (filtersValue.adjacency?.filters) attributePredicates(filtersValue.adjacency.filters, out);
  return out;
}
function query(data) {
  object(data, ['schemaVersion', 'kind', 'component', 'occurrence', 'scope', 'instances', 'frame', 'filters', 'expect', 'unique', 'groupBy'], 'query');
  if ('schemaVersion' in data && data.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  if ('kind' in data && !kinds.includes(data.kind)) throw new Error('Unsupported query kind');
  for (const k of ['instances', 'unique']) if (k in data && typeof data[k] !== 'boolean') throw new Error(`${k} must be boolean`);
  for (const k of ['component', 'occurrence']) if (k in data) reference(data[k]);
  if ('scope' in data) {
    object(data.scope, ['component', 'occurrence', 'body', 'feature'], 'scope');
    if ('component' in data || 'occurrence' in data || ('body' in data.scope && 'feature' in data.scope)) throw new Error('Conflicting query scopes');
    Object.values(data.scope).forEach(reference);
  }
  if ('frame' in data) frame(data.frame);
  if ('filters' in data) filters(data.filters);
  const contextualAttributes = attributePredicates(data.filters).filter(predicate =>
    predicate.owner === 'proxy' || predicate.owner === 'occurrence');
  if (contextualAttributes.length) {
    const scope = data.scope || {};
    const referenceHasOccurrence = ref => ref && typeof ref === 'object' && Object.hasOwn(ref, 'occurrence');
    const scopedOccurrence = Object.hasOwn(data, 'occurrence') || Object.hasOwn(scope, 'occurrence') ||
      ['body', 'feature'].some(key => referenceHasOccurrence(scope[key]));
    if (data.kind === 'component') throw new Error('proxy and occurrence attribute predicates are not valid for component candidates');
    if (!scopedOccurrence && data.instances !== true && data.kind !== 'occurrence') {
      throw new Error('proxy and occurrence attribute predicates require an occurrence scope, kind:occurrence, or instances:true');
    }
  }
  if ('expect' in data) { interval(data.expect, true); if (data.unique) throw new Error('unique and expect are exclusive'); }
  if ('groupBy' in data && (!Array.isArray(data.groupBy) || data.groupBy.some(k => !groups.includes(k)) || new Set(data.groupBy).size !== data.groupBy.length)) throw new Error('Invalid groupBy');
}
function validate(operation, data) {
  if (operation.startsWith('measure.') && data.ref && Object.hasOwn(data.ref, 'query')) reference(data.ref);
  if (['appearance.assign', 'material.assign'].includes(operation) && Array.isArray(data.refs)) {
    data.refs.filter(ref => ref && Object.hasOwn(ref, 'query')).forEach(reference);
  }
  if (operation === 'check' && data.measurement?.data && typeof data.measurement.operation === 'string') validate(data.measurement.operation, data.measurement.data);
  if (['entity.find', 'entity.stats'].includes(operation)) query(data);
  if (operation === 'entity.inspect') {
    if ('schemaVersion' in data && data.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
    reference(data.ref);
    if ('frame' in data) frame(data.frame);
  }
  if (['model.fillet', 'model.chamfer'].includes(operation)) {
    if (Object.hasOwn(data, 'edges') === Object.hasOwn(data, 'query')) throw new Error('Supply exactly one of edges or query');
    expression(data[operation === 'model.fillet' ? 'radius' : 'distance']);
    if ('tangentChain' in data && typeof data.tangentChain !== 'boolean') throw new Error('tangentChain must be boolean');
    if ('query' in data) {
      query(data.query);
      if (data.query.kind && data.query.kind !== 'edge') throw new Error('Modeling query requires kind edge');
      if (!Object.hasOwn(data.query, 'expect') && data.query.unique !== true) throw new Error('Modeling query requires expect or unique:true');
    } else {
      if (!Array.isArray(data.edges) || !data.edges.length) throw new Error('edges must be a nonempty array');
      data.edges.forEach(reference);
    }
  }
}
module.exports = { validate };

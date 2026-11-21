// GM07 owns file adaptation and its public schema. Geometry remains sketch.geometry DSL.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { csv } = require('./data-import');

const common = { schemaVersion: 'Required 1.', sketch: 'Existing native sketch reference.',
  frame: 'Required sketch: coordinates in the selected sketch frame.',
  tolerance: 'Positive length, default 0.001 mm; closure and stroke tolerance.',
  maxSamples: 'Integer 2..10000, default 2000. Bounds input and native strokes.',
  budgetMs: 'Integer 1..120000, default 10000; cooperative budget, cannot interrupt SDK calls.' };
const source = { source: 'CLI-host CSV/JSON path, exclusive with records.', records: 'Inline sample records.',
  baseDir: 'Absolute source directory; default CLI cwd. Never parsed in Fusion.',
  format: 'csv or json; inferred from source suffix if omitted.',
  columns: 'Exact mapping {x,y}, {x,y,z}, or {angle,radius}; optional loop/status. Values are source field names or array indexes.',
  recordsPath: 'Optional dotted JSON path to record array.', delimiter: 'CSV delimiter, default comma.',
  units: 'Required {length:mm|cm|m|in|ft, angle?:deg|rad}. Unit-bearing cells override column units.',
  plane: 'Required sketchXY: XY/polar are local; XYZ must have z within tolerance (no implicit projection).',
  closed: 'Required boolean. Closed data must already repeat the first endpoint within tolerance; never adds a missing chord.',
  winding: 'preserve (default), cw, ccw. Orientation requests require closed loops.',
  interpolation: 'lines (default) or spline. Native interpolating fit, not smoothing.',
  revision: 'Optional source revision retained in provenance.' };
const descriptors = {};
for (const op of ['sketch.profile-file', 'curve.fit', 'curve.inspect', 'curve.offset']) {
  const fitting = ['sketch.profile-file', 'curve.fit'].includes(op);
  descriptors[op] = { summary: `${op}: bounded native curve operation with explicit sample provenance (GM07 v1).`,
    required: ['schemaVersion', 'sketch', 'frame', ...(fitting ? ['columns', 'units', 'plane', 'closed'] : ['entities']), ...(op === 'curve.offset' ? ['distance', 'side'] : [])],
    readOnly: op === 'curve.inspect', curve: true,
    inputs: { ...common, ...(fitting ? source : { entities: 'Nonempty native sketch curve refs, in flow order.' }),
      ...(op === 'curve.offset' ? { distance: 'Positive length expression retained in native offset parameter.', side: 'left or right relative to SDK flow; circles/ellipses flow counterclockwise.' } : {}) },
    example: fitting ? { schemaVersion: 1, sketch: 'Profile', frame: 'sketch', plane: 'sketchXY', columns: { x: 'x', y: 'y' }, units: { length: 'mm' }, closed: false, records: [{ x: 0, y: 0 }, { x: 10, y: 5 }] }
      : { schemaVersion: 1, sketch: 'Profile', frame: 'sketch', entities: [{ token: 'curve-token' }], ...(op === 'curve.offset' ? { distance: '1 mm', side: 'right' } : {}) },
    limitations: ['See docs/GM07.md. Imported coordinates are importedReference; offsets retain native expressions/references. Native acceptance pending; sampled checks do not certify global regularity.'] };
}
descriptors['curve.offset-edit'] = { summary: 'curve.offset-edit: edit the native offset dimension expression of an existing curve offset (GM07 v1).',
  required: ['schemaVersion', 'frame', 'parameter', 'distance'], readOnly: false, curve: true,
  inputs: { schemaVersion: 'Required 1.', frame: 'Required sketch.',
    parameter: 'Native offset dimension parameter name (e.g. d203) or {token,name,kind:"parameter"} reference.',
    distance: 'New length expression for the native offset dimension; the sign preserves the offset side.' },
  example: { schemaVersion: 1, frame: 'sketch', parameter: 'd203', distance: '8 mm' },
  limitations: ['See docs/GM07.md. The native offset dimension must still exist; a deleted dimension cannot be edited. The expression is retained by Fusion and can reference other parameters.'] };
const lengths = { mm: .1, cm: 1, m: 100, in: 2.54, ft: 30.48 };
function quantity(value, unit, angle = false) {
  const table = angle ? { deg: Math.PI / 180, rad: 1 } : lengths;
  const m = String(value).trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)$/i);
  const u = m && (m[2] || unit);
  if (!m || !Object.hasOwn(table, u) || !Number.isFinite(Number(m[1]) * table[u])) throw new Error('Sample requires finite compatible units');
  return Number(m[1]) * table[u];
}
function validate(operation, data) {
  if (!descriptors[operation]) return;
  if (data.schemaVersion !== 1 || data.frame !== 'sketch') throw new Error('GM07 requires schemaVersion:1 and frame:sketch');
  for (const [key, fallback, min, max] of [['maxSamples', 2000, 2, 10000], ['budgetMs', 10000, 1, 120000]]) {
    const v = data[key] ?? fallback;
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${key} outside ${min}..${max}`);
  }
  if (!(quantity(data.tolerance ?? '0.001 mm') > 0)) throw new Error('tolerance must be positive');
  if (operation === 'curve.offset') {
    if (!['left', 'right'].includes(data.side)) throw new Error('side must be left or right');
    if (typeof data.distance !== 'string' || !data.distance.trim()) throw new Error('distance must be a length expression');
  }
  if (operation === 'curve.offset-edit') {
    if (typeof data.distance !== 'string' || !data.distance.trim()) throw new Error('distance must be a length expression');
    const parameter = data.parameter;
    if (!(typeof parameter === 'string' && parameter.trim()) && !(parameter && typeof parameter === 'object' && !Array.isArray(parameter) && (parameter.token || parameter.name))) throw new Error('parameter must be a name or a parameter reference');
  }
  if (['curve.offset', 'curve.inspect'].includes(operation) && (!Array.isArray(data.entities) || !data.entities.length)) throw new Error('entities must be nonempty');
}
function prepare(operation, data) {
  validate(operation, data);
  if (!['sketch.profile-file', 'curve.fit'].includes(operation)) return data;
  if (Object.hasOwn(data, 'source') === Object.hasOwn(data, 'records')) throw new Error('Supply source or records exclusively');
  if (data.plane !== 'sketchXY') throw new Error('Declare plane:sketchXY; spatial projection is not implicit');
  if (typeof data.closed !== 'boolean') throw new Error('closed must be boolean');
  if (!['preserve', 'cw', 'ccw'].includes(data.winding ?? 'preserve') || (!data.closed && data.winding && data.winding !== 'preserve')) throw new Error('Winding requires closed loops');
  if (!['lines', 'spline'].includes(data.interpolation ?? 'lines')) throw new Error('interpolation must be lines or spline');
  const cols = data.columns;
  if (!cols || typeof cols !== 'object' || Array.isArray(cols)) throw new Error('columns must be an object');
  const axes = Object.keys(cols).filter(k => !['loop', 'status'].includes(k)).sort().join(',');
  if (!['x,y', 'x,y,z', 'angle,radius'].includes(axes) || Object.values(cols).some(v => !(typeof v === 'string' && v.length || Number.isInteger(v) && v >= 0))) throw new Error('columns must explicitly map XY, XYZ, or angle/radius');
  if (!data.units || !Object.hasOwn(lengths, data.units.length) || Object.keys(data.units).some(k => !['length', 'angle'].includes(k)) || (axes === 'angle,radius' && !['deg', 'rad'].includes(data.units.angle))) throw new Error('Invalid column units');
  if (data.baseDir !== undefined && (typeof data.baseDir !== 'string' || !path.isAbsolute(data.baseDir))) throw new Error('baseDir must be absolute');
  let raw, rows, filename = null;
  if ('source' in data) {
    if (typeof data.source !== 'string' || !data.source.trim()) throw new Error('source must be a path');
    filename = path.resolve(data.baseDir || process.cwd(), data.source);
    if (fs.statSync(filename).size > 16 * 1024 * 1024) throw new Error('Source exceeds 16 MiB budget');
    raw = fs.readFileSync(filename, 'utf8');
    const format = data.format || path.extname(filename).slice(1).toLowerCase();
    if (format === 'csv') rows = csv(raw, data.delimiter);
    else if (format === 'json') {
      let value = JSON.parse(raw);
      if (data.recordsPath) for (const key of data.recordsPath.split('.')) value = value?.[key];
      if (!Array.isArray(value)) throw new Error('JSON recordsPath must select an array');
      rows = value.map((value, i) => ({ value, index: i }));
    } else throw new Error('format must be csv or json');
  } else {
    if (!Array.isArray(data.records)) throw new Error('records must be an array');
    if (['format', 'recordsPath', 'delimiter', 'baseDir'].some(k => k in data)) throw new Error('File options require source');
    raw = JSON.stringify(data.records); rows = data.records.map((value, i) => ({ value, index: i }));
  }
  const max = data.maxSamples ?? 2000, tol = quantity(data.tolerance ?? '0.001 mm');
  if (rows.length < 2 || rows.length > max) throw new Error('Sample count exceeds bounds');
  const loops = new Map();
  for (const row of rows) {
    const cell = k => row.value?.[cols[k]];
    let point;
    if (axes === 'angle,radius') {
      const a = quantity(cell('angle'), data.units.angle, true), r = quantity(cell('radius'), data.units.length);
      if (r < 0) throw new Error('Polar radius cannot be negative');
      point = [r * Math.cos(a), r * Math.sin(a), 0];
    } else point = [quantity(cell('x'), data.units.length), quantity(cell('y'), data.units.length), 'z' in cols ? quantity(cell('z'), data.units.length) : 0];
    if (Math.abs(point[2]) > tol) throw new Error('XYZ samples are not on declared sketchXY plane');
    point[2] = 0;
    const id = 'loop' in cols ? String(cell('loop') ?? '') : '0';
    if (!id) throw new Error('Missing loop ID');
    const status = 'status' in cols ? cell('status') : 'OPEN';
    if (!['CONFIRMED', 'ESTIMATED', 'OPEN', 'DERIVED'].includes(status)) throw new Error('Invalid source status');
    if (!loops.has(id)) loops.set(id, []);
    loops.get(id).push({ point, originalPoint: [...point], source: { ...(row.line ? { line: row.line } : { index: row.index }), status } });
  }
  const geometry = [], sampleMap = [], preparedLoops = [];
  for (const [id, samples] of loops) {
    if (samples.length < (data.closed ? 4 : 2)) throw new Error('Insufficient loop samples');
    const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
    for (let i = 1; i < samples.length; i++) if (dist(samples[i - 1].point, samples[i].point) <= 1e-12) throw new Error('Consecutive duplicate samples');
    const gap = dist(samples[0].point, samples.at(-1).point);
    if (data.closed && gap > tol) throw new Error('Closed input has missing endpoints; refusing to add a chord');
    if (data.closed) samples.at(-1).point = [...samples[0].point];
    const area = samples.slice(1).reduce((s, v, i) => s + samples[i].point[0] * v.point[1] - v.point[0] * samples[i].point[1], 0) / 2;
    if (data.winding && data.winding !== 'preserve') {
      if (Math.abs(area) < 1e-15) throw new Error('Winding undefined for zero-area loop');
      if ((area > 0) !== (data.winding === 'ccw')) samples.reverse();
    }
    const points = samples.map(s => s.point.map(v => `${v} cm`));
    const start = geometry.length;
    if (data.interpolation === 'spline') geometry.push({ type: 'spline', points });
    else for (let i = 1; i < points.length; i++) geometry.push({ type: 'line', start: points[i - 1], end: points[i] });
    preparedLoops.push({ id, geometryIndexes: Array.from({ length: geometry.length - start }, (_, i) => start + i), closed: data.closed, closureGap: gap });
    samples.forEach((s, i) => sampleMap.push({ loop: id, sample: i, point: s.originalPoint, ...s.source }));
  }
  return { schemaVersion: 1, sketch: data.sketch, frame: 'sketch', tolerance: data.tolerance ?? '0.001 mm', maxSamples: max,
    budgetMs: data.budgetMs ?? 10000, geometry, loops: preparedLoops, sampleMap,
    provenance: { path: filename, sha256: crypto.createHash('sha256').update(raw).digest('hex'), revision: data.revision ?? null, columns: cols, units: data.units, status: 'DERIVED' } };
}
module.exports = { descriptors, validate, prepare, quantity };

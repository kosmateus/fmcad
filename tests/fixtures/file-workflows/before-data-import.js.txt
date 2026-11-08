const { dataImportFiles: localFiles } = require('./dist/node-adapters/persistence/data-import-files');
const { sha256: hash } = require('./dist/core/domain/engineering/sha256');
const { prepareDataImport, offlineImportResult } = require('./dist/core/application/documents/data-import');

// GM-02 owns the public descriptors, file adapter and offline preflight.
const common = {
  version: 'Required integer 1 (adapter format version).',
  source: 'CSV/JSON path on the CLI host; mutually exclusive with records. Relative paths use baseDir (default CLI cwd).',
  records: 'Inline array of records, mutually exclusive with source.',
  baseDir: 'Absolute CLI-host directory for source and model paths. Never interpreted on the Fusion host.',
  schema: 'Optional {recordsPath, columns, defaults, values, delimiter}. columns maps canonical field names to source dotted paths; values provides explicit enum/value maps. Nested CSV values are JSON. See docs/DATA_IMPORT.md.',
  owner: 'Required nonempty import ownership namespace for mutations.',
  revision: 'Required nonempty source revision for mutations; retained with SHA256 provenance.',
  onExisting: 'error (default), reuse (exact owned revision/content/state), update (owned prior revision with expectedRevision).',
  expectedRevision: 'Required prior owned revision for update; no adoption of unowned objects.',
  maxItems: 'Positive integer work/expansion bound, default 10000, maximum 100000.',
  budgetMs: 'Positive integer native cooperative execution budget in milliseconds; default 120000. An in-flight SDK call cannot be cancelled; partial results require inspection.',
  inspectModel: 'Checks only: true compares current Fusion state; otherwise checks supplied data offline without a backend.',
  observed: 'Optional check evidence: catalog {instances:[{id,item,parent}], identity?, revision?} or placement {poses:[{id,transform}], identity?,revision?}. Historical snapshot, not live proof.',
};
const catalogInputs = {
  bom: 'Optional array {id,quantity,basis:physical|purchase|contents}, or {source,schema?,baseDir?} CSV/JSON adapter. Quantities compared independently; no inferred PCBA mass.',
  instances: 'Optional explicit array {id,item,parent,localKey,placement?}. parent is another instance ID or null. Reused assembly definitions must have identical local child structure.',
};
const descriptors = {};
for (const op of ['param.import', 'catalog.import', 'catalog.check', 'placement.import', 'placement.check', 'cots.replace']) {
  const check = op.endsWith('.check');
  descriptors[op] = {
    summary: `${op.replace('.', ' ')}: versioned data preflight, explicit units, provenance and ownership; ${check ? 'offline ledger or requested live comparison' : 'guarded document mutation'}.`,
    dataImport: true, requiresDoc: !check, readOnly: check,
    required: ['version'],
    inputs: { ...common, ...(op.startsWith('catalog.') ? catalogInputs : {}),
      ...(op.startsWith('placement.') ? { tolerance: 'Check translation tolerance with units (default 0.001 mm).', angleTolerance: 'Check rotation tolerance with units (default 0.01 deg).' } : {}),
      ...(op === 'cots.replace' ? {
        target: 'Owned catalog item ID to replace.', model: 'Required {path,representation:vendor|envelope,source,status,revision?,sha256?}; native geometry, never scaled.',
        occurrencePolicy: 'all or selected; selected requires exact occurrence refs. Replacement invalidates geometry refs.',
        occurrences: 'Exact occurrence refs for selected policy.',
        childrenPolicy: 'error (default) or preserve. Preserve separately cataloged child occurrences in world space; requires model.includedItems and rejects duplicate included children.',
        datumMap: 'Nonempty array {name,old,new}; old/new are complete local-to-component rigid transforms. Every datum must imply the same replacement transform.',
        impacts: 'Required {matingParts,routings,refs,mass}; each {status:known|unknown,items:[],source?}. Missing evidence stays unknown.',
        acceptInvalidation: 'Exactly true acknowledges invalidated geometry refs and downstream checks; constrained/externally referenced targets remain blocked.',
        mass: 'Optional replacement mass evidence object; absent mass remains unknown, never zero.',
      } : {}),
    },
    example: { version: 1, owner: 'example', revision: 'r1', records: [] },
    usage: `${op.replace('.', ' ')} ${check ? '[--doc <name> --inspect-model true] ' : '--doc <name> '}--file <adapter.json> [--json] [--preview]`,
    limitations: ['See docs/DATA_IMPORT.md for typed record schemas. Full data preflight precedes mutations; kernel failures can leave partial state and are never retried.',
      'Offline checks do not inspect Fusion. Neutral geometry is importedReference, poses are snapshots, parameters reuse native expressions. Missing evidence is unknown, not pass.',
      'No implicit save, scaling, source approval, material substitution or automatic downstream reference repair.'],
  };
}
const examplePose = { frame: 'parent', translation: ['0 mm', '0 mm', '0 mm'], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
descriptors['param.import'].example.records = [{ name: 'wall', expression: '2 mm', unit: 'mm', status: 'CONFIRMED', source: 'Fixture drawing' }];
for (const op of ['catalog.import', 'catalog.check']) descriptors[op].example = { version: 1, owner: 'example', revision: 'r1',
  ...(op.endsWith('.check') ? { inspectModel: true } : {}), records: [{ id: 'plate', name: 'Plate', kind: 'part', quantity: 1, parent: null, placement: examplePose, status: 'CONFIRMED' }] };
for (const op of ['placement.import', 'placement.check']) descriptors[op].example = { version: 1, owner: 'example', revision: 'r1',
  ...(op.endsWith('.check') ? { inspectModel: true } : {}), records: [{ id: 'plate:1', occurrence: 'Plate:1', placement: examplePose, status: 'CONFIRMED' }] };
descriptors['cots.replace'].example = { version: 1, owner: 'example', revision: 'r2', expectedRevision: 'r1', target: 'sensor',
  model: { path: 'replacement.step', representation: 'envelope', source: 'Example only', status: 'ESTIMATED' }, occurrencePolicy: 'all',
  datumMap: [{ name: 'mount', old: { ...examplePose, frame: 'component' }, new: { ...examplePose, frame: 'component' } }],
  impacts: Object.fromEntries(['matingParts', 'routings', 'refs', 'mass'].map(k => [k, { status: 'unknown', items: [] }])), acceptInvalidation: true };

function object(v, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} must be an object`);
  return v;
}
function fields(v, allowed, label) {
  object(v, label);
  const extra = Object.keys(v).filter(k => !allowed.includes(k));
  if (extra.length) throw new Error(`${label}: unknown fields ${extra.join(', ')}`);
}
function text(v, label) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} must be nonempty text`);
  return v;
}
function integer(v, label, min = 0) {
  if (!Number.isSafeInteger(v) || v < min) throw new Error(`${label} must be an integer >= ${min}`);
  return v;
}
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function at(v, key) {
  return key.split('.').reduce((a, k) => a && Object.hasOwn(a, k) ? a[k] : undefined, v);
}

// Strict RFC-4180-style records, including embedded CR/LF and escaped quotes.
function csv(source, delimiter = ',') {
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || /["\r\n]/.test(delimiter)) throw new Error('Invalid CSV delimiter');
  source = source.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false, closed = false, line = 1, start = 1;
  function emit() { row.push(cell); cell = ''; closed = false; }
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else { cell += c; if (c === '\n') line++; }
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === delimiter) emit();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      emit(); rows.push({ cells: row, line: start }); row = []; line++; start = line;
    } else { if (closed || c === '"') throw new Error(`Malformed CSV quoting at line ${line}`); cell += c; }
  }
  if (quoted) throw new Error('Unterminated CSV quoted field');
  if (cell || closed || row.length) { emit(); rows.push({ cells: row, line: start }); }
  if (!rows.length) throw new Error('CSV has no header');
  const headers = rows.shift().cells;
  if (headers.some(h => !h) || new Set(headers).size !== headers.length) throw new Error('CSV headers must be nonempty and unique');
  return rows.map(r => {
    if (r.cells.length !== headers.length) throw new Error(`CSV column count at line ${r.line}`);
    return { value: Object.fromEntries(headers.map((h, i) => [h, r.cells[i]])), line: r.line };
  });
}

const lengthUnits = { mm: 0.1, cm: 1, m: 100, in: 2.54, ft: 30.48 };
const angleUnits = { rad: 1, deg: Math.PI / 180 };
const MODEL_EXTENSIONS = ['.step', '.stp', '.f3d', '.iges', '.igs', '.sat', '.smt'];
function quantity(v, units, label) {
  const m = typeof v === 'string' && v.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([A-Za-z]+)$/i);
  if (!m || !Object.hasOwn(units, m[2]) || !Number.isFinite(Number(m[1]) * units[m[2]])) throw new Error(`${label} requires a finite value with units (${Object.keys(units).join('|')})`);
  return Number(m[1]) * units[m[2]];
}
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
  return Array.from({ length: 16 }, (_, i) => { const r = Math.floor(i / 4), c = i % 4; return [0, 1, 2, 3].reduce((s, k) => s + a[r * 4 + k] * b[k * 4 + c], 0); });
}
function inverse(a) {
  const b = identity();
  for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) b[r * 4 + c] = a[c * 4 + r]; b[r * 4 + 3] = -[0, 1, 2].reduce((s, c) => s + a[c * 4 + r] * a[c * 4 + 3], 0); }
  return b;
}
function rigid(m, label) {
  if (!Array.isArray(m) || m.length !== 16 || m.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error(`${label}: matrix must contain 16 finite numbers`);
  if ([12, 13, 14, 15].some((i, j) => Math.abs(m[i] - (j === 3 ? 1 : 0)) > 1e-9)) throw new Error(`${label}: invalid homogeneous row`);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const dot = [0, 1, 2].reduce((s, k) => s + m[k * 4 + r] * m[k * 4 + c], 0);
    if (Math.abs(dot - (r === c ? 1 : 0)) > 1e-9) throw new Error(`${label}: scaling/shear is not a rigid transform`);
  }
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  if (Math.abs(det - 1) > 1e-9) throw new Error(`${label}: reflection/handedness reversal is unsupported`);
  return m;
}
function transform(v, label = 'transform') {
  fields(v, ['matrix', 'unit', 'translation', 'rotation', 'frame'], label);
  if (!['root', 'parent', 'component'].includes(v.frame)) {
    fields(v.frame, ['occurrence', 'datum', 'component'], `${label}.frame`);
    if (v.frame.datum !== undefined) {
      text(v.frame.datum, 'datum frame name');
      if ((v.frame.occurrence !== undefined) === (v.frame.component !== undefined) || (v.frame.component !== undefined && v.frame.component !== 'root')) throw new Error('Named datum requires occurrence:REF or component:root');
    } else if (Object.keys(v.frame).length !== 1 || v.frame.occurrence === undefined) throw new Error(`${label}.frame requires occurrence:REF`);
  }
  let m;
  if (v.matrix !== undefined) {
    if (v.translation !== undefined || v.rotation !== undefined) throw new Error(`${label}: matrix excludes translation/rotation`);
    if (!Object.hasOwn(lengthUnits, v.unit)) throw new Error(`${label}: matrix requires explicit length unit`);
    m = [...rigid(v.matrix, label)]; for (const i of [3, 7, 11]) m[i] *= lengthUnits[v.unit];
  } else {
    if (v.unit !== undefined) throw new Error(`${label}: unit is only for matrices`);
    if (!Array.isArray(v.translation) || v.translation.length !== 3) throw new Error(`${label}: full translation required; lens offset cannot be inferred`);
    if (!Array.isArray(v.rotation) || v.rotation.length !== 9) throw new Error(`${label}: full 3x3 rotation required; optical normal does not define roll`);
    m = identity(); for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) m[r * 4 + c] = v.rotation[r * 3 + c]; m[r * 4 + 3] = quantity(v.translation[r], lengthUnits, label); }
    rigid(m, label);
  }
  return { matrix: m, frame: v.frame, units: 'cm', convention: 'row-major; column vectors; local-to-frame; parent * local' };
}

function evidence(row, provenance, unresolved, label) {
  if (row.status !== undefined && !['CONFIRMED', 'ESTIMATED', 'OPEN', 'DERIVED'].includes(row.status)) throw new Error(`${label}: invalid source status`);
  if (row.status === undefined || row.status === 'OPEN') unresolved.push({ id: label, field: 'status', status: 'unknown' });
  if (row.status === 'DERIVED' && !row.derivation) throw new Error(`${label}: DERIVED requires derivation evidence`);
  if (!row.source && !provenance.path) unresolved.push({ id: label, field: 'source', status: 'unknown' });
  return { ...provenance, status: row.status || 'OPEN', source: row.source ?? null, derivation: row.derivation ?? null };
}

function mass(value, unresolved, id) {
  if (value === undefined || value === null) return null;
  fields(value, ['value', 'unit', 'status', 'source', 'derivation'], `${id}.mass`);
  if (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value <= 0 || !['kg', 'g', 'lb'].includes(value.unit)) throw new Error(`${id}.mass requires positive finite value and kg|g|lb unit`);
  evidence(value, {}, unresolved, `${id}.mass`);
  return value;
}
function load(data, limit, files) {
  if ((data.source !== undefined) === (data.records !== undefined)) throw new Error('Provide exactly one of source or records');
  if (data.baseDir !== undefined && (typeof data.baseDir !== 'string' || !files.isAbsolute(data.baseDir))) throw new Error('baseDir must be an absolute CLI-host directory');
  const baseDir = data.baseDir || files.cwd();
  const schema = data.schema || {};
  fields(schema, ['recordsPath', 'columns', 'defaults', 'values', 'delimiter'], 'schema');
  if (schema.columns) { object(schema.columns, 'schema.columns'); for (const v of Object.values(schema.columns)) text(v, 'column path'); }
  if (schema.defaults) object(schema.defaults, 'schema.defaults');
  if (schema.values) { object(schema.values, 'schema.values'); for (const v of Object.values(schema.values)) object(v, 'schema value map'); }
  let rows, provenance, isCsv = false;
  if (data.source !== undefined) {
    const file = files.resolve(baseDir, text(data.source, 'source'));
    const stat = files.stat(file);
    if (!stat.regular || stat.size > 32 * 1024 * 1024) throw new Error('Source must be a regular file <=32 MiB');
    const snapshot = files.snapshot(file); provenance = { path: file, sha256: snapshot.sha256, revision: data.revision ?? null, pathHost: 'CLI' };
    isCsv = files.extension(file) === '.csv';
    if (isCsv) { if (schema.recordsPath) throw new Error('recordsPath applies only to JSON'); rows = csv(snapshot.text, schema.delimiter); }
    else {
      if (files.extension(file) !== '.json') throw new Error('Source must be CSV or JSON');
      const value = JSON.parse(snapshot.text.replace(/^\uFEFF/, ''));
      rows = schema.recordsPath ? at(value, schema.recordsPath) : value;
    }
  } else { rows = data.records; provenance = { path: null, sha256: hash(stable(rows)), revision: data.revision ?? null, pathHost: 'inline' }; }
  if (!Array.isArray(rows) || !rows.length || rows.length > limit) throw new Error(`records must contain 1..${limit} entries`);
  rows = rows.map((entry, i) => {
    const source = isCsv ? entry.value : entry; object(source, `row ${i + 1}`);
    const row = schema.columns ? Object.fromEntries(Object.entries(schema.columns).map(([k, v]) => [k, at(source, v)]).filter(([, v]) => v !== undefined)) : { ...source };
    if (isCsv) for (const [key, value] of Object.entries(row)) {
      if (value === '') { if (key !== 'unit') delete row[key]; continue; }
      if (['quantity', 'purchaseQuantity', 'contents', 'placement', 'model', 'material', 'motionMembership', 'functionalGroups', 'allocation', 'mass', 'derivation'].includes(key)) {
        try { row[key] = JSON.parse(value); } catch (_) { throw new Error(`row ${entry.line}: ${key} must be JSON`); }
      }
    }
    const mapped = { ...schema.defaults, ...row };
    for (const [key, values] of Object.entries(schema.values || {})) {
      if (mapped[key] === undefined) continue;
      if (!Object.hasOwn(values, String(mapped[key]))) throw new Error(`row ${i + 1}: unmapped ${key} value`);
      mapped[key] = values[String(mapped[key])];
    }
    // Relationship lists may arrive as a single source label or a ';'-delimited
    // string; normalize to the canonical text array so functional-group and
    // motion-membership labels stay separate from the rigid physical parent.
    for (const key of ['functionalGroups', 'motionMembership']) {
      if (typeof mapped[key] === 'string') mapped[key] = mapped[key].split(';').map(v => v.trim()).filter(Boolean);
    }
    // A scalar model column maps to a geometry file path. Wrap it into the
    // canonical model descriptor (envelope). Non-path placeholders (e.g. a
    // "to be created in CAD" note) carry no model and are dropped, not errors.
    if (typeof mapped.model === 'string') {
      const file = mapped.model.trim();
      if (MODEL_EXTENSIONS.includes(files.extension(file))) mapped.model = { path: file, representation: 'envelope' };
      else delete mapped.model;
    }
    return { row: mapped, provenance: { ...provenance, row: isCsv ? entry.line : i + 1 } };
  });
  return { rows, provenance, baseDir };
}

function model(v, baseDir, unresolved, id, files) {
  if (v == null) return null;
  fields(v, ['path', 'representation', 'source', 'status', 'revision', 'sha256', 'includedItems'], `${id}.model`);
  if (v.includedItems !== undefined && (!Array.isArray(v.includedItems) || v.includedItems.some(id => typeof id !== 'string' || !id) || new Set(v.includedItems).size !== v.includedItems.length)) throw new Error('model.includedItems must be an array of unique item IDs');
  if (!['vendor', 'envelope'].includes(v.representation)) throw new Error(`${id}.model requires representation vendor|envelope`);
  const file = files.resolve(baseDir, text(v.path, 'model.path'));
  if (!MODEL_EXTENSIONS.includes(files.extension(file))) throw new Error(`${id}: unsupported model format`);
  if (!files.exists(file)) { unresolved.push({ id, field: 'model', status: 'unknown', path: file }); return { ...v, path: file, missing: true }; }
  if (!files.stat(file).regular) throw new Error(`${id}: model must be a regular file`);
  const digest = files.snapshot(file).sha256;
  if (v.sha256 !== undefined && v.sha256 !== digest) throw new Error(`${id}: model SHA256 mismatch`);
  evidence(v, {}, unresolved, id + '.model');
  if (!v.source) unresolved.push({ id, field: 'model.source', status: 'unknown' });
  return { ...v, path: file, sha256: digest };
}

function catalogPlan(data, loaded, limit, unresolved, files) {
  const items = loaded.rows.map(({ row: r, provenance }, i) => {
    const label = `catalog row ${i + 1}`;
    fields(r, ['id', 'name', 'quantity', 'parent', 'kind', 'contents', 'allocation', 'purchaseQuantity', 'functionalGroups', 'motionMembership', 'material', 'model', 'placement', 'mass', 'status', 'source', 'derivation'], label);
    const id = text(r.id, `${label}.id`); text(r.name, `${id}.name`);
    if (!['part', 'assembly', 'purchased', 'pcba', 'reference'].includes(r.kind)) throw new Error(`${id}: kind must be part|assembly|purchased|pcba|reference`);
    integer(r.quantity, `${id}.quantity`);
    if (!Object.hasOwn(r, 'parent') || (r.parent !== null && typeof r.parent !== 'string')) throw new Error(`${id}: explicit physical parent (ID or null) required`);
    for (const key of ['functionalGroups', 'motionMembership']) if (r[key] !== undefined && (!Array.isArray(r[key]) || r[key].some(v => typeof v !== 'string'))) throw new Error(`${id}.${key} must be text array`);
    if (r.purchaseQuantity !== undefined) integer(r.purchaseQuantity, `${id}.purchaseQuantity`);
    if (r.material !== undefined) { fields(r.material, ['id', 'library', 'description'], `${id}.material`); if (r.material.id !== undefined) text(r.material.id, 'material.id'); if (r.material.library !== undefined) text(r.material.library, 'material.library'); if (!r.material.id) unresolved.push({ id, field: 'material', status: 'unknown' }); }
    if (r.allocation !== undefined) { fields(r.allocation, ['owner', 'quantity'], `${id}.allocation`); text(r.allocation.owner, 'allocation.owner'); integer(r.allocation.quantity, 'allocation.quantity'); }
    const contents = r.contents || [];
    if (!Array.isArray(contents)) throw new Error(`${id}.contents must be array`);
    const seen = new Set();
    for (const c of contents) { fields(c, ['id', 'quantity'], `${id}.contents`); text(c.id, 'contents.id'); integer(c.quantity, 'contents.quantity', 1); if (seen.has(c.id)) throw new Error(`${id}: duplicate contents ID`); seen.add(c.id); }
    if (r.mass == null && ['purchased', 'pcba'].includes(r.kind)) unresolved.push({ id, field: 'mass', status: 'unknown' });
    return { ...r, contents, mass: mass(r.mass, unresolved, id), model: model(r.model, loaded.baseDir, unresolved, id, files), provenance: evidence(r, provenance, unresolved, id),
      placement: r.placement == null ? null : transform(r.placement, `${id}.placement`) };
  });
  const byId = new Map(items.map(r => [r.id, r]));
  if (byId.size !== items.length) throw new Error('Duplicate catalog ID');
  const done = new Set(), visiting = new Set(), order = [];
  function visit(id) {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`Catalog parent cycle: ${id}`);
    const r = byId.get(id); if (!r) throw new Error(`Unknown catalog parent: ${id}`);
    visiting.add(id); if (r.parent !== null) visit(r.parent); visiting.delete(id); done.add(id); order.push(r);
  }
  for (const r of items) visit(r.id);
  // Contents are a purchase ledger, not an instruction to create geometry.
  const contentsDone = new Set();
  function contentsVisit(id, stack = []) {
    if (stack.includes(id)) throw new Error(`Contents cycle: ${id}`);
    if (contentsDone.has(id)) return;
    for (const c of byId.get(id).contents) { if (!byId.has(c.id)) throw new Error(`Unknown contents ID: ${c.id}`); contentsVisit(c.id, [...stack, id]); }
    contentsDone.add(id);
  }
  items.forEach(r => contentsVisit(r.id));
  let instances = [];
  if (data.instances !== undefined) {
    if (!Array.isArray(data.instances) || data.instances.length > limit) throw new Error('instances must be a bounded array');
    instances = data.instances.map(r => {
      fields(r, ['id', 'item', 'parent', 'localKey', 'placement'], 'instance');
      text(r.id, 'instance.id'); text(r.localKey, 'instance.localKey');
      if (!byId.has(r.item)) throw new Error(`Unknown instance item: ${r.item}`);
      if (r.parent !== null && typeof r.parent !== 'string') throw new Error('instance.parent must be ID or null');
      return { ...r, placement: r.placement ? transform(r.placement) : byId.get(r.item).placement };
    });
  } else {
    for (const r of order) {
      const parents = r.parent === null ? [null] : instances.filter(o => o.item === r.parent);
      for (const parent of parents) for (let n = 1; n <= r.quantity; n++) {
        if (instances.length >= limit) throw new Error('Instance expansion exceeds maxItems');
        const localKey = `${r.id}:${n}`, id = parent ? `${parent.id}/${localKey}` : localKey;
        instances.push({ id, localKey, item: r.id, parent: parent?.id ?? null, placement: r.placement });
      }
    }
  }
  const inst = new Map(instances.map(r => [r.id, r]));
  if (inst.size !== instances.length) throw new Error('Duplicate instance ID');
  const sorted = [], seen = new Set(), active = new Set();
  function visitInstance(r) {
    if (seen.has(r.id)) return;
    if (active.has(r.id)) throw new Error('Instance parent cycle');
    active.add(r.id);
    if (r.parent !== null) { const p = inst.get(r.parent); if (!p) throw new Error(`Unknown instance parent: ${r.parent}`); visitInstance(p); if (byId.get(r.item).parent !== p.item) throw new Error(`${r.id}: instance parent conflicts with catalog physical parent`); }
    else if (byId.get(r.item).parent !== null) throw new Error(`${r.id}: missing catalog parent`);
    active.delete(r.id); seen.add(r.id); sorted.push(r);
  }
  instances.forEach(visitInstance); instances = sorted;
  const signatures = new Map();
  for (const parent of [null, ...instances]) {
    const children = instances.filter(r => r.parent === (parent?.id ?? null));
    if (new Set(children.map(r => r.localKey)).size !== children.length) throw new Error('Duplicate sibling localKey');
    const signature = stable(children.map(r => ({ key: r.localKey, item: r.item, placement: r.placement })).sort((a, b) => a.key.localeCompare(b.key)));
    const key = parent?.item ?? null;
    if (signatures.has(key) && signatures.get(key) !== signature) throw new Error(`Linked assembly ${key} has inconsistent child structure/placements; use separate definition IDs`);
    signatures.set(key, signature);
    for (const r of children) if (r.placement && r.placement.frame !== 'parent') throw new Error('Catalog placements must be explicit parent-frame transforms; use placement import for root/named frames');
    for (const item of items.filter(r => r.parent === (parent?.item ?? null))) {
      if (children.filter(r => r.item === item.id).length !== item.quantity) throw new Error(`${item.id}: explicit instance count conflicts with quantity per parent`);
    }
  }
  for (const r of instances) if (!r.placement) unresolved.push({ id: r.id, field: 'placement', status: 'unknown' });
  const ledger = items.map(r => {
    const physical = instances.filter(o => o.item === r.id && r.kind !== 'reference').length;
    const owners = items.flatMap(p => p.contents.filter(c => c.id === r.id).map(c => ({ owner: p.id, quantity: p.purchaseQuantity === undefined ? null : c.quantity * p.purchaseQuantity })));
    const contained = owners.some(c => c.quantity === null) ? null : owners.reduce((s, c) => s + c.quantity, 0);
    if (['purchased', 'pcba'].includes(r.kind) && r.purchaseQuantity !== undefined && !r.allocation && r.purchaseQuantity < physical) throw new Error(`${r.id}: physical quantity exceeds declared purchases`);
    if (physical && owners.length) {
      if (!r.allocation || r.allocation.quantity !== physical || !owners.some(o => o.owner === r.allocation.owner && o.quantity >= physical)) throw new Error(`${r.id}: physical contents require explicit matching PCBA allocation; would double count purchase`);
      if (r.parent !== r.allocation.owner) throw new Error(`${r.id}: allocated contents must belong to their physical owner`);
      if (r.purchaseQuantity) throw new Error(`${r.id}: allocated contents cannot also be standalone purchases`);
    }
    if (r.allocation && !owners.some(o => o.owner === r.allocation.owner)) throw new Error(`${r.id}: allocation owner does not contain item`);
    for (const owner of items.filter(p => p.contents.some(c => c.id === r.id))) if (owner.purchaseQuantity === undefined) unresolved.push({ id: owner.id, field: 'purchaseQuantity', status: 'unknown' });
    return { id: r.id, physical, reference: r.kind === 'reference' ? instances.filter(o => o.item === r.id).length : 0,
      purchase: r.purchaseQuantity ?? null, contents: contained, owners, allocation: r.allocation ?? null };
  });
  const differences = []; let bomProvenance = null;
  if (data.bom !== undefined) {
    let bom = data.bom;
    if (!Array.isArray(bom)) {
      fields(bom, ['source', 'schema', 'baseDir'], 'bom adapter');
      const input = load({ ...bom, baseDir: bom.baseDir || loaded.baseDir, revision: data.revision }, limit, files);
      bom = input.rows.map(r => r.row); bomProvenance = input.provenance;
    }
    if (!bom.length) throw new Error('bom must be nonempty');
    const keys = new Set();
    for (const b of bom) {
      fields(b, ['id', 'quantity', 'basis'], 'BOM row'); integer(b.quantity, 'BOM quantity');
      if (!['physical', 'purchase', 'contents'].includes(b.basis)) throw new Error('BOM basis must be physical|purchase|contents');
      const key = `${b.id}/${b.basis}`; if (keys.has(key)) throw new Error('Duplicate BOM row'); keys.add(key);
      const r = ledger.find(r => r.id === b.id), actual = r?.[b.basis] ?? null;
      if (actual !== b.quantity) differences.push({ id: b.id, basis: b.basis, expected: b.quantity, actual, status: actual === null ? 'unknown' : 'fail' });
    }
  }
  return { items, instances, ledger, differences, bomProvenance, counts: { ids: items.length, models: items.filter(r => r.model).length, instances: instances.length } };
}

function prepare(operation, data, files = localFiles) {
  return prepareDataImport(operation, data, files, {
    inputs: op => descriptors[op] ? Object.keys(descriptors[op].inputs) : null,
    fields, text, integer, digest: value => hash(stable(value)), records: prepareRecords,
  });
}
function prepareRecords(operation, data, limit, unresolved, warnings, files) {
  let result, provenance;
  if (operation === 'cots.replace') {
    text(data.expectedRevision, 'expectedRevision');
    if (data.revision === data.expectedRevision) throw new Error('Replacement revision must differ from expectedRevision');
    if (data.onExisting !== undefined) throw new Error('cots.replace uses expectedRevision and occurrencePolicy, not onExisting');
    for (const key of ['source', 'records', 'schema', 'observed']) if (data[key] !== undefined) throw new Error(`cots.replace does not accept ${key}`);
    text(data.target, 'target');
    if (!['all', 'selected'].includes(data.occurrencePolicy)) throw new Error('occurrencePolicy must be all|selected');
    if (data.occurrencePolicy === 'selected' && (!Array.isArray(data.occurrences) || !data.occurrences.length)) throw new Error('selected requires occurrences');
    if (data.occurrencePolicy === 'all' && data.occurrences !== undefined) throw new Error('all excludes occurrences');
    if (data.childrenPolicy !== undefined && !['error', 'preserve'].includes(data.childrenPolicy)) throw new Error('childrenPolicy must be error|preserve');
    if (!Array.isArray(data.datumMap) || !data.datumMap.length) throw new Error('Complete datumMap required; optical normal alone cannot locate a replacement');
    const datums = data.datumMap.map(d => { fields(d, ['name', 'old', 'new'], 'datumMap'); text(d.name, 'datum name'); const old = transform(d.old), next = transform(d.new); if (old.frame !== 'component' || next.frame !== 'component') throw new Error('Datum frames must be component'); return { name: d.name, old, new: next, delta: multiply(old.matrix, inverse(next.matrix)) }; });
    if (new Set(datums.map(d => d.name)).size !== datums.length) throw new Error('Duplicate datum name');
    if (datums.some(d => d.delta.some((v, i) => Math.abs(v - datums[0].delta[i]) > 1e-8))) throw new Error('Datum map inconsistent: a single rigid replacement cannot preserve all interfaces');
    fields(data.impacts, ['matingParts', 'routings', 'refs', 'mass'], 'impacts');
    for (const key of ['matingParts', 'routings', 'refs', 'mass']) { const v = data.impacts[key]; fields(v, ['status', 'items', 'source'], `impacts.${key}`); if (!['known', 'unknown'].includes(v.status) || !Array.isArray(v.items)) throw new Error('Impacts require status known|unknown and items array'); if (v.status === 'unknown') unresolved.push({ id: data.target, field: key, status: 'unknown' }); }
    if (data.acceptInvalidation !== true) throw new Error('Replacement requires acceptInvalidation:true; mating/routing/ref/mass checks will be invalidated');
    if (data.mass === undefined) unresolved.push({ id: data.target, field: 'replacement.mass', status: 'unknown' });
    const replacement = model(data.model, data.baseDir || files.cwd(), unresolved, data.target, files); if (!replacement) throw new Error('Replacement model required');
    result = { target: data.target, model: replacement, datums, delta: datums[0].delta, occurrencePolicy: data.occurrencePolicy, occurrences: data.occurrences || [], childrenPolicy: data.childrenPolicy || 'error', impacts: data.impacts, mass: mass(data.mass, unresolved, data.target) };
    provenance = { sha256: hash(stable(result)), revision: data.revision, pathHost: 'CLI' };
  } else {
    const loaded = load(data, limit, files); provenance = loaded.provenance;
    if (operation.startsWith('catalog.')) result = catalogPlan(data, loaded, limit, unresolved, files);
    else if (operation === 'param.import') {
      const parameters = loaded.rows.map(({ row: r, provenance }, i) => {
        fields(r, ['name', 'expression', 'unit', 'comment', 'status', 'source', 'derivation'], `parameter ${i + 1}`);
        if (typeof r.name !== 'string' || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(r.name)) throw new Error('Invalid parameter name');
        if (typeof r.unit !== 'string' || r.unit.toLowerCase() === 'text') throw new Error('Explicit numeric parameter unit required (empty string for unitless)');
        let expression = r.expression;
        if (typeof expression === 'number' && Number.isFinite(expression)) expression = `${expression}${r.unit ? ' ' + r.unit : ''}`;
        if (typeof expression === 'string' && r.unit && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(expression.trim())) expression = `${expression.trim()} ${r.unit}`;
        text(expression, 'parameter expression'); if (r.comment !== undefined && typeof r.comment !== 'string') throw new Error('comment must be text');
        return { name: r.name, expression, unit: r.unit, ...(r.comment !== undefined ? { comment: r.comment } : {}), provenance: evidence(r, provenance, unresolved, r.name) };
      });
      if (new Set(parameters.map(r => r.name)).size !== parameters.length) throw new Error('Duplicate parameter name');
      result = { parameters };
      warnings.push('Fusion validates expression grammar, units and the complete dependency graph before param.apply writes; offline preflight does not evaluate Fusion expressions.');
    } else {
      const poses = loaded.rows.map(({ row: r, provenance }) => {
        fields(r, ['id', 'occurrence', 'placement', 'status', 'source', 'derivation'], 'placement row'); text(r.id, 'placement.id');
        if (r.occurrence === undefined) throw new Error('placement.occurrence required (exact full path or ref)');
        const p = r.placement == null ? null : transform(r.placement);
        if (!p) unresolved.push({ id: r.id, field: 'placement', status: 'unknown' });
        if (p?.frame === 'component') throw new Error('Occurrence placement frame must be parent/root/{occurrence:REF}');
        return { id: r.id, occurrence: r.occurrence, transform: p, provenance: evidence(r, provenance, unresolved, r.id) };
      });
      if (new Set(poses.map(p => p.id)).size !== poses.length) throw new Error('Duplicate placement ID');
      const tolerance = quantity(data.tolerance || '0.001 mm', lengthUnits, 'tolerance');
      const angleTolerance = quantity(data.angleTolerance || '0.01 deg', angleUnits, 'angleTolerance');
      if (tolerance < 0 || angleTolerance < 0) throw new Error('Tolerances must be nonnegative');
      result = { poses, tolerance, angleTolerance };
    }
  }
  return { result, provenance };
}

function offlineResult(plan, preview = false) {
  return offlineImportResult(plan, preview, { transform, multiply, inverse, stable });
}

function isOffline(operation, data) { return !!descriptors[operation] && operation.endsWith('.check') && data.inspectModel !== true; }

const manuals = Object.fromEntries(Object.entries(descriptors).map(([op, spec]) => [op, {
  sections: [
    { title: 'Return Contract', text: spec.summary },
    { title: 'Source And Limitations', text: spec.limitations.join(' ') },
  ],
  examples: [{ label: op, requires: 'Existing names/IDs from discovery and model paths on the CLI host. See docs/DATA_IMPORT.md.', data: spec.example, output: 'Versioned preflight/plan or check envelope; inspect status, unresolved, differences and provenance.' }],
  audit: {
    sources: ['src/data-import.js', 'docs/DATA_IMPORT.md'],
    verified: ['versioned adapter preflight and strict CSV/JSON parsing', 'ownership/revision/provenance and onExisting policy', 'catalog/placement/param record validation and offline checks', 'cots.replace datum-map consistency and impact invalidation'],
    tests: ['tests/data_import.test.js', 'tests/data_import_test.py'],
    gaps: [], bugs: ['Offline checks do not inspect a live Fusion model; kernel failures are never retried.'],
  },
}]));

module.exports = { descriptors, prepare, offlineResult, isOffline, csv, transform, rigid, multiply, inverse, stable, manuals };

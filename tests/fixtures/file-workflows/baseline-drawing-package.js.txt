'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OPERATION = 'drawing.package';

const SHEET = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297], LETTER: [215.9, 279.4] };
const SOURCE_STATUSES = ['CONFIRMED', 'ESTIMATED', 'OPEN', 'DERIVED'];
const LENGTH_UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
const ANGLE_UNITS = { deg: Math.PI / 180, rad: 1 };
const VIEW_KINDS = ['projection', 'section', 'detail'];
const ORIENTATIONS = ['front', 'side', 'rear', 'top', 'bottom', 'left', 'right', 'custom'];
const DIM_KINDS = ['linear', 'radius', 'diameter', 'angle'];
const CONTROL_KINDS = ['flatness', 'position', 'parallelism', 'perpendicularity'];
const NOTE_KINDS = ['material', 'process', 'general', 'finish'];
const FORMATS = ['svg', 'pdf', 'dxf'];

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, what = 'value') {
  if (typeof value !== 'string' || !value.trim()) fail('Expected nonempty string for ' + what);
  return value;
}
function safeId(value, what = 'id') {
  const id = text(value, what);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) fail('Invalid ' + what + ': ' + id);
  return id;
}
function number(value, minimum, what = 'number') {
  if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    fail('Expected finite ' + what + (minimum === undefined ? '' : ' >= ' + minimum));
  }
  return value;
}
function quantity(value, angle = false, what = 'quantity') {
  const units = angle ? ANGLE_UNITS : LENGTH_UNITS;
  const match = typeof value === 'string'
    ? value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(mm|cm|m|in|ft|deg|rad)$/)
    : null;
  if (!match || !(match[2] in units)) fail('Expected explicit ' + (angle ? 'angle' : 'length') + ' expression for ' + what);
  return parseFloat(match[1]) * units[match[2]];
}
const length = (value, what) => quantity(value, false, what);
const angleRad = (value, what) => quantity(value, true, what);
function point(value, what = 'point') {
  if (!Array.isArray(value) || value.length !== 2) fail('Expected [x,y] ' + what);
  return [number(value[0], undefined, what + ' x'), number(value[1], undefined, what + ' y')];
}
function source(value, what = 'source') {
  if (!isObject(value)) fail('Expected ' + what + ' object');
  text(value.path, what + '.path');
  if (!SOURCE_STATUSES.includes(value.status)) fail('Invalid ' + what + '.status');
  if (value.status === 'DERIVED' && (!Array.isArray(value.derivedFrom) || !value.derivedFrom.length)) fail('DERIVED source requires derivedFrom');
  if (value.status !== 'DERIVED' && 'derivedFrom' in value) fail('derivedFrom requires DERIVED status');
  return { path: value.path, status: value.status, ...(value.derivedFrom ? { derivedFrom: value.derivedFrom } : {}) };
}
function digest(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

function arcEndpoints(entity) {
  const a0 = entity.startDeg * Math.PI / 180;
  const a1 = (entity.startDeg + entity.sweepDeg) * Math.PI / 180;
  return [a0, a1].map(a => [entity.center[0] + entity.r * Math.cos(a), entity.center[1] + entity.r * Math.sin(a)]);
}

function validateEntity(value, ids, viewId) {
  if (!isObject(value)) fail('view ' + viewId + ': entity must be an object');
  const kind = value.kind;
  const entity = {};
  if (value.id !== undefined) {
    entity.id = safeId(value.id, 'entity id in ' + viewId);
    if (ids.has(entity.id)) fail('Duplicate entity id ' + entity.id);
    ids.add(entity.id);
  }
  switch (kind) {
    case 'line': entity.from = point(value.from); entity.to = point(value.to); break;
    case 'circle':
      entity.center = point(value.center); entity.r = number(value.r, 0);
      if (entity.r === 0) fail('circle radius must be positive');
      break;
    case 'arc':
      entity.center = point(value.center); entity.r = number(value.r, 0);
      entity.startDeg = number(value.startDeg); entity.sweepDeg = number(value.sweepDeg, 0);
      if (entity.r === 0 || entity.sweepDeg <= 0 || entity.sweepDeg > 360) fail('arc requires positive radius and sweep in (0,360]');
      break;
    case 'polyline':
      if (!Array.isArray(value.points) || value.points.length < 2) fail('polyline requires at least two points');
      entity.points = value.points.map(p => point(p));
      if (value.closed !== undefined && typeof value.closed !== 'boolean') fail('polyline closed must be boolean');
      entity.closed = value.closed === true;
      break;
    case 'hatch':
      if (!Array.isArray(value.boundary) || value.boundary.length < 3) fail('hatch boundary requires at least three points');
      entity.boundary = value.boundary.map(p => point(p));
      entity.spacing = number(value.spacing, 0);
      if (entity.spacing === 0) fail('hatch spacing must be positive');
      entity.angleDeg = value.angleDeg === undefined ? 45 : number(value.angleDeg);
      break;
    case 'text':
      entity.at = point(value.at); entity.text = text(value.text, 'entity text');
      entity.height = number(value.height, 0);
      if (entity.height === 0) fail('text height must be positive');
      break;
    default: fail('view ' + viewId + ': unsupported entity kind ' + kind);
  }
  return { kind, ...entity };
}

function resolvePoint(view, spec, what = 'point') {
  if (Array.isArray(spec)) return point(spec, what);
  if (!isObject(spec)) fail('Expected [x,y] or entity reference for ' + what);
  const entity = view.entities.find(e => e.id === spec.entity) || fail(what + ': unknown entity ' + spec.entity + ' in view ' + view.id);
  const role = spec.role === undefined ? 'center' : text(spec.role);
  switch (entity.kind) {
    case 'circle':
      if (role !== 'center') fail(what + ': circle role must be center');
      return [...entity.center];
    case 'arc': {
      if (role === 'center') return [...entity.center];
      const ends = arcEndpoints(entity);
      if (role === 'start') return ends[0];
      if (role === 'end') return ends[1];
      fail(what + ': arc roles are center, start, end');
    }
    case 'line':
      if (role === 'start') return [...entity.from];
      if (role === 'end') return [...entity.to];
      fail(what + ': line roles are start, end');
    case 'polyline':
      if (role === 'vertex' && Number.isInteger(spec.index) && spec.index >= 0 && spec.index < entity.points.length) return [...entity.points[spec.index]];
      fail(what + ': polyline role vertex requires a valid index');
    default: fail(what + ': entity kind ' + entity.kind + ' exposes no points');
  }
}

function validateView(value, entityIds, viewIds, index, allViews) {
  if (!isObject(value)) fail('view must be an object');
  const id = safeId(value.id, 'view id');
  if (viewIds.has(id)) fail('Duplicate view id ' + id);
  viewIds.add(id);
  const kind = value.kind;
  if (!VIEW_KINDS.includes(kind)) fail('view ' + id + ': unsupported kind ' + kind);
  const view = { id, kind, scale: value.scale === undefined ? 1 : number(value.scale, 0, 'view ' + id + ' scale'), origin: point(value.origin, 'view ' + id + ' origin') };
  if (view.scale === 0) fail('view ' + id + ': scale must be positive');
  if (kind === 'projection') {
    const orientation = value.orientation === undefined ? 'custom' : value.orientation;
    if (!ORIENTATIONS.includes(orientation)) fail('view ' + id + ': invalid orientation');
    view.orientation = orientation;
  } else {
    view.parent = safeId(value.parent, 'view ' + id + ' parent');
    const parent = allViews.slice(0, index).find(v => v.id === view.parent);
    if (!parent) fail('view ' + id + ': parent ' + view.parent + ' must be listed earlier');
    if (kind === 'section') {
      view.cutFrom = resolvePoint(parent, value.cutFrom, 'section cutFrom');
      view.cutTo = resolvePoint(parent, value.cutTo, 'section cutTo');
      if (view.cutFrom[0] === view.cutTo[0] && view.cutFrom[1] === view.cutTo[1]) fail('section cut line must have distinct endpoints');
    } else {
      view.detailFrom = resolvePoint(parent, value.detailFrom, 'detail center');
      view.detailRadius = number(value.detailRadius, 0, 'detail radius');
      if (view.detailRadius === 0) fail('detail radius must be positive');
    }
  }
  if (!Array.isArray(value.geometry) || !value.geometry.length) fail('view ' + id + ': geometry must be nonempty');
  view.entities = value.geometry.map(e => validateEntity(e, entityIds, id));
  return view;
}

function findView(views, id, what) {
  return views.find(v => v.id === id) || fail(what + ': unknown view ' + id);
}

function validateDimension(value, views, ids) {
  if (!isObject(value)) fail('dimension must be an object');
  const id = safeId(value.id, 'dimension id');
  if (ids.has(id)) fail('Duplicate dimension id ' + id);
  ids.add(id);
  const kind = value.kind;
  if (!DIM_KINDS.includes(kind)) fail('dimension ' + id + ': unsupported kind ' + kind);
  const view = findView(views, value.view, 'dimension ' + id);
  const dim = { id, view: view.id, kind, source: source(value.source, 'dimension ' + id + ' source'), toleranceMm: null };
  if (kind === 'linear') {
    dim.a = resolvePoint(view, value.a, 'dimension ' + id + ' a');
    dim.b = resolvePoint(view, value.b, 'dimension ' + id + ' b');
    dim.offset = number(value.offset === undefined ? 8 : value.offset, undefined, 'dimension ' + id + ' offset');
    dim.valueMm = length(value.value, 'dimension ' + id + ' value');
    if (dim.valueMm <= 0) fail('dimension ' + id + ': value must be positive');
  } else if (kind === 'angle') {
    dim.vertex = resolvePoint(view, value.vertex, 'dimension ' + id + ' vertex');
    dim.a = resolvePoint(view, value.a, 'dimension ' + id + ' a');
    dim.b = resolvePoint(view, value.b, 'dimension ' + id + ' b');
    dim.valueRad = angleRad(value.value, 'dimension ' + id + ' value');
    if (!(dim.valueRad > 0) || dim.valueRad > Math.PI) fail('dimension ' + id + ': angle value must be in (0, 180 deg]');
    if (value.tolerance !== undefined) fail('dimension ' + id + ': angle tolerances are not supported');
  } else {
    const circle = view.entities.find(e => e.id === value.circle && e.kind === 'circle') || fail('dimension ' + id + ': circle must reference a circle entity in its view');
    dim.circle = circle.id;
    if (value.value !== undefined) {
      dim.valueMm = length(value.value, 'dimension ' + id + ' value');
      if (dim.valueMm <= 0) fail('dimension ' + id + ': value must be positive');
    }
  }
  if (value.tolerance !== undefined) {
    if (dim.source.status !== 'CONFIRMED') fail('dimension ' + id + ': production tolerance requires CONFIRMED source; ESTIMATED/OPEN/DERIVED values must not become production tolerances');
    if (!isObject(value.tolerance)) fail('dimension ' + id + ': tolerance must be an object');
    const upper = length(value.tolerance.upper, 'dimension ' + id + ' tolerance upper');
    const lower = length(value.tolerance.lower, 'dimension ' + id + ' tolerance lower');
    if (upper < 0 || lower > 0) fail('dimension ' + id + ': tolerance upper must be >= 0 and lower <= 0');
    dim.toleranceMm = { upper, lower };
  }
  return dim;
}

function validateDatum(value, views, ids) {
  const id = safeId(value.id, 'datum id');
  if (ids.has(id)) fail('Duplicate datum id ' + id);
  ids.add(id);
  const kind = value.kind;
  if (!['plane', 'axis'].includes(kind)) fail('datum ' + id + ': kind must be plane or axis');
  const view = findView(views, value.view, 'datum ' + id);
  const datum = { id, view: view.id, kind, at: resolvePoint(view, value.at, 'datum ' + id + ' at'), label: value.label === undefined ? id : text(value.label, 'datum ' + id + ' label'), source: source(value.source, 'datum ' + id + ' source') };
  if (kind === 'plane') {
    datum.direction = value.direction === undefined ? 'horizontal' : value.direction;
    if (datum.direction !== 'horizontal' && datum.direction !== 'vertical' && typeof datum.direction !== 'number') fail('datum ' + id + ': plane direction must be horizontal, vertical or degrees');
  }
  return datum;
}

function validateControl(value, views, datumIds, dimensions, ids) {
  const id = safeId(value.id, 'control id');
  if (ids.has(id)) fail('Duplicate control id ' + id);
  ids.add(id);
  const kind = value.kind;
  if (!CONTROL_KINDS.includes(kind)) fail('control ' + id + ': unsupported GD&T kind; supported range: ' + CONTROL_KINDS.join(', '));
  const view = findView(views, value.view, 'control ' + id);
  const control = { id, view: view.id, kind, valueMm: length(value.value, 'control ' + id + ' value'), source: source(value.source, 'control ' + id + ' source') };
  if (control.valueMm < 0) fail('control ' + id + ': value must be nonnegative');
  const target = text(value.target, 'control ' + id + ' target');
  const targetIsEntity = view.entities.some(e => e.id === target);
  const targetIsDimension = dimensions.some(d => d.id === target && d.view === view.id);
  if (!targetIsEntity && !targetIsDimension) fail('control ' + id + ': target must be an entity or dimension in its view');
  control.target = target;
  if (kind === 'flatness') {
    if (value.datums !== undefined) fail('control ' + id + ': flatness does not use datums');
  } else {
    if (!Array.isArray(value.datums) || !value.datums.length) fail('control ' + id + ': ' + kind + ' requires datum references');
    for (const datum of value.datums) {
      const key = text(datum, 'control ' + id + ' datum');
      if (!datumIds.has(key)) fail('control ' + id + ': unknown datum ' + key);
    }
    control.datums = value.datums.map(d => text(d));
  }
  if (value.anchor !== undefined) control.anchor = resolvePoint(view, value.anchor, 'control ' + id + ' anchor');
  return control;
}

function validateNote(value, ids) {
  const id = safeId(value.id, 'note id');
  if (ids.has(id)) fail('Duplicate note id ' + id);
  ids.add(id);
  const kind = value.kind === undefined ? 'general' : value.kind;
  if (!NOTE_KINDS.includes(kind)) fail('note ' + id + ': unsupported kind ' + kind);
  const note = { id, kind, text: text(value.text, 'note ' + id + ' text'), at: point(value.at, 'note ' + id + ' at'), height: value.height === undefined ? 3.5 : number(value.height, 0, 'note ' + id + ' height'), source: source(value.source, 'note ' + id + ' source') };
  if (note.height === 0) fail('note ' + id + ': height must be positive');
  return note;
}

function validateItem(value, numbers) {
  const item = number(value.item, 1, 'item number');
  if (!Number.isInteger(item)) fail('item number must be an integer');
  if (numbers.has(item)) fail('Duplicate item number ' + item);
  numbers.add(item);
  return { item, partId: text(value.partId, 'item partId'), description: text(value.description, 'item description'),
    qty: number(value.qty, 1, 'item qty'), purchased: value.purchased === true,
    source: source(value.source, 'item ' + item + ' source') };
}

function validateBalloon(value, views, numbers, ids, pairs) {
  const id = safeId(value.id, 'balloon id');
  if (ids.has(id)) fail('Duplicate balloon id ' + id);
  ids.add(id);
  const view = findView(views, value.view, 'balloon ' + id);
  const item = number(value.item, 1, 'balloon ' + id + ' item');
  if (!Number.isInteger(item)) fail('balloon ' + id + ': item must be an integer');
  if (!numbers.has(item)) fail('balloon ' + id + ': unknown item ' + item);
  const pair = view.id + ':' + item;
  if (pairs.has(pair)) fail('Duplicate balloon for item ' + item + ' in view ' + view.id + '; balloon to BOM mapping must be unique');
  pairs.add(pair);
  return { id, view: view.id, item, at: resolvePoint(view, value.at, 'balloon ' + id + ' at'), anchor: resolvePoint(view, value.anchor, 'balloon ' + id + ' anchor') };
}

function validateFit(value, views, ids) {
  const id = safeId(value.id, 'fit id');
  if (ids.has(id)) fail('Duplicate fit id ' + id);
  ids.add(id);
  const view = findView(views, value.view, 'fit ' + id);
  const findCircle = (what, key) => {
    const circle = view.entities.find(e => e.id === value[key] && e.kind === 'circle') || fail('fit ' + id + ': ' + what + ' must reference a circle entity in its view');
    return circle.id;
  };
  const clearance = value.clearance;
  if (!isObject(clearance)) fail('fit ' + id + ': clearance must be an object');
  const minMm = length(clearance.min, 'fit ' + id + ' min'); const maxMm = length(clearance.max, 'fit ' + id + ' max');
  if (minMm < 0 || maxMm < minMm) fail('fit ' + id + ': clearance requires 0 <= min <= max');
  return { id, view: view.id, shaft: findCircle('shaft', 'shaft'), bore: findCircle('bore', 'bore'),
    clearance: { minMm, maxMm, source: source(clearance.source, 'fit ' + id + ' clearance source') } };
}

function validateSheet(value) {
  if (!isObject(value)) fail('sheet must be an object');
  let size;
  if (typeof value.format === 'string' && SHEET[value.format]) size = [...SHEET[value.format]];
  else if (value.format === 'custom') size = point(value.custom, 'sheet custom size');
  else fail('sheet format must be A0-A4, LETTER or custom');
  const orientation = value.orientation === undefined ? 'landscape' : value.orientation;
  if (!['landscape', 'portrait'].includes(orientation)) fail('sheet orientation must be landscape or portrait');
  const [a, b] = size;
  if (a <= 0 || b <= 0) fail('sheet size must be positive');
  const titleBlock = {};
  if (value.titleBlock !== undefined) {
    if (!isObject(value.titleBlock)) fail('titleBlock must be an object');
    for (const key of ['drawingNumber', 'author', 'date', 'scale']) {
      if (value.titleBlock[key] !== undefined) titleBlock[key] = text(value.titleBlock[key], 'titleBlock.' + key);
    }
  }
  return { format: value.format, orientation, sizeMm: orientation === 'portrait' ? [Math.min(a, b), Math.max(a, b)] : [Math.max(a, b), Math.min(a, b)], titleBlock };
}

function measureDimension(dim, view) {
  if (dim.kind === 'linear') return Math.hypot(dim.b[0] - dim.a[0], dim.b[1] - dim.a[1]);
  if (dim.kind === 'angle') {
    const angleOf = p => Math.atan2(p[1] - dim.vertex[1], p[0] - dim.vertex[0]);
    let diff = Math.abs(angleOf(dim.b) - angleOf(dim.a));
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    return diff;
  }
  const circle = view.entities.find(e => e.id === dim.circle);
  return dim.kind === 'radius' ? circle.r : 2 * circle.r;
}

function dimensionStatus(dim, measured) {
  if (dim.source.status === 'OPEN') return 'blocked';
  const value = dim.kind === 'angle' ? dim.valueRad : dim.valueMm;
  const within = dim.toleranceMm
    ? measured >= value + dim.toleranceMm.lower && measured <= value + dim.toleranceMm.upper
    : Math.abs(measured - value) <= 1e-6 * Math.max(1, Math.abs(value));
  if (!within) return 'fail';
  return dim.source.status === 'CONFIRMED' ? 'pass' : 'unknown';
}

function fitStatus(fit, view, axisToleranceMm) {
  if (fit.clearance.source.status === 'OPEN') return 'blocked';
  const shaft = view.entities.find(e => e.id === fit.shaft);
  const bore = view.entities.find(e => e.id === fit.bore);
  const clearance = bore.r - shaft.r;
  if (clearance < fit.clearance.minMm || clearance > fit.clearance.maxMm) return 'fail';
  const centers = Math.hypot(bore.center[0] - shaft.center[0], bore.center[1] - shaft.center[1]);
  if (centers > axisToleranceMm) return 'fail';
  return fit.clearance.source.status === 'CONFIRMED' ? 'pass' : 'unknown';
}

function collectSources(model) {
  return [
    ...model.dimensions.map(d => d.source),
    ...model.datums.map(d => d.source),
    ...model.controls.map(c => c.source),
    ...model.notes.map(n => n.source),
    ...model.items.map(i => i.source),
    ...model.fits.map(f => f.clearance.source),
  ];
}

function checkRows(model) {
  const rows = [];
  const views = model.views;
  const balloonPairs = new Set();
  let balloonsUnique = true;
  for (const balloon of model.balloons) {
    const pair = balloon.view + ':' + balloon.item;
    if (balloonPairs.has(pair)) { balloonsUnique = false; break; }
    balloonPairs.add(pair);
  }
  rows.push({ id: 'balloon-unique', kind: 'balloon-unique', status: balloonsUnique ? 'pass' : 'fail', detail: 'Unique balloon ids and one balloon per item per view' });
  const itemNumbers = new Set(model.items.map(i => i.item));
  const balloonMapped = model.balloons.every(b => itemNumbers.has(b.item));
  rows.push({ id: 'balloon-item-map', kind: 'balloon-item-map', status: balloonMapped ? 'pass' : 'fail', detail: 'Every balloon references an item table entry' });
  rows.push({ id: 'dimension-membership', kind: 'dimension-membership', status: 'pass', detail: model.dimensions.length + ' dimensions bound to declared views' });
  for (const dim of model.dimensions) {
    const view = findView(views, dim.view, 'dimension ' + dim.id);
    const measured = measureDimension(dim, view);
    const status = dimensionStatus(dim, measured);
    const value = dim.kind === 'angle' ? dim.valueRad * 180 / Math.PI + ' deg' : dim.valueMm + ' mm';
    rows.push({ id: dim.id, kind: 'dimension-consistency', view: dim.view, status,
      detail: 'declared ' + value + ' vs measured ' + (Math.round(measured * 1000) / 1000) + (dim.kind === 'angle' ? ' deg' : ' mm') });
    if (dim.toleranceMm) rows.push({ id: dim.id, kind: 'tolerance-source', view: dim.view, status: dim.source.status === 'CONFIRMED' ? 'pass' : 'fail',
      detail: 'Production tolerance requires CONFIRMED source' });
  }
  for (const control of model.controls) {
    const view = findView(views, control.view, 'control ' + control.id);
    const datumIds = new Set(model.datums.filter(d => d.view === view.id).map(d => d.id));
    const ok = (control.datums || []).every(d => datumIds.has(d));
    rows.push({ id: control.id, kind: 'control-datums', view: control.view, status: ok ? 'pass' : 'fail', detail: 'Feature control datums exist in the same view' });
  }
  for (const fit of model.fits) {
    const view = findView(views, fit.view, 'fit ' + fit.id);
    const shaft = view.entities.find(e => e.id === fit.shaft);
    const bore = view.entities.find(e => e.id === fit.bore);
    const clearance = bore.r - shaft.r;
    rows.push({ id: fit.id, kind: 'fit-geometry', view: fit.view, status: fitStatus(fit, view, model.axisToleranceMm),
      detail: 'radial clearance ' + (Math.round(clearance * 1000) / 1000) + ' mm in [' + fit.clearance.minMm + ', ' + fit.clearance.maxMm + '] mm' });
  }
  for (const item of model.items) {
    if (item.source.status === 'OPEN') rows.push({ id: 'item-' + item.item, kind: 'item-source', status: 'blocked', detail: 'Item ' + item.item + ' has an OPEN source' });
  }
  rows.push({ id: 'content-completeness', kind: 'content-completeness',
    status: model.items.length && model.balloons.length ? 'pass' : 'unknown',
    detail: 'Item table and balloons required for production acceptance' });
  return rows;
}

function aggregateStatus(rows, sources) {
  if (rows.some(r => r.status === 'blocked') || sources.some(s => s.status === 'OPEN')) return 'blocked';
  if (rows.some(r => r.status === 'fail')) return 'fail';
  if (rows.some(r => r.status === 'unknown') || sources.some(s => s.status !== 'CONFIRMED')) return 'unknown';
  return 'pass';
}

function buildModel(data) {
  const documentIdentity = isObject(data.documentIdentity) ? {
    name: text(data.documentIdentity.name, 'documentIdentity.name'),
    revision: data.documentIdentity.revision === undefined ? '' : text(data.documentIdentity.revision, 'documentIdentity.revision'),
  } : fail('documentIdentity must be an object');
  const sheet = validateSheet(data.sheet);
  const entityIds = new Set(); const viewIds = new Set(); const views = [];
  const allViews = [];
  data.views.forEach((value, index) => {
    const view = validateView(value, entityIds, viewIds, index, allViews);
    allViews.push(view); views.push(view);
  });
  const ids = new Set();
  const dimensions = (data.dimensions === undefined ? [] : data.dimensions).map(v => validateDimension(v, views, ids));
  const datums = (data.datums === undefined ? [] : data.datums).map(v => validateDatum(v, views, ids));
  const datumIds = new Set(datums.map(d => d.id));
  const controls = (data.controls === undefined ? [] : data.controls).map(v => validateControl(v, views, datumIds, dimensions, ids));
  const notes = (data.notes === undefined ? [] : data.notes).map(v => validateNote(v, ids));
  const numbers = new Set();
  const items = (data.items === undefined ? [] : data.items).map(v => validateItem(v, numbers));
  const balloonIds = new Set(); const pairs = new Set();
  const balloons = (data.balloons === undefined ? [] : data.balloons).map(v => validateBalloon(v, views, numbers, balloonIds, pairs));
  const fits = (data.fits === undefined ? [] : data.fits).map(v => validateFit(v, views, ids));
  const axisToleranceMm = data.axisTolerance === undefined ? 0.05 : length(data.axisTolerance, 'axisTolerance');
  return { documentIdentity, sheet, views, dimensions, datums, controls, notes, items, balloons, fits, axisToleranceMm };
}

function buildScene(model) {
  const primitives = [];
  const semantics = { sourceMap: { dimensions: {}, items: {}, notes: {} } };
  const put = primitive => primitives.push(primitive);
  const toSheet = (view, p) => [view.origin[0] + p[0] * view.scale, view.origin[1] + p[1] * view.scale];
  const scaleLabel = s => (Number.isInteger(s) ? s + ':1' : '1:' + (Math.round((1 / s) * 100) / 100));
  const label = (view, extra) => {
    const kindText = view.kind === 'projection' ? (view.orientation || '').toUpperCase() : view.kind === 'section' ? 'SECTION ' + view.id.toUpperCase() : 'DETAIL ' + view.id.toUpperCase();
    put({ type: 'text', at: [view.origin[0], view.origin[1] - 7], text: kindText + ' ' + scaleLabel(view.scale) + (extra ? ' — ' + extra : ''), height: 3.5, align: 'start' });
  };
  const hatch = (polygon, spacing, angleDeg) => {
    const angle = angleDeg * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const rotated = polygon.map(p => [p[0] * cos + p[1] * sin, -p[0] * sin + p[1] * cos]);
    const yMin = Math.min(...rotated.map(p => p[1])), yMax = Math.max(...rotated.map(p => p[1]));
    const lines = [];
    for (let y = yMin + spacing / 2; y < yMax; y += spacing) {
      const xs = [];
      for (let i = 0; i < rotated.length; i++) {
        const p1 = rotated[i], p2 = rotated[(i + 1) % rotated.length];
        if ((p1[1] <= y && p2[1] > y) || (p2[1] <= y && p1[1] > y)) xs.push(p1[0] + (y - p1[1]) * (p2[0] - p1[0]) / (p2[1] - p1[1]));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const back = (x, yy) => [x * cos - yy * sin, x * sin + yy * cos];
        lines.push({ type: 'line', from: back(xs[i], y), to: back(xs[i + 1], y), width: 0.18 });
      }
    }
    lines.forEach(put);
  };
  for (const view of model.views) {
    for (const entity of view.entities) {
      if (entity.kind === 'line') put({ type: 'line', from: toSheet(view, entity.from), to: toSheet(view, entity.to), width: 0.35 });
      else if (entity.kind === 'circle') put({ type: 'circle', center: toSheet(view, entity.center), r: entity.r * view.scale });
      else if (entity.kind === 'arc') put({ type: 'arc', center: toSheet(view, entity.center), r: entity.r * view.scale, startDeg: entity.startDeg, sweepDeg: entity.sweepDeg });
      else if (entity.kind === 'polyline') put({ type: 'polyline', points: entity.points.map(p => toSheet(view, p)), closed: entity.closed });
      else if (entity.kind === 'hatch') hatch(entity.boundary.map(p => toSheet(view, p)), entity.spacing * view.scale, entity.angleDeg);
      else if (entity.kind === 'text') put({ type: 'text', at: toSheet(view, entity.at), text: entity.text, height: entity.height * view.scale, align: 'start' });
    }
    label(view);
    if (view.kind === 'section') {
      const parent = model.views.find(v => v.id === view.parent);
      const from = toSheet(parent, view.cutFrom), to = toSheet(parent, view.cutTo);
      put({ type: 'line', from, to, width: 0.5 });
      put({ type: 'text', at: from, text: view.id.toUpperCase(), height: 3.5, align: 'start' });
      put({ type: 'text', at: to, text: view.id.toUpperCase(), height: 3.5, align: 'start' });
    } else if (view.kind === 'detail') {
      const parent = model.views.find(v => v.id === view.parent);
      put({ type: 'circle', center: toSheet(parent, view.detailFrom), r: view.detailRadius * parent.scale });
    }
  }
  const arrow = (tip, direction) => {
    const size = 2.5;
    const perp = [-direction[1], direction[0]];
    put({ type: 'solid', points: [tip, [tip[0] - direction[0] * size + perp[0] * 1, tip[1] - direction[1] * size + perp[1] * 1], [tip[0] - direction[0] * size - perp[0] * 1, tip[1] - direction[1] * size - perp[1] * 1]] });
  };
  const centerMark = center => {
    put({ type: 'line', from: [center[0] - 1.5, center[1]], to: [center[0] + 1.5, center[1]], width: 0.18 });
    put({ type: 'line', from: [center[0], center[1] - 1.5], to: [center[0], center[1] + 1.5], width: 0.18 });
  };
  const dimensionText = dim => {
    let value;
    if (dim.kind === 'angle') value = Math.round(dim.valueRad * 180 / Math.PI * 100) / 100 + '°';
    else if (dim.valueMm !== undefined) value = String(dim.valueMm);
    else {
      const view = model.views.find(v => v.id === dim.view);
      value = Math.round(measureDimension(dim, view) * 1000) / 1000 + ' (measured)';
    }
    if (dim.kind === 'radius') value = 'R' + value;
    if (dim.kind === 'diameter') value = '⌀' + value;
    if (dim.toleranceMm) value += ' +' + dim.toleranceMm.upper + '/' + dim.toleranceMm.lower;
    return value;
  };
  for (const dim of model.dimensions) {
    const view = model.views.find(v => v.id === dim.view);
    const textValue = dimensionText(dim);
    if (dim.kind === 'linear') {
      const a = toSheet(view, dim.a), b = toSheet(view, dim.b);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      const unit = [dx / len, dy / len];
      const perp = [-unit[1], unit[0]];
      const offset = dim.offset * view.scale;
      const d1 = [a[0] + perp[0] * offset, a[1] + perp[1] * offset];
      const d2 = [b[0] + perp[0] * offset, b[1] + perp[1] * offset];
      put({ type: 'line', from: a, to: [a[0] + perp[0] * (offset + 2), a[1] + perp[1] * (offset + 2)], width: 0.18 });
      put({ type: 'line', from: b, to: [b[0] + perp[0] * (offset + 2), b[1] + perp[1] * (offset + 2)], width: 0.18 });
      put({ type: 'line', from: d1, to: d2, width: 0.35 });
      arrow(a, unit); arrow(b, [-unit[0], -unit[1]]);
      const mid = [(d1[0] + d2[0]) / 2, (d1[1] + d2[1]) / 2];
      put({ type: 'text', at: [mid[0] + perp[0] * 1.5, mid[1] + perp[1] * 1.5], text: textValue, height: 3.5, align: 'middle' });
    } else if (dim.kind === 'angle') {
      const vertex = toSheet(view, dim.vertex), a = toSheet(view, dim.a), b = toSheet(view, dim.b);
      const angleOf = p => Math.atan2(p[1] - vertex[1], p[0] - vertex[0]);
      const r = Math.min(Math.hypot(a[0] - vertex[0], a[1] - vertex[1]), Math.hypot(b[0] - vertex[0], b[1] - vertex[1]), 12) * 0.6;
      let a0 = angleOf(a), a1 = angleOf(b);
      if (a1 < a0) { const t = a0; a0 = a1; a1 = t; }
      if (a1 - a0 > Math.PI) { a0 += Math.PI * 2; const t = a0; a0 = a1; a1 = t; }
      const sweep = (a1 - a0) * 180 / Math.PI;
      put({ type: 'arc', center: vertex, r, startDeg: a0 * 180 / Math.PI, sweepDeg: sweep });
      const pa = [vertex[0] + r * Math.cos(a0), vertex[1] + r * Math.sin(a0)];
      const pb = [vertex[0] + r * Math.cos(a1), vertex[1] + r * Math.sin(a1)];
      arrow(pa, [-Math.sin(a0), Math.cos(a0)]); arrow(pb, [Math.sin(a1), -Math.cos(a1)]);
      const midAngle = (a0 + a1) / 2;
      put({ type: 'text', at: [vertex[0] + (r + 4) * Math.cos(midAngle), vertex[1] + (r + 4) * Math.sin(midAngle)], text: textValue, height: 3.5, align: 'middle' });
    } else {
      const circle = view.entities.find(e => e.id === dim.circle);
      const center = toSheet(view, circle.center);
      const r = circle.r * view.scale;
      centerMark(center);
      const angle = 45 * Math.PI / 180;
      const u = [Math.cos(angle), Math.sin(angle)];
      const onCircle = [center[0] + u[0] * r, center[1] + u[1] * r];
      if (dim.kind === 'diameter') {
        const far = [center[0] - u[0] * r, center[1] - u[1] * r];
        put({ type: 'line', from: far, to: onCircle, width: 0.35 });
        arrow(far, u); arrow(onCircle, [-u[0], -u[1]]);
        put({ type: 'text', at: [center[0] - u[0] * 0, center[1] + 3.5 + 1.5], text: textValue, height: 3.5, align: 'middle' });
      } else {
        put({ type: 'line', from: center, to: onCircle, width: 0.35 });
        arrow(onCircle, u);
        put({ type: 'text', at: [onCircle[0] + u[0] * 2, onCircle[1] + u[1] * 2], text: textValue, height: 3.5, align: 'start' });
      }
    }
  }
  for (const datum of model.datums) {
    const view = model.views.find(v => v.id === datum.view);
    const at = toSheet(view, datum.at);
    if (datum.kind === 'plane') {
      put({ type: 'rect', from: [at[0] - 2.5, at[1] - 2.5], to: [at[0] + 2.5, at[1] + 2.5] });
    } else {
      put({ type: 'circle', center: at, r: 2.5 });
      centerMark(at);
    }
    put({ type: 'text', at: [at[0], at[1] - 0.9], text: datum.label, height: 3.5, align: 'middle' });
  }
  for (const control of model.controls) {
    const view = model.views.find(v => v.id === control.view);
    let local;
    if (control.anchor !== undefined) local = control.anchor;
    else {
      const entity = view.entities.find(e => e.id === control.target);
      if (entity && (entity.kind === 'circle' || entity.kind === 'arc')) local = [...entity.center];
      else {
        const dim = model.dimensions.find(d => d.id === control.target && d.view === view.id);
        if (dim && dim.kind === 'linear') local = [(dim.a[0] + dim.b[0]) / 2, (dim.a[1] + dim.b[1]) / 2];
        else if (dim && dim.kind === 'angle') local = [...dim.vertex];
        else fail('control ' + control.id + ': anchor required for this target kind');
      }
    }
    const at = [toSheet(view, local)[0] + 14, toSheet(view, local)[1] + 10];
    const symbol = { flatness: '⏥', position: '⌖', perpendicularity: '⟂', parallelism: '∥' }[control.kind];
    const boxes = [symbol, String(control.valueMm), (control.datums || []).join(' ')];
    const widths = boxes.map(box => box.length * 2.2 + 4);
    let x = at[0];
    for (let i = 0; i < boxes.length; i++) {
      put({ type: 'rect', from: [x, at[1] - 3.5], to: [x + widths[i], at[1] + 3.5] });
      put({ type: 'text', at: [x + widths[i] / 2, at[1] - 1.1], text: boxes[i], height: 3.5, align: 'middle' });
      x += widths[i];
    }
    put({ type: 'line', from: at, to: toSheet(view, local), width: 0.18 });
  }
  for (const balloon of model.balloons) {
    const view = model.views.find(v => v.id === balloon.view);
    const at = toSheet(view, balloon.at), anchor = toSheet(view, balloon.anchor);
    put({ type: 'circle', center: at, r: 3.5 });
    put({ type: 'line', from: at, to: anchor, width: 0.35 });
    put({ type: 'text', at: [at[0], at[1] - 1.1], text: String(balloon.item), height: 3.5, align: 'middle' });
  }
  for (const note of model.notes) put({ type: 'text', at: note.at, text: note.text, height: note.height, align: 'start' });
  for (const dim of model.dimensions) semantics.sourceMap.dimensions[dim.id] = dim.source;
  for (const item of model.items) semantics.sourceMap.items[String(item.item)] = item.source;
  for (const note of model.notes) semantics.sourceMap.notes[note.id] = note.source;
  semantics.items = model.items.map(item => ({ item: item.item, partId: item.partId, description: item.description, qty: item.qty, purchased: item.purchased, source: item.source }));
  semantics.balloons = model.balloons.map(b => ({ id: b.id, view: b.view, item: b.item }));
  semantics.dimensions = model.dimensions.map(d => ({ id: d.id, view: d.view, kind: d.kind, valueMm: d.valueMm, toleranceMm: d.toleranceMm, source: d.source }));
  const [w, h] = model.sheet.sizeMm;
  put({ type: 'rect', from: [w - 120, 6], to: [w - 6, 40] });
  put({ type: 'line', from: [w - 120, 28], to: [w - 6, 28], width: 0.35 });
  put({ type: 'line', from: [w - 70, 28], to: [w - 70, 40], width: 0.35 });
  put({ type: 'text', at: [w - 116, 32], text: model.documentIdentity.name, height: 3.5, align: 'start' });
  put({ type: 'text', at: [w - 116, 14], text: (model.sheet.titleBlock.drawingNumber || '') + '  REV ' + (model.documentIdentity.revision || '-'), height: 3, align: 'start' });
  put({ type: 'text', at: [w - 66, 32], text: model.sheet.titleBlock.scale || '', height: 3, align: 'start' });
  put({ type: 'text', at: [w - 116, 22], text: model.sheet.titleBlock.date || '', height: 3, align: 'start' });
  const statuses = collectSources(model);
  const confirmed = statuses.filter(s => s.status === 'CONFIRMED').length;
  put({ type: 'text', at: [6, 6], text: 'fmcad drawing package v1 - provenance: ' + confirmed + ' CONFIRMED, ' + (statuses.length - confirmed) + ' non-confirmed sources; full map in report.json sourceMap', height: 2.5, align: 'start' });
  return { schemaVersion: 1, sheet: { sizeMm: model.sheet.sizeMm }, primitives, semantics };
}

function outputDirectory(value) {
  const dir = path.resolve(text(value, 'out'));
  if (fs.existsSync(dir) || !fs.existsSync(path.dirname(dir))) fail('out must be NEW with existing parent');
  return dir;
}

function envelope(operation, result, status, warnings, provenance, created) {
  return { schemaVersion: 1, success: !['fail', 'blocked'].includes(status), status, operation,
    documentIdentity: result.documentIdentity || null, result, created, affected: [],
    units: { length: 'mm', angle: 'rad' }, frame: 'sheet', associativity: 'snapshot',
    warnings, provenance, method: 'Semantic external drawing artifacts (SVG/PDF/DXF) with item table, balloons and source map; no native Fusion drawing.',
    limitations: ['External artifact generation only; no native Fusion Drawing authoring, associativity or screenshot substitution.',
      'GD&T supported range: datum plane/axis features and flatness, position, perpendicularity, parallelism frames; other controls are rejected, never approximated.',
      'ESTIMATED/OPEN/DERIVED values cannot become production tolerances; OPEN sources block the package.',
      'Geometry checks are 2D sheet-space comparisons of declared entities; no 3D model verification. See docs/DRAWING.md for the manual native workflow.'],
    nativeAcceptance: 'notEvaluated' };
}

function execute(operation, data) {
  validate(operation, data);
  const out = outputDirectory(data.out);
  if (data.representation === 'native') {
    return envelope(OPERATION, { documentIdentity: data.documentIdentity, reason: 'native drawing authoring is not available through the public SDK; no silent replacement.',
      workflow: 'See docs/DRAWING.md native handoff: create the native drawing in Fusion UI, then compare it against this package report.', }, 'blocked', [], [], []);
  }
  if (data.representation !== undefined && data.representation !== 'external') fail('representation must be external or native');
  const model = buildModel(data);
  const rows = checkRows(model);
  const sources = collectSources(model);
  const status = aggregateStatus(rows, sources);
  const warnings = [];
  for (const item of model.items) if (!model.balloons.some(b => b.item === item.item)) warnings.push('Item ' + item.item + ' has no balloon in any view');
  const scene = buildScene(model);
  const sceneJson = JSON.stringify(scene, null, 2);
  fs.mkdirSync(out, { recursive: false });
  try {
    fs.writeFileSync(path.join(out, 'scene.json'), sceneJson, { flag: 'wx' });
  } catch (error) { fs.rmSync(out, { recursive: true, force: true }); throw error; }
  const report = envelope(OPERATION, {
    schemaVersion: 1, documentIdentity: model.documentIdentity, sheet: model.sheet,
    views: model.views, dimensions: model.dimensions, datums: model.datums, controls: model.controls,
    notes: model.notes, items: model.items, balloons: model.balloons, fits: model.fits,
    axisToleranceMm: model.axisToleranceMm, checks: rows, statusSummary: status,
    sourceMap: scene.semantics.sourceMap,
    scene: { path: path.join(out, 'scene.json'), sha256: digest(sceneJson) },
    artifacts: { status: 'pending', instruction: 'Run drawing export --file {"package":"<report.json>","formats":["svg","pdf","dxf"],"out":"<dir>"}' },
    nativeDrawing: { status: 'blocked', reason: 'SDK gate; external representation was requested or defaulted.', manualWorkflow: 'docs/DRAWING.md' },
  }, status, warnings, sources, [path.join(out, 'scene.json'), path.join(out, 'report.json')]);
  const reportJson = JSON.stringify(report, null, 2);
  try { fs.writeFileSync(path.join(out, 'report.json'), reportJson, { flag: 'wx' }); }
  catch (error) { fs.rmSync(out, { recursive: true, force: true }); throw error; }
  return { ...report, reportPath: path.join(out, 'report.json') };
}

function readPackage(filename, expected) {
  const resolved = path.resolve(text(filename, 'package'));
  const raw = fs.readFileSync(resolved);
  const report = JSON.parse(raw);
  if (report.schemaVersion !== 1 || report.operation !== expected) fail('Wrong drawing report kind/version');
  const sceneRaw = fs.readFileSync(report.result.scene.path);
  if (digest(sceneRaw) !== report.result.scene.sha256) fail('Stale drawing scene: sha256 mismatch');
  const scene = JSON.parse(sceneRaw);
  return { report, identity: { path: resolved, sha256: digest(raw) }, scene };
}

const inputs = {
  package: {
    schemaVersion: 'Required 1.',
    representation: 'Optional external (default) or native. native is blocked with the manual workflow; never silently replaced by external artifacts.',
    documentIdentity: 'Required {name, revision?}: declared model/revision identity of the drawing package.',
    sheet: 'Required {format:A0-A4|LETTER|custom, orientation?:landscape|portrait (default landscape), custom?:[w,h], titleBlock?:{drawingNumber?,author?,date?,scale?}}.',
    views: 'Required nonempty [{id,kind:projection|section|detail,orientation?(projection),parent?(section/detail; listed earlier),cutFrom/cutTo?(section, parent-local),detailFrom/detailRadius?(detail, parent-local),scale?,origin:[sheet mm],geometry:[entities]}]. Entities: line{from,to}, circle{center,r}, arc{center,r,startDeg,sweepDeg}, polyline{points,closed?}, hatch{boundary,spacing,angleDeg?}, text{at,text,height}; optional ids. View-local mm.',
    dimensions: 'Optional [{id,view,kind:linear|radius|diameter|angle, points as [x,y] or {entity,role,index?}, value unit expression (optional for radius/diameter), offset?(linear), tolerance?:{upper,lower} (CONFIRMED source only), source:{path,status}}].',
    datums: 'Optional [{id,view,kind:plane|axis,at,label?,direction? (plane),source}].',
    controls: 'Optional GD&T frames [{id,view,kind:flatness|position|parallelism|perpendicularity,target,value,datums? (required except flatness),anchor?,source}].',
    notes: 'Optional [{id,text,kind:material|process|general|finish,at:[sheet mm],height?,source}].',
    items: 'Optional item table [{item,qty,partId,description,purchased?,source}].',
    balloons: 'Optional [{id,view,item,at,anchor}]; unique balloon ids and one balloon per item per view.',
    fits: 'Optional axis/hole pairs [{id,view,shaft,bore,clearance:{min,max,source}}]; both circles in the same view.',
    axisTolerance: 'Optional concentricity length, default 0.05 mm.',
    out: 'NEW output directory with existing parent.',
  },
  check: { schemaVersion: 'Required 1.', package: 'Existing drawing.package report.json; identity and scene hashes are rechecked.', out: 'NEW output directory with existing parent.' },
  export: { schemaVersion: 'Required 1.', package: 'Existing drawing.package report.json; identity and scene hashes are rechecked.', formats: 'Nonempty unique subset of [svg, pdf, dxf].', out: 'NEW output directory with existing parent.' },
};

const packageExample = {
  schemaVersion: 1,
  documentIdentity: { name: 'Seal Subassembly', revision: 'A' },
  sheet: { format: 'A3', titleBlock: { drawingNumber: 'CW-100', scale: '1:1' } },
  views: [{ id: 'front', kind: 'projection', orientation: 'front', scale: 1, origin: [40, 40],
    geometry: [
      { id: 'plate', kind: 'polyline', points: [[0, 0], [60, 0], [60, 40], [0, 40]], closed: true },
      { id: 'bore', kind: 'circle', center: [30, 20], r: 5 },
      { id: 'shaft', kind: 'circle', center: [30, 20], r: 3 },
    ] }],
  dimensions: [
    { id: 'width', view: 'front', kind: 'linear', a: [0, 0], b: [60, 0], offset: -10, value: '60 mm', tolerance: { upper: '0.1 mm', lower: '-0.1 mm' }, source: { path: 'specs/seal.json', status: 'CONFIRMED' } },
    { id: 'bore-dia', view: 'front', kind: 'diameter', circle: 'bore', value: '10 mm', source: { path: 'specs/seal.json', status: 'CONFIRMED' } },
  ],
  items: [{ item: 1, partId: 'P020', description: 'Housing', qty: 1, source: { path: 'BOM.csv', status: 'CONFIRMED' } }],
  balloons: [{ id: 'b1', view: 'front', item: 1, at: [70, 55], anchor: { entity: 'plate', role: 'vertex', index: 2 } }],
  fits: [{ id: 'seal-fit', view: 'front', shaft: 'shaft', bore: 'bore', clearance: { min: '1.9 mm', max: '2.1 mm', source: { path: 'tolerance-strategy.md', status: 'CONFIRMED' } } }],
  out: 'drawing-output',
};

const familyDescriptors = Object.fromEntries(Object.entries(inputs).map(([mode, fields]) => ['drawing.' + mode, {
  summary: `GM35 local drawing ${mode}; external SVG/PDF/DXF artifacts with semantic dimensions, item table, balloons and source map. No Fusion/backend.`,
  required: Object.keys(fields).filter(key => !['representation', 'dimensions', 'datums', 'controls', 'notes', 'items', 'balloons', 'fits', 'axisTolerance'].includes(key)),
  inputs: fields, readOnly: true, offline: true, nodeOnly: true, requiresDoc: false,
  usage: `drawing ${mode} --file request.json [--json]`,
  example: mode === 'package' ? packageExample : mode === 'check' ? { schemaVersion: 1, package: 'drawing-output/report.json', out: 'check-output' } : { schemaVersion: 1, package: 'drawing-output/report.json', formats: ['svg', 'pdf', 'dxf'], out: 'export-output' },
  limitations: ['No native Fusion Drawing authoring or associativity; the native gate stays blocked and documented in docs/DRAWING.md.', 'GD&T supported range is datum features plus flatness/position/parallelism/perpendicularity; other controls are rejected.', 'ESTIMATED sources never become production tolerances; OPEN sources block the package. Artifacts are 2D sheet evidence, not 3D model certification.'],
}]));

const descriptors = { 'drawing.package': familyDescriptors['drawing.package'] };

function validate(operation, data) {
  if (!descriptors[operation]) return;
  if (data.schemaVersion !== 1) fail(operation + ' schemaVersion must be 1');
  const required = operation === 'drawing.package' ? ['documentIdentity', 'sheet', 'views', 'out'] : operation === 'drawing.check' ? ['package', 'out'] : ['package', 'formats', 'out'];
  for (const key of required) if (!Object.hasOwn(data, key)) fail(operation + ' requires ' + key);
}

const manuals = Object.fromEntries(Object.entries(familyDescriptors).map(([operation, spec]) => [operation, {
  sections: [{ title: 'Local Return Contract', text: 'Versioned GM35 envelope: success/status/operation/documentIdentity/result/created/affected/units/frame/associativity:snapshot/warnings/provenance/method/limitations/nativeAcceptance:notEvaluated. pass means all declared checks passed with only CONFIRMED sources; unknown means unresolved evidence; blocked means OPEN sources or a native request; fail means a violated check. Only fail/blocked exits nonzero.' },
    { title: 'Geometry And Source Contract', text: 'View-local geometry is declared in mm; sheet placement is view.origin + geometry * view.scale. Dimensions resolve endpoints from coordinates or entity references (circle center, arc center/start/end, line start/end, polyline vertex). Item table entries carry qty/partId/description/purchased and a source with CONFIRMED/ESTIMATED/OPEN/DERIVED status. Balloons must be unique per item per view and always reference an item. ESTIMATED/DERIVED values cannot carry production tolerances; OPEN sources block. See docs/DRAWING.md.' },
    { title: 'Native Drawing Gate', text: 'Native Drawing authoring is blocked: no public SDK path is claimed. The external SVG/PDF/DXF package is the explicit alternative; the report documents the manual native workflow. Nothing is ever silently replaced by a screenshot or a static render.' }],
  examples: [{ label: operation + ' local request', requires: 'A new output directory parent and, for check/export, an existing drawing.package report. Example paths/values are placeholders.', data: spec.example, output: 'Full report.json plus scene.json (package), checks (check), or sheet.svg/sheet.pdf/sheet.dxf with a manifest (export).' }],
  audit: { sources: ['src/drawing-package.js', 'src/drawing-check.js', 'src/drawing-export.js', 'docs/DRAWING.md'],
    verified: ['External SVG/PDF/DXF emission with dimensions, balloons and item table', 'balloon-to-BOM uniqueness, fit and dimension-vs-geometry checks', 'source status policy (ESTIMATED never a tolerance, OPEN blocks)', 'offline routing without backend'],
    tests: ['tests/drawing.test.js', 'tests/drawing_test.py'], gaps: [],
    bugs: ['Native Fusion drawing authoring is an open SDK gate. Text metrics for PDF centering use Helvetica approximations. DXF R12 carries no units or line types; source maps live in report.json and DXF comments.'] },
}]));

module.exports = { descriptors, familyDescriptors, validate, execute, manuals, OPERATION, SHEET, FORMATS, SOURCE_STATUSES,
  fail, text, safeId, number, quantity, length, angleRad, point, source, digest, arcEndpoints,
  resolvePoint, measureDimension, dimensionStatus, fitStatus, collectSources, checkRows, aggregateStatus,
  buildScene, envelope, outputDirectory, readPackage };

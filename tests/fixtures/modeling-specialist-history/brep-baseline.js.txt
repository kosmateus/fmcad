'use strict';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  return value;
}
function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.join(',') !== expected.join(',')) throw new Error(label + ' fields must be exactly ' + expected.join(', '));
}
function ref(value, label, kind = 'body') {
  if (typeof value === 'string' && value.trim()) return;
  const input = record(value, label);
  const allowed = ['token', 'kind', 'name', 'component', 'occurrence', 'path', 'sketch', 'index', 'loopCount'];
  if (Object.keys(input).some(key => !allowed.includes(key)) ||
      (typeof input.token !== 'string' && typeof input.name !== 'string') ||
      (input.token !== undefined && !input.token) || (input.name !== undefined && !input.name) ||
      (input.kind !== undefined && input.kind !== kind)) throw new Error(label + ' must be a ' + kind + ' reference');
}
function baselineReference(value) {
  const input = record(value, 'baseline');
  exactKeys(input, ['version', 'scope', 'owner', 'id', 'sha256'], 'baseline');
  if (input.version !== 1 || input.scope !== 'durable' || !/^[a-f0-9]{64}$/.test(input.owner) ||
      !/^[A-Za-z0-9_-]+$/.test(input.id) || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new Error('baseline must be an opaque version-1 durable artifact reference');
  }
}
function bodies(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) throw new Error('bodies must contain 1..1000 entries');
  const roles = new Set();
  for (const item of value) {
    const row = record(item, 'body entry');
    exactKeys(row, ['role', 'body'], 'body entry');
    if (!identifier(row.role) || roles.has(row.role)) throw new Error('body roles must be unique identifiers');
    roles.add(row.role);
    ref(row.body, 'body');
  }
}
function budget(value) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 300000)) {
    throw new Error('workBudgetMs must be an integer from 1 to 300000');
  }
}
function validate(operation, data) {
  if (!operation.startsWith('measure.baseline.')) return;
  if (operation.endsWith('_internal')) {
    const binding = record(data._trustedBinding, '_trustedBinding');
    if (binding.version !== 1 || typeof binding.session !== 'string' ||
        !Array.isArray(binding.stagePaths) || !binding.stagePaths.length ||
        binding.stagePaths.some(value => typeof value !== 'string' || !value.endsWith('.smt')) ||
        new Set(binding.stagePaths).size !== binding.stagePaths.length ||
        !Number.isSafeInteger(binding.maxBytes) || binding.maxBytes < 1 ||
        !Number.isSafeInteger(binding.workBudgetMs) || binding.workBudgetMs < 1 || binding.workBudgetMs > 300000) {
      throw new Error('Invalid broker-owned BRep baseline staging capability');
    }
    if (operation.endsWith('capture_internal')) {
      bodies(data.bodies);
      if (data.scope !== 'durable') throw new Error('Internal capture scope must be durable');
      if (binding.stagePaths.length !== data.bodies.length) throw new Error('Internal capture stage count mismatch');
    } else {
      baselineReference(data.baseline);
      bodies(data.bodies);
      const tolerances = record(data.tolerances, 'tolerances');
      exactKeys(tolerances, ['volume', 'length', 'angle'], 'tolerances');
      if (Object.values(tolerances).some(value => typeof value !== 'string' || !value.trim())) {
        throw new Error('tolerances must contain explicit dimensional expressions');
      }
      const manifest = record(binding.manifest, 'trusted baseline manifest');
      if (manifest.version !== 1 || manifest.scope !== 'durable' ||
          !Array.isArray(manifest.bodies) || manifest.bodies.length !== binding.stagePaths.length) {
        throw new Error('Invalid broker-verified exact baseline manifest');
      }
    }
    return;
  }
  budget(data.workBudgetMs);
  if (operation === 'measure.baseline.capture') {
    bodies(data.bodies);
    if (data.scope !== 'durable') throw new Error('scope must be durable');
    if (!(typeof data.frame === 'string' && ['assembly', 'component local'].includes(data.frame)) &&
        !(data.frame && typeof data.frame === 'object' && !Array.isArray(data.frame) &&
          Object.keys(data.frame).sort().join(',') === 'component,space' &&
          ['assembly', 'component local'].includes(data.frame.space) && data.frame.component !== undefined)) {
      throw new Error('frame must explicitly identify assembly or component local coordinates');
    }
    if (data.frame && typeof data.frame === 'object') ref(data.frame.component, 'frame.component', 'component');
  } else if (operation === 'measure.baseline.inspect') baselineReference(data.baseline);
  else {
    baselineReference(data.baseline);
    bodies(data.bodies);
    const tolerances = record(data.tolerances, 'tolerances');
    exactKeys(tolerances, ['volume', 'length', 'angle'], 'tolerances');
    if (Object.values(tolerances).some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('tolerances must contain explicit dimensional expressions');
    }
  }
}

module.exports = { validate, baselineReference, bodies };

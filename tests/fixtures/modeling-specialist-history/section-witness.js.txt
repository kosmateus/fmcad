'use strict';

const operations = new Set(['measure.section-series', 'measure.witness-check']);
const refFields = new Set(['token', 'kind', 'name', 'component', 'occurrence', 'path']);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  return value;
}

function exactKeys(value, allowed, required, label) {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new Error(label + ' has missing or unsupported fields');
  }
}

function reference(value, label, kind) {
  if (typeof value === 'string' && value.trim()) return;
  const input = record(value, label);
  if (Object.keys(input).some(key => !refFields.has(key)) ||
      (typeof input.token !== 'string' && typeof input.name !== 'string') ||
      (input.token !== undefined && input.token !== null && (typeof input.token !== 'string' || !input.token)) ||
      (input.name !== undefined && (typeof input.name !== 'string' || !input.name)) ||
      (input.kind !== undefined && input.kind !== kind)) {
    throw new Error(label + ' must be an explicit ' + kind + ' reference');
  }
}

function frame(value) {
  const input = record(value, 'frame');
  exactKeys(input, ['space', 'component'], ['space', 'component'], 'frame');
  if (!['assembly', 'component local'].includes(input.space)) throw new Error('frame.space must be assembly or component local');
  reference(input.component, 'frame.component', 'component');
}

function limits(value, section) {
  if (value === undefined) return;
  const input = record(value, 'limits');
  const maxima = section
    ? { stations: 256, edges: 16384, kernelCalls: 4096, bytes: 4194304, timeMs: 120000 }
    : { kernelCalls: 4096, bytes: 4194304, timeMs: 120000 };
  exactKeys(input, Object.keys(maxima), [], 'limits');
  for (const [key, maximum] of Object.entries(maxima)) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > maximum)) {
      throw new Error('limits.' + key + ' must be an integer from 1 to ' + maximum);
    }
  }
}

function dimensionalExpression(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be an explicit dimensional expression');
}

function validate(operation, data) {
  if (!operations.has(operation)) return;
  const section = operation === 'measure.section-series';
  const required = section
    ? ['body', 'frame', 'origin', 'normal', 'stations']
    : ['body', 'witness', 'frame', 'expect', 'volumeTolerance'];
  exactKeys(data, [...required, 'limits'], required, operation);
  reference(data.body, 'body', 'body');
  frame(data.frame);
  limits(data.limits, section);
  if (section) {
    if (!Array.isArray(data.origin) || data.origin.length !== 3) throw new Error('origin must contain three length expressions');
    data.origin.forEach((value, index) => dimensionalExpression(value, 'origin[' + index + ']'));
    if (!Array.isArray(data.normal) || data.normal.length !== 3 || data.normal.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('normal must contain three finite unitless numbers');
    }
    const magnitude = Math.hypot(...data.normal);
    if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error('normal must have finite nonzero magnitude');
    const maximum = data.limits?.stations ?? 64;
    if (!Array.isArray(data.stations) || data.stations.length < 1 || data.stations.length > maximum) {
      throw new Error('stations must be a nonempty array within the station limit');
    }
    data.stations.forEach((value, index) => dimensionalExpression(value, 'stations[' + index + ']'));
  } else {
    reference(data.witness, 'witness', 'body');
    if (!['material', 'void'].includes(data.expect)) throw new Error('expect must be material or void');
    dimensionalExpression(data.volumeTolerance, 'volumeTolerance');
  }
}

module.exports = { validate };

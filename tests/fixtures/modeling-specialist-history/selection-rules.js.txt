'use strict';

const RULE_OPERATIONS = new Set([
  'selection.rule.define',
  'selection.rule.inspect',
  'selection.rule.resolve',
  'selection.rule.check',
]);
const REFERENCE_KEYS = [
  'artifactId', 'documentCreationId', 'documentFileId', 'projectId', 'sha256', 'version',
];
const QUERY_FIELDS = new Set([
  'schemaVersion', 'kind', 'component', 'occurrence', 'scope', 'instances',
  'frame', 'filters', 'expect', 'groupBy',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(label + ' must be an object');
  return value;
}

function exactKeys(value, required, optional, label) {
  const keys = Object.keys(value);
  const unknown = keys.filter(key => !required.includes(key) && !optional.includes(key));
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (unknown.length || missing.length)
    throw new Error(label + ' has missing fields [' + missing.join(', ') + '] or unknown fields [' + unknown.join(', ') + ']');
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(label + ' must be a nonnegative integer');
}

function cardinality(value) {
  if (Number.isSafeInteger(value)) {
    count(value, 'query.expect');
    return;
  }
  const interval = record(value, 'query.expect');
  exactKeys(interval, [], ['min', 'max'], 'query.expect');
  if (!Object.keys(interval).length) throw new Error('query.expect requires min or max');
  if (Object.hasOwn(interval, 'min')) count(interval.min, 'query.expect.min');
  if (Object.hasOwn(interval, 'max')) count(interval.max, 'query.expect.max');
  if (interval.min !== undefined && interval.max !== undefined && interval.min > interval.max)
    throw new Error('query.expect min exceeds max');
}

function definition(data) {
  record(data, 'selection rule definition');
  exactKeys(data, ['ruleId', 'query'], ['schemaVersion', 'exclude'], 'selection rule definition');
  if (data.schemaVersion !== undefined && data.schemaVersion !== 1)
    throw new Error('schemaVersion must be 1');
  if (typeof data.ruleId !== 'string' || !data.ruleId.trim() || data.ruleId !== data.ruleId.trim() ||
      data.ruleId.length > 128 || /[\x00-\x1f\x7f-\x9f]/u.test(data.ruleId)) {
    throw new Error('ruleId must be nonempty printable text of at most 128 characters');
  }
  const query = record(data.query, 'query');
  if (Object.keys(query).some(key => !QUERY_FIELDS.has(key))) throw new Error('query contains unsupported fields');
  if (query.schemaVersion !== undefined && query.schemaVersion !== 1) throw new Error('query.schemaVersion must be 1');
  if (typeof query.kind !== 'string' || !query.kind || !Object.hasOwn(query, 'expect'))
    throw new Error('query requires kind and explicit expected cardinality');
  cardinality(query.expect);
  if (Object.hasOwn(query, 'instances') && typeof query.instances !== 'boolean')
    throw new Error('query.instances must be boolean');
  if (Object.hasOwn(query, 'unique')) throw new Error('selection rules require explicit expected cardinality');
  const queryScope = record(query.scope ?? {}, 'query.scope');
  exactKeys(queryScope, [], ['component', 'occurrence', 'body', 'feature'], 'query.scope');
  if (Object.hasOwn(query, 'scope') &&
      (Object.hasOwn(query, 'component') || Object.hasOwn(query, 'occurrence')))
    throw new Error('query.scope cannot be combined with top-level component/occurrence');
  if (Object.hasOwn(queryScope, 'body') && Object.hasOwn(queryScope, 'feature'))
    throw new Error('query.scope body and feature are exclusive');
  const hasScope = ['component', 'occurrence'].some(key => Object.hasOwn(query, key) && query[key] !== null) ||
    query.instances === true || ['component', 'occurrence', 'body', 'feature'].some(key => Object.hasOwn(queryScope, key) && queryScope[key] !== null);
  if (!hasScope)
    throw new Error('query requires explicit component, occurrence, body, feature, or instances:true scope');
  if (data.exclude !== undefined && (!Array.isArray(data.exclude) || data.exclude.length > 64 ||
      data.exclude.some(filters => !filters || typeof filters !== 'object' || Array.isArray(filters)))) {
    throw new Error('exclude must be an array of at most 64 filter objects');
  }
}

function artifactReference(value) {
  const reference = record(value, 'selection rule artifact');
  if (Object.keys(reference).sort().join(',') !== REFERENCE_KEYS.join(',') ||
      reference.version !== 1 || typeof reference.artifactId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,256}$/u.test(reference.artifactId) ||
      typeof reference.projectId !== 'string' || !reference.projectId ||
      typeof reference.documentFileId !== 'string' || !reference.documentFileId ||
      (reference.documentCreationId !== null && typeof reference.documentCreationId !== 'string') ||
      typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.sha256)) {
    throw new Error('artifact must be an exact version-1 project/document-owned selection rule reference');
  }
}

function validate(operation, data) {
  if (!RULE_OPERATIONS.has(operation)) return;
  if (operation === 'selection.rule.define') return definition(data);
  const input = record(data, operation);
  exactKeys(input, ['artifact'], [], operation);
  artifactReference(input.artifact);
}

module.exports = { RULE_OPERATIONS, artifactReference, definition, validate };

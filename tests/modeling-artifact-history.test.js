'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const fixtures = path.join(__dirname, 'fixtures/modeling-history');
const manifest = require('./fixtures/modeling-history/services-manifest.json');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function load(file, overrides, expectedHash) {
  const source = fs.readFileSync(file, 'utf8');
  if (expectedHash) assert.equal(createHash('sha256').update(source).digest('hex'), expectedHash);
  const realRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, process,
    require(name) { return overrides(name) ?? realRequire(name); },
  }, { filename: file });
  return module.exports;
}
const owner = { projectId: 'project-A', documentFileId: 'file-A', documentCreationId: 'creation-A' };
const context = { projectId: 'project-A', docFileId: 'file-A', docId: 'creation-A', purpose: 'parity' };
const reference = { ...owner, artifactId: 'rule-A', hash: 'hash-A' };
const saved = { owner, revision: 1, rule: { id: 'outer-face' }, count: 1 };
async function selection(historical, scenario) {
  const events = [];
  let uuid = 0;
  const authorize = (op, payload) => events.push(['authorize', op, clone(payload)]);
  const artifact = {
    async read(ctx, ref) { events.push(['read', clone(ctx), clone(ref)]); return scenario.missing ? null : clone(saved); },
    async write(ctx, value) { events.push(['write', clone(ctx), clone(value)]); return { ...reference, hash: 'hash-B' }; },
  };
  const overrides = name => {
    if (name === 'node:crypto') return { randomUUID: () => 'uuid-' + ++uuid };
    if (name === 'node:fs') return { realpathSync: p => { events.push(['realpath', p]); return p; } };
    if (name.endsWith('/domain/contracts')) return { id: (_kind, value) => value };
    if (name.endsWith('/artifact-store')) return { createArtifactStore: p => { events.push(['store', p]); return {}; } };
    if (name.endsWith('/selection-rules')) return { createSelectionRuleArtifactClient: () => artifact, validateReference: value => value };
    if (name.endsWith('/owned-results') || name === './queue-response-files') return { projectDirectory: p => p };
    if (name === './catalog') return { selectionRulesInternal: { authorize } };
    return undefined;
  };
  const entry = manifest['selection-rules'];
  const api = historical
    ? load(path.join(fixtures, entry.fixture), overrides, entry.sha256)
    : load(path.join(__dirname, '../src/dist/node-adapters/persistence/selection-service.js'), overrides);
  const execute = historical ? api.execute : api.createSelectionExecutor(authorize);
  const operation = scenario.operation || 'selection.rule.resolve';
  const input = operation === 'selection.rule.define' ? { ruleId: 'outer-face' } : { artifact: clone(reference) };
  const target = { ...context, ...scenario.context };
  const native = async (op, payload, ctx) => {
    events.push(['native', op, clone(payload), clone(ctx)]);
    if (scenario.throwNative) throw new Error('uncertain native outcome');
    const next = { ...saved, revision: scenario.changed ? 2 : 1 };
    const result = { success: true, operation, status: scenario.status || 'resolved', manifest: next, count: 1, refs: ['face-A'] };
    return scenario.unwrapped ? result : { result };
  };
  let output;
  try { output = { value: clone(await execute(scenario.unavailable ? null : {}, operation, input, target, { projectDirectory: '/owned', executeNative: native })) }; }
  catch (error) { output = { error: error.message }; }
  return { output, events, input, target };
}
for (const scenario of [
  { operation: 'selection.rule.define' },
  { operation: 'selection.rule.inspect', changed: true },
  { operation: 'selection.rule.resolve' },
  { operation: 'selection.rule.resolve', changed: true },
  { operation: 'selection.rule.check', changed: true },
  { changed: true, status: 'ambiguous' }, { missing: true }, { throwNative: true },
  { unwrapped: true }, { unavailable: true }, { operation: 'unknown' },
  { context: { projectId: 'foreign' } }, { context: { docId: 'foreign' } },
  { context: { docFileId: 'foreign' } }, { context: { docFileId: null } },
  { context: { docFileId: null, docId: null } },
]) {
  test('selection service matches historical effects: ' + JSON.stringify(scenario), async () => {
    const before = await selection(true, scenario);
    const after = await selection(false, scenario);
    assert.deepEqual(after, before);
    assert.ok(after.events.filter(event => event[0] === 'native').length <= 1);
    if (scenario.missing || scenario.context || scenario.unavailable || scenario.operation === 'unknown')
      assert.equal(after.events.filter(event => event[0] === 'native').length, 0);
    if (scenario.operation === 'selection.rule.inspect' || scenario.throwNative)
      assert.equal(after.events.filter(event => event[0] === 'write').length, 0);
  });
}
async function brep(historical, operation, target, client) {
  const events = [];
  const authorize = payload => events.push(['authorize', clone(payload)]);
  const overrides = name => {
    if (name === 'node:crypto') return { randomUUID: () => 'session-A' };
    if (name === 'node:fs') return { realpathSync: p => { events.push(['realpath', p]); return p; } };
    if (name.includes('/application/cad/brep-baseline')) return { createBrepBaselineService: ports => ({
      async execute(op, data, context) {
        events.push(['execute', op, data, context, ports.newSession()]);
        ports.stage(2);
        return ports.executeNative('capture', { owned: true }, context);
      },
    }) };
    if (name.endsWith('/persistence/brep-baseline') || name === './brep-baseline') return {
      brepBaselineArtifacts: p => { events.push(['artifacts', p]); return {}; },
      createBrepBaselineStage: (p, count, convert) => { events.push(['stage', p, count, convert('part')]); return {}; },
    };
    if (name === './queue-response-files' || name === './owned-results') return { projectDirectory: p => p };
    if (name === './catalog/brep-baseline-internal') return { authorize };
    return undefined;
  };
  const entry = manifest['brep-baseline'];
  const api = historical ? load(path.join(fixtures, entry.fixture), overrides, entry.sha256)
    : load(path.join(__dirname, '../src/dist/node-adapters/persistence/brep-baseline-service.js'), overrides);
  const execute = historical ? api.execute : api.createBrepExecutor(authorize);
  let output;
  try { output = await execute(client, operation, { bodies: ['body-A'] }, target, {
    projectDirectory: '/owned', toFusionPath: p => 'fusion:' + p,
    executeNative: async (...args) => { events.push(['native', ...args]); return { success: true }; },
  }); } catch (error) { output = { error: error.message }; }
  return clone({ output, events });
}
for (const op of ['measure.baseline.capture', 'measure.baseline.inspect', 'measure.baseline.compare', 'unknown']) {
  for (const pinned of [true, false]) {
    test(`BRep composition matches historical effects: ${op}, pinned=${pinned}`, async () => {
      const target = pinned ? context : {};
      assert.deepEqual(await brep(false, op, target, pinned ? {} : null), await brep(true, op, target, pinned ? {} : null));
    });
  }
}

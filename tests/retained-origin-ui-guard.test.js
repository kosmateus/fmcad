'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runtime = path.resolve(__dirname, '../dist');
test('real add-in UI guard: legacy source rejects the same final bytes, verified retained-span offset passes all aggregate groups', { timeout: 150000 }, async t => {
  const temporary = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'retained-origin-offset-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const py = require(runtime + '/src/python'), api = require(runtime + '/src/queue-instance');
  const artifact = require(runtime + '/src/cad').prepareCadScript('sketch.create', { name: 'RegressionSection', plane: 'XY' },
    { doc: 'QUALIFIED_OFFLINE_FIXTURE', docId: 'not-an-actual-live-document', preview: false });
  const physical = require(runtime + '/src/dist/fusion-transport/broker').createBrokerTransport({
    backend: 'addin', url: 'http://NEVER-SEND.invalid', timeoutMs: 180000,
  }, { version: 'offline-regression', requestTimeout: s => s.timeoutMs, bridgeSource: () => assert.fail('No generic bridge') });
  physical._post = () => assert.fail('NO HTTP OR SDK PORT in this test');
  let prepared;
  physical.preparePost = async (payload, origin) => {
    const code = payload.params.arguments.code;
    assert.ok(code.includes('FMCAD_UI_GUARD'), 'Actual real add-in transformation must be present');
    const final = py.retainPythonOrigin(api.prepareReceiptScript(code, false, path.join(temporary, 'never-sent.json'), {
      jobId: 'offline', rpcId: 'offline', sourceHash: api.hash(code), requestHash: api.hash(JSON.stringify(payload)), buildHash: 'offline',
    }, { mapPath: file => file }), origin);
    prepared = { payload: { ...payload, params: { ...payload.params, arguments: { ...payload.params.arguments, code: final.script } } }, artifact: final };
    return { fence() {}, send() { assert.fail('No send'); } };
  };
  await physical.prepareCallTool({ featureType: 'script', object: { script: artifact.script } }, 'fusion_mcp_execute', py.pythonArtifactManifest(artifact));
  const basedpyright = path.dirname(require.resolve('basedpyright/package.json'));
  const typingRoot = path.join(runtime, 'runtime/python/typing');
  const make = factory => py.createPythonRpcAdmission({ runtime: path.join(runtime, 'runtime/python'),
    checker: factory({ typingRoot, definitionsRoot: typingRoot, pythonPlatform: 'Windows',
      checkerResources: () => py.pythonAdmissionResources([basedpyright]) }),
    resources: () => py.pythonAdmissionResources([typingRoot, basedpyright]),
  });
  const oldFactory = require('./fixtures/historical-module.cjs')('f7082569f9ac8c321e704175cccc6781275a0d0e',
    'packages/node-adapters/src/python/checker.ts', 'src/dist/python/checker.js').createPythonChecker;
  const old = make(oldFactory);
  await assert.rejects(old.check(prepared.payload, prepared.artifact), error =>
    error.pythonCheck?.status === 'tool_error' && error.pythonCheck.reasons.includes('Aggregate checker completed 1 of 5 required analyses'));
  const fixed = make(py.createPythonChecker);
  const certificate = await fixed.check(prepared.payload, prepared.artifact);
  assert.equal(certificate.report.status, 'passed'); assert.equal(certificate.report.provenance.checker, 'basedpyright');
  certificate.fence(prepared.payload);
  const altered = structuredClone(prepared.payload); altered.params.arguments.code += '\n# unapproved bytes';
  assert.throws(() => certificate.fence(altered));
  const forged = structuredClone(prepared.artifact); forged.context.origin.segments[0].startLine++;
  await assert.rejects(fixed.check(prepared.payload, forged));
  assert.equal(fs.existsSync(path.join(temporary, 'never-sent.json')), false);
});

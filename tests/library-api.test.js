'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const config = { backend: 'addin', url: 'http://localhost:1/mcp', headers: {}, timeoutMs: 1000,
  tool: 'execute_python', transport: 'node', protocolVersion: '2025-06-18', routing: 'queue',
  queue: { autoStart: true }, controlCenter: { port: 4748 } };
const options = { version: 1, config, context: { clientId: 'library-test', instanceId: 'instance-test',
  source: 'system', projectDirectory: '/tmp/opencode/library-project' } };
function child(code, env = {}) {
  return execFileSync(process.execPath, ['-e', code], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
}

test('import and construction have no configuration, host SDK, IO or process startup effects', () => {
  child(`
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(name, ...args) {
      if (/opencode|queue-client|queue-broker|backends|config-platform/.test(name)) throw Error('Forbidden import: ' + name);
      return load.call(this, name, ...args);
    };
    const fail = () => { throw Error('Unexpected effect'); };
    const fs = require('node:fs');
    // Node's own module loader is allowed to read JS; application I/O is not.
    for (const method of ['writeFileSync','mkdirSync','openSync','readdirSync','existsSync']) fs[method] = fail;
    for (const method of ['spawn','execFile','execFileSync','spawnSync']) require('node:child_process')[method] = fail;
    require('node:net').createConnection = fail;
    const api = require('fmcad/api');
    api.createCatalogServices();
    const services = api.createFmcad(${JSON.stringify(options)});
    api.createReviewServices({ version: 1, ports: {} }).dispose();
    require('node:assert/strict').equal(services.versions.api, 1);
    services.dispose();
  `, { HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent', XDG_STATE_HOME: '/nonexistent' });
});

test('catalog, common validation and local execution work without start or Fusion', async () => {
  const { createFmcad } = require('fmcad/api');
  const api = createFmcad(options);
  const catalog = api.query.catalog();
  assert(catalog.length > 250);
  assert(!catalog.some(item => item.declaration.internalOnly));
  catalog[0].operation = 'foreign';
  assert(!api.query.catalog().some(item => item.operation === 'foreign'));
  assert.throws(() => api.query.validate({ version: 1, kind: 'cad', operation: 'body.move', data: {} }));
  assert.throws(() => api.query.validate({ version: 1, kind: 'cad', operation: 'capabilities.inspect', data: { invalid: Number.NaN } }), /JSON/);
  await assert.rejects(api.execute({ version: 1, kind: 'cad', operation: 'document.status', doc: 'active', data: {} }, { requestId: 'sdk' }), /start\(\)/);
  const local = await api.execute({ version: 1, kind: 'cad', operation: 'capabilities.inspect', data: {} }, { requestId: 'local' });
  assert.equal(local.jobId, null);
  assert.equal(local.outcome.validation.status, 'not_checked');
  assert(local.result);
  await api.dispose();
  await api.dispose();
  assert.throws(() => api.query.catalog(), /disposed/);
});

test('CLI and MCP adapters consume the same public catalog factory without a second validator', () => {
  child(`
    const assert = require('node:assert/strict');
    const Module = require('node:module'), load = Module._load;
    let cliValidated = 0, mcpValidated = 0;
    Module._load = function(name, parent, ...args) {
      const value = load.call(this, name, parent, ...args);
      if (!['../../api', './dist/api', '../api'].includes(name)) return value;
      return { ...value, createCatalogServices() {
        const catalog = value.createCatalogServices();
        return { ...catalog,
          validate(...args) { if (name === '../../api') cliValidated++; return catalog.validate(...args); },
          fromMcp(...args) { mcpValidated++; return catalog.fromMcp(...args); },
        };
      } };
    };
    (async () => {
      const cli = require('./src/cli');
      const output = [];
      const code = await cli.main(['cad', 'entity', 'list', '--doc', 'Model', '--preview', '--json'], {
        stdout: { write: text => output.push(text) }, stderr: { write: () => {} },
        loadConfig() { throw Error('Preview must not load config'); },
        createBackend() { throw Error('Preview must not construct a backend'); },
      });
      assert.equal(code, 0, output.join('')); assert.equal(cliValidated, 1);
      const mcp = require('./src/mcp-stdio');
      const post = mcp.createCatalogPost(() => { throw Error('Raw backend is not needed'); }, { queued: true });
      const result = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'fmcad_cad_entity_list', arguments: { doc: 'Model', data: {}, preview: true },
      } });
      assert.equal(result.status, 200); assert.equal(mcpValidated, 1);
      assert(!JSON.parse(result.raw).error);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
});

test('unsupported public versions and direct routing reject before effects', async () => {
  const { createFmcad, contractVersions, assertCompatibility, CompatibilityError } = require('fmcad/api');
  assertCompatibility({ ...contractVersions, optionalExtension: 'ok' });
  for (const boundary of Object.keys(contractVersions)) {
    assert.throws(() => assertCompatibility({ ...contractVersions, [boundary]: 99 }), CompatibilityError);
  }
  assert.throws(() => createFmcad({ ...options, version: 99 }), CompatibilityError);
  assert.throws(() => createFmcad({ ...options, config: { ...config, routing: 'direct' } }), /routing/);
  const api = createFmcad(options);
  await assert.rejects(api.execute({ version: 99 }, { requestId: 'version' }), CompatibilityError);
  await assert.rejects(api.control({ version: 99, action: 'cancel', jobId: 'job' }), CompatibilityError);
  await api.dispose();
});

test('broker composition fences compatibility before credentials, submits typed DTO once and never retries', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fmcad-api-'));
  try {
    child(`
      const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
       const directory = ${JSON.stringify(directory)};
       const marker = value => fs.writeFileSync(path.join(directory, 'broker.lock'), JSON.stringify({ protocol: value }));
       const state = value => fs.writeFileSync(path.join(directory, 'queue-state.json'), JSON.stringify({ version: value }));
       const config = require('./src/dist/core').resolveFmcadConfiguration({ adapter: ${JSON.stringify(config)}, environment: {}, file: {}, platformDefaults: {}, acceptedService: null });
       const brokerConfigHash = require('./src/queue-instance').brokerConfigHash;
       const configHash = brokerConfigHash(config);
      const identity = value => fs.writeFileSync(path.join(directory, 'instance.json'), JSON.stringify({ buildHash: value, configHash }));
      let constructed = 0, submits = 0, disposed = 0;
      const Module = require('node:module'), load = Module._load;
      Module._load = function(name, parent, ...args) {
        if (name.endsWith('/queue-connection')) return { queueDirectory: () => directory };
        if (name.endsWith('/queue-instance')) return { buildHash: () => 'current', brokerConfigHash };
        if (name.endsWith('/queue-client')) return { QueueClient: class {
          constructor() { constructed++; }
          async register(options) { assert.equal(options.autoStart, false); }
          async call(action, value) {
            if (action === 'control-status') return { buildHash: 'current', unresolved: false, activeOperations: 0 };
            assert.equal(action, 'submit'); submits++;
            assert.equal(value.request.payload.operation, 'document.status');
            assert.equal(value.request.requestId, 'stable');
            assert.equal(value.request.buildHash, 'current');
            throw Object.assign(Error('Lost acknowledgement'), { code: 'QUEUE_IPC_TIMEOUT' });
          }
          dispose() { disposed++; }
        } };
        if (/cli|queue-autostart|backends/.test(name)) throw Error('Forbidden execution dependency: ' + name);
        return load.call(this, name, parent, ...args);
      };
      (async () => {
        const { createFmcad, CompatibilityError } = require('fmcad/api');
        const api = createFmcad(${JSON.stringify(options)});
        marker(99); state(1); identity('current');
        await assert.rejects(api.start(), CompatibilityError); assert.equal(constructed, 0);
        marker(2); state(99);
        await assert.rejects(api.start(), CompatibilityError); assert.equal(constructed, 0);
        state(1); identity('other');
        await assert.rejects(api.start(), CompatibilityError); assert.equal(constructed, 0);
        identity('current');
        fs.writeFileSync(path.join(directory, 'instance.json'), JSON.stringify({ buildHash: 'current', configHash: 'other' }));
        await assert.rejects(api.start(), CompatibilityError); assert.equal(constructed, 0);
        identity('current');
        await Promise.all([api.start(), api.start()]); assert.equal(constructed, 1);
        await assert.rejects(api.execute({ version: 1, kind: 'cad', operation: 'document.status', doc: 'active', data: {} }, { requestId: 'stable' }), /Lost acknowledgement/);
        assert.equal(submits, 1);
        state(99);
        await assert.rejects(api.execute({ version: 1, kind: 'cad', operation: 'document.status', doc: 'active', data: {} }, { requestId: 'stable' }), CompatibilityError);
        assert.equal(submits, 1);
        await api.dispose(); assert(disposed >= 1);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('outside-repository consumer imports built JS and declarations with no source or host SDK', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'fmcad-consumer-'));
  let installed;
  try {
    fs.writeFileSync(path.join(directory, 'package.json'), '{"private":true}');
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root, encoding: 'utf8' }));
    execFileSync('npm', ['install', '--offline', '--prefix', directory, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', path.join(directory, packed[0].filename)], { cwd: directory, encoding: 'utf8', timeout: 120000 });
    installed = path.join(directory, 'node_modules/fmcad');
    for (const entry of fs.readdirSync(installed, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o555);
    }
    fs.chmodSync(installed, 0o555);
    fs.writeFileSync(path.join(directory, 'consumer.ts'), `
      import { createFmcad, createReviewServices, contractVersions } from 'fmcad/api';
      import { McpClient } from './node_modules/fmcad/dist/src/dist/composition/library-client.js';
      import { loadConfig } from './node_modules/fmcad/dist/src/dist/composition/library-configuration.js';
      void new McpClient({clientId: 'installed-owner'}).close();
      void loadConfig;
      import type { FmcadOptions, ExecutionReceipt, ReviewRequest, ReviewServiceOptions, PythonCheckReport } from 'fmcad/api';
      declare const options: FmcadOptions;
      declare const reviewOptions: ReviewServiceOptions;
      declare const reviewRequest: ReviewRequest;
      void createReviewServices(reviewOptions).execute({version: 1, kind: 'review', request: reviewRequest});
      const services = createFmcad(options);
       const result: Promise<ExecutionReceipt> = services.execute({version: 1, kind: 'cad', operation: 'document.status', data: {}, doc: 'active'}, {requestId: 'request'});
       void result.then(receipt => {
         const report: PythonCheckReport | undefined = receipt.pythonChecks?.[0];
         const state: 'passed' | 'failed' | 'incomplete' | 'tool_error' | undefined = report?.status;
         return state;
       });
      void result; void contractVersions;
      // @ts-expect-error No physical transport constructor on public services.
      services.createBackend();
      // @ts-expect-error No direct routing in library configuration.
      options.config.routing = 'direct';
    `);
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', 'false', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', 'consumer.ts'], { cwd: directory, encoding: 'utf8' });
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const Module = require('node:module'), load = Module._load;
      Module._load = function(name, ...args) {
        if (name.startsWith('@opencode') || name.includes('/src/opencode/') || /queue-client|queue-broker/.test(name)) throw Error('Forbidden host/broker import: ' + name);
        return load.call(this, name, ...args);
      };
      const fail = () => { throw Error('Unexpected consumer startup effect'); };
      require('node:net').createConnection = fail;
      for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) require('node:child_process')[method] = fail;
      const fs = require('node:fs'), open = fs.openSync;
      for (const method of ['mkdirSync', 'writeFileSync']) fs[method] = fail;
      fs.openSync = (file, flags, ...args) => {
        if (flags !== 'r' && flags !== fs.constants.O_RDONLY) fail();
        return open(file, flags, ...args); // ESM loader reads package JavaScript.
      };
      const { createFmcad } = await import('fmcad/api');
      const api = createFmcad(${JSON.stringify(options)});
      if (api.query.catalog().length < 250) throw Error('Missing public catalog');
      await api.dispose();
    `], { cwd: directory, env: { ...process.env, HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent' }, encoding: 'utf8' });
    assert(!fs.existsSync(path.join(installed, 'src')));
    assert(!fs.existsSync(path.join(directory, 'node_modules/@opencode-ai')));
    assert(!fs.existsSync(path.join(directory, 'node_modules/@opencode')));
  } finally {
    if (installed && fs.existsSync(installed)) {
      for (const entry of fs.readdirSync(installed, { recursive: true, withFileTypes: true })) {
        if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o755);
      }
      fs.chmodSync(installed, 0o755);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function historicalPublicBoundary(name) {
  const fixture = path.join(__dirname, 'fixtures/public-host-baseline', name + '.js.txt');
  const source = fs.readFileSync(fixture, 'utf8');
  const expected = require('./fixtures/public-host-baseline/provenance.json')[`src/${name}.js`];
  assert.equal(require('node:crypto').createHash('sha256').update(source).digest('hex'), expected.sha256);
  const Module = require('node:module');
  const baseline = new Module(path.join(root, 'src', name + '.js'), module);
  baseline.filename = baseline.id;
  baseline.paths = module.paths;
  baseline._compile(source, baseline.filename);
  return baseline.exports;
}

test('typed compatibility client preserves metadata and every historical denial without transport', async () => {
  const historical = historicalPublicBoundary('client').McpClient;
  const current = require('../src/client').McpClient;
  async function observe(Client) {
    const headers = { 'X-Fixture': 'żółć' };
    const client = new Client({ clientId: 'fixture-owner', headers, url: 'http://127.0.0.1:1' });
    headers['X-Fixture'] = 'changed';
    assert.equal(client.invocationContext.clientId, 'fixture-owner');
    assert.equal(client.invocationContext.source, 'mcp');
    assert.equal(typeof client.invocationContext.instanceId, 'string');
    const observations = { server: client.server, frozen: [Object.isFrozen(client.server), Object.isFrozen(client.server.headers)], denials: [] };
    for (const method of ['initialize','notifications/initialized','ping','tools/list','resources/list','resources/templates/list','resources/read','tools/call',null]) {
      try { await client.controlPost({ method, id: 'żółć', params: { documentId: 'foreign' } }); assert.fail('must reject'); }
      catch (error) { observations.denials.push([error.code, error.message]); }
    }
    for (const method of ['_post','_openSession','callTool','listTools']) {
      await assert.rejects(client[method]({ code: 'never execute' }), { code: 'QUEUE_REQUIRED' });
    }
    const context = { clientId: 'second-owner', documentId: 'doc-pin', requestId: 'request-pin', metadata: { project: 'żółć' } };
    client.setInvocationContext(context);
    assert.equal(client.invocationContext, context);
    assert.equal(client.invocationMetadata, context.metadata);
    client.setInvocationContext(null);
    assert.equal(client.invocationContext, null);
    assert.deepEqual(client.invocationMetadata, {});
    assert.deepEqual(client._parse('{"id":0,"result":null}'), { id: 0, result: null });
    assert.throws(() => client._parse('{invalid'), SyntaxError);
    await client.close(); await client.close();
    return observations;
  }
  assert.deepEqual(await observe(current), await observe(historical));
});

test('typed configuration matches historical validation, initialization and accepted service writes', t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'public-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const program = `
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const baseline = new Module(${JSON.stringify(path.join(root, 'src/config.js'))});
    baseline.filename = baseline.id; baseline.paths = module.paths;
    baseline._compile(fs.readFileSync(${JSON.stringify(path.join(__dirname, 'fixtures/public-host-baseline/config.js.txt'))}, 'utf8'), baseline.filename);
    const current = require(${JSON.stringify(path.join(root, 'src/config.js'))});
    function observe(c, label) {
      const config = path.join(process.env.HOME, label, 'config.json');
      const result = { before: c.loadConfig({config}), initialized: c.initConfig({config}), bytes: fs.readFileSync(config,'utf8'), errors: [] };
      for (const input of [null, [], {routing:'direct'}, {timeoutMs:-1}]) {
        try { c.loadConfig(input); result.errors.push(null); } catch(e) { result.errors.push(e.message); }
      }
      try { c.initConfig({config}); } catch(e) { result.duplicate = e.message; }
      result.forced = c.initConfig({config, force:true, backend:'mcp'});
      result.loaded = c.loadConfig({config, url: "http://127.0.0.1:12345/mcp"});
      for (const input of [null, {}, {version:2}, {version:1, controlCenter:{port:0}}]) {
        try { c.writeAcceptedServiceConfiguration(input); result.errors.push(null); } catch(e) { result.errors.push(e.message); }
      }
      return JSON.parse(JSON.stringify(result).split(path.join(process.env.HOME, label)).join('<fixture>'));
    }
    const expected = observe(baseline.exports, 'before');
    const actual = observe(current, 'after');
    require('node:assert/strict').deepEqual(actual, expected);
    baseline.exports.writeAcceptedServiceConfiguration({version:1, controlCenter:{port:4751}});
    const serviceBytes = fs.readFileSync(baseline.exports.acceptedServiceConfigurationPath(), 'utf8');
    current.writeAcceptedServiceConfiguration({version:1, controlCenter:{port:4751}});
    require('node:assert/strict').equal(fs.readFileSync(current.acceptedServiceConfigurationPath(), 'utf8'), serviceBytes);
    require('node:assert/strict').deepEqual(current.resolveRuntimePaths(), baseline.exports.resolveRuntimePaths());
    process.stdout.write('matched');
  `;
  const env = { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: path.join(directory,'config'), XDG_STATE_HOME: path.join(directory,'state') };
  assert.equal(execFileSync(process.execPath, ['-e', program], { cwd: directory, env, encoding: 'utf8' }), 'matched');
});

test('MCP reconciliation accepts advertised optional outcomes without resubmission', async () => {
  const historical = historicalPublicBoundary('mcp-stdio-compat');
  const current = require('../src/mcp-stdio-compat');
  assert.deepEqual(current.queueTools,historical.queueTools);
  const catalog = {tools:()=>[],list:()=>[],fromMcp:()=>assert.fail('helper is not a CAD call'),isLocal:()=>false};
  historical.configureCatalogServices(catalog); current.configureCatalogServices(catalog);
  async function invoke(api, args) {
    const calls = [];
    const job = {id:'job-owned',requestId:'request-owned',clientId:'owner',state:'needs_reconciliation',revision:7};
    const context = {clientId:'owner',requestId:'request-owned',docId:'document-pin',docFileId:'file-pin',sessionId:'session-owned'};
    const client = {
      auth:{clientId:'owner'},
      register:async options=>calls.push(['register',options]),
      call:async (method,input)=> { calls.push([method,input]); return method==='status'?job:{...job,acceptedOutcome:input.acceptedOutcome}; },
      readRequestContext: id=>{assert.equal(id,'request-owned');return context;},
      submit:()=>assert.fail('reconcile must never submit'),
      wait:()=>assert.fail('reconcile must never replay or wait for a new job'),
    };
    const response = await api.createQueuePost(client,{},undefined)({jsonrpc:'2.0',id:'reconcile-response',method:'tools/call',params:{name:'fmcad_queue_reconcile',arguments:args}});
    return {calls,response,body:JSON.parse(response.raw)};
  }
  assert.deepEqual(await invoke(current,{jobId:'job-owned'}),await invoke(historical,{jobId:'job-owned'}));
  for (const acceptedOutcome of ['committed','aborted']) {
    const before = await invoke(historical,{jobId:'job-owned',acceptedOutcome});
    assert.match(before.body.error.message,/INVALID_QUEUE_PARAMS/);
    assert.deepEqual(before.calls,[]); // Reproduces the inherited required-only allowlist defect.
    const after = await invoke(current,{jobId:'job-owned',acceptedOutcome});
    assert.equal(after.body.id,'reconcile-response');
    assert.equal(after.body.error,undefined);
    assert.deepEqual(after.calls,[['register',{autoStart:false}],['reconcile',{jobId:'job-owned',acceptedOutcome}],['status',{jobId:'job-owned'}]]);
    assert.equal(after.response.queueReceipt.requestId,'request-owned');
    assert.equal(after.response.queueReceipt.context.docId,'document-pin');
    assert.equal(after.response.queueReceipt.context.docFileId,'file-pin');
    assert.equal(after.body.result.structuredContent.acceptedOutcome,acceptedOutcome);
  }
  for (const args of [{jobId:'job-owned',acceptedOutcome:'success'},{jobId:'job-owned',acceptedOutcome:null},{jobId:'job-owned',acceptedOutcome:42},{jobId:'job-owned',foreign:true},{acceptedOutcome:'committed'},{jobId:' '}]) {
    const result=await invoke(current,args);
    assert.match(result.body.error.message,/INVALID_QUEUE_PARAMS/);
    assert.deepEqual(result.calls,[]);
  }
});

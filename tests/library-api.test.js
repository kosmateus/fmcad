'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

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
      import { parseReviewArgs, reviewCmd } from './node_modules/fmcad/dist/src/dist/composition/library-review-command.js';
      void parseReviewArgs; void reviewCmd;
      import { shotCmd, type ShotClient } from './node_modules/fmcad/dist/src/dist/composition/library-shot.js';
      declare const shotClient: ShotClient;
      void shotCmd(shotClient, []);
      import { queueMetadata } from './node_modules/fmcad/dist/src/dist/composition/library-mcp-metadata.js';
      import { createCatalogPost } from './node_modules/fmcad/dist/src/dist/composition/library-mcp-catalog.js';
      void queueMetadata; void createCatalogPost;
      import { commands, findCommand } from './node_modules/fmcad/dist/src/dist/composition/library-commands.js';
      import { detail, globalHelp } from './node_modules/fmcad/dist/src/dist/composition/library-help.js';
      void commands; void findCommand; void detail; void globalHelp;
      import { validateInvocation, executeCapability } from './node_modules/fmcad/dist/src/dist/composition/library-catalog-registry.js';
      void validateInvocation; void executeCapability;
import { createQueuePost as queuePost, createForwarder as forwarder, responseMessages } from './node_modules/fmcad/dist/src/dist/composition/library-mcp-compat.js';
void queuePost; void forwarder; void responseMessages;
import { startHostHelper } from './node_modules/fmcad/dist/src/dist/composition/library-ui-host.js';
void startHostHelper;
import { createUiStateStore } from './node_modules/fmcad/dist/src/dist/composition/library-ui-state.js';
import { validate as validateUi } from './node_modules/fmcad/dist/src/dist/composition/library-ui-domain.js';
void createUiStateStore; void validateUi;
import { execute as executeUi, armWatcher } from './node_modules/fmcad/dist/src/dist/composition/library-ui-command.js';
void executeUi; void armWatcher;
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
    const poison = path.join(directory, 'invalid-help-config.json');
    fs.writeFileSync(poison, '{invalid application configuration');
    const help = require('node:child_process').spawnSync(process.execPath, [path.join(directory, 'node_modules/.bin/fmcad'), 'help', 'batch', 'run'], {
      cwd: directory, encoding: 'utf8', env: {...process.env, FMCAD_CONFIG: poison, LC_ALL:'en_US.UTF-8'},
    });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stderr, '');
    assert.match(help.stdout, /Help: batch run/);
    assert.match(help.stdout, /Worked Workflow: Multi-component parametric sketch-to-solid/);
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

function historicalPublicBoundary(name, additionalExports = '', overrides = {}) {
  const fixture = path.join(__dirname, 'fixtures/public-host-baseline', name + '.js.txt');
  const source = fs.readFileSync(fixture, 'utf8');
  const expected = require('./fixtures/public-host-baseline/provenance.json')[`src/${name}.js`];
  assert.equal(require('node:crypto').createHash('sha256').update(source).digest('hex'), expected.sha256);
  const Module = require('node:module');
  const baseline = new Module(path.join(root, 'src', name + '.js'), module);
  baseline.filename = baseline.id;
  baseline.paths = module.paths;
  const originalRequire = baseline.require.bind(baseline);
  baseline.require = id => Object.hasOwn(overrides,id) ? overrides[id] : originalRequire(id);
  baseline._compile(source + additionalExports, baseline.filename);
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

test('review CLI preserves historical parsing, script bytes and report validation', () => {
  const historical=historicalPublicBoundary('review'),current=require('../src/review');
  const base=['--doc','Part α','--doc-id','creation-1','--doc-file-id','file-1','--out','new review'];
  for (const extra of [[],['--width','64','--height','96'],['--width','2.5'],['--height'],['--doc-id','duplicate'],['--recipes','{bad'],['--recipes','{}'],['--recipes','[]'],['--unknown','x']]) {
    const observe=api=>{try{return {value:api.parseReviewArgs([...base,...extra])};}catch(error){return {error:error.message};}};
    assert.deepEqual(observe(current),observe(historical));
  }
  const request={...current.parseReviewArgs(base),requestId:'review-owned',fusionOut:'C:\\review'};
  assert.equal(current.buildReviewScript(request),historical.buildReviewScript(request));
  for (const report of [null,{}, {schemaVersion:1,requestId:'foreign'}, {success:true,status:'captured'}]) {
    const observe=api=>{try{return {value:api.verifyReport(report,request)};}catch(error){return {error:error.message};}};
    assert.deepEqual(observe(current),observe(historical));
  }
  assert.deepEqual(current.flags,historical.flags);
  assert.deepEqual(current.views,historical.views);
});

test('shot preserves historical single dispatch, response precedence and publication failures', async () => {
  const historical = historicalPublicBoundary('shot');
  const current = require('../src/shot');
  const image = Buffer.from('image bytes').toString('base64');
  const responses = [
    { data: { base64Data: image } },
    { text: JSON.stringify({ result: { content: [{ type: 'image', data: image }] } }) },
    { data: { data: image }, text: '{bad' },
    { failed: true, data: { base64Data: image }, text: 'unknown outcome' },
    { text: '{bad' }, { data: { content: [null] } },
    { data: { base64Data: { invalid: true } } },
  ];
  for (const response of responses) {
    for (const failWrite of [false, true]) {
      const observe = async api => {
        const calls = [], writes = [], stdout = [], stderr = [];
        const client = { callTool: async (...args) => { calls.push(args); return response; } };
        const files = { writeFileSync: (file, bytes) => { writes.push([file, bytes.toString('hex')]); if (failWrite) throw new Error('disk full'); } };
        const io = { stdout: { write: value => stdout.push(value) }, stderr: { write: value => stderr.push(value) } };
        let code, error;
        try { code = await api.shotCmd(client, ['--width','invalid','--dir','front','--transparent','--unknown'], io, files, () => 123); }
        catch (caught) { error = { name: caught.name, message: caught.message }; }
        return { calls, writes, stdout, stderr, code, error };
      };
      assert.deepEqual(await observe(current), await observe(historical));
    }
  }
});

test('MCP metadata preserves historical ownership validation and strips only private fields', () => {
  const historical = historicalPublicBoundary('mcp-stdio-compat', '\nmodule.exports.queueMetadata = queueMetadata;');
  const current = require('../src/dist/composition/library-mcp-metadata');
  const cases = [null, [], {}, { unknown: true },
    { sequence: { action: 'continue', id: 'lease' }, expectedRevision: 0, requestId: 'request-α', sessionId: 'session', doc: 'Żółć', docId: 'creation', docFileId: 'file', projectId: 'project', purpose: 'Inspect', description: 'Inspect', projectDirectory: '/tmp/project', roots: [{ uri: 'file:///tmp/project', name: 'local' }] },
    { sequence: { action: 'begin', id: 'lease' } }, { sequence: { action: {}, id: 'lease' } },
    { sequence: { action: 'end', id: 'lease', extra: true } },
    { expectedRevision: -1 }, { expectedRevision: 1.5 }, { expectedRevision: '1' },
    { purpose: 'a', description: 'b' }, { description: '\u0000' },
    { projectDirectory: 'x'.repeat(257) }, { roots: Array(33).fill({uri: 'file:///tmp'}) },
    { roots: [{ uri: 'file:///tmp', extra: true }] }, { roots: [{uri:'file:///tmp', name: 1}] },
  ];
  for (const key of ['requestId','sessionId','doc','docId','docFileId','projectId','projectDirectory']) {
    for (const value of ['', ' ', 1, 'x'.repeat(257)]) cases.push({[key]: value});
  }
  for (const options of cases) {
    for (const method of ['tools/call', 'ping']) {
      const request = { jsonrpc:'2.0', id:'α', method, params:{name:'fixture', arguments:{doc:'argument'}, _meta:{other:{keep:true}, fmcad:options}} };
      const original = structuredClone(request);
      const observe = api => { try { return {value:api.queueMetadata(request)}; } catch (error) { return {error:{message:error.message,code:error.code}}; } };
      assert.deepEqual(observe(current), observe(historical));
      assert.deepEqual(request, original);
    }
  }
});

test('typed MCP catalog preserves local routing, notification errors and exact owner pins', async () => {
  const historical = historicalPublicBoundary('mcp-stdio-compat');
  const current = require('../src/mcp-stdio-compat');
  const catalog = require('../src/dist/api').createCatalogServices();
  historical.configureCatalogServices(catalog);
  current.configureCatalogServices(catalog);
  const call = (name, args, meta) => ({jsonrpc:'2.0',id:'request-α',method:'tools/call',params:{name,arguments:args,...(meta ? {_meta:{fmcad:meta}} : {})}});
  const args = {doc:'Żółć', docId:'creation',docFileId:'file',data:{},projectId:'project'};
  const requests = [
    {jsonrpc:'2.0',id:1,method:'tools/list'}, {jsonrpc:'2.0',method:'tools/list'},
    {jsonrpc:'2.0',id:null,method:'ping'},
    call('fmcad_cad_entity_list', args),
    call('fmcad_cad_entity_list', {...args,preview:true}, {description:'Inspect'}),
    call('fmcad_cad_entity_list', {...args,preview:true}, {expectedRevision:0}),
    call('fmcad_cad_entity_list', {...args,purpose:'body'}, {description:'meta'}),
    call('fmcad_cad_entity_list', {...args,preview:'true'}),
    call('fmcad_cad_missing', {}), call('other_tool', {raw:true}),
    {...call('fmcad_cad_entity_list',args), id:undefined},
    {jsonrpc:'2.0',method:'tools/call',params:{name:'fmcad_cad_entity_list',arguments:args}},
  ];
  for (const queued of [false,true]) for (const response of [{success:true}, {success:false}, null]) for (const request of requests) {
    const observe = async api => {
      const calls = [];
      const post = api.createCatalogPost(async (...values) => {calls.push(['post',...values]); return {status:204,raw:''};}, {queued,cfg:{backend:'mcp'}, execute:async (...values) => {calls.push(['execute',...values]); return response;}});
      try {return {result:await post(structuredClone(request),'session','protocol'),calls};}
      catch (error) {return {error:{name:error.name,message:error.message},calls};}
    };
    assert.deepEqual(await observe(current),await observe(historical));
  }
});

test('typed command registration preserves every route, alias, flag and argument limit', () => {
  const historical = historicalPublicBoundary('commands');
  const current = require('../src/commands');
  const previous = 'legacy document lookup activates the first case-insensitive open-name match; duplicate names are not rejected.';
  const corrected = 'document lookup requires one case-insensitive open-name match; duplicate names are rejected before activation.';
  const expected = historical.commands.map(command => ({...command, description:command.description.replace(previous, corrected)}));
  assert.deepEqual(current.commands, expected);
  assert.deepEqual(current.globalFlags, historical.globalFlags);
  assert.deepEqual(current.legacyCommands, expected.slice(0, historical.legacyCommands.length));
  for (const command of expected) {
    for (const spelling of [command.key, ...(command.aliases || [])]) {
      assert.equal(current.findCommand(spelling.split(' ')), current.commands.find(entry => entry.key === command.key));
      assert.equal(current.findCommand([...spelling.split(' '), 'argument-α']).key, historical.findCommand([...spelling.split(' '), 'argument-α']).key);
    }
  }
  for (const key of Object.keys(historical.SPECIAL)) assert.deepEqual(current.SPECIAL[key](),historical.SPECIAL[key]());
  assert.deepEqual(current.DOC_SUB, historical.DOC_SUB);
  for (const [key, descriptor] of Object.entries(historical.OPS_DETAIL)) assert.deepEqual(current.OPS_DETAIL[key], {...descriptor,desc:descriptor.desc.replace(previous,corrected)});
  assert.equal(current.findCommand(['not-a-command']),undefined);
  const documentSource = fs.readFileSync(path.join(root,'runtime/python/fmcad/adapters/fusion/legacy_document.py'),'utf8');
  assert.match(documentSource, /if len\(matches\) != 1:/);
  assert(documentSource.indexOf('if len(matches) != 1:') < documentSource.indexOf('doc.activate()'));
});

test('typed help preserves every registered English and Polish page and text layout', () => {
  assert.deepEqual(require('../src/legacy-manual'), historicalPublicBoundary('legacy-manual'));
  assert.deepEqual(require('../src/broker-manual'), historicalPublicBoundary('broker-manual'));
  const oldHelp = historicalPublicBoundary('help'), help = require('../src/help');
  const oldPolish = historicalPublicBoundary('help-pl'), polish = require('../src/help-pl');
  const oldDetails = historicalPublicBoundary('help-details'), details = require('../src/help-details');
  const oldManual = historicalPublicBoundary('help-manual'), manual = require('../src/help-manual');
  const oldFormat = historicalPublicBoundary('help-format'), format = require('../src/help-format');
  const commands = require('../src/commands').commands;
  const original = {LC_ALL:process.env.LC_ALL,FMCAD_CONFIG:process.env.FMCAD_CONFIG};
  process.env.FMCAD_CONFIG = path.join(tmpdir(),'fmcad-help-no-config-'+process.pid);
  try {
    for (const language of ['en_US.UTF-8','pl_PL.UTF-8']) {
      process.env.LC_ALL = language;
      assert.equal(help.globalHelp(),oldHelp.globalHelp());
      for (const entry of commands) assert.equal(help.detail(...entry.key.split(' ')),oldHelp.detail(...entry.key.split(' ')),entry.key);
      assert.equal(help.detail('missing','route'),oldHelp.detail('missing','route'));
    }
    for (const entry of commands) {
      assert.equal(polish.description(entry),oldPolish.description(entry),entry.key);
      assert.equal(polish.detail(entry),oldPolish.detail(entry),entry.key);
      assert.equal(details.contextualHelp(entry),oldDetails.contextualHelp(entry),entry.key);
      assert.equal(manual.manualHelp(entry),oldManual.manualHelp(entry),entry.key);
    }
    for (const width of [20,40,80,120]) for (const text of ['plain words '.repeat(30),'  indented text\n{\"json\":true}\n\nŻółć','\u001b[31mred words '.repeat(15)+'\u001b[0m']) assert.equal(format.formatHelp(text,width),oldFormat.formatHelp(text,width));
    const guide = historicalPublicBoundary('help-guide');
    guide.sections = guide.sections.map(section => ({...section,text:section.text.replace('Legacy --doc operations activate the FIRST case-insensitive document match, not a uniqueness-safe selector.','Legacy --doc operations require one case-insensitive open-document name match; ambiguous names fail before activation.')}));
    assert.deepEqual(require('../src/help-guide'),guide);
  } finally { for (const [key,value] of Object.entries(original)) { if(value === undefined) delete process.env[key]; else process.env[key]=value; } }
});

test('typed catalog composition preserves declarations, specialists and broker probe pins', () => {
  async function observeCatalog(root, historical) {
    const path = require('node:path'), fs = require('node:fs');
    const filename = path.join(root, 'src/catalog/index.js');
    let api;
    if (historical) {
      const source = fs.readFileSync(path.join(root,'tests/fixtures/public-host-baseline/catalog/index.js.txt'),'utf8');
      const provenance = require(path.join(root,'tests/fixtures/public-host-baseline/provenance.json'))['src/catalog/index.js'];
      require('node:assert/strict').equal(require('node:crypto').createHash('sha256').update(source).digest('hex'),provenance.sha256);
      const Module = require('node:module'), baseline = new Module(filename, module);
      baseline.filename = filename;
      baseline.paths = Module._nodeModulePaths(path.dirname(filename));
      require.cache[filename] = baseline;
      baseline._compile(source,filename);
      api = baseline.exports;
    } else api = require(filename);
    const observe = fn => {try{return {value:fn()};}catch(error){return {error:{name:error.name,message:error.message,code:error.code}};}};
    const operations = {};
    for (const [operation,declaration] of Object.entries(api.catalog)) {
      const input={version:1,kind:'cad',operation,data:declaration.example,doc:'Model',docId:'creation',docFileId:'file'};
      operations[operation]={declaration,contract:api.contracts[operation],
        validation:[declaration.example,{unknown:true},null].map(data=>observe(()=>api.validateCad(operation,structuredClone(data)))),
        invocation:observe(()=>api.validateInvocation(structuredClone(input))),
        local:[false,true].map(preview=>observe(()=>api.localInvocation({...input,preview}))) };
    }
    const tools = Object.fromEntries(api.mcpTools.map(tool=>[tool.name,{tool,
      calls:[undefined,{},null,[],{data:{},doc:'Model',docId:'creation',docFileId:'file',preview:true}].map(args=>observe(()=>api.mcpInvocation(tool.name,structuredClone(args))))}]));
    const search = [{query:'sketch'},{query:'żółć'},{limit:101},null].map(data=>observe(()=>api.executeCapability('capabilities.inspect',data)));
    const probes=[];
    for (const backend of ['mcp','addin','invalid']) {
      const calls=[];
      const brokerSdkProbePort={boundary:'fmcad-broker',kind:'sdk-probe',probe:async request=>{calls.push(request);return {capabilityId:request.capabilityId,status:'pass',precision:'pass',coverage:'pass',build:'fixture',identity:'verified',mutation:'none',restoration:'not_applicable',limitations:[]};}};
      try {probes.push({value:await api.executeCapability('capabilities.probe',{capabilityId:'entity.list'},{docId:'creation',docFileId:'file'},{backend,brokerSdkProbePort}),calls});}
      catch(error){probes.push({error:{name:error.name,message:error.message},calls});}
    }
    const reserved = require(path.join(root,'src/commands')).legacyCommands.flatMap(command=>[command.key,...(command.aliases||[])]);
    return {operations,tools,search,probes,cli:api.cliContracts(reserved)};
  }
  const observe = historical => JSON.parse(execFileSync(process.execPath,['-e',
    '('+observeCatalog.toString()+')('+JSON.stringify(root)+','+historical+').then(result=>process.stdout.write(JSON.stringify(result)),error=>{console.error(error);process.exitCode=1})'],
    {cwd:root,encoding:'utf8',maxBuffer:32*1024*1024}));
  const historical=observe(true),current=observe(false);
  assert.deepEqual(Object.keys(current.operations),Object.keys(historical.operations));
  for(const [operation,value] of Object.entries(historical.operations)) assert.deepEqual(current.operations[operation],value,operation);
  assert.deepEqual(Object.keys(current.tools),Object.keys(historical.tools));
  for(const [tool,value] of Object.entries(historical.tools)) assert.deepEqual(current.tools[tool],value,tool);
  assert.deepEqual(current.cli,historical.cli);
  assert.deepEqual(current.search,historical.search);
  assert.deepEqual(current.probes,historical.probes);
});

test('compatibility forwarder preserves framing, sessions, receipts and no-retry errors', async () => {
  const historical = historicalPublicBoundary('mcp-stdio-compat').createForwarder;
  const current = require('../src/mcp-stdio-compat').createForwarder;
  async function observe(factory, request, response) {
    const sent = [], logs = [], calls = [];
    const forward = factory(async (...args) => {
      calls.push(args);
      if (response instanceof Error) throw response;
      return structuredClone(response);
    }, (message, frame) => sent.push({ message, frame }), line => logs.push(line), { headers: { Authorization: 'secret' } });
    await forward(typeof request === 'string' ? request : JSON.stringify(request));
    return { sent, logs, calls };
  }
  const requests = ['{', 'null', '[]', '{}', {jsonrpc:'1.0',id:1,method:'ping'},
    {jsonrpc:'2.0',id:{},method:'ping'}, {jsonrpc:'2.0',id:null,method:'ping'},
    {jsonrpc:'2.0',id:1,method:'ping'}, {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:1,method:'resources/templates/list'}, {jsonrpc:'2.0',id:1,method:'tools/list'}];
  const responses = [{status:204,raw:''}, {status:500,raw:'secret'},
    {status:200,raw:'invalid'}, {status:200,raw:'{"jsonrpc":"2.0","id":1,"result":{}}'},
    {status:200,raw:'{"jsonrpc":"2.0","id":1,"error":{"code":-32601}}'},
    {status:200,raw:'{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"foreign"},{"name":"fmcad_queue_result"}]}}',queueTools:true,queueReceipt:{jobId:'owned',requestId:'request'}},
    {status:200,raw:'data: {"jsonrpc":"2.0","method":"notice"}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'},
    {status:200,raw:'{"jsonrpc":"2.0","id":2,"result":{}}'},
    {status:200,raw:'{"jsonrpc":"1.0","id":1,"result":{}}'},
    new Error('authorization secret disconnected')];
  for (const request of requests) for (const response of responses)
    assert.deepEqual(await observe(current,request,response),await observe(historical,request,response));
  async function sessions(factory) {
    const calls=[], sent=[];
    const forward=factory(async (request,session,version)=>{
      calls.push({request,session,version});
      return {status:200,sessionId:'retained-session',raw:JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-03-26'}})};
    }, message=>sent.push(message));
    await forward('{"jsonrpc":"2.0","id":"init","method":"initialize"}');
    await forward('{"jsonrpc":"2.0","id":"next","method":"ping"}');
    return {calls,sent};
  }
  assert.deepEqual(await sessions(current),await sessions(historical));
});

test('MCP queue migration preserves single admission, recovery, receipts and disposal', async () => {
  const historical=historicalPublicBoundary('mcp-stdio-compat'), current=require('../src/mcp-stdio-compat');
  const catalog={tools:()=>[],list:()=>[],fromMcp:()=>assert.fail('raw RPC is not catalog'),isLocal:()=>false};
  historical.configureCatalogServices(catalog);current.configureCatalogServices(catalog);
  async function observe(api, scenario) {
    const calls=[];
    const job={id:'owned-job',requestId:'owned-request',clientId:'owner',state:scenario==='unknown'?'needs_reconciliation':scenario==='failed'?'failed':'succeeded',revision:3};
    const value={job,rpc:{status:200,raw:JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'exact'}]}})}};
    if(scenario==='missing') delete value.rpc;
    if(scenario==='python') value.execution={pythonCheck:{status:'required'},code:'PYTHON_REQUIRED',executionOutcome:'not_started',mayHaveMutated:false};
    const client={dir:'unused',auth:{clientId:'owner'},
      register:async options=>{calls.push(['register',options]);if(scenario==='registration')throw new Error('registration failed');},
      submit:async input=>{calls.push(['submit',input]);if(['recovered','lost','recovery-failed'].includes(scenario))throw new Error('acknowledgement lost');return job;},
      findRequest:async requestId=>{calls.push(['findRequest',requestId]);if(scenario==='recovery-failed')throw new Error('recovery disconnected');return scenario==='recovered'?value:null;},
      wait:async (id,{signal})=>{calls.push(['wait',id,signal.aborted]);return value;},
      persistRequestContext:(...args)=>calls.push(['persist',...args]),
      dispose:()=>calls.push(['dispose']),
    };
    const post=api.createQueuePost(client,{backend:'addin',timeoutMs:2000},3000,{sessionId:'owner-session',projectDirectory:root});
    const response=await post({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'execute_python',arguments:{code:'unchanged'},_meta:{fmcad:{requestId:'owned-request',doc:'Exact',docId:'doc-pin',docFileId:'file-pin',projectId:'project-pin',purpose:'Inspect requested design',expectedRevision:3}}}},'wire-session','wire-version');
    post.close();
    assert.equal(calls.filter(c=>c[0]==='submit').length,scenario==='registration'?0:1);
    assert.equal(calls.at(-1)[0],'dispose');
    return {calls,response};
  }
  for(const scenario of ['success','failed','unknown','missing','python','recovered','lost','recovery-failed','registration'])
    assert.deepEqual(await observe(current,scenario),await observe(historical,scenario),scenario);
});

test('UI host helper preserves argv, bounded output, readiness and timeout ownership', async () => {
  const restore=require('./fixtures/fake-wsl-platform.cjs')();
  try {
    const {EventEmitter}=require('node:events');
    async function observe(which,scenario) {
      const calls=[], ready=[];
      const spawn=(executable,args,options)=>{
        calls.push({executable,args,options});
        if(scenario==='spawn-error')throw new Error('spawn failed');
        const child=new EventEmitter();
        child.exitCode=null;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
        child.unref=()=>calls.push('detach-child');child.stdout.unref=()=>calls.push('detach-stdout');child.stderr.unref=()=>calls.push('detach-stderr');
        child.kill=()=>{calls.push('kill');queueMicrotask(()=>child.emit('close',null));};
        setTimeout(()=>{
          if(scenario==='timeout')return;
          if(scenario==='status-timeout'){child.exitCode=0;child.emit('close',0);return;}
          if(scenario==='error'){child.emit('error',new Error('host error'));return;}
          if(scenario==='watch'){
            child.stdout.emit('data',Buffer.from('FMCAD_UI_WATCHER_READY {"requestId":"foreign","lifecycleId":"lifecycle"}\n'));
            // A complete foreign first marker is deliberately not accepted.
          }
          if(scenario==='ready')child.stdout.emit('data',Buffer.from('FMCAD_UI_WATCHER_READY {"requestId":"request","lifecycleId":"lifecycle"}\n'));
          child.stdout.emit('data',Buffer.from(scenario==='oversized'?'x'.repeat(256*1024+1):scenario==='invalid'?'FMCAD_UI_RESULT {bad}\n':'FMCAD_UI_RESULT {"status":"ready","actionSubmitted":false}\n'));
          if(scenario==='stderr')child.stderr.emit('data',Buffer.from('diagnostic'));
          child.exitCode=scenario==='exit-failure'?1:0;child.emit('close',child.exitCode);
        },scenario==='status-timeout'?20:0);
        return child;
      };
      const factory=which==='historical'?historicalPublicBoundary('ui','\nmodule.exports.startHostHelper=startHostHelper;',{'node:child_process':{spawn}}).startHostHelper:require('../src/dist/composition/library-ui-host').startHostHelper;
      const mode=scenario==='status-timeout'?'watch-status':['ready','watch'].includes(scenario)?'watch':'inspect';
      const request={requestId:'request',lifecycleId:'lifecycle',timeBudgetMs:['timeout','status-timeout'].includes(scenario)?1:1000};
      if(scenario==='argv')request.payload='x'.repeat(17*1024);
      if(scenario==='deadline')request.timeBudgetMs=120001;
      const handle=factory(mode,request,{powershellPath:'powershell.exe',helperPath:path.join(root,'assets/ui_dialog.ps1'),spawnHost:spawn});
      handle.ready?.then(value=>ready.push(value));
      const result=await handle.completion;
      if(scenario==='status-timeout')assert(!calls.includes('kill'),'status timeout must never stop the host process');
      if(scenario==='timeout')assert.equal(calls.filter(x=>x==='kill').length,1);
      if(scenario==='watch')assert.deepEqual(ready,[],'foreign readiness must not arm this request');
      if(scenario==='ready')assert.equal(ready.length,1);
      return {calls,ready,result};
    }
    for(const scenario of ['normal','stderr','invalid','exit-failure','spawn-error','error','oversized','argv','deadline','watch','ready','timeout','status-timeout'])
      assert.deepEqual(await observe('current',scenario),await observe('historical',scenario),scenario);
  } finally {restore();}
});

test('UI domain preserves validation, exact identity, profiles and probe bytes', () => {
  const historical=historicalPublicBoundary('ui','\nObject.assign(module.exports,{buildProbe,targetIdentity,decorateSnapshot,structuralDialogs,exactControl});');
  const current=require('../src/dist/composition/library-ui-domain');
  assert.deepEqual(current.PROFILES,historical.profiles);
  const target={name:'Żółć',creationId:'creation',fileId:'file',commandId:'command'};
  const base={requestId:'request',lease:{id:'lease',requestId:'request',operationId:'operation',expiresAt:2000000000000,target},target,intent:'confirmRequestedUpdate'};
  function outcome(fn){try{return {value:fn()};}catch(error){return {name:error.name,message:error.message};}}
  for(const operation of ['ui.inspect','ui.respond','ui.resolve','unknown']){
    const inputs=[null,[],{},base,{...base,foreign:true}];
    for(const key of Object.keys(base)){const input=structuredClone(base);delete input[key];inputs.push(input);}
    for(const patch of [{requestId:'bad space'},{intent:'foreign'},{lease:{...base.lease,target:{...target,fileId:'other'}}},{maxControls:513},{observationId:'not-uuid'},{allowedProfiles:['']},{maxActions:11},{timeBudgetMs:120001},{expectedCommandId:''}]) inputs.push({...base,...patch});
    inputs.push({...base,observationId:'00000000-0000-4000-8000-000000000000',action:'confirm',profileId:'update-all-latest'});
    for(const input of inputs)assert.deepEqual(outcome(()=>current.validate(operation,input)),outcome(()=>historical.validate(operation,input)),operation);
  }
  for(const context of [{doc:'Żółć',docId:'creation',docFileId:'file'},{doc:'other'},{doc:'Żółć',docId:'other'},{doc:'Żółć',docFileId:'other'}])
    assert.deepEqual(outcome(()=>current.targetIdentity(base,context)),outcome(()=>historical.targetIdentity(base,context)));
  const identity=current.targetIdentity(base,{doc:'Żółć'});
  assert.equal(current.buildProbe(identity),historical.buildProbe(identity));
  for(const documents of [[],[target],[{...target,isActive:true}],[target,target],[{...target,name:'other'}]])
    for(const unavailableEvidence of [[],['unavailable']])
      assert.deepEqual(current.resolveProbeDocuments({documents,unavailableEvidence},identity),historical.resolveProbeDocuments({documents,unavailableEvidence},identity));
  const crypto=require('node:crypto'),original=crypto.randomUUID;
  function decorate(api){let index=0;crypto.randomUUID=()=>`fixture-${++index}`;return api.decorateSnapshot({status:'ready',locale:'pl-PL',windows:[{handle:100,controls:[{name:'secret',isPassword:true},{name:'Żółć',runtimeId:[1,2],parentPath:['a'],semanticRole:'confirm'}]}]});}
  try {assert.deepEqual(decorate(current),decorate(historical));}finally{crypto.randomUUID=original;}
});

test('UI observation and lifecycle store preserves one-time claims and absorbing states', async () => {
  const historical=historicalPublicBoundary('ui','\nObject.assign(module.exports,{writeWatcherLifecycle,watcherLifecycleBinding,saveObservation,getObservation,claimObservation,finishObservation,writeExclusive});');
  const current=require('../src/dist/composition/library-ui-state');
  const crypto=require('node:crypto'),originalUuid=crypto.randomUUID,originalNow=Date.now;
  async function observe(api) {
    const directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'fmcad-ui-state-parity-'));
    let sequence=0;
    crypto.randomUUID=()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
    Date.now=()=>1800000000000;
    const options={stateDir:directory,now:Date.now};
    try {
      const target={name:'Żółć',creationId:'creation',fileId:'file'};
      const request={requestId:'request',lease:{id:'lease',requestId:'request',operationId:'operation',target,expiresAt:1800000060000},expectedIdentity:target,intent:'confirmRequestedUpdate',profileId:'update-all-latest'};
      const binding=api.watcherLifecycleBinding(request),results=[];
      results.push(await api.writeWatcherLifecycle(directory,binding,false));
      results.push(await api.writeWatcherLifecycle(directory,binding,true));
      results.push(await api.writeWatcherLifecycle(directory,binding,true));
      results.push(await api.writeWatcherLifecycle(directory,binding,false,{state:'running'}));
      results.push(await api.writeWatcherLifecycle(directory,binding,false,{state:'unknown'}));
      results.push(await api.writeWatcherLifecycle(directory,binding,false,{state:'finished'}));
      results.push(await api.writeWatcherLifecycle(directory,{...binding,requestId:'foreign'},false,{state:'finished'}));
      const second={...binding,lifecycleId:'second'};
      results.push(await api.writeWatcherLifecycle(directory,second,true));
      results.push(await api.writeWatcherLifecycle(directory,second,false,{state:'finished',result:{status:'unknown',actionSubmitted:null}}));
      results.push(await api.writeWatcherLifecycle(directory,second,false,{state:'running'}));
      const token=await api.saveObservation({requestId:'request',leaseHash:'hash',target,windows:[],truncated:false,intent:'confirmRequestedUpdate'},options);
      const loaded=await api.getObservation(token.observationId,options);results.push(loaded);
      const claim=await api.claimObservation(token.observationId,loaded,'request');
      await assert.rejects(api.claimObservation(token.observationId,loaded,'request'),{code:'EEXIST'});
      results.push(await api.getObservation(token.observationId,options));
      results.push(await api.finishObservation(token.observationId,loaded,claim,{status:'unknown',actionSubmitted:null}));
      results.push(await api.getObservation(token.observationId,options));
      await assert.rejects(api.writeExclusive(path.join(directory,'oversized'),'x'.repeat(512*1024)),/bounded size/);
      assert(!fs.existsSync(path.join(directory,'oversized')));
      const files=Object.fromEntries(fs.readdirSync(directory).sort().map(name=>[name,fs.readFileSync(path.join(directory,name),'utf8')]));
      return JSON.parse(JSON.stringify({results,files}).replaceAll(directory,'<state>'));
    }finally{fs.rmSync(directory,{recursive:true,force:true});}
  }
  try {assert.deepEqual(await observe(current),await observe(historical));}
  finally {crypto.randomUUID=originalUuid;Date.now=originalNow;}
});

test('qualified native cancellation fixes the historical missing serializer without bypassing guards', async () => {
  const historical=historicalPublicBoundary('ui');
  const repairedHistorical=historicalPublicBoundary('ui','\nconst pythonValue=pythonLiteral; module.exports.terminationScript=terminationScript;');
  const current=require('../src/ui');
  const identity={name:'Żółć "quoted"',creationId:'creation',fileId:'file',commandId:'FusionMoveCommand',identityPinned:true};
  const profile={qualified:true,nativeCommandId:'FusionMoveCommand',commandIds:['FusionMoveCommand']};
  let calls=0,source;
  const client={capabilities:{backend:'addin'},executeUiGuardedScript:async script=>{calls++;source=script;return {text:'FMCAD_UI_ACTION {"status":"unknown","actionSubmitted":null,"operationOutcome":"notEvaluated"}'};}};
  await assert.rejects(historical.terminateNativeCommand(client,identity,{},profile),/pythonValue is not defined/);
  assert.equal(calls,0,'historical defect occurs before the guarded route');
  const result=await current.terminateNativeCommand(client,identity,{},profile);
  assert.equal(calls,1);assert.equal(result.status,'unknown');assert.equal(result.actionSubmitted,null);
  assert.equal(source,repairedHistorical.terminationScript(identity,profile.nativeCommandId));
  const checked=spawnSync('python3',['-c','import ast,sys; ast.parse(sys.stdin.read())'],{input:source,encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr);
  const denied=await current.terminateNativeCommand(client,identity,{}, {...profile,qualified:false});
  assert.equal(denied.status,'blocked');assert.equal(calls,1,'unqualified cancellation cannot reach the backend');
});

test('unchanged retained UI suite also passes against the frozen historical implementation', () => {
  const directory=fs.mkdtempSync(path.join(tmpdir(),'fmcad-ui-historical-'));
  const preload=path.join(directory,'preload.cjs');
  const fixture=path.join(__dirname,'fixtures/public-host-baseline/ui.js.txt');
  const target=path.join(root,'src/ui.js');
  fs.writeFileSync(preload,`
    const Module=require('node:module'),fs=require('node:fs'),crypto=require('node:crypto');
    const target=${JSON.stringify(target)}, source=fs.readFileSync(${JSON.stringify(fixture)},'utf8');
    const expected=require(${JSON.stringify(path.join(__dirname,'fixtures/public-host-baseline/provenance.json'))})['src/ui.js'];
    require('node:assert/strict').equal(crypto.createHash('sha256').update(source).digest('hex'),expected.sha256);
    const baseline=new Module(target,module); baseline.filename=target; baseline.paths=Module._nodeModulePaths(${JSON.stringify(root)});
    baseline._compile(source,target);
    const load=Module._load;
    Module._load=function(request,parent,isMain){
      if ((request==='./ui'||request.endsWith('/ui')||request.endsWith('/ui.js'))&&Module._resolveFilename(request,parent)===target)return baseline.exports;
      return load.call(this,request,parent,isMain);
    };
  `);
  try {
    const env={...process.env}; delete env.NODE_TEST_CONTEXT;
    const output=execFileSync(process.execPath,['--require',preload,'--test',path.join(__dirname,'ui.test.js')],{cwd:root,env,encoding:'utf8',timeout:60000});
    assert.match(output,/(?:fail 0|# fail 0)/);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('remaining host registrations preserve public descriptors and manuals', () => {
  for(const name of ['image-trace','image-optimize','image-boundaries','engineering-local','reference','review']){
    const historical=historicalPublicBoundary(name),current=require('../src/'+name);
    for(const key of ['descriptor','manual','descriptors','manuals','localOperations'])
      assert.deepEqual(current[key],historical[key],name+':'+key);
    if(current.methods)assert.deepEqual(Object.fromEntries(Object.entries(current.methods).map(([key,{run,...metadata}])=>[key,metadata])),Object.fromEntries(Object.entries(historical.methods).map(([key,{run,...metadata}])=>[key,metadata])));
    if(name==='reference'){
      const initial={'reference.image':{inputs:{},required:[],limitations:[]}};
      const before=structuredClone(initial),after=structuredClone(initial);
      historical.configure(before);current.configure(after);assert.deepEqual(after,before);
    }
  }
});

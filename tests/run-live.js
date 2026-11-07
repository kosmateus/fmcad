'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { boundedMap, concurrencyLimit, sourceHash } = require('../dist/tests/scenarios/scheduling');

const suites = ['legacy', 'cad', 'extended', 'definitions', 'data-import', 'backend-adapter',
  'feature-modes', 'style-save', 'motion-animation', 'camera-probe', 'joint-limits-probe', 'mcp-stdio'];
const scopedSuites = ['gm12-spring', 'data-import-fixed'];

const optIns = {
  'data-import': ['--run'], 'feature-modes': ['--run'], 'style-save': ['--run'],
  'motion-animation': ['--run'], 'camera-probe': ['--run'], 'joint-limits-probe': ['--run'],
};

function testSourceHash(root = __dirname) {
  const roots = { tests: root };
  if (root === __dirname) {
    roots.runtime = path.resolve(root, '../runtime/python/fmcad');
    roots.assets = path.resolve(root, '../assets');
  }
  return sourceHash(roots);
}

function parseOptions(argv) {
  let routing = 'queue';
  let concurrency = 10;
  const rest = [], seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--routing' && flag !== '--concurrency') { rest.push(flag); continue; }
    if (seen.has(flag)) throw new Error('Duplicate runner option: ' + flag);
    seen.add(flag);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(flag + ' requires a value');
    if (flag === '--routing') routing = value;
    else {
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error('concurrency must be a positive safe integer');
      concurrency = concurrencyLimit(Number(value));
    }
  }
  if (routing !== 'queue') throw new Error('routing=direct is no longer supported; all live suites require the shared broker');
  return { routing, concurrency, suite: rest[0] || 'all', args: rest.slice(1) };
}

async function runBatch(names, routing, launch, concurrency = 10) {
  const one = async name => {
    try { return { suite: name, exitCode: await launch(name) }; }
    catch (error) { return { suite: name, exitCode: 1, error: error.message }; }
  };
  if (routing !== 'queue') throw new Error('routing=direct is no longer supported; use shared broker admission');
  return boundedMap(names, concurrency, one);
}

function runChild(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, script, { cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => signal ? reject(new Error('Live child terminated by ' + signal + '; inspect broker before retry')) : resolve(code ?? 1));
  });
}

async function prepareBroker() {
  const { cfg } = require('../src/config').loadConfig({ routing: 'queue' });
  const { QueueClient } = require('../src/queue-client');
  const client = new QueueClient('live:startup:' + randomUUID(), { cfg });
  try {
    await client.register({ autoStart: false });
    const status = await client.call('status');
    if (status.buildHash !== require('../src/queue-instance').buildHash()) {
      throw new Error('Shared broker build differs from this test source; coordinate an explicit owner-managed update before running. No broker was started or reloaded.');
    }
  } finally { client.dispose(); }
}

async function captureBaseline() {
  const { cfg } = require('../src/config').loadConfig({ routing: 'queue' });
  const { QueueClient } = require('../src/queue-client');
  const client = new QueueClient('live:baseline:' + randomUUID(), { cfg });
  const body = `import adsk.core, json
a = adsk.core.Application.get()
print(json.dumps(dict(documents=[dict(creationId=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified) for d in a.documents],activeCreationId=a.activeDocument.creationId if a.activeDocument else None)))`;
  const payload = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: cfg.backend === 'addin'
    ? { name: 'execute_python', arguments: { code: body, persistent: false } }
    : { name: cfg.tool, arguments: { featureType: 'script', object: { readOnly: true,
      script: 'def run(context):\n' + body.split('\n').map(line => '    ' + line).join('\n') } } } };
  const job = await client.submit({ kind: 'rpc', payload, timeoutMs: cfg.timeoutMs, backend: cfg.backend,
    cwd: path.resolve(__dirname, '..'), buildHash: require('../src/queue-instance').buildHash() });
  const value = await client.wait(job.id);
  const response = require('./helpers/live-broker').rpcResponse(value, client);
  if (value.job.state !== 'succeeded') throw new Error('Baseline capture failed; inspect job ' + job.id);
  const message = JSON.parse(response.raw);
  const text = message.result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  return JSON.parse(cfg.backend === 'addin' ? JSON.parse(text).stdout : text);
}

async function run(argv = process.argv.slice(2), settings = {}) {
  const { routing, concurrency, suite, args } = parseOptions(argv);
  if (suite === 'all') {
    const sourceBefore = testSourceHash();
    if (args.length) throw new Error('all accepts only --routing and --concurrency');
    await prepareBroker();
    let baselineFile;
    const directory = path.resolve(__dirname, '../.test-artifacts/live-scope', randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    baselineFile = path.join(directory, 'baseline.json');
    fs.writeFileSync(baselineFile, JSON.stringify(await captureBaseline()));
    const names = [...suites];
    const results = await runBatch(names, routing, name => run([name, '--routing', routing, ...(optIns[name] || [])], { baselineFile }), concurrency);
    if (baselineFile) {
      const before = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
      const after = await captureBaseline();
      fs.writeFileSync(path.join(path.dirname(baselineFile), 'after.json'), JSON.stringify(after));
      const ids = new Set(before.documents.map(doc => doc.creationId));
      const stable = documents => [...documents].sort((a, b) => a.creationId.localeCompare(b.creationId));
      const preserved = JSON.stringify(stable(before.documents)) === JSON.stringify(stable(after.documents.filter(doc => ids.has(doc.creationId))));
      results.push({ suite: 'original-user-documents-preserved', exitCode: preserved ? 0 : 1 });
    }
    const sourceAfter = testSourceHash();
    results.push({ suite: 'live-test-source-stability', exitCode: sourceBefore === sourceAfter ? 0 : 1 });
    console.log(JSON.stringify({ routing, scheduling: 'bounded-parallel', concurrency,
      sourceBefore, sourceAfter, baselineFile, results }, null, 2));
    return results.some(result => result.exitCode !== 0) ? 1 : 0;
  }
  if (!suites.includes(suite) && !scopedSuites.includes(suite))
    throw new Error('Choose a live suite: ' + [...suites, ...scopedSuites].join(', '));
  let clientId;
  if (scopedSuites.includes(suite)) {
    for (const name of ['FMCAD_LIVE_CLIENT', 'FMCAD_LIVE_RUNTIME_ROOT', 'FMCAD_LIVE_DOC_NAME',
      'FMCAD_LIVE_DOC_ID', 'FMCAD_LIVE_FUSION_VERSION']) {
      if (!process.env[name]?.trim()) throw new Error(`The ${suite} fixed scope requires ${name}; no suite client or document is generated.`);
    }
    clientId = process.env.FMCAD_LIVE_CLIENT;
  } else clientId = 'live:' + suite + ':' + randomUUID();
  const env = { ...process.env, FMCAD_ROUTING: routing, FMCAD_CLIENT: clientId,
    FMCAD_LIVE_ROUTING: routing, FMCAD_LIVE_CLIENT: clientId, FMCAD_LIVE_SUITE: suite };
  if (settings.baselineFile) env.FMCAD_LIVE_BASELINE_FILE = settings.baselineFile;
  delete env.FMCAD_LIVE_SEQUENCE_ID;
  // The native import suites were migrated to TypeScript; execute their build
  // output so the runner cannot silently select an abandoned JS implementation.
  const directory = ['data-import', 'data-import-fixed'].includes(suite) ? path.join('dist', 'tests') : 'tests';
  const script = [path.join(directory, 'live-' + suite + '.js'), ...args];
  process.stderr.write(`LIVE ${suite}: routing=${routing}, client=${clientId}; no suite-wide lease\n`);
  return (settings.launch || runChild)(script, env);
}

if (require.main === module) run().then(code => { process.exitCode = code; }).catch(error => {
  console.error(error.stack); process.exitCode = 1;
});
module.exports = { run, suites, scopedSuites, parseOptions, runBatch, prepareBroker, captureBaseline, testSourceHash };

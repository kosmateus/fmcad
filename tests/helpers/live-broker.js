'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createBrokerTransport } = require('../../packages/node-adapters/dist/fusion-transport/broker');
const { requestTimeout } = require('../../packages/node-adapters/dist/execution/request-timeout');
const { resolveRuntimePaths } = require('../../packages/node-adapters/dist/config-platform');
const scope = require('./live-scope');
const { resolveQualifiedLiveRuntime } = require('./qualified-live-runtime');

function commandScript(code) {
  return `import contextlib, io, json, traceback, re
def run(_context: str):
    captured_out, captured_err = io.StringIO(), io.StringIO()
    result = {'success': True}
    try:
        with contextlib.redirect_stdout(captured_out), contextlib.redirect_stderr(captured_err):
            exec(${JSON.stringify(code)}, {'__name__': '__main__',
                 '__fmcad_native_lifecycle__': globals().get('__fmcad_native_lifecycle__')})
    except Exception as error:
        result.update(success=False, error=str(error), traceback=traceback.format_exc())
    result.update(stdout=captured_out.getvalue(), stderr=captured_err.getvalue())
    # Do not hide a native workflow's pending state inside captured stdout.
    for line in result['stdout'].splitlines():
        text = line
        for marker in ('FMCAD_RESULT ', 'FMCAD_BRIDGE_RESULT '):
            if text.startswith(marker):
                text = text[len(marker):]
                break
        try:
            record = json.loads(text)
        except (ValueError, TypeError):
            continue
        if not isinstance(record, dict):
            continue
        for value in [record] + [record.get(key) for key in ('result', 'data', 'workflowOutcome', 'structuredContent')]:
            if not isinstance(value, dict):
                continue
            identity = value.get('nativeReceiptIdentity') or value.get('identity') or value
            if isinstance(identity, dict) and value.get('destroyed') is True:
                command = str(identity.get('commandId') or '')
                known_atomic = (re.fullmatch(r'fmcad_atomic_[a-f0-9]{32}', command)
                    and re.fullmatch(r'[a-f0-9]{64}', str(identity.get('requestHash') or ''))
                    and re.fullmatch(r'[a-f0-9]{32}', str(identity.get('sessionNonce') or ''))
                    and isinstance(identity.get('resolvedIdentity'), dict) and identity['resolvedIdentity'].get('creationId'))
                if identity.get('runId') and known_atomic:
                    continue
            operation = str(value.get('operation') or record.get('operation') or '')
            current, target = value.get('current'), value.get('target')
            cloud_processing = (operation == 'document.save_as' and value.get('accepted') is True
                and value.get('pending') is True and value.get('status') == 'pending'
                and value.get('targetObserved') is True and isinstance(current, dict) and isinstance(target, dict)
                and current.get('saved') is True and current.get('modified') is False and current.get('isComplete') is False
                and all(isinstance(current.get(k), str) and current[k] for k in ('creationId','fileId','fileName','projectId','folderId'))
                and target.get('name') == current['fileName'] and target.get('projectId') == current['projectId']
                and target.get('folderId') == current['folderId'])
            if (value.get('outcome') == 'unknown' or value.get('executionOutcome') == 'unknown'
                or value.get('status') in ('started', 'running', 'pending') and not cloud_processing or value.get('completed') is False
                or value.get('status') == 'unknown' and (operation.startswith(('batch.', 'ui.'))
                    or operation in ('references.refresh', 'document.save_as', 'review'))):
                result['executionOutcome'] = 'unknown'
    print(json.dumps(result))
`;
}

function context(env = process.env) {
  if (env.FMCAD_LIVE_ROUTING !== undefined && env.FMCAD_LIVE_ROUTING !== 'queue') {
    throw new Error('routing=direct is no longer supported; live tests require the shared broker');
  }
  if (!env.FMCAD_LIVE_CLIENT) {
    throw new Error('Run live tests through node tests/run-live.js <suite>; no direct fallback');
  }
  return { clientId: env.FMCAD_LIVE_CLIENT };
}

function commandFlags(env = process.env) {
  const value = context(env);
  return ['--routing', 'queue', '--client', value.clientId];
}

function spawnQueueCli(cliPath, args, options = {}) {
  return new Promise(resolve => {
    const child = childProcess.spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', error;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', value => { error = value; });
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr, error }));
  });
}

function runQueueExec({ cliPath, backend, clientId, requestId, timeoutMs, argv, cwd, env }) {
  return spawnQueueCli(cliPath, [
    'queue', 'exec', '--backend', backend, '--client', clientId,
    '--request-id', requestId, '--timeout', String(timeoutMs), '--', ...argv,
  ], { cwd, env });
}

async function readQueueResult({ cliPath, backend, clientId, jobId, cwd, env }) {
  const result = await spawnQueueCli(cliPath, [
    'queue', 'result', '--backend', backend, '--client', clientId,
    '--job', jobId,
  ], { cwd, env });
  if (result.status !== 0)
    throw new Error(`Could not read original queue result ${jobId}: ${result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Malformed original queue result ${jobId}`, { cause: error });
  }
}

async function readQueueStatus({ cliPath, backend, clientId, cwd, env }) {
  const result = await spawnQueueCli(cliPath, [
    'queue', 'status', '--backend', backend, '--client', clientId,
  ], { cwd, env });
  if (result.status !== 0)
    throw new Error(`Could not read queue status: ${result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error('Malformed queue status response', { cause: error });
  }
}

function queueInvocation(words, clientId, configuredBackend) {
  const valueOptions = [
    '--routing', '--client', '--backend', '--request-id', '--queue-timeout',
    '--sequence-action', '--sequence-id', '--sequence-mode',
    '--expected-revision', '--config',
  ];
  const argv = [], queueOptions = [];
  let backend = configuredBackend, requestId;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (!valueOptions.includes(word)) {
      argv.push(word);
      continue;
    }
    const value = words[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error('Missing value for live CLI option ' + word);
    if (word === '--routing') {
      if (value !== 'queue') throw new Error('routing=direct is not supported');
    } else if (word === '--client') {
      if (value !== clientId) throw new Error('Foreign live CLI client');
    } else if (word === '--backend') {
      if (value !== configuredBackend)
        throw new Error('Live CLI backend differs from the configured broker');
      backend = value;
    } else if (word === '--request-id') {
      if (requestId !== undefined) throw new Error('Duplicate live request ID');
      requestId = value;
    } else if (word === '--config') {
      throw new Error('Live commands may not override the qualified transport configuration');
    } else {
      queueOptions.push(word, value);
    }
    index++;
  }
  return { argv, backend, requestId: requestId || randomUUID(), queueOptions };
}

function legacyQueueDriver(handoffPath, cliPath, queueArgs, requestId, maxBuffer) {
  return `
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const handoff = require(${JSON.stringify(handoffPath)});
let result, failure;
try {
  handoff.beginCliIntent(process.env);
  result = childProcess.spawnSync(process.execPath, ${JSON.stringify([cliPath, ...queueArgs])}, {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 0, maxBuffer: ${maxBuffer}
  });
  if (result.error) throw result.error;
  const stderr = String(result.stderr || '');
  handoff.observeCliIntent(stderr, process.env);
  const jobs = stderr.split(/\\r?\\n/u).filter(line => line.startsWith('FMCAD_QUEUE_JOB '));
  if (jobs.length > 1) throw new Error('Duplicate original queue job receipts');
  if (jobs.length === 1) {
    const job = JSON.parse(jobs[0].slice('FMCAD_QUEUE_JOB '.length));
    const lease = JSON.parse(fs.readFileSync(process.env.FMCAD_LIVE_OWNED_SCOPE, 'utf8'));
    if (job.requestId !== ${JSON.stringify(requestId)} || lease.owner.clientId !== process.env.FMCAD_LIVE_CLIENT || typeof job.jobId !== 'string' || !job.jobId)
      throw new Error('Foreign original queue job receipt');
    const directory = path.join(path.dirname(process.env.FMCAD_LIVE_OWNED_SCOPE), 'queue-receipts');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, path.basename(process.env.FMCAD_LIVE_COMMAND_INTENT));
    fs.writeFileSync(filename, JSON.stringify({ version: 1, owner: lease.owner, requestId: job.requestId, jobId: job.jobId }), { flag: 'wx', mode: 0o600 });
  }
  handoff.finishCliIntent(Number.isInteger(result.status) ? result.status : 1, process.env);
} catch (error) {
  failure = error;
  try { handoff.finishCliIntent(1, process.env); } catch {}
}
if (result?.stdout) process.stdout.write(result.stdout);
if (result?.stderr) process.stderr.write(result.stderr);
if (failure) process.stderr.write(String(failure.stack || failure) + '\\n');
process.exitCode = failure ? 1 : Number.isInteger(result?.status) ? result.status : 1;
`;
}

function spawnSync(command, args, options) {
  if (path.basename(args?.[0] || '') === 'fmcad.js') {
    const cliPath = path.resolve(options?.cwd || process.cwd(), args[0]);
    const env = options?.env || process.env;
    const installedRoot = env.FMCAD_LIVE_RUNTIME_ROOT;
    const realCli = cliPath === path.resolve(__dirname, '../../bin/fmcad.js') ||
      installedRoot && cliPath === path.resolve(installedRoot, 'dist/bin/fmcad.js');
    if (realCli) {
      const identity = context(env);
      const handoff = require('../../dist/tests/scenarios/legacy-handoff');
      const owned = env.FMCAD_LIVE_OWNED_SCOPE
        ? handoff.reserveCli(args.slice(1), env)
        : null;
      const liveEnv = {
        ...(options?.env || process.env),
        ...scope.environment(),
        ...(owned ? { FMCAD_LIVE_COMMAND_INTENT: owned.filename } : {}),
      };
      const runtime = resolveQualifiedLiveRuntime(liveEnv);
      const loadRuntime = createRequire(path.join(runtime.dist, 'package.json'));
      const { cfg } = loadRuntime('./src/config').loadConfig({ routing: 'queue' });
      const simulatorEndpoint = liveEnv.FMCAD_SCENARIO_SIMULATOR_ENDPOINT;
      let simulatorUrl;
      try { simulatorUrl = new URL(cfg.url); } catch {}
      const privateSimulator = ['mcp', 'addin'].includes(cfg.backend) &&
        typeof simulatorEndpoint === 'string' && simulatorEndpoint === cfg.url &&
        simulatorUrl?.protocol === 'http:' && simulatorUrl.hostname === '127.0.0.1' &&
        Boolean(simulatorUrl.port) && simulatorUrl.pathname === '/mcp' &&
        !['27182', '8765'].includes(simulatorUrl.port) &&
        !simulatorUrl.username && !simulatorUrl.password &&
        !simulatorUrl.search && !simulatorUrl.hash;
      const qualifiedAddin = cfg.backend === 'addin' && cfg.url === 'http://127.0.0.1:8765/mcp' &&
        cfg.protocolVersion === '2025-06-18' && cfg.tool === 'execute_python';
      if (!privateSimulator && !qualifiedAddin)
        throw new Error('Live test commands require the qualified ADDIN endpoint');
      const words = owned ? owned.words : args.slice(1);
      const invocation = queueInvocation(words, identity.clientId, cfg.backend);
      if (owned && invocation.requestId !== words[words.indexOf('--request-id') + 1])
        throw new Error('Owned CLI request ID changed before queue submission');
      const queueArgs = [
        'queue', 'exec', '--backend', invocation.backend, '--client', identity.clientId,
        '--request-id', invocation.requestId, ...invocation.queueOptions,
        '--', ...invocation.argv,
      ];
      const executable = path.join(runtime.dist, 'bin/fmcad.js');
      options = { ...options, env: liveEnv, timeout: 0 };
      if (owned) {
        const driver = legacyQueueDriver(
          path.resolve(__dirname, '../../dist/tests/scenarios/legacy-handoff.js'),
          executable,
          queueArgs,
          invocation.requestId,
          options.maxBuffer || 64 * 1024 * 1024,
        );
        const result = childProcess.spawnSync(process.execPath, ['-e', driver], options);
        if (!result.error && result.status !== null)
          handoff.awaitCliSettlement(owned.filename, liveEnv);
        return result;
      }
      return childProcess.spawnSync(process.execPath, [executable, ...queueArgs], options);
    }
    args = [args[0], ...commandFlags(env), ...args.slice(1)];
  }
  return childProcess.spawnSync(command, args, options);
}

function rpcResponse(value, client) {
  if (!value.rpc && value.outputs?.rpc) {
    const expected = path.join(client.dir, 'jobs', value.job.id, 'rpc-result.json');
    if (path.resolve(value.outputs.rpc.path) !== expected) throw new Error('Unexpected RPC artifact path');
    const fd = fs.openSync(expected, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.fstatSync(fd).size > 16 * 1024 * 1024) throw new Error('RPC artifact exceeds 16 MiB');
      value.rpc = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  }
  if (!['succeeded', 'failed'].includes(value.job.state) || !value.rpc) {
    throw Object.assign(new Error(`Queue job ${value.job.id}: ${value.job.state} (${value.job.code}); inspect, never replay`),
      { code: 'QUEUE_RESULT_UNAVAILABLE', jobId: value.job.id });
  }
  return { ...value.rpc, queueReceipt: value.job };
}

function disposeBackend(client) {
  client.reqOpts?.agent?.destroy?.();
}

function createBackend(server, dependencies = {}) {
  const value = context(dependencies.clientId
    ? { ...process.env, FMCAD_LIVE_CLIENT: dependencies.clientId } : process.env);
  const runtime = resolveQualifiedLiveRuntime();
  const loadRuntime = createRequire(path.join(runtime.dist, 'package.json'));
  const queueModule = loadRuntime('./src/queue-client');
  const loadConfig = dependencies.loadConfig || loadRuntime('./src/config').loadConfig;
  if (!dependencies.queue && server.backend === 'addin' &&
      (server.url !== 'http://127.0.0.1:8765/mcp' ||
       server.protocolVersion !== '2025-06-18' || server.tool !== 'execute_python'))
    throw new Error('Internal transport qualification requires the qualified ADDIN endpoint');
  const client = (dependencies.createBackend || createBrokerTransport)({ ...server, routing: 'queue' }, {
    version: require('../../package.json').version,
    requestTimeout,
    bridgeSource: () => {
      const assets = resolveRuntimePaths({ anchor: path.resolve(__dirname, '../../src/queue-broker.js') }).assets;
      return fs.readFileSync(path.join(assets, 'cad/identity.py'), 'utf8') + '\n' +
        fs.readFileSync(path.join(assets, 'addin-bridge.py'), 'utf8');
    },
  });
  const cfg = { ...loadConfig({ routing: 'queue' }).cfg, backend: server.backend || 'mcp' };
  const timeoutMs = server.timeoutMs ?? cfg.timeoutMs;
  const queue = dependencies.queue || new queueModule.QueueClient(value.clientId, { cfg });
  const post = client._post.bind(client);
  client._post = async (payload, sessionId, controlPlane) => {
    payload = scope.payload(payload);
    if (controlPlane) throw new Error('SDK traffic cannot bypass the broker');
    if (process.env.FMCAD_LIVE_OWNED_SCOPE) throw new Error('Owned native observations must use the journaled CLI command path');
    if (dependencies.registeredRequest && dependencies.diagnosticReadOnly !== true)
      throw new Error('Registered diagnostic transport requires explicit read-only intent');
    const command = dependencies.command === true && payload.params?.name === 'execute_python';
    if (dependencies.registeredRequest && command)
      throw new Error('Registered diagnostic transport requires raw read-only RPC; use journaled CLI for commands');
    let file, argv;
    if (command) {
      if (payload.params.arguments.persistent !== false) throw new Error('Live scripts require persistent:false');
      const directory = path.join('/tmp/opencode', 'fmcad-live-requests');
      fs.mkdirSync(directory, { recursive: true });
      file = path.join(directory, randomUUID() + '.py');
      fs.writeFileSync(file, commandScript(payload.params.arguments.code), { flag: 'wx', mode: 0o600 });
      argv = ['run', file];
    }
    const buildHash = runtime.fingerprint;
    const protocolVersion = client.negotiatedProtocolVersion || client.server.protocolVersion;
    const dispatch = async requestId => {
      const job = await queue.submit({ ...(command ? {
        kind: 'command', argv,
        inputFiles: queueModule.inputFiles(argv, process.cwd()),
      } : { kind: 'rpc', payload, ...(sessionId ? { sessionId } : {}) }),
        buildHash, protocolVersion, requestId, cwd: process.cwd(), backend: cfg.backend, timeoutMs,
        description: 'Live integration ' + (process.env.FMCAD_LIVE_SUITE || 'test') + ': ' + (payload.params?.name || payload.method) });
      const result = await queue.wait(job.id);
      return { job, result };
    };
    const { job, result } = dependencies.registeredRequest
      ? await dependencies.registeredRequest('transport-rpc', {
        readOnly: true, payload, sessionId, protocolVersion, buildHash,
      }, async binding => {
        if (binding.owner.clientId !== value.clientId) throw new Error('Foreign registered transport owner');
        const observed = await dispatch(binding.requestId);
        if (observed.job.id !== observed.result.job.id) throw new Error('Foreign original transport result');
        return { value: observed,
          execution: require('../../dist/tests/scenarios/queue-backend').queueExecution(observed.result, binding.owner, binding.requestId) };
      })
      : await dispatch(randomUUID());
    let response;
    if (command) {
      if (!['succeeded', 'failed'].includes(result.job.state) || !result.stdout?.trim()) {
        throw new Error(`Queue command ${job.id}: ${result.job.state} (${result.job.code}); inspect, never replay`);
      }
      // Keep the real CLI/addin payload. Missing/malformed output is rejected by
      // the existing native client parser; it is never converted to success.
      response = { status: 200, queueReceipt: result.job, raw: JSON.stringify({ jsonrpc: '2.0', id: payload.id,
        result: { isError: result.job.state === 'failed', content: [{ type: 'text', text: result.stdout.trimEnd() }] } }) };
      fs.unlinkSync(file);
    } else response = rpcResponse(result, queue);
    process.stderr.write('FMCAD_LIVE_RPC ' + JSON.stringify({ jobId: job.id, state: response.queueReceipt.state }) + '\n');
    return response;
  };
  return client;
}

module.exports = {
  context,
  commandFlags,
  spawnSync,
  createBackend,
  disposeBackend,
  rpcResponse,
  commandScript,
  runQueueExec,
  readQueueResult,
  readQueueStatus,
  fixture: scope.fixture,
};

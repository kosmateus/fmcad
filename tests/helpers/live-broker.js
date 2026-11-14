'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { QueueClient } = require('../../src/queue-client');
const { loadConfig } = require('../../src/config');
const { createBrokerTransport } = require('../../packages/node-adapters/dist/fusion-transport/broker');
const { requestTimeout } = require('../../src/request-timeout');
const { resolveRuntimePaths } = require('../../src/dist/config-platform');
const scope = require('./live-scope');

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

function spawnSync(command, args, options) {
  if (path.basename(args?.[0] || '') === 'fmcad.js') {
    const cliPath = path.resolve(options?.cwd || process.cwd(), args[0]);
    const installedRoot = (options?.env || process.env).FMCAD_LIVE_RUNTIME_ROOT;
    const realCli = cliPath === path.resolve(__dirname, '../../bin/fmcad.js') ||
      installedRoot && cliPath === path.resolve(installedRoot, 'dist/bin/fmcad.js');
    const owned = realCli && process.env.FMCAD_LIVE_OWNED_SCOPE
      ? require('../../dist/tests/scenarios/legacy-handoff').reserveCli(args.slice(1), options?.env || process.env) : null;
    args = owned ? [args[0], ...owned.words] : [args[0], ...commandFlags(), ...args.slice(1)];
    if (realCli) args[0] = path.join(__dirname, 'live-cli.js');
    options = { ...options, env: { ...(options?.env || process.env), ...scope.environment(),
      ...(owned ? { FMCAD_LIVE_COMMAND_INTENT: owned.filename } : {}) } };
    // The CLI/broker owns SDK and queue budgets separately. A wall-clock child
    // timeout would also count queue waiting and could kill an admitted caller.
    if (context()) options = { ...options, timeout: 0 };
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
  const client = (dependencies.createBackend || createBrokerTransport)({ ...server, routing: 'queue' }, {
    version: require('../../package.json').version,
    requestTimeout,
    bridgeSource: () => {
      const assets = resolveRuntimePaths({ anchor: path.resolve(__dirname, '../../src/queue-broker.js') }).assets;
      return fs.readFileSync(path.join(assets, 'cad/identity.py'), 'utf8') + '\n' +
        fs.readFileSync(path.join(assets, 'addin-bridge.py'), 'utf8');
    },
  });
  const cfg = { ...(dependencies.loadConfig || loadConfig)({ routing: 'queue' }).cfg, backend: server.backend || 'mcp',
    timeoutMs: server.timeoutMs };
  const queue = dependencies.queue || new QueueClient(value.clientId, { cfg });
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
    const buildHash = require('../../src/queue-instance').buildHash();
    const protocolVersion = client.negotiatedProtocolVersion || client.server.protocolVersion;
    const dispatch = async requestId => {
      const job = await queue.submit({ ...(command ? {
        kind: 'command', argv,
        inputFiles: require('../../src/queue-client').inputFiles(argv, process.cwd()),
      } : { kind: 'rpc', payload, ...(sessionId ? { sessionId } : {}) }),
        buildHash, protocolVersion, requestId, cwd: process.cwd(), backend: cfg.backend, timeoutMs: cfg.timeoutMs,
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

module.exports = { context, commandFlags, spawnSync, createBackend, disposeBackend, rpcResponse, commandScript, fixture: scope.fixture };

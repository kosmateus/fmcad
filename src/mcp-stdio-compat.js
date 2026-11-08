// Retained queue/transport compatibility adapters for the typed stdio root.
const { createHash, randomUUID } = require('node:crypto');
const { resolveMcpProjectDirectory } = require('./queue-client');
const { mcpRequestState } = require('./invocation');
const { redactDiagnostic, formatJsonError } = require('./diagnostics');
let libraryCatalog, mcpTools, byMcpName, contracts, mcpInvocation, localInvocation;
const { executeInvocation, invocationFailed } = require('./catalog/execute');

function configureCatalogServices(catalog, tools = catalog.tools(), catalogContracts = catalog.list()) {
  libraryCatalog = catalog;
  mcpTools = tools;
  byMcpName = new Map(tools.map(tool => [tool.name, tool]));
  contracts = Object.fromEntries(catalogContracts.map(contract => [contract.operation, contract]));
  mcpInvocation = catalog.fromMcp;
  localInvocation = catalog.isLocal;
}

function ensureCatalogServices() {
  if (!libraryCatalog) {
    const catalog = require('./dist/api').createCatalogServices();
    configureCatalogServices(catalog);
  }
}

function responseMessages(raw) {
  return require('./dist/entrypoints/mcp-framing').parseMcpResponseMessages(raw);
}

const { queueTools, validateQueueHelperArguments } = require('./dist/composition/library-mcp-tools');
const QUEUED_ACCEPT_MS = 1000;
const MAX_OWNED_MCP_RESPONSE_BYTES = 128 * 1024 * 1024;
// Log before OpenCode's 10 MiB read-buffer ceiling, with a 2 MiB safety margin.
const SIZE_DIAGNOSTIC_THRESHOLD_BYTES = 8 * 1024 * 1024;
const MAX_SIZE_DIAGNOSTICS = 20;
const SAFE_DIAGNOSTIC_METHODS = new Set([
  'initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call',
  'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get',
]);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const invalidQueueParams = message => { throw Object.assign(new Error(message), { code: 'INVALID_QUEUE_PARAMS' }); };

function receipt(job) {
  return { jobId: job.id, revision: job.revision ?? null, sequenceId: job.sequenceId ?? null,
    sequenceState: job.sequenceState ?? null, state: job.state };
}

function queueMetadata(request) {
  const meta = request.params?._meta;
  if (request.method !== 'tools/call' || !object(meta) || !Object.hasOwn(meta, 'fmcad')) return { payload: request, options: {} };
  const options = meta.fmcad;
  if (!object(options) || Object.keys(options).some(key => !['sequence', 'expectedRevision', 'requestId', 'description', 'projectDirectory', 'roots', 'sessionId', 'doc', 'docId', 'docFileId', 'projectId', 'purpose'].includes(key))) {
    invalidQueueParams('params._meta.fmcad accepts only queue options and validated client context fields');
  }
  if (options.description !== undefined) require('./invocation').description(options.description);
  if (options.sequence !== undefined) {
    const seq = options.sequence;
    if (!object(seq) || Object.keys(seq).some(key => !['action', 'id'].includes(key)) ||
        !['continue', 'end'].includes(seq.action) || !identifier(seq.id)) {
      invalidQueueParams('sequence requires action continue|end and id; begin with fmcad_queue_begin');
    }
  }
  if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)) {
    invalidQueueParams('expectedRevision must be a nonnegative safe integer');
  }
  if (options.requestId !== undefined && !identifier(options.requestId)) invalidQueueParams('requestId must contain 1..256 characters');
  if (options.sessionId !== undefined && !identifier(options.sessionId)) invalidQueueParams('sessionId must contain 1..256 characters');
  for (const key of ['doc', 'docId', 'docFileId', 'projectId']) {
    if (options[key] !== undefined && !identifier(options[key])) invalidQueueParams(key + ' must contain 1..256 characters');
  }
  if (options.purpose !== undefined) require('./invocation').description(options.purpose);
  if (options.description !== undefined && options.purpose !== undefined && options.description !== options.purpose) {
    invalidQueueParams('Conflicting purpose and description');
  }
  if (options.projectDirectory !== undefined && (!identifier(options.projectDirectory) || options.projectDirectory.length > 4096)) {
    invalidQueueParams('projectDirectory must contain 1..4096 characters');
  }
  if (options.roots !== undefined && (!Array.isArray(options.roots) || options.roots.length > 32 || options.roots.some(root =>
    !object(root) || Object.keys(root).some(key => !['uri', 'name'].includes(key)) || !identifier(root.uri) ||
    (root.name !== undefined && typeof root.name !== 'string')))) {
    invalidQueueParams('roots must be at most 32 local MCP root hints with a URI and optional name');
  }
  const upstreamMeta = { ...meta };
  delete upstreamMeta.fmcad;
  const params = { ...request.params, _meta: upstreamMeta };
  if (!Object.keys(upstreamMeta).length) delete params._meta;
  return { payload: { ...request, params }, options: { ...options,
    ...(options.description !== undefined ? { description: require('./invocation').description(options.description) } : {}) } };
}

function createQueuePost(client, cfg, queueTimeoutMs, context = {}) {
  let registration;
  const ready = (autoStart = true) => registration ||= Promise.resolve().then(() => client.register({ autoStart })).catch(error => {
    registration = undefined;
    throw error;
  });
  const post = async (request, session, version) => {
    ensureCatalogServices();
    let requestId = randomUUID(), job, clientContext, admissionAttempted = false;
    const reply = result => ({ status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
    const helperResult = value => reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
    try {
      const helper = request.method === 'tools/call' && queueTools.find(tool => tool.name === request.params?.name);
      const { payload, options } = queueMetadata(request);
      requestId = options.requestId || requestId;
      if (context.sessionId && options.sessionId && options.sessionId !== context.sessionId) {
        invalidQueueParams('sessionId is assigned by the MCP owner context');
      }
      const catalogCall = request.method === 'tools/call' && byMcpName.has(request.params?.name)
        ? mcpInvocation(request.params.name, request.params.arguments) : null;
      if (helper) {
        if (!Object.hasOwn(request, 'id')) throw Object.assign(new Error('Queue helpers require a request id'), { code: 'unsupported_queue_route' });
        if (request.params?._meta && Object.hasOwn(request.params._meta, 'fmcad')) invalidQueueParams('Queue helper tools do not accept fmcad metadata');
        const args = validateQueueHelperArguments(helper, request.params.arguments);
        await ready(helper.name === 'fmcad_queue_begin');
        switch (helper.name) {
          case 'fmcad_queue_end': return helperResult(await client.call('release', { sequenceId: args.sequenceId }));
          case 'fmcad_queue_status': return helperResult(await client.call('queue-summary'));
          case 'fmcad_queue_result': {
            const value = await client.call('result', { jobId: args.jobId });
            const context = client.readRequestContext?.(value.job.requestId) ?? null;
            const response = helperResult({ ...value, context });
            return { ...response, queueReceipt: { ...receipt(value.job), requestId: value.job.requestId,
              requestStatus: mcpRequestState(value.job.state), context } };
          }
          case 'fmcad_queue_request': {
            const value = await client.findRequest(args.requestId);
            const result = value?.job ? {
              requestId: args.requestId,
              jobId: value.job.id,
              status: mcpRequestState(value.job.state),
              job: value.job,
              context: value.context,
              ...value,
            } : {
              requestId: args.requestId,
              jobId: null,
              status: 'needs_reconciliation',
              context: value?.context ?? null,
              instruction: 'No owned receipt is visible in this broker snapshot. Do not resubmit an uncertain request; inspect again after reconnecting.',
            };
            const response = helperResult(result);
            return { ...response, ...(value?.job ? { queueReceipt: receipt(value.job) } : {}) };
          }
          case 'fmcad_queue_reconcile': {
            const value = await client.call('reconcile', { jobId: args.jobId,
              ...(args.acceptedOutcome === undefined ? {} : { acceptedOutcome: args.acceptedOutcome }) });
            const job = await client.call('status', { jobId: args.jobId });
            const context = job?.clientId === client.auth.clientId
              ? client.readRequestContext?.(job.requestId) ?? null
              : null;
            return { ...helperResult({ ...value, context }), queueReceipt: { ...receipt(job || value),
              ...(job?.clientId === client.auth.clientId ? { requestId: job.requestId, context } : {}) } };
          }
        }
      }
      const begin = helper?.name === 'fmcad_queue_begin';
      const selectedProject = begin ? { projectDirectory: null, source: 'none' } : resolveMcpProjectDirectory({
        ...(options.projectDirectory !== undefined ? { projectDirectory: options.projectDirectory }
          : context.projectDirectory !== undefined && context.projectDirectory !== null ? { projectDirectory: context.projectDirectory } : {}),
        ...(options.roots !== undefined ? { roots: options.roots } : {}),
      });
      if (!begin && !selectedProject.projectDirectory) {
        throw Object.assign(new Error('A validated projectDirectory is required for queued MCP execution; select --project or provide one validated MCP root'),
          { code: 'MCP_PROJECT_REQUIRED', notStarted: true });
      }
      clientContext = {
        clientId: client.auth?.clientId ?? context.clientId ?? 'mcp-client',
        requestId,
        sessionId: options.sessionId || context.sessionId,
        ...(selectedProject.projectDirectory ? { projectDirectory: selectedProject.projectDirectory } : {}),
        ...(catalogCall?.invocation.projectId ? { projectId: catalogCall.invocation.projectId } : options.projectId !== undefined ? { projectId: options.projectId } : {}),
        ...(catalogCall?.invocation.doc ? { doc: catalogCall.invocation.doc } : options.doc !== undefined ? { doc: options.doc } : {}),
        ...(catalogCall?.invocation.docId ? { docId: catalogCall.invocation.docId } : options.docId !== undefined ? { docId: options.docId } : {}),
        ...(catalogCall?.invocation.docFileId ? { docFileId: catalogCall.invocation.docFileId } : options.docFileId !== undefined ? { docFileId: options.docFileId } : {}),
        ...(catalogCall?.invocation.purpose ? { purpose: catalogCall.invocation.purpose } : options.purpose ? { purpose: options.purpose } : options.description ? { purpose: options.description } : {}),
        ...(options.expectedRevision !== undefined ? { expectedRevision: options.expectedRevision } : {}),
      };
      const { projectDirectory: _projectDirectory, roots: _roots, sessionId: _sessionId,
        doc: _doc, docId: _docId, docFileId: _docFileId, projectId: _projectId, purpose: _purpose,
        ...queueOptions } = options;
      await ready();
      const input = { ...(catalogCall ? { kind: 'command', argv: catalogCall.argv, payload: catalogCall.invocation,
          buildHash: require('./queue-instance').buildHash(),
          ...(catalogCall.invocation.purpose !== undefined ? { description: catalogCall.invocation.purpose } : {}) }
        : { kind: 'rpc', payload: begin ? { jsonrpc: '2.0', id: request.id, method: 'ping' } : payload }),
        ...(session ? { sessionId: session } : {}), ...(version ? { protocolVersion: version } : {}), timeoutMs: cfg.timeoutMs,
        ...(selectedProject.projectDirectory ? { cwd: selectedProject.projectDirectory } : {}),
        clientContext,
        requestId, backend: cfg.backend, ...queueOptions,
        ...(queueTimeoutMs !== undefined ? { queueTimeoutMs } : {}),
        ...(begin ? { sequence: { action: 'begin', mode: 'exclusive' } } : {}) };
      if (!begin) client.persistRequestContext?.(requestId, clientContext);
      let recovered;
      try {
        admissionAttempted = !begin;
        job = await client.submit(input);
      } catch (error) {
        try { recovered = await client.findRequest(requestId); }
        catch { throw error; }
        if (!recovered?.job) throw error;
        job = recovered.job;
      }
      const controller = new AbortController();
      const completion = (recovered
        ? Promise.resolve(recovered)
        : client.wait(job.id, { signal: controller.signal }))
        .then(value => ({ value }), error => ({ error }));
      let timer;
      const first = await Promise.race([completion, new Promise(resolve => {
        timer = setTimeout(() => resolve(null), QUEUED_ACCEPT_MS);
      })]);
      clearTimeout(timer);
      if (first === null) {
        const current = await client.call('result', { jobId: job.id });
        if (['preparing', 'processing', 'queued', 'running', 'sending', 'needs_reconciliation'].includes(current.job?.state)) {
          controller.abort();
          const accepted = { status: current.job.state === 'queued' ? 'QUEUED' : 'ACCEPTED', jobId: job.id, state: current.job.state,
            ...(current.job.state === 'queued' ? { executed: false } : {}),
            instruction: 'Poll fmcad_queue_result with this jobId; do not resubmit this task.' };
          return { ...reply({ content: [{ type: 'text', text: JSON.stringify(accepted) }], structuredContent: accepted }),
            queueReceipt: { ...receipt(current.job), requestId, requestStatus: mcpRequestState(current.job.state), context: clientContext }, queueTools: true };
        }
      }
      const outcome = first || await completion;
      if (outcome.error) throw outcome.error;
      const value = outcome.value;
      job = value.job;
      if (value.execution?.pythonCheck) {
        const result = { success: false, status: value.execution.pythonCheck.status,
          code: value.execution.code, executionOutcome: value.execution.executionOutcome,
          mayHaveMutated: value.execution.mayHaveMutated, pythonCheck: value.execution.pythonCheck };
        return { ...reply({ isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }),
          queueReceipt: receipt(job), queueTools: true };
      }
      if (catalogCall) {
        if (!['succeeded', 'failed'].includes(job.state)) throw Object.assign(new Error('Catalog job requires reconciliation; inspect its owned result, do not resubmit'), { code: 'QUEUE_RESULT_UNAVAILABLE' });
        let stdout = value.stdout;
        if (value.outputs?.stdout) {
          const reference = value.outputs.stdout.artifact;
          if (reference?.name !== 'stdout.txt') throw new Error('Missing owned catalog result artifact reference');
          stdout = require('./queue-response-files').readOwnedResult(client.dir,
            { jobId: job.id, ...(input.cwd ? { cwd: input.cwd } : {}) },
            reference, MAX_OWNED_MCP_RESPONSE_BYTES).toString('utf8');
        }
        if (typeof stdout !== 'string' || !stdout.trim()) throw Object.assign(new Error('Catalog result unavailable; inspect owned job diagnostics before any resubmission'), { code: 'QUEUE_RESULT_UNAVAILABLE' });
        const result = JSON.parse(stdout);
        return { ...reply(catalogResult(result, catalogCall.operation, job.state !== 'succeeded')),
          queueReceipt: { ...receipt(job), requestId, requestStatus: mcpRequestState(job.state), context: clientContext },
          artifactOwner: { jobId: job.id, ...(input.cwd ? { cwd: input.cwd } : {}) }, queueTools: true };
      }
      const ownedArtifact = value.outputs?.rpc?.artifact;
      if (!value.rpc && value.outputs?.rpc) {
        const { readOwnedResult } = require('./queue-response-files');
        const reference = value.outputs.rpc.artifact;
        if (reference?.name !== 'rpc-result.json') throw new Error('Missing owned RPC artifact reference');
        value.rpc = JSON.parse(readOwnedResult(client.dir,
          { jobId: job.id, ...(input.cwd ? { cwd: input.cwd } : {}) },
          reference, MAX_OWNED_MCP_RESPONSE_BYTES).toString('utf8'));
      }
      if (!['succeeded', 'failed'].includes(job.state) || !value.rpc) {
        throw Object.assign(new Error('Queue job ' + job.id + ' is ' + job.state +
          ' (' + (job.code || value.execution?.code || 'RAW_RESULT_UNAVAILABLE') + '); inspect its result before any resubmission'), { code: 'QUEUE_RESULT_UNAVAILABLE' });
      }
      const response = { ...value.rpc,
        ...(ownedArtifact?.name === 'rpc-result.json' ? { ownedArtifact } : {}),
        queueReceipt: { ...receipt(job), requestId,
          requestStatus: mcpRequestState(job.state), context: clientContext },
        artifactOwner: { jobId: job.id, ...(input.cwd ? { cwd: input.cwd } : {}) }, queueTools: true };
      if (begin) {
        // Validate the physical ping before replacing its payload with the lease receipt.
        const messages = responseMessages(response.raw);
        const ping = messages.find(message => message.id === request.id && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')));
        if (response.status < 200 || response.status >= 300 || !ping || messages.some(message => message.jsonrpc !== '2.0')) {
          throw new Error('Missing or invalid matching MCP response for queue sequence begin');
        }
        if (ping.error) return response;
        if (job.state !== 'succeeded') throw new Error('Queue sequence begin failed; inspect job ' + job.id);
        const result = { content: [{ type: 'text', text: JSON.stringify(receipt(job)) }], structuredContent: receipt(job) };
        const replies = messages.map(message => message === ping ? { ...message, result } : message);
        return { ...response, raw: replies.length === 1 ? JSON.stringify(replies[0])
          : replies.map(message => 'data: ' + JSON.stringify(message) + '\n\n').join('') };
      }
      return response;
    } catch (error) {
      if (!Object.hasOwn(request, 'id')) throw error;
      const validationRequired = error.notStarted === true ||
        ['INVALID_QUEUE_PARAMS', 'MCP_PROJECT_REQUIRED', 'unsupported_queue_route', 'REQUEST_CONTEXT_CONFLICT'].includes(error.code);
      const requestStatus = job ? mcpRequestState(job.state)
        : validationRequired || !admissionAttempted ? 'rejected-before-admission' : 'needs_reconciliation';
      return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
        code: -32000, message: error instanceof SyntaxError ? formatJsonError(error)
          : redactDiagnostic((error.code ? error.code + ': ' : '') + error.message, cfg),
        data: { requestId, requestStatus,
          ...(validationRequired ? { validation: { status: 'required', diagnostics: [error.message] } } : {}),
          ...(clientContext ? { context: clientContext } : {}),
          ...(job ? { fmcad: { ...receipt(job), requestId, requestStatus, context: clientContext ?? null } } : {}),
          ...(error.pythonCheck ? { pythonCheck: error.pythonCheck } : {}),
          ...(error.notStarted ? { executionOutcome: 'not_started', mayHaveMutated: false } : {}) },
      } }) };
    }
  };
  post.close = () => client.dispose?.();
  return post;
}

function catalogResult(result, operation, failed = false) {
  if (!object(result)) throw new Error('Invalid catalog application result');
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
    isError: failed || invocationFailed(result, operation) };
}

/** Application catalog routes are local metadata and typed CAD requests. Raw
 * backend requests retain the transport path, sessions and owned-artifact reads. */
function createCatalogPost(post, { queued, cfg = {},
  execute = executeInvocation } = {}) {
  return async (request, session, version) => {
    ensureCatalogServices();
    const reply = result => ({ status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
    if (request.method === 'tools/list') return Object.hasOwn(request, 'id')
      ? reply({ tools: [...mcpTools, ...(queued ? queueTools : [])] }) : { status: 204, raw: '' };
    const name = request.params?.name;
    if (request.method !== 'tools/call' || typeof name !== 'string' || !name.startsWith('fmcad_cad_')) return post(request, session, version);
    let call, options;
    try {
      if (!Object.hasOwn(request, 'id')) throw new Error('Catalog calls require a request id');
      options = queueMetadata(request).options;
      const args = request.params.arguments;
      if (options.description !== undefined && args?.purpose !== undefined &&
          require('./invocation').description(args.purpose) !== options.description) throw new Error('Conflicting purpose and metadata description');
      call = mcpInvocation(name, { ...args, ...(options.description !== undefined ? { purpose: options.description } : {}) });
      if (!localInvocation(call.invocation)) {
        if (!contracts[call.operation].requirements.backends.includes(cfg.backend || 'mcp')) throw new Error(call.operation + ' requires the addin backend; no fallback');
        if (queued && call.operation === 'animation.play') throw new Error('unsupported_queue_route: asynchronous animation.play has no terminal queue receipt');
      }
    } catch (error) {
      if (!Object.hasOwn(request, 'id')) throw error;
      return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32602, message: redactDiagnostic(error.message, cfg) } }) };
    }
    if (queued && !localInvocation(call.invocation)) {
      return post({ ...request, params: { ...request.params, arguments: {
        ...request.params.arguments, ...(call.invocation.purpose !== undefined ? { purpose: call.invocation.purpose } : {}),
      } } }, session, version);
    }
    if (options.sequence || options.expectedRevision !== undefined) {
      return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32602, message: 'Local/direct catalog execution does not accept queue sequence or revision metadata' } }) };
    }
    try {
      if (!localInvocation(call.invocation)) {
        throw new Error('unsupported_queue_route: MCP SDK execution requires the broker');
      }
      return reply(catalogResult(await execute(call.invocation, null), call.operation));
    } catch (error) {
      return { status: 200, raw: JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32000, message: redactDiagnostic(error.message, cfg) } }) };
    }
  };
}

// Framing only: preserve responses from the catalog/application or physical post.
// Do not initialize a second session, adapt Python, or retry a failed request.
function createForwarder(post, send, log = () => {}, cfg = {}) {
  let session;
  let version;
  // startStdio constructs one forwarder for each stdio process.
  let sizeDiagnosticCount = 0;
  const clientInstanceId = randomUUID();
  const requestIdSalt = randomUUID();
  return async line => {
    let request;
    try {
      request = JSON.parse(line);
    } catch (_) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } });
      return;
    }
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
        (Object.hasOwn(request, 'id') && request.id !== null && typeof request.id !== 'string' &&
          (typeof request.id !== 'number' || !Number.isFinite(request.id)))) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Expected a JSON-RPC request or notification' } });
      return;
    }
    const hasId = Object.hasOwn(request, 'id');
    let response;
    try {
      response = await post(request, session, version);
      if (response.status < 200 || response.status >= 300) throw new Error('HTTP ' + response.status);
      if (response.sessionId) session = response.sessionId;
      let messages = responseMessages(response.raw);
      if (request.method === 'resources/templates/list' && hasId && messages.length === 1 &&
          messages[0].jsonrpc === '2.0' && messages[0].id === request.id &&
          messages[0].error?.code === -32601 && !Object.hasOwn(messages[0], 'result')) {
        messages = [{ jsonrpc: '2.0', id: request.id, result: { resourceTemplates: [] } }];
      }
      if (hasId && !messages.some(message => message.id === request.id &&
          (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')))) {
        throw new Error('Missing matching MCP response');
      }
      for (const message of messages) {
        if (message.jsonrpc !== '2.0') throw new Error('Invalid upstream JSON-RPC message');
      }
      for (const message of messages) {
        if (message.id !== request.id) continue;
        if (response.queueTools && request.method === 'tools/list' && Array.isArray(message.result?.tools)) {
          message.result.tools = [...message.result.tools.filter(tool => !queueTools.some(local => local.name === tool.name)), ...queueTools];
        }
        if (response.queueReceipt && object(message.result)) message.result._meta = { ...message.result._meta, fmcad: response.queueReceipt };
        if (response.queueReceipt && object(message.error)) message.error.data = { ...message.error.data, fmcad: response.queueReceipt };
      }
      if (request.method === 'initialize') {
        version = messages.find(message => message.id === request.id)?.result?.protocolVersion;
      }
      let stdoutFrameBytes;
      for (const message of messages) {
        const isMatchingResponse = message.id === request.id &&
          (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'));
        const frame = JSON.stringify(message) + '\n';
        send(message, frame);
        if (isMatchingResponse) stdoutFrameBytes = Buffer.byteLength(frame, 'utf8');
      }
      if (hasId && stdoutFrameBytes !== undefined && sizeDiagnosticCount < MAX_SIZE_DIAGNOSTICS) {
        const upstreamResponseBytes = Buffer.byteLength(response.raw || '', 'utf8');
        if (upstreamResponseBytes >= SIZE_DIAGNOSTIC_THRESHOLD_BYTES || stdoutFrameBytes >= SIZE_DIAGNOSTIC_THRESHOLD_BYTES) {
          sizeDiagnosticCount++;
          const requestIdHash = createHash('sha256')
            .update(requestIdSalt).update('\0').update(JSON.stringify(request.id)).digest('hex').slice(0, 24);
          const toolName = request.method === 'tools/call' && typeof request.params?.name === 'string' &&
            /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(request.params.name) ? request.params.name : undefined;
          const event = {
            event: 'mcp_response_size',
            pid: process.pid,
            clientInstanceId,
            // `fusion` and `fusion_addin` share this command without alias-specific args or env.
            serverAlias: null,
            backend: ['mcp', 'addin'].includes(cfg.backend) ? cfg.backend : 'unknown',
            routing: cfg.routing === 'queue' ? 'queue' : 'unknown',
            requestIdHash,
            method: SAFE_DIAGNOSTIC_METHODS.has(request.method) ? request.method : 'other',
            ...(toolName ? { toolName } : {}),
            upstreamResponseBytes,
            stdoutFrameBytes,
            thresholdBytes: SIZE_DIAGNOSTIC_THRESHOLD_BYTES,
          };
          try { log('[fmcad-mcp-size] ' + JSON.stringify(event)); } catch { /* Diagnostics must not affect MCP output. */ }
        }
      }
    } catch (error) {
      const detail = error instanceof SyntaxError && /^\s+at JSON\.parse \(/m.test(error.stack || '')
        ? formatJsonError(error) : redactDiagnostic(error.message, cfg);
      const message = 'Fusion MCP connection error; no retry was performed. An operation may have run: ' + detail;
      if (hasId) send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message,
        ...(response?.queueReceipt ? { data: { fmcad: response.queueReceipt } } : {}) } });
      else log(message);
    }
  };
}

module.exports = { responseMessages, createQueuePost, createCatalogPost, createForwarder, configureCatalogServices, queueTools };

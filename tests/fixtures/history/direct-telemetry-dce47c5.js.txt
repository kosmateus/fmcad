'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { resolveProject } = require('./console-project');
const { durable, processBirth } = require('./queue-instance');
const core = require('./dist/core');
const { createProjectPresencePort } = require('./dist/node-adapters/telemetry/client-presence');

// Transport observations only: never persist RPC arguments, output or credentials.
function createTelemetry({ cwd = process.cwd(), now = Date.now, intervalMs = 5000, invocation: suppliedInvocation, events: suppliedEvents } = {}) {
  const root = resolveProject({ cwd }) || fs.realpathSync(cwd);
  const dir = path.join(root, '.cad', 'telemetry', 'direct');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const instanceId = suppliedInvocation?.instanceId || randomUUID();
  let birth = null;
  try { birth = processBirth(); } catch { /* Unsupported host: presence remains unknown. */ }
  const file = path.join(dir, createHash('sha256').update(instanceId).digest('hex') + '.json');
  const baseInvocation = suppliedInvocation || core.createInvocationContext({ instanceId, source: 'mcp' });
  const observedAt = () => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : Date.now();
    } catch { return Date.now(); }
  };
  const snapshot = { version: 1, id: instanceId, instanceId, pid: process.pid, birth, project: root,
    source: 'direct-transport', observedAt: observedAt(), sequence: 0, operations: [] };
  let timer;
  let disposed = false;
  let eventSink;
  try { eventSink = suppliedEvents || require('./opencode/project-logger.cjs').createEventSink(root); }
  catch { eventSink = { async publish() {}, dispose() {} }; }
  const publisher = core.createObservationPublisher(eventSink, { nowMs: now });
  const observationScope = core.createObservationScope({ invocation: baseInvocation, events: eventSink,
    presence: createProjectPresencePort(root, core), clock: { nowMs: now } });
  void observationScope.heartbeat();
  let exitHandler;

  const unsettled = item => ['running', 'unknown'].includes(item.state);
  const retain = () => {
    const active = snapshot.operations.filter(unsettled);
    snapshot.operations = [...active.slice(-256), ...snapshot.operations.filter(item => !unsettled(item)).slice(-500)];
  };
  const publish = () => {
    if (disposed) return;
    try {
      snapshot.observedAt = observedAt();
      snapshot.sequence++;
      durable(file, snapshot);
    } catch { /* Telemetry failure cannot change an execution result or encourage replay. */ }
  };
  async function track(payload, send, call = {}) {
    if (disposed) return send();
    let callInvocation;
    try {
      callInvocation = core.createInvocationContext({
        ...baseInvocation,
        requestId: call.requestId || randomUUID(),
        sessionId: call.sessionId ?? baseInvocation.sessionId,
        purpose: call.purpose ?? baseInvocation.purpose,
      });
    } catch {
      callInvocation = core.createInvocationContext({ ...baseInvocation, requestId: randomUUID() });
    }
    const operation = { id: callInvocation.requestId, requestId: callInvocation.requestId,
      clientId: callInvocation.clientId, jobId: callInvocation.jobId, projectId: callInvocation.projectId,
      documentId: callInvocation.documentId, sessionId: callInvocation.sessionId, turnId: callInvocation.turnId,
      instanceId: callInvocation.instanceId, source: callInvocation.source,
      state: 'running', label: ['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'].includes(payload.method) ? payload.method : 'rpc',
      ...(callInvocation.purpose ? { description: callInvocation.purpose } : {}),
      startedAt: observedAt(), outcomeScope: 'transport' };
    const metadata = call.metadata || {};
    for (const key of ['label', 'document', 'sourcePath', 'sourceHash']) {
      if (typeof metadata[key] === 'string' && metadata[key]) operation[key] = metadata[key];
    }
    if (metadata.label) operation.label = metadata.label;
    snapshot.operations.push(operation);
    retain();
    publish();
    void publisher.publish(callInvocation, 'transport.started', { method: operation.label });
    if (!timer) { timer = setInterval(publish, intervalMs); timer.unref(); }
    try {
      const result = await send();
      operation.state = 'completed';
      operation.httpStatus = result.status;
      void publisher.publish(callInvocation, 'transport.completed', { status: 'completed', method: operation.label });
      return result;
    } catch (error) {
      operation.state = 'unknown'; // A transport error cannot prove remote termination.
      void publisher.publish(callInvocation, 'transport.unknown', { status: 'unknown', method: operation.label });
      throw error;
    } finally {
      operation.finishedAt = observedAt();
      retain();
      publish();
      if (!snapshot.operations.some(item => item.state === 'running')) { clearInterval(timer); timer = null; }
    }
  }
  async function dispose() {
    if (disposed) return;
    disposed = true;
    if (exitHandler) process.removeListener('exit', exitHandler);
    if (timer) clearInterval(timer);
    timer = null;
    await observationScope.dispose();
  }
  exitHandler = () => { void dispose(); };
  process.once('exit', exitHandler);
  return { track, file, instanceId, dispose };
}

module.exports = { createTelemetry };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { QueueClient, defaultMcpClientId, resolveMcpProjectDirectory } = require('../src/queue-client');
const { mcpRequestState, createMcpExecutionContext } = require('../src/dist/core/application/mcp-context');

test('MCP projects are explicit or derived from one validated local root, never cwd', t => {
  const base = fs.mkdtempSync('/tmp/opencode/mcp-project-context-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const project = path.join(root, 'project');
  const other = path.join(base, 'other');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(other);
  assert.deepEqual(resolveMcpProjectDirectory({}), { projectDirectory: null, source: 'none' });
  assert.deepEqual(resolveMcpProjectDirectory({ projectDirectory: project }), {
    projectDirectory: fs.realpathSync(project), source: 'explicit',
  });
  const hint = { uri: pathToFileURL(root).href, name: 'workspace' };
  assert.deepEqual(resolveMcpProjectDirectory({ roots: [hint] }), {
    projectDirectory: fs.realpathSync(root), source: 'root',
  });
  assert.deepEqual(resolveMcpProjectDirectory({ projectDirectory: project, roots: [hint] }), {
    projectDirectory: fs.realpathSync(project), source: 'explicit',
  });
  assert.throws(() => resolveMcpProjectDirectory({ roots: [hint, { uri: pathToFileURL(other).href }] }), /Multiple MCP roots/);
  assert.throws(() => resolveMcpProjectDirectory({ projectDirectory: other, roots: [hint] }), /inside one/);
  assert.throws(() => resolveMcpProjectDirectory({ roots: [{ uri: 'https://example.invalid/project' }] }), /local file URI/);
});

test('persistent owner credentials are distinct from process presence and private request context', t => {
  const state = fs.mkdtempSync('/tmp/opencode/mcp-owner-context-');
  const oldState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  t.after(() => {
    if (oldState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldState;
    fs.rmSync(state, { recursive: true, force: true });
  });
  const first = new QueueClient('owner-a', { instanceId: 'process-one' });
  const restarted = new QueueClient('owner-a', { instanceId: 'process-two' });
  const foreign = new QueueClient('owner-b', { instanceId: 'process-three' });
  t.after(() => { first.dispose(); restarted.dispose(); foreign.dispose(); });
  assert.deepEqual(first.auth, restarted.auth);
  assert.notEqual(first.auth.clientId, foreign.auth.clientId);
  assert.notEqual(first.instanceId, restarted.instanceId);
  assert.equal(defaultMcpClientId(), defaultMcpClientId());

  const context = { clientId: 'owner-a', requestId: 'stable-request', sessionId: 'owner-session',
    projectDirectory: '/tmp/project', projectId: 'cloud-project', doc: 'Model', docId: 'creation',
    docFileId: 'file', purpose: 'Inspect model', expectedRevision: 4 };
  first.persistRequestContext(context.requestId, context);
  assert.deepEqual(restarted.readRequestContext(context.requestId), context);
  assert.equal(foreign.readRequestContext(context.requestId), null);
  assert.throws(() => restarted.persistRequestContext(context.requestId, { ...context, docId: 'other' }), /different immutable/);
  const record = fs.readdirSync(path.join(first.dir, 'client-credentials'))
    .find(name => name.endsWith('.mcp-context.json'));
  const file = path.join(first.dir, 'client-credentials', record);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert(!fs.readFileSync(file, 'utf8').includes(first.auth.clientToken));
});

test('typed MCP state and context keep request, cloud project, document pins and revision explicit', () => {
  const context = createMcpExecutionContext({ clientId: 'owner-a', instanceId: 'presence-a', sessionId: 'session-a',
    requestId: 'request-a', projectDirectory: '/tmp/project-a', projectId: 'cloud-a', doc: 'Model',
    docId: 'creation-a', docFileId: 'file-a', purpose: 'Inspect', expectedRevision: 7 });
  assert.equal(context.projectDirectory, '/tmp/project-a');
  assert.equal(context.projectId, 'cloud-a');
  assert.equal(context.docId, 'creation-a');
  assert.equal(context.docFileId, 'file-a');
  assert.equal(context.expectedRevision, 7);
  assert.equal(mcpRequestState('queued'), 'queued');
  assert.equal(mcpRequestState('running'), 'running');
  assert.equal(mcpRequestState('succeeded'), 'succeeded');
  assert.equal(mcpRequestState('needs_reconciliation'), 'needs_reconciliation');
  assert.throws(() => createMcpExecutionContext({ clientId: 'owner-a', instanceId: 'presence-a',
    sessionId: 'session-a', requestId: 'request-a', docId: 'without-doc' }), /require doc/);
});

'use strict';
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');
const { startStdio, createCatalogPost } = require('../src/mcp-stdio');
const { mcpTools, catalog } = require('../src/catalog');
const { decodeCatalogInvocation } = require('../src/dist/core/catalog');

function call(name, args, meta) {
  return { jsonrpc: '2.0', id: 'catalog-call', method: 'tools/call', params: {
    name: 'fmcad_cad_' + name, arguments: args, ...(meta ? { _meta: { fmcad: meta } } : {}),
  } };
}
async function harness(requests, dependencies = {}) {
  const stdin = new PassThrough();
  let output = '';
  const { closed } = startStdio(['--routing', 'queue', '--project-directory', process.cwd()], {
    stdin, stdout: { write: text => { output += text; } }, stderr: { write: text => assert.fail(text) },
    loadConfig: () => ({ cfg: { routing: 'queue', backend: 'mcp', timeoutMs: 5000, headers: {} } }),
    McpClient: class {
      close() {}
      async controlPost() { assert.fail('catalog discovery/execution must not forward upstream metadata'); }
    },
    QueueClient: class { async register() { assert.fail('local discovery/preflight must not register'); } },
    ...dependencies,
  });
  stdin.end(requests.map(JSON.stringify).join('\n') + '\n');
  await closed;
  return output.trim().split('\n').map(JSON.parse);
}

test('stdio catalog discovery is offline and exactly projects every public operation', async () => {
  const [reply] = await harness([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  assert.deepEqual(reply.result.tools.filter(tool => tool.name.startsWith('fmcad_cad_')), mcpTools);
  assert.ok(reply.result.tools.some(tool => tool.name === 'fmcad_queue_result'));
  assert.equal(reply.result.tools.some(tool => tool.name === 'fmcad_cad_document_save_native'), false);
  const post = createCatalogPost(() => assert.fail('no physical tool discovery'), { queued: false });
  const direct = JSON.parse((await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).raw);
  assert.deepEqual(direct.result.tools, mcpTools);
});

test('local and preview catalog calls execute shared CAD without backend/queue creation', async () => {
  const replies = await harness([
    call('entity_list', { doc: 'Model', data: {}, preview: true, purpose: 'Inspect payload' }),
    call('definition_inspect', { doc: 'Model', data: catalog['definition.inspect'].example }),
  ], { createBackend: () => assert.fail('local execution must not create a backend') });
  assert.equal(replies[0].result.structuredContent.state, 'input-validated-only');
  assert.equal(replies[0].result.isError, false);
  assert.equal(replies[1].result.structuredContent.success, true);
});

test('malformed envelopes and payloads fail before any admission, SDK or raw forwarding', async () => {
  const replies = await harness([
    call('entity_list', { doc: 'Model', data: { unknown: 1 } }),
    call('entity_list', { doc: 'Model', data: {}, preview: 'true' }),
    call('entity_list', { data: {} }),
    call('entity_list', { doc: 'Model', data: {}, docId: 'with whitespace' }),
    call('entity_list', { doc: 'Model', data: {}, purpose: 'body' }, { description: 'meta' }),
    call('document_save_native', { doc: 'Model', data: {} }),
    call('not_a_tool', { data: {} }),
    call('entity_list', [], {}),
    call('animation_play', { doc: 'Model', data: catalog['animation.play'].example }),
  ]);
  for (const reply of replies) assert.equal(reply.error.code, -32602, JSON.stringify(reply));
  for (const value of [NaN, Infinity, undefined, () => {}]) {
    assert.throws(() => decodeCatalogInvocation({ version: 1, kind: 'cad', operation: 'entity.list', data: { value } }), /acyclic JSON/);
  }
  assert.throws(() => decodeCatalogInvocation({ version: 2, kind: 'cad', operation: 'entity.list', data: {} }), /version/);
});

test('SDK catalog calls submit typed payloads to the existing phased worker with purpose and pins', async () => {
  let submitted;
  const result = { success: true, operation: 'entity.list', result: { entities: [] } };
  const replies = await harness([call('entity_list', { doc: 'Model', docId: 'creation', docFileId: 'file',
    data: {}, component: 'root', projectId: 'project' }, { requestId: 'stable-request', description: 'Inspect part',
    sequence: { action: 'continue', id: 'lease' }, expectedRevision: 4 })], {
    QueueClient: class {
      async register() {}
      async submit(input) { submitted = input; return { id: 'job' }; }
      async wait() { return { job: { id: 'job', state: 'succeeded', revision: 5 }, stdout: JSON.stringify(result) }; }
    },
  });
  assert.equal(submitted.kind, 'command');
  assert.equal(submitted.payload.kind, 'cad');
  assert.equal(submitted.payload.version, 1);
  assert.equal(submitted.payload.operation, 'entity.list');
  assert.equal(submitted.payload.docId, 'creation');
  assert.equal(submitted.payload.docFileId, 'file');
  assert.equal(submitted.payload.component, 'root');
  assert.equal(submitted.payload.projectId, 'project');
  assert.equal(submitted.payload.purpose, 'Inspect part');
  assert.equal(submitted.description, 'Inspect part');
  assert.equal(submitted.requestId, 'stable-request');
  assert.equal(submitted.expectedRevision, 4);
  assert.deepEqual(submitted.sequence, { action: 'continue', id: 'lease' });
  assert.deepEqual(submitted.argv, ['cad', 'entity', 'list', '--doc', 'Model', '--doc-id', 'creation', '--doc-file-id', 'file']);
  assert.deepEqual(replies[0].result.structuredContent, result);
  assert.equal(replies[0].result._meta.fmcad.jobId, 'job');
});

test('queued catalog output reads only owned hash-bound artifacts, never advertised paths', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owned = require('../src/queue-response-files');
  const job = { id: randomUUID(), state: 'succeeded', request: { cwd: process.cwd() } };
  const output = { success: true, operation: 'entity.list', result: 'x'.repeat(1024 * 1024 + 1) };
  const file = owned.responsePath(dir, job, 'stdout.txt', true);
  // The fixture owns only this result directory, not the surrounding project.
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify(output));
  const descriptor = owned.describeOwnedResult(dir, job, 'stdout.txt');
  let selected = { ...descriptor, path: '/definitely/not/an/authorized/path' };
  const dependencies = { QueueClient: class {
    constructor() { this.dir = dir; }
    async register() {}
    async submit() { return job; }
    async wait() { return { job, outputs: { stdout: selected } }; }
  } };
  const request = call('entity_list', { doc: 'Model', data: {} }, { sequence: { action: 'continue', id: 'artifact-lease' } });
  const [valid] = await harness([request], dependencies);
  assert.deepEqual(valid.result.structuredContent, output);
  selected = { ...descriptor, artifact: { ...descriptor.artifact, jobId: 'other-job' } };
  const [invalid] = await harness([request], dependencies);
  assert.equal(invalid.error.code, -32000);
  assert.match(invalid.error.message, /artifact|job|scope/i);
  fs.appendFileSync(file, 'tampered');
  selected = descriptor;
  const [changed] = await harness([request], dependencies);
  assert.equal(changed.error.code, -32000);
  assert.match(changed.error.message, /hash|size/i);
});

test('direct catalog execution is denied without constructing a physical backend', async t => {
  let destroyed = 0, observed;
  const backend = { reqOpts: { agent: { destroy: () => { destroyed++; } } } };
  const post = createCatalogPost(() => assert.fail('no catalog raw forwarding'), { queued: false, cfg: {},
    makeBackend: () => backend, execute: async (input, client) => {
      observed = input; assert.equal(client, backend); return { success: true };
    } });
  const response = JSON.parse((await post(call('entity_list', { doc: 'Model', data: {} }))).raw);
  assert.match(response.error.message, /requires the broker/);
  assert.equal(observed, undefined);
  assert.equal(destroyed, 0);
});

test('uncertain catalog jobs return an owned accepted receipt and are never resubmitted', async () => {
  let submits = 0, aborted = 0;
  const [reply] = await harness([call('entity_list', { doc: 'Model', data: {} }, { sequence: { action: 'continue', id: 'uncertain-lease' } })], {
    QueueClient: class {
      async register() {}
      async submit() { submits++; return { id: 'uncertain-job' }; }
      wait(id, { signal }) { return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        aborted++; reject(new Error('Observation stopped, not execution cancellation'));
      }, { once: true })); }
      async call(action, { jobId }) {
        assert.equal(action, 'result'); assert.equal(jobId, 'uncertain-job');
        return { job: { id: jobId, state: 'needs_reconciliation', revision: 9 } };
      }
    },
  });
  assert.equal(submits, 1);
  assert.equal(aborted, 1);
  assert.equal(reply.result.structuredContent.status, 'ACCEPTED');
  assert.equal(reply.result._meta.fmcad.jobId, 'uncertain-job');
  assert.match(reply.result.structuredContent.instruction, /do not resubmit/);
});

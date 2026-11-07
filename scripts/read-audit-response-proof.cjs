#!/usr/bin/env node
'use strict';
// No IPC/HTTP/SDK port. Original-owner authentication reads existing credentials
// locally and publishes a NEW derived proof outside the queue, never edits it.
const fs = require('node:fs');
const path = require('node:path');
const readerRoot = fs.existsSync(path.join(__dirname, '../src/queue-audit-response-proof.js'))
  ? path.resolve(__dirname, '..') : path.resolve(__dirname, '../dist');
const api = require(readerRoot + '/src/queue-instance');
const proofApi = require(readerRoot + '/src/queue-audit-response-proof');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function main() {
  const options = {}, args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--runtime', '--migration-audit', '--request-id', '--output', '--config'].includes(args[i]) ||
        options[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_REQUEST', 'Exact runtime/migration/request/output required; no client override');
    options[args[i]] = args[i + 1];
  }
  const runtime = options['--runtime'], output = options['--output'];
  if (!path.isAbsolute(runtime || '') || !path.isAbsolute(output || '') || !path.isAbsolute(options['--migration-audit'] || '') ||
      !options['--request-id'] || api.buildHash(runtime) !== '14aca04a4c37e5a3142d2493fc9e559987864779bad0b25dee41d166bcd3960d')
    fail('BUILD_CHANGED', 'This file-only reader requires the exact frozen qualified 843 producer');
  const { cfg } = require(runtime + '/src/config').loadConfig({ config: options['--config'] });
  const client = new (require(runtime + '/src/queue-client').QueueClient)(process.env.FMCAD_CLIENT || cfg.queue?.client,
    { cfg, existingCredentialsOnly: true });
  try {
    const dir = client.dir, migration = api.readJson(path.join(options['--migration-audit'], 'intent.json'));
    const token = api.hash(client.auth.clientToken), clients = api.readJson(path.join(dir, 'clients.json'));
    if (migration.binding.clientId !== client.auth.clientId || migration.ownerTokenHash !== token || clients[client.auth.clientId] !== token)
      fail('NOT_OWNER', 'Only existing private credentials of the original migration/audit owner can publish this derived read');
    const scope = { ...require(runtime + '/src/atomic-workflow-observation').fastenersScope,
      observationJobId: '3627db2e-0b9d-4e4f-927f-20cb45deae74' };
    const state = api.readJson(path.join(dir, 'queue-state.json'), 256 * 1024 * 1024);
    for (const id of [scope.jobId, scope.observationJobId])
      if (state.jobs[id]?.clientId !== client.auth.clientId || state.jobs[id].request.ownerToken !== token)
        fail('NOT_OWNER', 'Original target and observer must remain owned by this credential');
    const files = proofApi.collectAuditResponseFiles(dir, options['--migration-audit'], scope);
    const proof = proofApi.auditResponseProof(files, dir, scope);
    if (proof.key.requestId !== options['--request-id'] || proof.key.clientId !== client.auth.clientId)
      fail('AUDIT_RESPONSE_PROOF_INVALID', 'Request/owner does not match the original failed audit');
    const resolved = path.resolve(output);
    if (resolved === dir || resolved.startsWith(dir + path.sep) || resolved === runtime || resolved.startsWith(runtime + path.sep))
      fail('INVALID_OUTPUT', 'Publish outside the protected queue and frozen runtime');
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    if (fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved) || !proofApi.auditResponseProofStillCurrent(proof))
      fail('AUDIT_RESPONSE_PROOF_INVALID', 'Output path or original evidence changed');
    const derived = { ...proof, derivedAt: new Date().toISOString(), writerClientId: client.auth.clientId,
      writerAuthenticated: true, readerScriptSha256: api.hash(fs.readFileSync(__filename)),
      readerModuleSha256: api.hash(fs.readFileSync(require.resolve(readerRoot + '/src/queue-audit-response-proof'))) };
    api.durable(resolved, derived, true);
    console.log(JSON.stringify({ path: resolved, sha256: api.hash(fs.readFileSync(resolved)), factsAvailable: false,
      epochEligible: false, sdkRequestsSent: 0, historicalOutcome: 'unknown' }, null, 2));
  } finally { client.dispose(); }
}
try { main(); } catch (error) { console.error(error); process.exitCode = 1; }

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pythonLiteral, prepareCadBundle } = require('./python');
const { publishComplete } = require('./publish');
const { redactDiagnostic } = require('./diagnostics');
const { batchServices } = require('./batch');
const { localOperations } = require('./engineering-local');
const application = require('./dist/core/application/cad/atomic');
const own = (value, key) => Object.hasOwn(value, key);

// Test-only deterministic fault injection; absent from the public catalog.
function injectTestFault(steps) {
  const spec = process.env.FMCAD_TEST_ATOMIC_FAULT;
  if (!spec) return steps;
  const match = /^(after_mutation|before_ref_publish|final_validation)(?::(\d+))?$/.exec(String(spec).trim());
  if (!match) throw new Error('FMCAD_TEST_ATOMIC_FAULT must be <phase>[:<afterIndex>] with phase in after_mutation | before_ref_publish | final_validation');
  const afterIndex = match[2] === undefined ? steps.length - 1 : Number(match[2]);
  if (afterIndex < -1 || afterIndex >= steps.length) throw new Error('FMCAD_TEST_ATOMIC_FAULT afterIndex is out of range for the current batch');
  return [...steps.slice(0, afterIndex + 1), { id: '__test_fault', operation: '__test.fault', data: { phase: match[1] } }, ...steps.slice(afterIndex + 1)];
}
function prepareAtomicScript(args) {
  const wrapper = `

_ATOMIC_REQUEST: "JsonObject"

_ATOMIC_REQUEST = ${pythonLiteral(args)}

def run(_context: str) -> None:
    import json
    import adsk.core
    result = execute(_ATOMIC_REQUEST)
    print('FMCAD_RESULT ' + json.dumps(result, allow_nan=False))
`;
  return prepareCadBundle(require('./dist/config-platform').resolveRuntimePaths({ anchor: __filename }).installation, wrapper, { request: args });
}
function buildAtomicScript(args) { return prepareAtomicScript(args).script; }
function executeAtomic(client, request) {
  return client.callTool({ featureType: 'script', object: { script: request.artifact.script, ...(request.readOnly ? { readOnly: true } : {}) } },
    'fusion_mcp_execute', require('./python').pythonArtifactManifest(request.artifact));
}
async function callAtomicWithinBudget(client, request, deadline, reserveMs = 5000) {
  const remaining = Math.floor(deadline - performance.now() - reserveMs);
  if (remaining < 1) throw Object.assign(new Error('RPC not submitted: insufficient batch budget after native-finalize reserve'), { code: 'FMCAD_BATCH_BUDGET_EXHAUSTED' });
  const server = client.server;
  const configured = server.timeoutMs ?? 180000, previous = server.timeoutMs;
  server.timeoutMs = Math.min(configured, remaining);
  try { return await executeAtomic(client, request); }
  finally { if (previous === undefined) delete server.timeoutMs; else server.timeoutMs = previous; }
}
async function readAtomicReceipt(reportPath) {
  if (typeof reportPath !== 'string' || !reportPath.trim()) throw new Error('reportPath must be a nonempty directory');
  const dir = path.resolve(reportPath);
  const names = (await fs.readdir(dir)).filter(name => /^\d{8}\.json$/.test(name)).sort();
  if (!names.length || names.some((name, i) => name !== `${String(i).padStart(8, '0')}.json`)) throw new Error('Missing or incomplete atomic journal; outcome unknown');
  const records = [];
  for (const name of names) records.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')));
  return { dir, report: application.validateAtomicHistory(records), records };
}
let observeCatalog = {};
function setObserveReadOnlyCatalog(catalog) { observeCatalog = catalog ?? {}; }
function atomicServices(client, catalog = observeCatalog) {
  const services = batchServices(client, undefined, catalog);
  return { catalog, backend: client?.capabilities?.backend ?? 'mcp',
    supported: client?.capabilities ? client.capabilities.atomicBatch === true : true,
    isLocal: operation => own(localOperations, operation), reportPath: services.reportPath,
    now: services.now, timestamp: services.timestamp, redact: services.redact,
    nonce: () => randomBytes(16).toString('hex'), faultSteps: injectTestFault,
    wait: () => new Promise(resolve => setTimeout(resolve, 200)),
    prepare: prepareAtomicScript,
    execution: { execute: (request, deadline) => deadline === undefined ? executeAtomic(client, request) : callAtomicWithinBudget(client, request, deadline) },
    open: async reportPath => {
      const port = await services.open(reportPath);
      return { ...port, assertEmpty: async () => {
        if ((await fs.readdir(reportPath)).some(name => name !== 'run.lock')) throw new Error('Atomic run report already exists; inspect before rerunning (no automatic replay)');
      } };
    },
  };
}
function runAtomicBatch(client, data, context = {}, _executeCad, catalog, validation) {
  const services = atomicServices(client, catalog);
  services.supported = client?.capabilities?.atomicBatch === true;
  return application.runAtomicBatch(data, context, validation, services);
}
async function reconcileAtomicBatch(client, reportPath, observe = []) {
  if (!Array.isArray(observe) || observe.length > 100) throw new Error('observe must be an array of at most 100 read operations');
  const { report } = await readAtomicReceipt(reportPath);
  return application.reconcileAtomicBatch(report, observe, atomicServices(client));
}
async function finalizeAtomicBatch(client, reportPath) {
  const { dir, report } = await readAtomicReceipt(reportPath);
  return application.finalizeAtomicBatch(report, atomicServices(client), async () => {
    let lock;
    try { lock = await fs.open(path.join(dir, 'run.lock'), 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Batch writer lock exists; finalize refused without lock theft'); throw error; }
    return { latest: async () => report, assertEmpty: async () => {},
      publish: value => publishComplete(path.join(dir, `${String(value.sequence).padStart(8, '0')}.json`), JSON.stringify(value, null, 2) + '\n'),
      close: async preserveLock => { await lock.close(); if (!preserveLock) await fs.unlink(path.join(dir, 'run.lock')); } };
  });
}
const { readOperationJournal, writeOperationRecord } = require('./dist/node-adapters/persistence/operation-journal');
module.exports = { readOperationJournal, writeOperationRecord, runAtomicBatch, buildAtomicScript, prepareAtomicScript,
  isTransactional: application.isTransactional, injectTestFault, readAtomicReceipt, reconcileAtomicBatch, finalizeAtomicBatch, setObserveReadOnlyCatalog };

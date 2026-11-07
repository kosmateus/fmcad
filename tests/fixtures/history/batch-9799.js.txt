const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { failedOutcome } = require('./outcome');
const { publishComplete } = require('./publish');
const { redactDiagnostic, formatJsonError } = require('./diagnostics');
const { run: runLocal, localOperations } = require('./engineering-local');
const application = require('./dist/core/application/cad/batch');
const planning = require('./dist/core/application/cad/batch-plan');
const { expandDefinition } = require('./dist/core/application/cad/definition');
const { hash, clone, resolveReferences } = require('./dist/core/application/cad/json');
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLocal = operation => own(localOperations, operation);
const validateBatch = (data, catalog) => planning.validateBatch(data, catalog, isLocal);

function batchServices(client, executeCad, catalog, stageDependencies) {
  return { catalog, isLocal, local: runLocal,
    async beforeRun(data, context, validation, atomic) {
      const mutates = (validation.operations || []).some(step =>
        !isLocal(step.operation) && catalog[step.operation]?.readOnly !== true);
      if (!mutates || !stageDependencies) return;
      const request = structuredClone(data);
      delete request.mode; delete request.reportPath;
      const requestHash = hash({ request, context: structuredClone(context) });
      await stageDependencies.beforeRun({ data, context, validation, atomic, requestHash });
    },
    execute: typeof executeCad === 'function' ? (operation, data, context) => executeCad(client, operation, data, context) : undefined,
    atomic: (data, context, validation) => require('./batch-atomic').runAtomicBatch(client, data, context, executeCad, catalog, validation),
    reportPath: data => path.resolve(data.reportPath || path.join('.fmcad-batch', data.runId)),
    now: () => performance.now(), timestamp: () => new Date().toISOString(),
    redact: value => redactDiagnostic(value, client?.server), failed: failedOutcome,
    open: async reportPath => {
      await fs.mkdir(reportPath, { recursive: true });
      const lockPath = path.join(reportPath, 'run.lock');
      const lock = await fs.open(lockPath, 'wx', 0o600).catch(error => {
        if (error.code === 'EEXIST') throw new Error('Run is locked; inspect operator/model state before removing a stale lock');
        throw error;
      });
      return {
        latest: async () => {
          const files = (await fs.readdir(reportPath)).filter(name => /^\d{8}\.json$/.test(name)).sort();
          if (!files.length) return undefined;
          if (files.some((name, index) => name !== `${String(index).padStart(8, '0')}.json`)) throw new Error('Incomplete report history; operator inspection required');
          return JSON.parse(await fs.readFile(path.join(reportPath, files.at(-1)), 'utf8'));
        },
        assertEmpty: async () => {
          if ((await fs.readdir(reportPath)).some(name => name !== 'run.lock')) throw new Error('Unrecognized report files; operator inspection required');
        },
        publish: report => publishComplete(path.join(reportPath, `${String(report.sequence).padStart(8, '0')}.json`), JSON.stringify(report, null, 2) + '\n'),
        close: async preserveLock => { await lock.close(); if (!preserveLock) await fs.unlink(lockPath); },
      };
    },
  };
}
const runBatch = (client, data, context = {}, executeCad, catalog, stageDependencies) => application.runBatch(data, context, batchServices(client, executeCad, catalog, stageDependencies));
const runBatchEntry = (client, data, context = {}, executeCad, catalog, stageDependencies) => application.runBatchEntry(data, context, batchServices(client, executeCad, catalog, stageDependencies));
async function definitionInstantiate(client, data, context, executeCad, catalog, stageDependencies) {
  return { ...await runBatch(client, data, context, executeCad, catalog, stageDependencies), operation: 'definition.instantiate' };
}
function definitionInspect(data, catalog, operation = 'definition.inspect') {
  const result = validateBatch({ runId: 'inspection', ...data }, catalog);
  return { ...result, operation, status: result.success ? 'pass' : 'fail', mutated: false,
    documentIdentity: null, associativity: data.recipe ? 'recipeRegeneration' : 'snapshot', units: 'inherited from leaf operations', frame: 'per-step component/sketch',
    provenance: { sourceHash: hash(data), formatVersion: data.formatVersion ?? 'legacy' },
    definitions: Object.keys(data.definitions ?? {}), warnings: ['Offline expansion is not native model acceptance.'] };
}
function smallResult(output) {
  const result = output?.result;
  if (!object(result)) return {};
  return Object.fromEntries(['value', 'units', 'count', 'healthy', 'healthState', 'passed', 'sampledPassed', 'checkOutcome']
    .filter(key => own(result, key) && (result[key] === null || typeof result[key] === 'number' ||
      typeof result[key] === 'boolean' || typeof result[key] === 'string' && result[key].length <= 256))
    .map(key => [key, result[key]]));
}
function summarizeReport(report) {
  return { operation: 'batch.summary', historical: true, modelValidated: false,
    success: report.success, status: report.status, runId: report.runId, reportPath: report.reportPath, sequence: report.sequence,
    ...(report.error ? { error: clone(report.error) } : {}),
    steps: report.steps.map((step, index) => {
      const result = smallResult(step.output);
      return { step: index + 1, id: step.id, status: step.status,
        ...(Object.keys(result).length ? { result } : {}), ...(step.expectFail ? { expectFail: true } : {}),
        ...(step.error ? { error: clone(step.error) } : {}) };
    }) };
}
async function readBatchSummary(data) {
  if (typeof data.reportPath !== 'string' || !data.reportPath.trim()) throw new Error('reportPath must be a nonempty directory path');
  if (data.step !== undefined && (!Number.isSafeInteger(data.step) || data.step < 1)) throw new Error('step must be a 1-based positive integer');
  const reportPath = path.resolve(data.reportPath);
  const files = (await fs.readdir(reportPath)).filter(name => /^\d{8}\.json$/.test(name)).sort();
  if (!files.length) throw new Error('Missing numbered batch report');
  if (files.some((name, index) => name !== `${String(index).padStart(8, '0')}.json`)) throw new Error('Incomplete report history; operator inspection required');
  let report;
  try {
    report = JSON.parse(await fs.readFile(path.join(reportPath, files.at(-1)), 'utf8'));
    const expanded = object(report?.request) ? expandDefinition(report.request).operations : null;
    if (!object(report) || ![1, 2].includes(report.version) || report.operation !== 'batch.run' ||
        typeof report.success !== 'boolean' || !['running', 'success', 'failed', 'unknown'].includes(report.status) ||
        typeof report.runId !== 'string' || !report.runId || report.sequence !== files.length - 1 ||
        !object(report.request) || !object(report.context) || hash({ request: report.request, context: report.context }) !== report.requestHash ||
        !Array.isArray(report.steps) || !report.steps.length || !Array.isArray(expanded) || report.steps.length !== expanded.length ||
        report.steps.some((step, index) => !object(step) || typeof step.id !== 'string' || step.id !== expanded[index]?.id || step.operation !== expanded[index]?.operation ||
          !['pending', 'running', 'success', 'failed', 'unknown', 'skipped'].includes(step.status) ||
          (step.error !== undefined && (!object(step.error) || typeof step.error.message !== 'string'))) ||
        report.success !== (report.status === 'success') || (report.success && report.steps.some(step => step.status !== 'success' ||
          (!step.expectFail && (step.output?.success !== true || failedOutcome(step.output)))))) throw new Error('Invalid version-1 report schema or request/context hash');
  } catch (error) { throw new Error(`Corrupt batch report ${files.at(-1)}: ${error instanceof SyntaxError ? formatJsonError(error) : error.message}`); }
  const summary = summarizeReport({ ...report, reportPath });
  if (data.step !== undefined) {
    if (data.step > summary.steps.length) throw new Error(`step out of range: expected 1..${summary.steps.length}`);
    summary.steps = [summary.steps[data.step - 1]];
  }
  return summary;
}
function readBatchReportSync(reportPath) {
  if (typeof reportPath !== 'string' || !reportPath.trim()) throw new Error('reportPath must be a nonempty directory path');
  reportPath = path.resolve(reportPath);
  if (fsSync.realpathSync(reportPath) !== reportPath) throw new Error('Batch report directory is not canonical');
  const files = fsSync.readdirSync(reportPath).filter(name => /^\d{8}\.json$/.test(name)).sort();
  if (!files.length || files.some((name, index) => name !== `${String(index).padStart(8, '0')}.json`)) throw new Error('Missing or incomplete numbered batch report');
  const file = path.join(reportPath, files.at(-1));
  const bytes = require('./dist/node-adapters/persistence/records').readBytes(file, 16 * 1024 * 1024, fsSync, file);
  let report;
  try {
    report = JSON.parse(bytes.toString('utf8'));
    const expanded = object(report?.request) ? expandDefinition(report.request).operations : null;
    const invalidSuccess = report.success === true && Array.isArray(report.steps) && report.steps.some(step =>
      step.status !== 'success' || (!step.expectFail && (step.output?.success !== true || failedOutcome(step.output))));
    if (!object(report) || ![1, 2].includes(report.version) || report.operation !== 'batch.run' ||
        typeof report.success !== 'boolean' || !['running', 'success', 'failed', 'unknown'].includes(report.status) ||
        typeof report.runId !== 'string' || !report.runId || report.sequence !== files.length - 1 ||
        !object(report.request) || !object(report.context) || hash({ request: report.request, context: report.context }) !== report.requestHash ||
        !Array.isArray(report.steps) || !report.steps.length || !Array.isArray(expanded) || report.steps.length !== expanded.length ||
        report.steps.some((step, index) => !object(step) || typeof step.id !== 'string' || step.id !== expanded[index]?.id || step.operation !== expanded[index]?.operation ||
          !['pending', 'running', 'success', 'failed', 'unknown', 'skipped'].includes(step.status) ||
          (step.error !== undefined && (!object(step.error) || typeof step.error.message !== 'string'))) ||
        report.success !== (report.status === 'success') || invalidSuccess)
      throw new Error('Invalid batch report schema or request/context hash');
  } catch (error) {
    throw new Error(`Corrupt batch report ${files.at(-1)}: ${error instanceof SyntaxError ? formatJsonError(error) : error.message}`);
  }
  return { report, bytes };
}
function formatBatchSummary(report) {
  const summary = report.historical ? report : report.steps ? summarizeReport(report) : report;
  const text = value => JSON.stringify(value ?? null);
  return [summary.steps ? 'Historical reported outcome; not current model validation (modelValidated=false).'
    : 'Offline input validation only; no report or model validated.',
    `status=${summary.status || (summary.success ? 'input-validated-only' : 'failed')} runId=${text(summary.runId)} reportPath=${text(summary.reportPath)}`,
    ...(summary.error ? [`error=${text(summary.error)}`] : []),
    ...(summary.steps || []).map(step => `step=${step.step} id=${text(step.id)} status=${step.status}${step.result ? ` result=${text(step.result)}` : ''}${step.error ? ` error=${text(step.error)}` : ''}`),
    ...(summary.errors || []).map(error => `error=${text(error)}`)].join('\n') + '\n';
}
module.exports = { runBatch, validateBatch, validateBatchMode: planning.validateBatchMode, resolveReferences, expandDefinition,
  definitionInstantiate, definitionInspect, readBatchSummary, readBatchReportSync, formatBatchSummary, runBatchEntry, hash, clone,
  atomicInfo: planning.atomicInfo, ATOMIC_BACKENDS: planning.ATOMIC_BACKENDS, batchServices };

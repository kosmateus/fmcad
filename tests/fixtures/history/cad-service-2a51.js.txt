'use strict';
// Shared command composition: consumes a typed payload, never argv or cli.main.
const application = require('./dist/core/application/cad/worker-command');
const { validateInvocation } = require('./catalog');
const { executeInvocation, invocationFailed } = require('./catalog/execute');

/** Client-side converter AFTER the existing entrypoint parser. No second parser.
 * Return both fields to queue admission; argv is broker guard metadata only. */
function fromParsedCommand(command, options = {}) {
  let payload;
  if (command.kind === 'cad') {
    const context = command.context || {};
    const invocation = { version: 1, kind: 'cad', operation: command.operation, data: command.data };
    for (const key of ['doc', 'docId', 'docFileId', 'component', 'projectId', 'preview']) {
      if (context[key] !== undefined && context[key] !== null) invocation[key] = context[key];
    }
    if (command.purpose !== undefined) invocation.purpose = command.purpose;
    payload = { version: 1, kind: 'cad-command', invocation: validateInvocation(invocation),
      output: { json: command.json === true, summary: command.summary === true } };
  } else if (command.kind === 'run') {
    const readOnlyOperations = Object.entries(require('./catalog').catalog)
      .filter(([, spec]) => spec.readOnly).map(([name]) => name);
    const request = { ...command.request, identity: { ...command.request.identity },
      name: require('./run').resolveScript(command.request.name, options),
      readOnlyOperations: command.request.readOnlyOperations ??
        (command.request.helperVersion === 'cad-v1' && command.request.identity?.readOnly !== true
          ? [] : readOnlyOperations) };
    payload = { version: 1, kind: 'run', request,
      ...(command.purpose === undefined ? {} : { purpose: command.purpose }),
      ...(command.output === undefined ? {} : { output: { ...command.output,
        ...(command.output.path === undefined ? {} : { path: require('node:path').resolve(command.output.path) }) } }) };
  } else throw new Error('fromParsedCommand supports parsed CAD/batch and run only');
  payload = application.decodeCadWorkerInvocation(payload);
  return { payload, argv: application.cadWorkerPolicyArguments(payload) };
}

/** Matches execution-worker execute(request, backend, onOutcome). Output is an
 * explicit optional adapter; omitting it uses the worker process streams. */
async function execute(request, backend, onOutcome = () => {}, io = {}, internal = {}) {
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr;
  const payload = application.decodeCadWorkerInvocation(request.payload);
  if (request.argv !== undefined && JSON.stringify(request.argv) !== JSON.stringify(application.cadWorkerPolicyArguments(payload))) {
    throw Object.assign(new Error('Typed CAD/run invocation differs from broker guard metadata'), { code: 'INVALID_REQUEST' });
  }
  if (payload.kind === 'cad' || payload.kind === 'cad-command') {
    const invocation = payload.kind === 'cad' ? payload : payload.invocation;
    const result = await executeInvocation(invocation, backend, onOutcome, internal);
    const output = payload.kind === 'cad-command' ? payload.output : { json: true };
    const spec = require('./catalog').catalog[invocation.operation];
    stdout.write(!output?.json && (output?.summary || spec.textSummary)
      ? require('./batch').formatBatchSummary(result) : JSON.stringify(result, null, output?.json ? 0 : 2) + '\n');
    return invocationFailed(result, invocation.operation) ? 1 : 0;
  }
  const { checkPublishTarget, publishComplete } = require('./publish');
  return require('./invocation').context.run({ description: payload.purpose }, async () => {
    try {
      const result = await application.executeRunCommand(payload, {
        helperStages: internal.stageDependencies?.helper,
        prepare: (input, trustedStageContext) => require('./run').prepareRunScript(input.name, input.args, input.hasArgs, input.doc || '', input.identity, input.helperVersion, input.readOnlyOperations, { trustedStageContext }),
        execution: { execute: turn => backend.callTool({ featureType: 'script', object: { script: turn.artifact.script, ...(turn.readOnly ? { readOnly: true } : {}) } },
          'fusion_mcp_execute', require('./python').pythonArtifactManifest(turn.artifact)) },
        checkOutput: checkPublishTarget, publish: publishComplete, outcome: onOutcome,
        redact: text => require('./diagnostics').redactDiagnostic(text, backend.server), backend: backend.capabilities?.backend ?? backend.server?.backend ?? 'mcp',
      });
      stdout.write(result.stdout); if (result.stderr) stderr.write(result.stderr);
      return result.code;
    } catch (error) {
      if (error.stdout) stdout.write(error.stdout);
      stderr.write(require('./diagnostics').redactDiagnostic('ERROR ' + error.message + '\n', backend.server));
      return 1;
    }
  });
}
module.exports = { execute, fromParsedCommand,
  decodeInvocation: application.decodeCadWorkerInvocation, policyArguments: application.cadWorkerPolicyArguments };

'use strict';
// Compatibility edge owned by the broker, before the typed worker is spawned.
// Job identity remains the accepted raw request; only the worker envelope changes.
function prepareRequest(job) {
  const request = job.request;
  if (request.payload && request.payload.kind !== 'legacy-command') return request;
  const path = require('node:path');
  const argv = [...request.argv];
  for (let i = 0; i < argv.length; i++) {
    if (['--file', '--args-file', '--config'].includes(argv[i]) && argv[i + 1]) argv[++i] = path.resolve(request.cwd, argv[i]);
  }
  const { opts, rest } = require('../cli').parseFlags(argv);
  const entry = require('../commands').findCommand(rest);
  if (!entry) throw new Error(`unknown command: ${rest[0]}`);
  const purpose = request.description || opts.description;
  if (entry.kind === 'cad') {
    const spec = require('../catalog').catalog[entry.target];
    const spelling = [entry.key, ...(entry.aliases || [])].sort((a, b) => b.length - a.length)
      .find(value => rest.slice(0, value.split(' ').length).join(' ') === value);
    const { planCadInput, decodeCadInput } = require('../dist/core/application/cad/input');
    const plan = planCadInput(rest.slice(spelling.split(' ').length), spec.inputs,
      { ...spec, observeShortcut: entry.target === 'batch.reconcile' });
    let fileText;
    if (plan.payload?.kind === 'file') {
      const bytes = require('node:fs').readFileSync(plan.payload.value);
      const pinned = request.inputFiles?.find(input => path.resolve(request.cwd, input.path) === plan.payload.value);
      if (pinned && require('../queue-instance').hash(bytes) !== pinned.sha256) {
        throw Object.assign(new Error('Accepted CAD input bytes changed'), { code: 'INPUT_CHANGED' });
      }
      fileText = bytes.toString('utf8');
    }
    const input = decodeCadInput(plan, fileText);
    const typed = require('../cad-service').fromParsedCommand({ kind: 'cad', operation: entry.target, data: input.data,
      context: { doc: input.doc, docId: input.docId, docFileId: input.docFileId, component: input.component,
        projectId: input.projectId, preview: input.preview }, json: input.json, summary: input.summary, purpose });
    return { ...request, ...typed };
  }
  const rawArgs = rest.slice(entry.key.split(' ').length);
  const { args, flags, listing } = require('../cli').parseCommand(entry, rawArgs);
  if (entry.kind === 'run' && !listing) {
    const fs = require('node:fs');
    const path = require('node:path');
    const argumentFile = flags['--args-file'] === undefined ? undefined : path.resolve(request.cwd, flags['--args-file']);
    const bytes = argumentFile === undefined ? undefined : fs.readFileSync(argumentFile);
    if (bytes) {
      const pinned = request.inputFiles?.find(input => path.resolve(request.cwd, input.path) === argumentFile);
      if (pinned && require('../queue-instance').hash(bytes) !== pinned.sha256) {
        throw Object.assign(new Error('Accepted run argument bytes changed'), { code: 'INPUT_CHANGED' });
      }
    }
    const payload = bytes === undefined ? flags['--args'] : bytes.toString('utf8');
    const source = path.isAbsolute(args[0]) ? args[0] : path.resolve(request.cwd, args[0]);
    const typed = require('../cad-service').fromParsedCommand({ kind: 'run', purpose,
      request: { name: fs.existsSync(source) ? source : args[0], args: payload === undefined ? [] : JSON.parse(payload), hasArgs: payload !== undefined,
        doc: flags['--doc'] || '', identity: { docId: flags['--doc-id'], docFileId: flags['--doc-file-id'], readOnly: !!flags['--readonly'] },
        helperVersion: flags['--helpers'] },
      ...(flags['--out'] === undefined ? {} : { output: { path: path.resolve(request.cwd, flags['--out']),
        ...(flags['--out-format'] === undefined ? {} : { format: flags['--out-format'] }),
        ...(flags['--pretty'] === undefined ? {} : { pretty: flags['--pretty'] === 'true' }) } }) }, { config: opts.config });
    return { ...request, ...typed };
  }
  return { ...request, payload: { version: 1, kind: 'legacy-command', entry, args, flags, listing, rawArgs,
    options: opts, purpose } };
}
module.exports = { prepareRequest };

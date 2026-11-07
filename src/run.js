const fs = require('fs');
const path = require('path');
const { pythonValue, pythonLiteral, preparePythonArtifact, cadBundleUnits } = require('./python');
const { resolveRuntimePaths } = require('./dist/config-platform');
const application = require('./dist/core/application/cad/run');

function userScriptsDir(options = {}) {
  return resolveRuntimePaths({ anchor: __filename, ...options }).scripts;
}

function pkgScriptsDir() {
  return path.join(resolveRuntimePaths({ anchor: __filename }).assets, 'scripts');
}

function resolveScript(name, options = {}) {
  if (name.includes('/') || name.endsWith('.py')) {
    const p = path.resolve(name);
    if (fs.existsSync(p)) return p;
    throw new Error(`script not found: ${p}`);
  }
  const candidates = [path.join(userScriptsDir(options), name + '.py'), path.join(pkgScriptsDir(), name + '.py')];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`script "${name}" not found in ${userScriptsDir(options)} or ${pkgScriptsDir()}`);
}

function prepareRunScript(name, args, hasArgs, docName, identity = {}, helperVersion, readOnlyOperations = [], options = {}) {
  const request = { name, args, hasArgs, doc: docName, identity, helperVersion, readOnlyOperations };
  application.validateRunRequest(request);
  const file = resolveScript(name, options);
  const bytes = fs.readFileSync(file);
  const invocation = require('./invocation').context.getStore();
  if (invocation) {
    invocation.sourcePath = file;
    invocation.sourceHash = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  }
  if (process.env.FMCAD_QUEUE_WORKER_JOB) require('./queue-client').verifyInputBytes(file, bytes);
  return application.prepareRun(request, { filename: file, source: bytes.toString('utf8') }, {
      pythonValue: pythonLiteral,
      pythonLiteral,
    prepare: preparePythonArtifact,
    runtime: version => version ? cadBundleUnits(resolveRuntimePaths({ anchor: __filename }).installation) :
      [{ id: 'identity', filename: 'runtime/python/fmcad/adapters/fusion/identity.py',
        source: fs.readFileSync(path.join(resolveRuntimePaths({ anchor: __filename }).runtime, 'fmcad', 'adapters', 'fusion', 'identity.py'), 'utf8'), role: 'runtime' }],
  }, options.trustedStageContext);
}

function buildRunScript(...args) { return prepareRunScript(...args).script; }

function listScripts(options = {}) {
  const entries = [];
  for (const dir of [userScriptsDir(options), pkgScriptsDir()]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.endsWith('.py')) entries.push({ name: f.replace(/\.py$/, ''), dir });
    }
  }
  return entries;
}

module.exports = { buildRunScript, prepareRunScript, resolveScript, listScripts, userScriptsDir, pkgScriptsDir,
  validateRunIdentity: application.validateRunIdentity, validateRunOutput: application.validateRunOutput,
  formatRunOutput: application.formatRunOutput };

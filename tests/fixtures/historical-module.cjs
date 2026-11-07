'use strict';

const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

// Source-level legacy comparison, not a claim of installed-runtime qualification.
// Load an immutable Git blob with today's dependencies; no lost /tmp checkout.
module.exports = function historicalModule(revision, sourcePath, runtimePath = sourcePath) {
  const root = path.resolve(__dirname, '../..');
  let source = execFileSync('git', ['show', `${revision}:${sourcePath}`], { cwd: root, encoding: 'utf8' });
  if (sourcePath.endsWith('.ts')) {
    const ts = require('typescript');
    source = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText;
  }
  const filename = path.join(root, runtimePath);
  const isolated = new Module(filename, module);
  isolated.filename = filename;
  isolated.paths = Module._nodeModulePaths(path.dirname(filename));
  isolated._compile(source, filename);
  return isolated.exports;
};

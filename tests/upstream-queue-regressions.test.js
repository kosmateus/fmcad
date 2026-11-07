'use strict';
// Run the installed package's unchanged regression tests against this isolated
// runtime. No installed executable or active broker is edited or contacted.
const Module = require('node:module');
const path = require('node:path');
const installed = process.env.FMCAD_UPSTREAM_TEST_ROOT || path.resolve(__dirname, '..');
const staged = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  const file = resolve.call(this, request, parent, ...rest);
  if (typeof file === 'string' && (file.startsWith(installed + '/src/') || file.startsWith(installed + '/assets/'))) return staged + file.slice(installed.length);
  return file;
};
for (const file of ['queue-scheduling.test.js', 'queue-probe-recovery.test.js', 'queue-document.test.js',
  'addin-bridge.test.js', 'document-identity.test.js', 'run-identity.test.js', 'run-out.test.js',
  'review.test.js', 'console-pause.test.js', 'mcp-stdio.test.js', 'backend-cli.test.js',
  'execution-budget.test.js']) require(path.join(installed, 'tests', file));

'use strict';
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');

// Decode a generated data expression only. This never executes the surrounding
// CAD program or permits calls/imports in a fake transport's request fixture.
module.exports = function decodePythonLiteral(source) {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-c',
    'import ast,json,sys; print(json.dumps(ast.literal_eval(sys.stdin.read()), allow_nan=False))'], {
    input: source, encoding: 'utf8',
    maxBuffer: Math.max(65536, Buffer.byteLength(source) * 8),
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout);
};

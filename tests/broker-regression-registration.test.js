'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('CI executes every retained broker regression family and its historical comparison', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const command = pkg.scripts['test:broker-regressions'];
  assert.equal(typeof command, 'string');
  const files = command.split(/\s+/).filter(token => token.endsWith('.test.js'));
  const required = ['queue-scheduling', 'queue-cloud-save', 'queue-document',
    'queue-native-receipt', 'queue-probe-recovery', 'queue-snapshot-size',
    'dead-epoch-successor', 'closed-epoch-successor', 'instance-loss-recovery'];
  for (const name of required) assert.ok(files.includes(`tests/${name}.test.js`), name);
  assert.ok(files.includes('dist/tests/queue-scheduling-history.test.js'));
  assert.ok(files.includes('tests/broker-regression-registration.test.js'));
  assert.equal(new Set(files).size, files.length, 'No duplicate suite execution');
  for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), file);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /^\s+- run: npm run test:broker-regressions\s*$/m);
});

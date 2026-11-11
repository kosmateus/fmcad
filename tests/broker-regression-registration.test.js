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
    'dead-epoch-successor', 'closed-epoch-successor', 'instance-loss-recovery',
    'queue-atomic-recovery-audit'];
  for (const name of required) assert.ok(files.includes(`tests/${name}.test.js`), name);
  assert.ok(files.includes('dist/tests/queue-scheduling-history.test.js'));
  assert.ok(files.includes('tests/broker-regression-registration.test.js'));
  assert.equal(new Set(files).size, files.length, 'No duplicate suite execution');
  for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), file);
  const caller = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(caller, /^  pipeline:\r?\n    uses: \.\/\.github\/workflows\/ci-tests\.yml\s*$/m);
  assert.match(caller, /needs: pipeline\r?\n    if: \$\{\{ always\(\) \}\}/);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci-tests.yml'), 'utf8');
  assert.match(workflow, /^on:\r?\n  workflow_call:/m);
  const brokerJob = workflow.split(/^  broker-regressions:\r?\n/m)[1]?.split(/^  [\w-]+:\r?\n/m)[0];
  assert.ok(brokerJob, 'Reusable workflow retains the broker regression job');
  assert.match(brokerJob, /^    needs: prepare\s*$/m);
  assert.match(brokerJob, /node: \["22\.13\.0", "24\.x"\]/);
  assert.match(brokerJob, /^      - run: npm run test:broker-regressions\s*$/m);
  assert.doesNotMatch(brokerJob, /continue-on-error:/);
  assert.equal((brokerJob.match(/^\s+- if:/gm) || []).length, 1);
  assert.match(
    brokerJob,
    /if: steps\.npm-cache\.outputs\.cache-hit != 'true'/,
  );
});

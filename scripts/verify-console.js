'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { buildHash } = require('../src/queue-instance');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'console-verify-'));
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = [
  'console-bootstrap', 'console-data', 'console-interface', 'console-pause', 'registry', 'help-details',
  'backend-cli', 'addin-client', 'curl-transport', 'execution-budget', 'queue-scheduling', 'queue-document',
  'queue-probe-recovery', 'mcp-stdio',
].map(name => 'tests/' + name + '.test.js');
const env = { ...process.env, XDG_STATE_HOME: temporary, FMCAD_CONFIG: path.join(temporary, 'config.json'),
  LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', NO_COLOR: '1' };
const before = buildHash(root);
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  return { status: result.status, output: (result.stdout || '') + (result.stderr || ''), error: result.error?.message || null };
};
try {
  const node = run(process.execPath, ['--test', '--test-reporter=spec', ...files]);
  const pty = run('python3', ['tests/console-pty-smoke.py']);
  const after = buildHash(root);
  const count = name => Number(node.output.match(new RegExp('(?:ℹ |# )' + name + ' (\\d+)'))?.[1] || 0);
  const report = { timestamp: new Date().toISOString(), nodeVersion: process.version,
    workingCopy: root, testedBuildHash: before, buildUnchangedDuringTests: before === after,
    packageLockHash: hashFile(path.join(root, 'package-lock.json')),
    terminalKitVersion: require('terminal-kit/package.json').version,
    verificationRecipeHash: hashFile(__filename),
    tests: { node: { exitCode: node.status, total: count('tests'), passed: count('pass'), failed: count('fail'), error: node.error,
      files: Object.fromEntries(files.map(file => [file, hashFile(path.join(root, file))])) },
      pty: { exitCode: pty.status, cases: pty.output.trim().split('\n'), error: pty.error } },
    fusionAccess: 'None. Controlled dispatchers and private test state only.', deployed: true,
    scope: 'Focused functional regression; not the complete pre-existing repository suite.',
    limitations: ['External immutable host deadlines require the accepted-job/result protocol.',
      'Unmanaged Fusion clients are outside the broker gate.',
      'Live product Fusion and physical validation were not performed; other agents retain ownership.',
      'An older running broker is read-only to the new console until a controlled deployment handoff.'] };
  fs.writeFileSync(path.join(root, 'docs/console-verification-20261020.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'docs/console-verification-20261020-node.log'), node.output, { mode: 0o600 });
  console.log(`Node: ${report.tests.node.passed}/${report.tests.node.total}; failures: ${report.tests.node.failed}; exit: ${node.status}`);
  console.log(pty.output.trim());
  console.log(`Build unchanged: ${report.buildUnchangedDuringTests}; SHA-256: ${before}`);
  console.log('Evidence: docs/console-verification-20261020.json');
  if (node.status !== 0 || pty.status !== 0 || before !== after || !count('tests')) {
    console.error(node.output); console.error(pty.error || pty.output); process.exitCode = 1;
  }
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }

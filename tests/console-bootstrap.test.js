'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveProject } = require('../src/console-project');
const { main } = require('../src/cli');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'CAD project');
  const child = path.join(project, 'drawings', 'nested');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(project, '.fmcad-batch'));
  return { root, project, child };
}

test('nearest artifact project, explicit relative path and symlink resolve canonically', t => {
  const { root, project, child } = fixture(t);
  assert.equal(resolveProject({ cwd: project }), project);
  assert.equal(resolveProject({ cwd: child }), project);
  assert.equal(resolveProject({ cwd: root, project: 'CAD project' }), project);
  fs.symlinkSync(project, path.join(root, 'link'), 'dir');
  assert.equal(resolveProject({ cwd: root, project: 'link' }), project);
  fs.mkdirSync(path.join(child, '.cad', 'telemetry', 'direct'), { recursive: true });
  assert.equal(resolveProject({ cwd: child }), child);
});

test('generic repository markers do not select projects; explicit errors never fall back', t => {
  const { root, project } = fixture(t);
  fs.mkdirSync(path.join(root, '.beads'));
  fs.mkdirSync(path.join(root, '.cad'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.equal(resolveProject({ cwd: root }), null);
  assert.throws(() => resolveProject({ cwd: project, project: 'missing' }), /ENOENT/);
  assert.throws(() => resolveProject({ cwd: project, project: '..' }), /No fmcad project artifacts/);
});

function dependencies(extra = {}) {
  let output = '', error = '', code = 0;
  const deps = {
    stdin: { isTTY: false }, stdout: { write: s => { output += s; }, isTTY: false },
    stderr: { write: s => { error += s; } }, setExitCode: n => { code = n; },
    loadConfig: () => { throw new Error('unexpected config access'); },
    createBackend: () => { throw new Error('unexpected Fusion access'); },
    ...extra,
  };
  return { deps, result: () => ({ output, error, code }) };
}

test('console and diagnostic help work offline without config or terminal', async () => {
  for (const argv of [['console', '--help'], ['diagnostic', '-h'], ['help', 'console'], ['help', 'diagnostic']]) {
    const io = dependencies();
    assert.equal(await main(argv, io.deps), 0);
    assert.match(io.result().output, /fmcad console/);
    assert.equal(io.result().error, '');
  }
});

test('non-TTY exits promptly without escape sequences or backend construction', async t => {
  const { project } = fixture(t);
  const io = dependencies({ cwd: project });
  assert.equal(await main(['console'], io.deps), 1);
  assert.match(io.result().error, /interactive terminal/);
  assert.doesNotMatch(io.result().error + io.result().output, /\x1b/);
});

test('aliases dispatch the same bootstrap; invalid explicit project cannot launch', async t => {
  const { project, child } = fixture(t);
  let launches = 0;
  for (const command of ['console', 'diagnostic']) {
    const io = dependencies({ cwd: child, stdin: { isTTY: true }, stdout: { isTTY: true, write() {} },
      launchConsole: async context => { launches++; assert.equal(context.project, project); return 0; } });
    assert.equal(await main([command], io.deps), 0);
  }
  const io = dependencies({ cwd: project, launchConsole: () => { launches++; } });
  assert.equal(await main(['console', '--project', 'missing'], io.deps), 1);
  assert.equal(await main(['console', '--unexpected'], io.deps), 1);
  assert.equal(launches, 2);
});

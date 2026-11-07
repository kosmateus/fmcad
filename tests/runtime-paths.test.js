'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const adapterRoot = path.resolve(__dirname, '../packages/node-adapters/dist/config-platform');
const runtime = require(path.join(adapterRoot, 'runtime-paths.js'));
const platform = require(path.join(adapterRoot, 'platform.js'));
const python = require(path.join(adapterRoot, 'python.js'));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad paths żółć '));
  t.after(() => {
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o755);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('installed runtime resolves in readonly Unicode installation, unrelated cwd and clean HOME', t => {
  const root = fixture(t);
  const install = path.join(root, 'installed package');
  const home = path.join(root, 'clean home');
  const cwd = path.join(root, 'unrelated');
  fs.mkdirSync(path.join(install, 'dist/processes'), { recursive: true });
  fs.mkdirSync(path.join(install, 'dist/assets'), { recursive: true });
  fs.mkdirSync(path.join(install, 'dist/runtime/python'), { recursive: true });
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(install, 'package.json'), '{"name":"fmcad"}');
  fs.writeFileSync(path.join(install, 'dist/processes/queue-worker.js'), 'process.stdout.write("worker ok")');
  fs.cpSync(adapterRoot, path.join(install, 'dist/config-platform'), { recursive: true });
  const before = fs.readdirSync(install, { recursive: true });
  for (const entry of fs.readdirSync(install, { recursive: true, withFileTypes: true })) {
    fs.chmodSync(path.join(entry.parentPath, entry.name), entry.isDirectory() ? 0o555 : 0o444);
  }
  fs.chmodSync(install, 0o555);
  const result = spawnSync(process.execPath, ['-e', `
    const p = require(${JSON.stringify(path.join(install, 'dist/config-platform/runtime-paths.js'))});
    const paths = p.resolveRuntimePaths({ anchor: ${JSON.stringify(path.join(install, 'dist/processes/queue-worker.js'))} });
    process.stdout.write(JSON.stringify({ paths, child: p.resolveChildEntrypoint(paths, 'queue-worker'), hash: p.runtimeBuildIdentity(paths) }));
  `], { cwd, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.paths.installation, install);
  assert.equal(actual.paths.assets, path.join(install, 'dist/assets'));
  assert.equal(actual.paths.scripts, path.join(home, '.config/fmcad/scripts'));
  assert.equal(actual.paths.state, path.join(home, '.local/state/fmcad'));
  assert.match(actual.hash, /^[a-f0-9]{64}$/);
  assert.equal(spawnSync(process.execPath, [actual.child], { cwd, encoding: 'utf8' }).stdout, 'worker ok');
  assert.deepEqual(fs.readdirSync(install, { recursive: true }), before);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('custom config keeps scripts adjacent and normalizes XDG paths without cwd', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fmcad"}');
  const paths = runtime.resolveRuntimePaths({ anchor: path.join(root, 'index.js'), home: root,
    env: { XDG_CONFIG_HOME: 'configs', XDG_STATE_HOME: 'state', FMCAD_CONFIG: 'custom/config.json' }, temporaryRoot: root });
  assert.equal(paths.config, path.join(root, 'configs/custom/config.json'));
  assert.equal(paths.scripts, path.join(root, 'configs/custom/scripts'));
  assert.equal(paths.state, path.join(root, 'state/fmcad'));
  assert.equal(runtime.projectResultsPath(root), path.join(root, '.cad/results'));
  assert.throws(() => runtime.projectResultsPath('relative'), /absolute/);
  const diagnostics = runtime.createPrivateDiagnosticsDirectory(paths);
  assert.equal(fs.statSync(diagnostics).mode & 0o777, 0o700);
});

test('identity covers executed Python and JavaScript and excludes user state', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'dist/processes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/runtime/python'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fmcad"}');
  const worker = path.join(root, 'dist/processes/queue-worker.js');
  fs.writeFileSync(worker, '// one');
  const paths = runtime.resolveRuntimePaths({ anchor: worker, home: root, env: {} });
  const initial = runtime.runtimeBuildIdentity(paths);
  fs.writeFileSync(path.join(root, 'user-state.json'), '{}');
  assert.equal(runtime.runtimeBuildIdentity(paths), initial);
  fs.writeFileSync(path.join(paths.runtime, 'helper.py'), 'print(1)');
  const pythonHash = runtime.runtimeBuildIdentity(paths);
  assert.notEqual(pythonHash, initial);
  fs.writeFileSync(worker, '// two');
  assert.notEqual(runtime.runtimeBuildIdentity(paths), pythonHash);
});

const linux = { platform: 'linux', architecture: 'x64', nodeVersion: '24.1.0', osRelease: '6.8.0-generic', distribution: 'ubuntu', distributionVersion: '24.04' };
test('capabilities distinguish Linux, WSL2 and unsupported hosts without fallback', () => {
  platform.assertPlatformCapability(linux, 'local');
  assert.throws(() => platform.assertPlatformCapability(linux, 'fusion'), { code: 'FMCAD_UNSUPPORTED_PLATFORM' });
  assert.throws(() => platform.toWindowsPath('/home/user/file', linux), /detected WSL/);
  for (const facts of [{ ...linux, platform: 'win32' }, { ...linux, platform: 'darwin' }, { ...linux, nodeVersion: '22.12.0' }, { ...linux, nodeVersion: '25.0.0' }, { ...linux, architecture: 'arm64' }]) {
    assert.throws(() => platform.assertPlatformCapability(facts, 'local'), { code: 'FMCAD_UNSUPPORTED_PLATFORM' });
  }
  const wsl = { ...linux, osRelease: '6.6.87.2-microsoft-standard-WSL2', wslDistro: 'Actual Distro' };
  platform.assertPlatformCapability(wsl, 'fusion');
  assert.equal(platform.toWindowsPath('/mnt/d/Sp ace/żółć.py', wsl), 'D:\\Sp ace\\żółć.py');
  assert.equal(platform.toWindowsPath('/home/user/a', wsl), '\\\\wsl$\\Actual Distro\\home\\user\\a');
  assert.throws(() => platform.toWindowsPath('relative', wsl), /absolute/);
});

test('Python selection never falls back from an explicit missing interpreter or installs dependencies', t => {
  const root = fixture(t);
  assert.throws(() => python.resolvePython({ pythonPath: path.join(root, 'missing python') }), /Python unavailable/);
  assert.throws(() => python.resolvePython({ env: { FMCAD_PYTHON: path.join(root, 'also missing') } }), /Python unavailable/);
  const stub = path.join(root, 'python stub');
  fs.writeFileSync(stub, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({implementation:'CPython',version:[3,12],missing:['black']}));\n`, { mode: 0o700 });
  assert.throws(() => python.resolvePython({ pythonPath: stub, feature: 'formatter' }), /Missing Python dependencies.*black.*never runs pip/);
  fs.writeFileSync(stub, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({implementation:'CPython',version:[3,13],missing:[]}));\n`, { mode: 0o700 });
  assert.throws(() => python.resolvePython({ pythonPath: stub }), /Unsupported Python/);
  assert.deepEqual(fs.readdirSync(root), ['python stub']);
});

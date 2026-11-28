import test, { type TestContext } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const adapterRoot = path.resolve(__dirname, '../../packages/node-adapters/dist/config-platform');
const runtime = load(path.join(adapterRoot, "runtime-paths.js")) as typeof import("../packages/node-adapters/dist/config-platform/runtime-paths");
const platform = load(path.join(adapterRoot, "platform.js")) as typeof import("../packages/node-adapters/dist/config-platform/platform");
const python = load(path.join(adapterRoot, "python.js")) as typeof import("../packages/node-adapters/dist/config-platform/python");

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function fixture(t: TestContext) {
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
  `], { cwd, env: { PATH: process.env["PATH"], HOME: home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const actual = record(JSON.parse(result.stdout));
  const paths = record(actual["paths"]);
  assert.equal(paths["installation"], install);
  assert.equal(paths["assets"], path.join(install, 'dist/assets'));
  assert.equal(paths["scripts"], path.join(home, '.config/fmcad/scripts'));
  assert.equal(paths["state"], path.join(home, '.local/state/fmcad'));
  assert.match(text(actual["hash"]), /^[a-f0-9]{64}$/);
  assert.equal(spawnSync(process.execPath, [text(actual["child"])], { cwd, encoding: 'utf8' }).stdout, 'worker ok');
  assert.deepEqual(fs.readdirSync(install, { recursive: true }), before);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('custom config keeps scripts adjacent and normalizes XDG paths without cwd', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fmcad"}');
  const paths = runtime.resolveRuntimePaths({ anchor: path.join(root, 'index.js'), home: root,
    env: { XDG_CONFIG_HOME: 'configs', XDG_STATE_HOME: 'state', FMCAD_CONFIG: 'custom/config.json' }, temporaryRoot: root });
  assert.equal(paths.config, path.join(root, 'configs/custom/config.json'));
  assert.equal(paths["scripts"], path.join(root, 'configs/custom/scripts'));
  assert.equal(paths["state"], path.join(root, 'state/fmcad'));
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

test('repeated identity checks detect same-size byte changes with restored mtime across every executable root', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'dist/processes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/runtime/python'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fmcad"}');
  const worker = path.join(root, 'dist/processes/queue-worker.js');
  fs.writeFileSync(worker, '// original');
  const paths = runtime.resolveRuntimePaths({ anchor: worker, home: root, env: {} });
  for (const name of ['dist/processes/queue-worker.js', 'dist/assets/input.dat',
    'dist/runtime/python/module.py', 'bin/launcher.js', 'scripts/console-source-format.py', 'package.json']) {
    const file = path.join(root, name);
    fs.writeFileSync(file, 'first bytes');
    fs.utimesSync(file, new Date(1000), new Date(1000));
    const before = fs.statSync(file);
    const original = runtime.runtimeBuildIdentity(paths);
    assert.equal(runtime.runtimeBuildIdentity(paths), original);
    fs.writeFileSync(file, 'other bytes');
    fs.utimesSync(file, before.atime, before.mtime);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    assert.notEqual(runtime.runtimeBuildIdentity(paths), original, name);
    fs.writeFileSync(file, 'first bytes');
    assert.equal(runtime.runtimeBuildIdentity(paths), original, name);
  }
});

test('identity detects added, deleted and renamed modules and denies symlinks even for excluded files', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'dist/processes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fmcad"}');
  const worker = path.join(root, 'dist/processes/queue-worker.js');
  fs.writeFileSync(worker, '// worker');
  const paths = runtime.resolveRuntimePaths({ anchor: worker, home: root, env: {} });
  const original = runtime.runtimeBuildIdentity(paths);
  const added = path.join(root, 'dist/processes/added.js');
  fs.writeFileSync(added, '// module');
  const withModule = runtime.runtimeBuildIdentity(paths);
  assert.notEqual(withModule, original);
  const renamed = added + '.renamed';
  fs.renameSync(added, renamed);
  assert.notEqual(runtime.runtimeBuildIdentity(paths), withModule);
  fs.unlinkSync(renamed);
  assert.equal(runtime.runtimeBuildIdentity(paths), original);
  fs.symlinkSync(worker, path.join(root, 'dist/processes/ignored.map'));
  assert.throws(() => runtime.runtimeBuildIdentity(paths), { code: 'UNPINNED_BUILD' });
});

test('identity accepts stable installation aliases and aliases in earlier ancestors', t => {
  const root = fixture(t);
  const install = path.join(root, 'physical/package');
  const worker = path.join(install, 'dist/processes/queue-worker.js');
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.writeFileSync(path.join(install, 'package.json'), '{"name":"fmcad"}');
  fs.writeFileSync(worker, '// worker');
  fs.symlinkSync(install, path.join(root, 'current'), 'dir');
  fs.symlinkSync(path.join(root, 'physical'), path.join(root, 'ancestor'), 'dir');
  const identity = (anchor: string) => runtime.runtimeBuildIdentity(
    runtime.resolveRuntimePaths({ anchor, home: root, env: {} }));
  const expected = identity(worker);
  assert.equal(identity(path.join(root, 'current/dist/processes/queue-worker.js')), expected);
  assert.equal(identity(path.join(root, 'ancestor/package/dist/processes/queue-worker.js')), expected);
  fs.writeFileSync(worker, '// changed');
  assert.notEqual(identity(path.join(root, 'current/dist/processes/queue-worker.js')), expected);
});

for (const target of ['package.json', 'dist/processes/queue-worker.js']) {
  test(`identity refuses an installation alias retarget while reading ${target}`,
    { skip: process.platform !== 'linux', timeout: 5000 }, t => {
      const root = fixture(t);
      for (const name of ['first', 'second']) {
        const install = path.join(root, name);
        fs.mkdirSync(path.join(install, 'dist/processes'), { recursive: true });
        fs.writeFileSync(path.join(install, 'package.json'), '{"name":"fmcad"}');
        fs.writeFileSync(path.join(install, 'dist/processes/queue-worker.js'), '// worker');
      }
      const alias = path.join(root, 'current');
      fs.symlinkSync(path.join(root, 'first'), alias, 'dir');
      const script = `
        const fs = require('node:fs'), path = require('node:path');
        const api = require(process.argv[1]), root = process.argv[2], target = process.argv[3];
        const alias = path.join(root, 'current');
        const paths = api.resolveRuntimePaths({ anchor: path.join(alias, 'dist/processes/queue-worker.js'), home: root, env: {} });
        const read = fs.readSync;
        let injected = false;
        fs.readSync = function(fd, ...args) {
          const count = read.call(this, fd, ...args);
          if (!injected && fs.readlinkSync('/proc/self/fd/' + fd) === path.join(root, 'first', target)) {
            injected = true;
            fs.unlinkSync(alias); fs.symlinkSync(path.join(root, 'second'), alias, 'dir');
          }
          return count;
        };
        try { api.runtimeBuildIdentity(paths); console.log(JSON.stringify({ injected, accepted: true })); }
        catch (error) { console.log(JSON.stringify({ injected, accepted: false, code: error.code })); }
      `;
      const result = spawnSync(process.execPath, ['-e', script,
        path.join(adapterRoot, 'runtime-paths.js'), root, target],
        { encoding: 'utf8', timeout: 3000 });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { injected: true, accepted: false, code: 'UNPINNED_BUILD' });
    });
}

test('streamed identity preserves the exact sorted path/byte delimiter format and duplicate roots', t => {
  const root = fixture(t);
  const files: Array<[string, string]> = [
    ['package.json', '{"name":"fmcad"}'],
    ['dist/assets/a.bin', 'asset'],
    ['dist/processes/queue-worker.js', '// worker'],
    ['dist/processes/ż.js', '// unicode'],
    ['dist/runtime/python/module.py', 'print(1)'],
    ['bin/cli.js', '// cli'],
    ['scripts/console-source-format.py', '# formatter'],
  ];
  const expected = createHash('sha256');
  for (const [name, bytes] of files) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    expected.update(name); expected.update('\0'); expected.update(bytes); expected.update('\0');
  }
  fs.writeFileSync(path.join(root, 'dist/processes/ignored.map'), 'excluded');
  fs.mkdirSync(path.join(root, 'dist/processes/__pycache__'));
  fs.writeFileSync(path.join(root, 'dist/processes/__pycache__/ignored.py'), 'excluded');
  const paths = runtime.resolveRuntimePaths({ anchor: path.join(root, files[2]![0]), home: root, env: {} });
  const digest = expected.digest('hex');
  assert.equal(runtime.runtimeBuildIdentity(paths), digest);
  assert.equal(runtime.runtimeBuildIdentity({ ...paths, runtime: paths.assets }), digest);
  fs.chmodSync(path.join(root, files[2]![0]), 0o444);
  assert.equal(runtime.runtimeBuildIdentity(paths), digest);
});

for (const fault of ['symlink', 'fifo', 'directory-swap', 'during-read'] as const) {
  test(`identity refuses a bounded ${fault} race at the real filesystem boundary`,
    { skip: process.platform !== 'linux', timeout: 5000 }, t => {
      const root = fixture(t);
      const worker = path.join(root, 'dist/processes/queue-worker.js');
      fs.mkdirSync(path.dirname(worker), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fmcad"}');
      fs.writeFileSync(worker, '// original');
      fs.mkdirSync(path.join(root, 'other'));
      fs.writeFileSync(path.join(root, 'other/queue-worker.js'), '// redirected');
      const script = `
        const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
        const api = require(process.argv[1]), file = process.argv[2], fault = process.argv[3];
        const paths = api.resolveRuntimePaths({ anchor: file, home: path.dirname(file), env: {} });
        let injected = false;
        if (fault === 'during-read') {
          const read = fs.readSync;
          fs.readSync = function(fd, ...args) {
            const count = read.call(this, fd, ...args);
            if (!injected && fs.readlinkSync('/proc/self/fd/' + fd) === file) {
              injected = true; fs.writeFileSync(file, '// mutation');
            }
            return count;
          };
        } else if (fault === 'directory-swap') {
          const read = fs.readdirSync;
          fs.readdirSync = function(directory, ...args) {
            const entries = read.call(this, directory, ...args);
            if (!injected && fs.realpathSync(directory) === path.dirname(file)) {
              injected = true;
              const original = path.dirname(file);
              fs.renameSync(original, original + '.prior');
              fs.symlinkSync(path.join(original, '../../other'), original, 'dir');
            }
            return entries;
          };
        } else {
          const open = fs.openSync;
          fs.openSync = function(name, ...args) {
            if (!injected && fs.realpathSync(name) === file) {
              injected = true; fs.renameSync(file, file + '.prior');
              if (fault === 'symlink') fs.symlinkSync(file + '.prior', file);
              else {
                const result = cp.spawnSync('mkfifo', [file]);
                if (result.status !== 0) throw Error('Could not create owned FIFO fixture');
              }
            }
            return open.call(this, name, ...args);
          };
        }
        try { api.runtimeBuildIdentity(paths); console.log(JSON.stringify({ injected, accepted: true })); }
        catch (error) { console.log(JSON.stringify({ injected, accepted: false, code: error.code })); }
      `;
      const result = spawnSync(process.execPath, ['-e', script,
        path.join(adapterRoot, 'runtime-paths.js'), worker, fault],
        { encoding: 'utf8', timeout: 3000 });
      assert.equal(result.status, 0, result.stderr);
      const observed = record(JSON.parse(result.stdout));
      assert.equal(observed["injected"], true);
      assert.equal(observed["accepted"], false);
      assert.equal(observed["code"], 'UNPINNED_BUILD');
    });
}

test('an unreadable executable input cannot disappear from the fingerprint',
  { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, t => {
    const root = fixture(t);
    const worker = path.join(root, 'dist/processes/queue-worker.js');
    fs.mkdirSync(path.dirname(worker), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fmcad"}');
    fs.writeFileSync(worker, '// source');
    const paths = runtime.resolveRuntimePaths({ anchor: worker, home: root, env: {} });
    fs.chmodSync(worker, 0);
    assert.throws(() => runtime.runtimeBuildIdentity(paths), { code: 'EACCES' });
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

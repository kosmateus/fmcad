'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { RUNTIME_FILES, archiveFiles, install } = require(path.join(process.env.FMCAD_UPSTREAM_TEST_ROOT || path.resolve(__dirname, '..'), 'scripts/install-queue-phases'));
const stage = path.resolve(__dirname, '..');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qinstall-'));
  const dir = path.join(root, 'queue');fs.mkdirSync(dir);
  const entries = new Map([['package.json', Buffer.from('{"name":"offline-install-fixture","version":"1.0.0"}')]]);
  for (const file of RUNTIME_FILES) if (file !== 'src/queue-phased.js') entries.set(file, Buffer.from('original fixture bytes for ' + file + '\n'));
  const records = [];
  for (const [file, bytes] of entries) {
    const header = Buffer.alloc(512);header.write('package/' + file, 0);header.write('0000644\0', 100);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);header[156] = 48;
    header.write('ustar\0', 257);header.fill(32, 148, 156);
    header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    records.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  const archive = path.join(root, 'baseline.tgz');fs.writeFileSync(archive, zlib.gzipSync(Buffer.concat([...records, Buffer.alloc(1024)])));
  const baseline = archiveFiles(archive);
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'package.json'), baseline.get('package.json'));
  for (const file of RUNTIME_FILES) {
    if (!baseline.has(file)) continue;
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });fs.writeFileSync(path.join(root, file), baseline.get(file));
  }
  fs.writeFileSync(path.join(root, 'src/console-theme.js'), 'unrelated user UI work\n');
  fs.writeFileSync(path.join(dir, 'queue-state.json'), JSON.stringify({ active: null, blocked: null, lease: null, jobs: {} }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, stage, archive };
}

test('installation refuses a foreign active/unknown lease without stopping or editing anything', async t => {
  const f = fixture(t), before = hash(path.join(f.root, 'src/queue-state.js'));let stops = 0;
  fs.writeFileSync(path.join(f.dir, 'broker.lock'), '{}');
  await assert.rejects(install({ ...f, apply: true, control: async action => {
    if (action === 'stop') stops++;
    return { active: 'other', blocked: { id: 'other' }, lease: { clientId: 'other-owner' }, jobs: {} };
  } }), { code: 'QUEUE_NOT_QUIESCENT' });
  assert.equal(stops, 0);assert.equal(hash(path.join(f.root, 'src/queue-state.js')), before);
  assert.equal(fs.existsSync(path.join(f.dir, 'recovery.lock')), false);
});

test('concurrent installed-source changes are preserved, never overwritten by the staged patch', async t => {
  const f = fixture(t);fs.appendFileSync(path.join(f.root, 'src/queue-state.js'), '\n// another author\n');
  const before = hash(path.join(f.root, 'src/queue-state.js'));
  await assert.rejects(install({ ...f, apply: true, control: async () => { throw Error('Control must not be called'); } }), { code: 'CONCURRENT_SOURCE_CHANGE' });
  assert.equal(hash(path.join(f.root, 'src/queue-state.js')), before);
});

test('quiescent installation fences autostart, stops only the idle broker and preserves unrelated files', async t => {
  const f = fixture(t);fs.writeFileSync(path.join(f.dir, 'broker.lock'), '{}');const calls = [];
  const result = await install({ ...f, apply: true, control: async action => {
    calls.push(action);
    if (action === 'stop') { assert.equal(fs.existsSync(path.join(f.dir, 'recovery.lock')), true);fs.unlinkSync(path.join(f.dir, 'broker.lock'));return { stopping: true }; }
    return { active: null, blocked: null, lease: null, jobs: {} };
  } });
  assert.equal(result.state, 'installed');assert.equal(result.fusionCalls, 0);assert.equal(result.brokerLeftStopped, true);
  assert.deepEqual(calls, ['status', 'status', 'stop']);
  assert.equal(fs.existsSync(path.join(f.dir, 'recovery.lock')), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'src/console-theme.js'), 'utf8'), 'unrelated user UI work\n');
  for (const file of result.files) assert.equal(hash(path.join(f.root, file.name)), file.afterSha256);
  assert.equal(fs.existsSync(path.join(result.backup, 'manifest.json')), true);
});

test('an interrupted local installation restores only its own bytes and removes incomplete temporary files', async t => {
  const f = fixture(t);const before = Object.fromEntries(RUNTIME_FILES.filter(file => fs.existsSync(path.join(f.root, file))).map(file => [file, hash(path.join(f.root, file))]));
  const rename = fs.renameSync;let installed = 0, injected = false;
  fs.renameSync = function(from, to) {
    if (String(from).endsWith('.install') && String(to).startsWith(f.root) && !String(to).includes('/tmp/queue-phases-install-')) {
      installed++;
      if (installed === 2 && !injected) { injected = true;throw Object.assign(new Error('Controlled install interruption'), { code: 'EIO' }); }
    }
    return rename.call(this, from, to);
  };
  try { await assert.rejects(install({ ...f, apply: true, control: async () => { throw Error('No broker is running'); } }), { code: 'EIO' }); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true);
  for (const [file, value] of Object.entries(before)) assert.equal(hash(path.join(f.root, file)), value);
  assert.equal(fs.existsSync(path.join(f.dir, 'recovery.lock')), false);
  assert.equal(fs.readdirSync(path.join(f.root, 'assets/cad')).some(file => file.endsWith('.install')), false);
});

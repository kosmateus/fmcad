'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { openSource } = require('../src/console-source');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, source = 'x=1\n') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcad-source-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'source.py');
  await fs.writeFile(file, source);
  return { dir, file };
}
const joined = preview => preview.lines.map(line => line.map(span => span.text).join('')).join('\n');

test('source preview preserves bytes and mtime, checks hashes, and never executes source', async t => {
  const { dir, file } = await fixture(t);
  const marker = path.join(dir, 'executed');
  const original = `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('executed')\nx=1\n`;
  await fs.writeFile(file, original);
  const before = await fs.stat(file);
  const bytes = await fs.readFile(file);
  const result = await openSource({ sourcePath: file, sourceHash: hash(bytes) });
  assert.equal(result.original, original);
  assert.equal(result.sha256, hash(bytes));
  assert.equal(result.changedSinceRun, false);
  assert.equal(joined(result), result.formatted);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  const changed = await openSource({ sourcePath: file, sourceHash: '0'.repeat(64) });
  assert.equal(changed.changedSinceRun, true);
});

test('valid source formats in memory when optional libraries are available', async t => {
  const { file } = await fixture(t, 'x=1\n');
  const result = await openSource({ sourcePath: file });
  assert.equal(result.original, 'x=1\n');
  assert.equal(result.changedSinceRun, null);
  if (!result.formatter.applied) {
    assert.match(result.formatter.error, /unavailable|No module named|Missing Python dependencies/i);
    t.skip('Optional Python formatter or syntax library unavailable');
    return;
  }
  assert.equal(result.formatter.error, null);
  assert.equal(result.formatted, 'x = 1\n');
  assert.equal(joined(result), result.formatted);
  assert.ok(result.lines.flat().some(span => span.tone === 'warning'));
  assert.equal(await fs.readFile(file, 'utf8'), 'x=1\n');
});

test('source preview shares bounded reader and hash policy without losing runtime Python preflight', async t => {
  const { dir, file } = await fixture(t, 'x=1\n');
  const missingPython = path.join(dir, 'missing-python');
  const result = await openSource({ sourcePath: file, sourceHash: hash(await fs.readFile(file)).toUpperCase() }, { pythonPath: missingPython });
  assert.equal(result.changedSinceRun, false);
  assert.equal(result.original, 'x=1\n');
  assert.match(result.formatter.error, /unavailable/);
  const link = path.join(dir, 'source-link.py');
  await fs.symlink(file, link);
  const rejected = await openSource({ sourcePath: link }, { pythonPath: missingPython });
  assert.equal(rejected.original, null);
  assert.equal(rejected.sha256, null);
  assert.ok(rejected.formatter.error);
  assert.equal(require('../src/console-source').readSource, require('../src/dist/node-adapters/console/bounded-read').readSource);
});

test('invalid Python and missing interpreter preserve original memory copy', async t => {
  const original = 'def broken(:\n';
  const { dir, file } = await fixture(t, original);
  const invalid = await openSource({ sourcePath: file });
  assert.equal(invalid.formatter.applied, false);
  assert.ok(invalid.formatter.error);
  assert.equal(invalid.formatted, original);
  assert.equal(joined(invalid), original);
  const missing = await openSource({ sourcePath: file }, { pythonPath: path.join(dir, 'missing-python') });
  assert.equal(missing.formatter.applied, false);
  assert.match(missing.formatter.error, /unavailable/);
  assert.equal(missing.formatted, original);
  assert.equal(joined(missing), original);
});

test('Python preview assigns distinct semantic colors without changing or executing source', async t => {
  const { file } = await fixture(t, '# comment\nclass Example:\n    def method(self):\n        return print("hello", 42)\n');
  const result = await openSource({ sourcePath: file });
  if (!result.formatter.applied) { t.skip('Optional Python libraries unavailable'); return; }
  const tones = new Set(result.lines.flat().map(span => span.tone));
  for (const tone of ['syntaxKeyword', 'syntaxFunction', 'syntaxType', 'syntaxBuiltin', 'success', 'warning', 'muted']) assert.ok(tones.has(tone), tone);
});

test('missing, oversized, non-regular, and non-UTF-8 files report explicit errors', async t => {
  const { dir, file } = await fixture(t, 'abcdef');
  const oversized = await openSource({ sourcePath: file }, { maxBytes: 3 });
  assert.match(oversized.formatter.error, /exceeds/);
  assert.equal(oversized.original, null);
  const missing = await openSource({ sourcePath: path.join(dir, 'absent.py') });
  assert.ok(missing.formatter.error);
  assert.equal(missing.sha256, null);
  const directory = await openSource({ sourcePath: dir });
  assert.ok(directory.formatter.error);
  assert.equal(directory.original, null);
  await fs.writeFile(file, Buffer.from([0xff]));
  const encoding = await openSource({ sourcePath: file });
  assert.ok(encoding.formatter.error);
  assert.equal(encoding.original, null);
  assert.equal(encoding.sha256, hash(Buffer.from([0xff])));
});

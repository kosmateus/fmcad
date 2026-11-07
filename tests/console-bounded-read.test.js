'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readBounded, readSource } = require('../packages/node-adapters/dist/console/bounded-read');

test('bounded Node reader reports missing/error, refuses symlinks, directories and excess bytes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-console-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'response');
  assert.equal((await readBounded(file, 8)).status, 'missing');
  fs.writeFileSync(file, 'null');
  const value = await readBounded(file, 4);
  assert.equal(value.status, 'available');
  assert.equal(value.value.toString(), 'null');
  assert.equal((await readBounded(file, 3)).status, 'error');
  assert.equal((await readBounded(file, 0)).status, 'error');
  assert.equal((await readBounded(dir, 100)).status, 'error');
  const link = path.join(dir, 'link'); fs.symlinkSync(file, link);
  assert.equal((await readBounded(link, 10)).status, 'error');
  await assert.rejects(readSource(path.join(dir, 'missing'), 10), { code: 'ENOENT' });
});

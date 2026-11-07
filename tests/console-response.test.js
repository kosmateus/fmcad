'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const kit = require('terminal-kit');
const { openResponse, jsonLines } = require('../src/console-response');
const { createUI } = require('../src/console-ui');
const { render } = require('../src/console-response-view');
const { pointerAction } = require('../src/console-pointer');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcad-response-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project'); await fs.mkdir(project);
  await fs.mkdir(path.join(dir, 'jobs', 'task'), { recursive: true });
  const row = { id: 'task' }, snapshot = { mode: 'broker', project, operations: [row] };
  await fs.writeFile(path.join(dir, 'queue-state.json'), JSON.stringify({ jobs: { task: { id: 'task', request: { cwd: project } } } }));
  return { dir, project, row, snapshot };
}
test('saved response is read-only, pretty-printed and JSON-highlighted; stderr stays separate', async t => {
  const f = await fixture(t), file = path.join(f.dir, 'jobs/task/stdout.txt');
  const original = '{"success":false,"result":{"count":0,"name":"Fusion","missing":null}}\n';
  await fs.writeFile(file, original); await fs.writeFile(path.join(f.dir, 'jobs/task/stderr.txt'), 'diagnostic\n');
  const before = await fs.stat(file), result = await openResponse(f.row, f.snapshot, { dir: f.dir });
  assert.equal(result.error, null); assert.deepEqual(result.outputs.map(item => item.name), ['stdout.txt', 'stderr.txt']);
  const output = result.outputs[0];
  assert.deepEqual(JSON.parse(output.text), JSON.parse(original));
  assert.equal(output.lines.map(line => line.map(span => span.text).join('')).join('\n'), output.text);
  const tones = new Set(output.lines.flat().map(span => span.tone));
  for (const tone of ['syntaxKey', 'syntaxKeyword', 'success', 'warning']) assert.ok(tones.has(tone));
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readdir(f.dir), ['jobs', 'project', 'queue-state.json']);
});
test('missing output, direct mode, unknown ID and foreign project never manufacture a response', async t => {
  const f = await fixture(t);
  assert.equal((await openResponse(f.row, f.snapshot, { dir: f.dir })).error, 'NO_RETAINED_RESPONSE');
  assert.equal((await openResponse(f.row, { ...f.snapshot, mode: 'direct' }, { dir: f.dir })).error, 'DIRECT_RESPONSE_NOT_RETAINED');
  assert.equal((await openResponse({ id: '../task' }, f.snapshot, { dir: f.dir })).error, 'TASK_NOT_IN_SNAPSHOT');
  const other = path.join(f.dir, 'other'); await fs.mkdir(other);
  assert.equal((await openResponse(f.row, { ...f.snapshot, project: other }, { dir: f.dir })).error, 'TASK_PROJECT_MISMATCH');
});
test('response reads are bounded and malformed JSON remains text', async t => {
  const f = await fixture(t), file = path.join(f.dir, 'jobs/task/rpc-result.json');
  await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 1));
  assert.match((await openResponse(f.row, f.snapshot, { dir: f.dir })).outputs[0].error, /exceeds/);
  await fs.writeFile(file, '{partial');
  const output = (await openResponse(f.row, f.snapshot, { dir: f.dir })).outputs[0];
  assert.equal(output.json, false); assert.equal(output.text, '{partial');
});
test('JSON highlighting preserves escaped strings and all exact text', () => {
  const text = JSON.stringify({ 'quote"key': 'line\nvalue', flag: true, amount: -1.2e-7 }, null, 2);
  assert.equal(jsonLines(text).map(line => line.map(span => span.text).join('')).join('\n'), text);
});
test('response viewer supports bounded modal scrolling and mouse stream selection', () => {
  for (const Class of [kit.ScreenBuffer, kit.ScreenBufferHD]) for (const [width, height] of [[80, 24], [140, 40]]) {
    const ui = createUI({ buffer: new Class({ width, height }), prefs: {}, language: 'pl' });
    const text = JSON.stringify({ values: Array.from({ length: 100 }, (_, i) => i) }, null, 2);
    const modal = { kind: 'response', row: { id: 'task' }, index: 0, result: { outputs: [
      { name: 'stdout.txt', path: '/fixture/stdout.txt', lines: jsonLines(text) }, { name: 'stderr.txt', path: '/fixture/stderr.txt', lines: [] },
    ] } };
    render(ui, modal);
    const viewport = ui.hits.find(hit => hit.type === 'viewport');
    pointerAction('MOUSE_WHEEL_DOWN', { x: viewport.x + 1, y: viewport.y + 1 }, ui, {}, { modal: true });
    assert.ok(modal.viewport.offset > 0);
    const stream = ui.hits.find(hit => hit.type === 'response-stream' && hit.index === 1);
    assert.equal(pointerAction('MOUSE_LEFT_BUTTON_PRESSED', { x: stream.x + 1, y: stream.y + 1 }, ui, {}, { modal: true }).index, 1);
    assert.ok(ui.hits.every(hit => hit.x >= 0 && hit.y >= 0 && hit.x + hit.width <= width && hit.y + hit.height <= height));
  }
});

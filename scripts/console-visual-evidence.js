'use strict';
// Captures actual ScreenBuffer cells. It is not a mock-up or browser rendering.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('terminal-kit');
const args = Object.fromEntries(process.argv.slice(2).map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
const root = path.resolve(args.root || path.join(__dirname, '..'));
const output = path.resolve(args.output || path.join(root, 'tmp/console-visual-evidence'));
const project = args.project;
if (!project) throw new Error('Provide project=/absolute/path (passive file reads only)');
const cfg = require(path.join(root, 'src/config')).loadConfig().cfg;
const adapter = require(path.join(root, 'src/console-data')).createAdapter({ project: fs.realpathSync(project), cfg });
adapter.read();
// A real second passive sample, so CPU/network rates are measured rather than invented.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
const snapshot = adapter.read();
const { ConsoleModel } = require(path.join(root, 'src/console-controller'));
const { render } = require(path.join(root, 'src/console-view'));
const width = Number(args.width || 200), height = Number(args.height || 52), language = args.language || 'pl';
const model = new ConsoleModel(); model.update(snapshot);
fs.mkdirSync(output, { recursive: true });
const shots = [];
for (let tab = 0; tab < 5; tab++) {
  if (args.tabs && !args.tabs.split(',').includes(String(tab))) continue;
  model.tab = tab;
  if (args.history === 'true' && ['agents', 'tasks'].includes(model.name)) model.state.filters.scope = 'history';
  const BufferClass = args.hd === 'true' ? kit.ScreenBufferHD : kit.ScreenBuffer;
  const buffer = new BufferClass({ width, height }); buffer.draw = () => {};
  render({ model, term: {}, buffer, prefs: { color: 'auto', frames: 'unicode' }, language, modal: null, message: '' });
  const cells = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) row.push(buffer.get({ x, y }));
    cells.push(row);
  }
  const name = `${args.prefix || 'console'}-${tab + 1}-${model.name}`;
  fs.writeFileSync(path.join(output, name + '.txt'), cells.map(row => row.map(cell => cell.char === '\x00' ? '' : cell.char).join('')).join('\n'));
  const file = path.join(output, name + '.png');
  const result = spawnSync(process.env.FMCAD_SCREENSHOT_PYTHON || 'python3', [path.join(__dirname, 'console-rasterize.py'), file], {
    input: JSON.stringify({ width, height, cells }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || 'PNG rasterization failed');
  shots.push(file);
}
fs.writeFileSync(path.join(output, (args.prefix || 'console') + '-evidence.json'), JSON.stringify({ rendererRoot: root,
  source: 'Actual renderer and passive local project snapshot; not a desktop screenshot', project, width, height, language,
  brokerOnline: snapshot.broker?.online ?? null, sourceAvailable: snapshot.available,
  operations: snapshot.operations?.length ?? null, logs: snapshot.logs?.length ?? null, shots }, null, 2) + '\n');
console.log(shots.join('\n'));

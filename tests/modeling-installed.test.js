'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const inventory = require('./fixtures/modeling-operation-contracts.json');

test('installed modeling contracts validate every assigned public example outside the checkout', { timeout: 180000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-modeling-consumer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"private":true}');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root, encoding: 'utf8' }));
  execFileSync('npm', ['install', '--offline', '--prefix', directory, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', path.join(directory, packed[0].filename)], { cwd: directory, encoding: 'utf8', timeout: 120000 });
  const installed = path.join(directory, 'node_modules/fmcad');
  assert.equal(fs.existsSync(path.join(installed, 'src')), false);
  fs.writeFileSync(path.join(directory, 'inventory.json'), JSON.stringify(inventory));
  const declarations = [
    ...['sketch', 'curve', 'surface', 'datum', 'entity-query', 'spring', 'thread', 'seal', 'cam', 'fastener', 'feature-rework', 'selection-service'].map(name => 'core/application/modeling/' + name),
    'node-adapters/persistence/selection-service', 'node-adapters/persistence/brep-baseline-service', 'python/curve-source',
  ];
  fs.writeFileSync(path.join(directory, 'consumer.ts'), declarations.map((name, index) =>
    `import * as module${index} from './node_modules/fmcad/dist/src/dist/${name}.js'; void module${index};`).join('\n'));
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', 'false', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', 'consumer.ts'], { cwd: directory, encoding: 'utf8', timeout: 60000 });

  fs.writeFileSync(path.join(directory, 'consumer.cjs'), `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const inventory = require('./inventory.json');
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (String(file).startsWith(${JSON.stringify(root + path.sep)})) throw Error('Unexpected checkout access: ' + file);
      return read.call(this, file, ...args);
    };
    const fail = () => { throw Error('Validation must not launch a host or native process'); };
    for (const key of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) require('node:child_process')[key] = fail;
    require('node:net').createConnection = fail;
    const { createCatalogServices } = require('fmcad/api');
    const services = createCatalogServices();
    const entries = new Map(services.list().map(entry => [entry.operation, entry]));
    let count = 0;
    for (const row of inventory.operations) {
      const entry = entries.get(row.operation);
      assert.ok(entry, row.operation);
      const input = structuredClone(entry.declaration.example);
      const before = JSON.stringify(input);
      services.validateData(row.operation, input);
      assert.equal(JSON.stringify(input), before, row.operation + ' mutated input');
      assert.equal(entry.declaration.readOnly === true, row.declaredReadOnly, row.operation);
      count++;
    }
    for (const family of ['sketch', 'curve', 'surface', 'datum', 'entity-query', 'spring', 'thread', 'seal', 'cam', 'fastener', 'feature-rework']) {
      const source = read(require('node:path').join(${JSON.stringify(installed)}, 'dist/src/dist/core/application/modeling', family + '.d.ts'), 'utf8');
      assert.ok(source.includes('export'), family);
    }
    process.stdout.write(JSON.stringify({ count }));
    process.exit(0);
  `);
  const result = JSON.parse(execFileSync(process.execPath, ['consumer.cjs'], { cwd: directory, env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory }, encoding: 'utf8', timeout: 60000 }));
  assert.equal(result.count, inventory.operations.length);
});

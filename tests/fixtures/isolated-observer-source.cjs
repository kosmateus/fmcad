'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Negative admission cases alter only this disposable code/checker copy. Never
// rename a checker binary reached through the worktree's shared node_modules.
function isolatedObserverSource(root, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ['package.json', 'src', 'assets', 'runtime', 'bin', 'dist/src', 'dist/runtime',
    'dist/package.json', 'dist/bin', 'scripts/console-source-format.py', 'tests/fixtures/observer-python-literals.py',
    'tests/fixtures/atomic-observer-composition.json']) {
    const source = path.join(root, name), target = path.join(destination, name);
    if (!fs.existsSync(source)) throw new Error('Observer fixture requires a built source tree: ' + name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  }
  const modules = path.join(destination, 'node_modules');
  fs.mkdirSync(modules, { mode: 0o700 });
  for (const name of fs.readdirSync(path.join(root, 'node_modules'))) {
    if (name === 'basedpyright') continue;
    fs.symlinkSync(path.join(root, 'node_modules', name), path.join(modules, name));
  }
  const checker = path.dirname(require.resolve('basedpyright/package.json', { paths: [root] }));
  fs.cpSync(checker, path.join(modules, 'basedpyright'), { recursive: true, errorOnExist: true, force: false });
  return destination;
}

module.exports = { isolatedObserverSource };

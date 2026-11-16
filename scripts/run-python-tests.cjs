const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pythonPath = [path.join(root, 'runtime', 'python'), process.env.PYTHONPATH]
  .filter(Boolean)
  .join(path.delimiter);

const result = spawnSync(
  python,
  ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', '*_test.py'],
  {
    cwd: root,
    env: { ...process.env, PYTHONPATH: pythonPath },
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('workspace and packaged fmcad launchers use the same installed distribution runtime', () => {
  const root = path.resolve(__dirname, '..');
  const cases = [
    {
      launchers: ['bin/fmcad.js', 'dist/bin/fmcad.js'],
      expected: path.join(root, 'dist/src/dist/entrypoints/cli.js'),
      stub: `return { main(argv) {
        process.stdout.write(JSON.stringify({ entrypoint: request, argv }));
      }};`,
    },
    {
      launchers: ['bin/fmcad-mcp.js', 'dist/bin/fmcad-mcp.js'],
      expected: path.join(root, 'dist/src/dist/entrypoints/mcp-stdio.js'),
      stub: `return { startStdio(argv) {
        process.stdout.write(JSON.stringify({ entrypoint: request, argv }));
      }};`,
    },
  ];

  for (const { launchers, expected, stub } of cases) {
    const probe = `
    const path = require('node:path');
    const Module = require('node:module');
    const expected = ${JSON.stringify(expected)};
    const load = Module._load;
    Module._load = function(request, parent, ...rest) {
      if (request === expected) ${stub}
      return load.call(this, request, parent, ...rest);
    };
    const launcher = process.argv[1];
    process.argv = [process.execPath, launcher, '--help'];
    require(launcher);
    `;

    for (const launcher of launchers) {
      const result = spawnSync(process.execPath, ['-e', probe, path.join(root, launcher)], {
        cwd: root, encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${launcher}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), { entrypoint: expected, argv: ['--help'] });
    }
  }
});

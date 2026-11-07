#!/usr/bin/env node
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});
const path = require('node:path');
const fs = require('node:fs');
const installation = path.resolve(__dirname, '..');
const packaged = path.join(installation, 'dist/src/dist/entrypoints/cli.js');
const nested = path.join(installation, 'src/dist/entrypoints/cli.js');
require(fs.existsSync(packaged) ? packaged : nested).main(process.argv.slice(2));

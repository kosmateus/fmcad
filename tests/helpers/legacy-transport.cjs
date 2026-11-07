'use strict';
// Explicit test-only composition for legacy CLI formatting/payload fixtures.
// Production clients never infer physical authorization from a worker env var.
// Queue admission and real broker construction are exercised in separate E2E.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { createBrokerTransport } = require('../../packages/node-adapters/dist/fusion-transport/broker');
const { requestTimeout } = require('../../src/request-timeout');
const root = path.resolve(__dirname, '../..');
const load = Module._load;
Module._load = function (name, parent, ...rest) {
  if (name === './backends' && parent?.filename === path.join(root, 'src/cli.js')) {
    return { createBackend: server => createBrokerTransport(server, {
      version: require('../../package.json').version,
      requestTimeout,
      bridgeSource: () => fs.readFileSync(path.join(root, 'assets/cad/identity.py'), 'utf8') + '\n' +
        fs.readFileSync(path.join(root, 'assets/addin-bridge.py'), 'utf8'),
    }) };
  }
  return load.call(this, name, parent, ...rest);
};

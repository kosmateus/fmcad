const fs = require('node:fs');
const path = require('node:path');
const { buildBridgeScript: build } = require('./dist/fusion-transport/bridge');
const { resolveRuntimePaths } = require('./dist/config-platform');

function buildBridgeScript(toolName, request) {
  const assets = resolveRuntimePaths({ anchor: __filename }).assets;
  const source = fs.readFileSync(path.join(assets, 'cad/identity.py'), 'utf8') + '\n' +
    fs.readFileSync(path.join(assets, 'addin-bridge.py'), 'utf8');
  return build(toolName, request, source);
}

module.exports = { buildBridgeScript };

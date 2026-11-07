const { McpClient } = require('./client');
const { AddinClient } = require('./addin-client');

function createBackend(server, constructors = {}) {
  if (server?.routing === 'direct') {
    throw Object.assign(new Error('routing=direct is no longer supported; use the shared fmcad broker'), {
      code: 'UNSUPPORTED_ROUTING',
    });
  }
  const backend = server.backend || 'mcp';
  if (backend === 'mcp') return new (constructors.McpClient || McpClient)(server);
  if (backend === 'addin') return new (constructors.AddinClient || AddinClient)(server);
  throw new Error('Unknown backend: ' + backend);
}

module.exports = { createBackend };

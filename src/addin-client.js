const { McpClient } = require('./client');
const { ADDIN_CAPABILITIES } = require('./dist/fusion-transport/addin-capabilities');

// Public compatibility clients retain metadata only; broker code owns transport.
class AddinClient extends McpClient {
  constructor(server) {
    super({ ...server, protocolVersion: server.protocolVersion || '2025-06-18' });
    this.capabilities = ADDIN_CAPABILITIES;
  }
  executeUiGuardedScript() {
    return Promise.reject(Object.assign(new Error('SDK access requires a broker turn'), { code: 'QUEUE_REQUIRED' }));
  }
}

module.exports = { AddinClient, ADDIN_CAPABILITIES };

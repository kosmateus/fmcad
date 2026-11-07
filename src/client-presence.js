'use strict';

const core = require('./dist/core');
const { createClientPresenceAdapter } = require('./dist/node-adapters/telemetry/client-presence');

module.exports = createClientPresenceAdapter(core);

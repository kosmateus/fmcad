'use strict';
const { stripVTControlCharacters } = require('node:util');
const { redactDiagnostic } = require('./diagnostics');
const { parseConsoleLog } = require('./dist/core');
const { createLogReader } = require('./dist/node-adapters/console/logs');
function sanitize(value, cfg = {}) {
  return stripVTControlCharacters(redactDiagnostic(String(value), cfg)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
function parseLog(value, cfg = {}) { return parseConsoleLog(sanitize(value, cfg)); }
const read = createLogReader(parseLog);
function readLogs(project, cfg = {}, ...options) { return read(project, cfg, ...options); }
module.exports = { readLogs, sanitize, parseLog };

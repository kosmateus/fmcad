'use strict';
const { render } = require('./console-renderer');
const { wrap } = require('./console-theme');
const { t } = require('./i18n');
const { label } = require('./console-labels');
function banner(snapshot, language) {
  if (snapshot.mode === 'direct') return t('directPause', {}, language);
  if (snapshot.broker?.state === 'STOPPED') return label('brokerOffline', language);
  const key = { RUNNING: 'running', PAUSED: 'paused', PAUSING: 'pausing', RESUMING: 'resuming', RECOVERY_BLOCKED: 'blocked' }[snapshot.broker?.state];
  return t(snapshot.available && key ? key : 'unconfirmed', {}, language);
}
function details(row, language) {
  if (!row) return [t('noData', {}, language)];
  return [t('purpose', {}, language) + ': ' + (row.description || t('noDescription', {}, language)),
    t('operation', {}, language) + ': ' + (row.label || row.component || '—'),
    ...['id', 'state', 'document', 'clientId', 'requestId', 'sessionId', 'code', 'message'].filter(key => row[key] !== undefined).map(key => key + ': ' + row[key])];
}
module.exports = { render, banner, details, wrap };

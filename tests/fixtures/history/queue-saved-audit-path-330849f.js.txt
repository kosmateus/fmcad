'use strict';
const path = require('node:path');
const { hash, fusionPath } = require('./queue-instance');

function savedAuditKind(prefix, requestId) {
  if (!['dp-', 'sp-', 'sr-'].includes(prefix) || typeof requestId !== 'string' || !requestId.trim() || requestId.length > 180)
    throw Object.assign(new Error('Exact saved audit purpose and request ID required'), { code: 'INVALID_REQUEST' });
  // Only the directory locator is shortened. Full request IDs/binding hashes
  // remain authoritative; a prefix collision fails the immutable intent key check.
  return prefix + hash(requestId).slice(0, 16);
}

function savedAuditLegacyKind(prefix, requestId) {
  savedAuditKind(prefix, requestId); // Same strict input validation.
  return prefix + hash(requestId);
}

function assertSavedAuditPathBudget(directory) {
  const receipt = path.join(directory, 'remote-00000000-0000-0000-0000-000000000000.json');
  const native = receipt.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(receipt) ? receipt : fusionPath(receipt);
  const atomicTempLength = native.length + 41; // Existing .<uuid>.tmp writer, unchanged.
  if ((native.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(native)) && atomicTempLength > 259)
    throw Object.assign(new Error('Saved audit receipt atomic temporary path exceeds Windows MAX_PATH; no SDK request submitted'),
      { code: 'SAVED_AUDIT_PATH_TOO_LONG', nativeReceiptLength: native.length, atomicTempLength });
  return { nativeReceiptLength: native.length, atomicTempLength };
}

module.exports = { savedAuditKind, savedAuditLegacyKind, assertSavedAuditPathBudget };

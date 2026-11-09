"use strict";
const policy = require('./dist/core/application/cad/owner-migration');
const observation = require('./atomic-workflow-observation');
const dependencies = {
  scope: observation.fastenersScope,
  isCandidate: observation.isAtomicObservationCandidate,
  assertUpgrade: (...args) => require('./queue-atomic-audit-upgrade').assertAuditUpgradeSnapshot(...args),
};
module.exports = {
  assertHeld: (...args) => policy.assertHeld(dependencies, ...args),
  createMigrator: ports => policy.createMigrator(ports, dependencies),
};

const { dependencyOrder, makePlan } = require('./dist/core/application/documents/reference-plan');
const { hash } = require('./engineering-common');
const { publishComplete } = require('./publish');
const { createReferenceWorkflow } = require('./dist/node-adapters/persistence/reference-workflow');
const { loadJournal, writePlan, readPlan, apply, execute } = createReferenceWorkflow({ hash, publish: publishComplete });

const { validate } = require('./dist/core/application/documents/reference-input');
const { staleBeforeStep, planFreshness } = require('./dist/core/application/documents/reference-freshness');

function configure(catalog) {
  if (!catalog['references.refresh']) throw new Error('references.refresh catalog entry is required');
  const entry = catalog['references.refresh'];
  entry.nodeOnly = true;
  entry.batchAllowed = false;
  entry.requiresDoc = false;
}


module.exports = { configure, validate, makePlan, dependencyOrder, staleBeforeStep, planFreshness, writePlan,
  readPlan, loadJournal, apply, execute };

const { canonical, hash } = require('./dist/core/application/cad/json');
const { createStageApi, validateStageJournal, inspectStageJournal, resumeStagePlan, revalidateStagePlan } = require('./dist/core/application/stage-journal');
const { openStageJournal, stageReceiptReference } = require('./dist/node-adapters/persistence/stage-journal');

/** Composition-only: scope and pinnedDocument MUST come from the authenticated owning job.
 * Never call this with CAD data/context or inspection request arguments as authority.
 * Evidence is the owner's original accepted-byte/build/document/terminal-receipt reader.
 */
function createDocumentSaveStages(operationDirectory, authenticatedOwner, evidence) {
  const scope = JSON.parse(canonical(authenticatedOwner.scope));
  const pinnedDocument = JSON.parse(canonical(authenticatedOwner.pinnedDocument));
  validateStageJournal([], scope);
  if (scope.document !== canonical(pinnedDocument)) throw new Error('Authenticated document stage scope differs from pinned owning-job document');
  const journal = openStageJournal(operationDirectory, scope, validateStageJournal);
  const api = createStageApi(journal, scope);
  function bind(binding) {
    if (canonical(binding.target) !== canonical(pinnedDocument)) throw new Error('Document stage target differs from authenticated owning job');
    return { id: 'document.save.once', requestHash: binding.requestHash, mutates: true };
  }
  const head = () => journal.read().at(-1)?.sha256;
  return {
    stages: {
      plan(binding) {
        const stage = bind(binding);
        // Existing/missing-after-use journals are never reconstructed as replay permission.
        if (journal.read().length) throw new Error('Document stage journal already exists; inspect the original request, never resubmit');
        api.plan([stage]); return head();
      },
      started(binding) {
        const stage = bind(binding);
        const plan = journal.read()[0]?.event;
        if (plan?.kind !== 'plan' || plan.stages.length !== 1 || hash(plan.stages[0]) !== hash(stage)) throw new Error('Document stage plan differs from original binding');
        api.started(stage.id, stageReceiptReference(Buffer.from(canonical(binding), 'utf8')));
        return head();
      },
    },
    inspect: expectedHead => inspectStageJournal(journal, scope, evidence, expectedHead),
    resumePlan: expectedHead => resumeStagePlan(journal, scope, evidence, expectedHead),
    revalidate: plan => revalidateStagePlan(plan, journal, scope, evidence),
  };
}
module.exports = { createDocumentSaveStages };

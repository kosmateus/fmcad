import type { SaveBinding, SaveTarget } from "./save";
import { canonical, clone, hash } from "../cad/json";
import {
  createStageApi,
  inspectStageJournal,
  resumeStagePlan,
  revalidateStagePlan,
  validateStageJournal,
  type StageDefinition,
  type StageEvidencePort,
  type StageJournalPort,
  type StageScope,
} from "../stage-journal";

/** Supplied only by authenticated owning-job composition, never decoded from CAD data/context. */
export interface DocumentSaveStages {
  plan(binding: SaveBinding): Promise<string> | string;
  started(binding: SaveBinding): Promise<string> | string;
}

/** Trusted owning-job data, never authority supplied by a CAD request. */
export interface DocumentSaveStageOwner {
  scope: StageScope;
  pinnedDocument: SaveTarget;
}

export function createDocumentSaveStages(
  authenticatedOwner: DocumentSaveStageOwner,
  evidence: StageEvidencePort,
  openJournal: (scope: StageScope) => StageJournalPort,
) {
  const scope = clone(authenticatedOwner.scope);
  const pinnedDocument = clone(authenticatedOwner.pinnedDocument);
  validateStageJournal([], scope);
  if (scope.document !== canonical(pinnedDocument))
    throw new Error(
      "Authenticated document stage scope differs from pinned owning-job document",
    );
  const journal = openJournal(scope);
  const api = createStageApi(journal, scope);
  function bind(binding: SaveBinding): StageDefinition {
    if (canonical(binding.target) !== canonical(pinnedDocument))
      throw new Error(
        "Document stage target differs from authenticated owning job",
      );
    return {
      id: "document.save.once",
      requestHash: binding.requestHash,
      mutates: true,
    };
  }
  const head = (): string => {
    const entry = journal.read().at(-1);
    if (!entry)
      throw new Error("Document stage journal disappeared after publication");
    return entry.sha256;
  };
  const stages: DocumentSaveStages = {
    plan(binding) {
      const stage = bind(binding);
      if (journal.read().length)
        throw new Error(
          "Document stage journal already exists; inspect the original request, never resubmit",
        );
      api.plan([stage]);
      return head();
    },
    started(binding) {
      const stage = bind(binding);
      const plan = journal.read()[0]?.event;
      if (
        plan?.kind !== "plan" ||
        plan.stages.length !== 1 ||
        hash(plan.stages[0]) !== hash(stage)
      )
        throw new Error("Document stage plan differs from original binding");
      api.started(stage.id, hash(binding));
      return head();
    },
  };
  return {
    stages,
    inspect: (expectedHead?: string) =>
      inspectStageJournal(journal, scope, evidence, expectedHead),
    resumePlan: (expectedHead?: string) =>
      resumeStagePlan(journal, scope, evidence, expectedHead),
    revalidate: (plan: ReturnType<typeof resumeStagePlan>) =>
      revalidateStagePlan(plan, journal, scope, evidence),
  };
}

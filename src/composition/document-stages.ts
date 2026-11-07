import { createRequire } from "node:module";
import type { DocumentSaveStageOwner } from "../../packages/core/src/application/documents/stages.js";
import type { StageEvidencePort } from "../../packages/core/src/application/stage-journal.js";

const load = createRequire(__filename);
const { createDocumentSaveStages: createStages } = load(
  "../core/application/documents/stages.js",
) as typeof import("../../packages/core/src/application/documents/stages.js");
const { validateStageJournal } = load(
  "../core/application/stage-journal.js",
) as typeof import("../../packages/core/src/application/stage-journal.js");
const { openStageJournal } = load(
  "../node-adapters/persistence/stage-journal.js",
) as typeof import("../../packages/node-adapters/src/persistence/stage-journal.js");

export function createDocumentSaveStages(
  operationDirectory: string,
  authenticatedOwner: DocumentSaveStageOwner,
  evidence: StageEvidencePort,
) {
  return createStages(authenticatedOwner, evidence, (scope) =>
    openStageJournal(operationDirectory, scope, validateStageJournal),
  );
}

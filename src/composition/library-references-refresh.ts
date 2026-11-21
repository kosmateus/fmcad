import { createRequire } from "node:module";
import type { OperationDeclaration } from "@fmcad/core";
const load = createRequire(__filename);
const {
  dependencyOrder,
  makePlan,
}: typeof import("../../packages/core/src/application/documents/reference-plan.js") =
  load("../core/application/documents/reference-plan.js");
const {
  hash,
}: typeof import("../../packages/core/src/domain/engineering/common.js") = load(
  "../core/domain/engineering/common.js",
);
const {
  publishComplete,
}: typeof import("../../packages/node-adapters/src/persistence/publish.js") =
  load("../node-adapters/persistence/publish.js");
const {
  createReferenceWorkflow,
}: typeof import("../../packages/node-adapters/src/persistence/reference-workflow.js") =
  load("../node-adapters/persistence/reference-workflow.js");
const workflow = createReferenceWorkflow({ hash, publish: publishComplete });
const loadJournal: ReturnType<typeof createReferenceWorkflow>["loadJournal"] =
  workflow.loadJournal;
const writePlan: ReturnType<typeof createReferenceWorkflow>["writePlan"] =
  workflow.writePlan;
const readPlan: ReturnType<typeof createReferenceWorkflow>["readPlan"] =
  workflow.readPlan;
const apply: ReturnType<typeof createReferenceWorkflow>["apply"] =
  workflow.apply;
const execute: ReturnType<typeof createReferenceWorkflow>["execute"] =
  workflow.execute;
const {
  validate,
}: typeof import("../../packages/core/src/application/documents/reference-input.js") =
  load("../core/application/documents/reference-input.js");
const {
  staleBeforeStep,
  planFreshness,
}: typeof import("../../packages/core/src/application/documents/reference-freshness.js") =
  load("../core/application/documents/reference-freshness.js");

function configure(catalog: Record<string, OperationDeclaration>) {
  if (!catalog["references.refresh"])
    throw new Error("references.refresh catalog entry is required");
  const entry = catalog["references.refresh"];
  entry.nodeOnly = true;
  entry["batchAllowed"] = false;
  entry.requiresDoc = false;
}

export {
  configure,
  validate,
  makePlan,
  dependencyOrder,
  staleBeforeStep,
  planFreshness,
  writePlan,
  readPlan,
  loadJournal,
  apply,
  execute,
};

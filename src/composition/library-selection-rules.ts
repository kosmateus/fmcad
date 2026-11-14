import { createRequire } from "node:module";

const load = createRequire(__filename);
const adapter = load(
  "../node-adapters/persistence/selection-service",
) as typeof import("../../packages/node-adapters/src/persistence/selection-service");
const { selectionRulesInternal } = load("../../catalog") as {
  selectionRulesInternal: typeof import("../../packages/core/src/application/modeling/selection-rules-internal");
};

export const execute: ReturnType<typeof adapter.createSelectionExecutor> =
  adapter.createSelectionExecutor(selectionRulesInternal.authorize);
export const publicOperations = adapter.publicOperations;

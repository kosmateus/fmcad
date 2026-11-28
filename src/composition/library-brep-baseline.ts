import { createRequire } from "node:module";

const load = createRequire(__filename);
const adapter = load(
  "../node-adapters/persistence/brep-baseline-service",
) as typeof import("../../packages/node-adapters/src/persistence/brep-baseline-service");
const { authorize } = load(
  "../../catalog/brep-baseline-internal",
) as typeof import("../../packages/core/src/application/modeling/brep-baseline-internal");

export const execute: ReturnType<typeof adapter.createBrepExecutor> =
  adapter.createBrepExecutor(authorize);
export const publicOperations = adapter.publicOperations;

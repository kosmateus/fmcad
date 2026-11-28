import { createRequire } from "node:module";
const load = createRequire(__filename);
const adapter = load(
  "./dist/node-adapters/execution/epoch-prerequisite",
) as typeof import("../packages/node-adapters/src/execution/epoch-prerequisite");
const instance = load("./queue-instance") as {
  sameInstance(a: unknown, b: unknown): boolean;
};
export const {
  epochAuditPrerequisite,
  epochPrerequisiteStillCurrent,
  inheritedEpochPause,
  inheritedAuditResponsePause,
} = adapter.createEpochPrerequisite(instance.sameInstance);

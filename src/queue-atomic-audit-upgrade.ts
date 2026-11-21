import { createRequire } from "node:module";
import type { AuditUpgradePorts } from "../packages/node-adapters/src/execution/audit-upgrade";
const load = createRequire(__filename);
const adapter = load(
  "./dist/node-adapters/execution/audit-upgrade",
) as typeof import("../packages/node-adapters/src/execution/audit-upgrade");
const scope = load("./atomic-workflow-observation") as {
  fastenersScope: { jobId: string };
};
const instance = load("./queue-instance") as {
  sameInstance: AuditUpgradePorts["sameInstance"];
};
const response = () =>
  load("./queue-audit-response-proof") as Pick<
    AuditUpgradePorts,
    "auditResponseProof" | "auditResponseProofStillCurrent"
  >;
const epoch = () =>
  load("./queue-epoch-prerequisite") as Pick<
    AuditUpgradePorts,
    "epochAuditPrerequisite" | "epochPrerequisiteStillCurrent"
  >;
export const {
  auditUpgradeApproval,
  assertAuditUpgradeSnapshot,
  auditUpgradeStillCurrent,
} = adapter.createAuditUpgrade({
  jobId: scope.fastenersScope.jobId,
  sameInstance: instance.sameInstance,
  auditResponseProof: (...args) => response().auditResponseProof(...args),
  auditResponseProofStillCurrent: (value) =>
    response().auditResponseProofStillCurrent(value),
  epochAuditPrerequisite: (...args) => epoch().epochAuditPrerequisite(...args),
  epochPrerequisiteStillCurrent: (value) =>
    epoch().epochPrerequisiteStillCurrent(value),
});

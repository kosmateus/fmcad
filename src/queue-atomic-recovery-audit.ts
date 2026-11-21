import { createRequire } from "node:module";
import type { RecoveryAuditPorts } from "../packages/node-adapters/src/execution/recovery-audit";
import type {
  ReceiptPreparer,
  RecoveryWireInput,
} from "../packages/node-adapters/src/execution/recovery-python";
const load = createRequire(__filename);
const preparation = load(
  "./dist/node-adapters/execution/recovery-python",
) as typeof import("../packages/node-adapters/src/execution/recovery-python");
const controller = load(
  "./dist/node-adapters/execution/recovery-audit",
) as typeof import("../packages/node-adapters/src/execution/recovery-audit");
const policy = load(
  "./dist/core/application/cad/recovery-audit",
) as typeof import("../packages/core/src/application/cad/recovery-audit");
export const { auditSummary } = policy;
export const { prepareRecoveryAudit, auditAtomic } = preparation;
export function prepareRecoveryAuditWire(input: RecoveryWireInput) {
  const instance = load("./queue-instance") as {
    prepareReceiptScript: ReceiptPreparer;
  };
  return preparation.prepareRecoveryAuditWire(
    instance.prepareReceiptScript,
    input,
  );
}
export const createRecoveryAudit = (ports: RecoveryAuditPorts) =>
  controller.createRecoveryAudit(ports, {
    prepareReader: prepareRecoveryAudit,
    prepareWire: prepareRecoveryAuditWire,
  });

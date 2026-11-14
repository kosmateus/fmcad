import { createRequire } from "node:module";
import type { EpochStartupPorts } from "../packages/node-adapters/src/execution/epoch-startup";
const load = createRequire(__filename);
const instance = load("./queue-instance") as {
  sameInstance(a: unknown, b: unknown): boolean;
  priorProcessAlive: EpochStartupPorts["priorProcessAlive"];
};
const application = load(
  "./dist/core/application/cad/epoch-upgrade",
) as typeof import("../packages/core/src/application/cad/epoch-upgrade");
const policy = application.epochUpgradePolicy(instance.sameInstance);
export const {
  assertEpochUpgrade,
  assertSettledEpochUpgrade,
  assertSettledEpochUpgradeRecord,
  createEpochRuntimeUpgrade,
  createSettledEpochRuntimeUpgrade,
} = policy;
const startup = load(
  "./dist/node-adapters/execution/epoch-startup",
) as typeof import("../packages/node-adapters/src/execution/epoch-startup");
export function claimEpochRuntimeBroker(
  dir: string,
  marker: unknown,
  nonce: string,
  codeHash: string,
) {
  return startup.claimEpochRuntimeBroker(
    {
      priorProcessAlive: instance.priorProcessAlive,
      assertSettled: policy.assertSettledEpochUpgradeRecord,
      settledEvidence: (...values) =>
        (
          load("./queue-settled-epoch-evidence") as {
            settledEpochEvidence: EpochStartupPorts["settledEvidence"];
          }
        ).settledEpochEvidence(...values),
      installation: () =>
        (
          load("./dist/config-platform") as {
            resolveRuntimePaths(input: { anchor: string }): {
              installation: string;
            };
          }
        ).resolveRuntimePaths({ anchor: __filename }).installation,
    },
    dir,
    marker,
    nonce,
    codeHash,
  );
}

import { createRequire } from "node:module";
import type {
  MigrationPolicy,
  MigrationPorts,
} from "../packages/core/src/application/cad/owner-migration";
const load = createRequire(__filename);
const policy = load(
  "./dist/core/application/cad/owner-migration",
) as typeof import("../packages/core/src/application/cad/owner-migration");
const observation = load("./atomic-workflow-observation") as {
  fastenersScope: MigrationPolicy["scope"];
  isAtomicObservationCandidate: MigrationPolicy["isCandidate"];
};
const dependencies: MigrationPolicy = {
  scope: observation.fastenersScope,
  isCandidate: observation.isAtomicObservationCandidate,
  assertUpgrade: (...args) =>
    (
      load("./queue-atomic-audit-upgrade") as {
        assertAuditUpgradeSnapshot: MigrationPolicy["assertUpgrade"];
      }
    ).assertAuditUpgradeSnapshot(...args),
};
type WithoutFirst<T extends unknown[]> = T extends [unknown, ...infer Rest]
  ? Rest
  : never;
export const assertHeld = (
  ...args: WithoutFirst<Parameters<typeof policy.assertHeld>>
) => policy.assertHeld(dependencies, ...args);
export const createMigrator = (ports: MigrationPorts) =>
  policy.createMigrator(ports, dependencies);

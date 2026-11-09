import { createRequire } from "node:module";
import { createSavedFixtureLifecycle } from "../../packages/node-adapters/src/persistence/saved-fixture-lifecycle";
import type { SavedFixtureHost } from "../../packages/core/src/application/cad/saved-fixture-contracts";
import { hash as digest } from "../../packages/core/src/application/cad/json";
import { parseSavedFixtureReader } from "../../packages/core/src/application/cad/saved-fixture-proof";
import { prepareSavedFixtureReader } from "../../packages/node-adapters/src/persistence/saved-fixture-reader";

/** Keep the facade's installation anchor and lazy broker dependency graph. */
export function createSavedRuntime(
  anchor: string,
): ReturnType<typeof createSavedFixtureLifecycle> {
  const load = createRequire(anchor);
  const instance = load("./queue-instance") as Pick<
    SavedFixtureHost,
    "hash" | "buildHash" | "sameInstance" | "priorProcessAlive"
  >;
  return createSavedFixtureLifecycle({
    hash: instance.hash,
    buildHash: instance.buildHash,
    sameInstance: instance.sameInstance,
    priorProcessAlive: instance.priorProcessAlive,
    digest,
    parseSavedFixtureReader,
    prepareSavedFixtureReader,
    fileHash: (...args) =>
      (
        load("./queue-atomic-migration-files") as Pick<
          SavedFixtureHost,
          "fileHash"
        >
      ).fileHash(...args),
    exclusive: (...args) =>
      (
        load("./queue-atomic-migration-files") as Pick<
          SavedFixtureHost,
          "exclusive"
        >
      ).exclusive(...args),
    epochControlDirectory: (...args) =>
      (
        load("./queue-epoch-lineage") as Pick<
          SavedFixtureHost,
          "epochControlDirectory"
        >
      ).epochControlDirectory(...args),
    settledEpochEvidence: (...args) =>
      (
        load("./queue-settled-epoch-evidence") as Pick<
          SavedFixtureHost,
          "settledEpochEvidence"
        >
      ).settledEpochEvidence(...args),
    responsePath: (...args) =>
      (
        load("./queue-response-files") as Pick<SavedFixtureHost, "responsePath">
      ).responsePath(...args),
    decodeInvocation: (...args) =>
      (
        load("./cad-service") as Pick<SavedFixtureHost, "decodeInvocation">
      ).decodeInvocation(...args),
    policyArguments: (...args) =>
      (
        load("./cad-service") as Pick<SavedFixtureHost, "policyArguments">
      ).policyArguments(...args),
    createRecoveryAudit: (...args) =>
      (
        load("./queue-atomic-recovery-audit") as Pick<
          SavedFixtureHost,
          "createRecoveryAudit"
        >
      ).createRecoveryAudit(...args),
    verifyScratchSdkProof: (...args) =>
      (
        load("./queue-scratch-control") as Pick<
          SavedFixtureHost,
          "verifyScratchSdkProof"
        >
      ).verifyScratchSdkProof(...args),
  });
}

import { createRequire } from "node:module";
const load = createRequire(__filename);
const policy = load(
  "./dist/core/application/cad/observation-binding",
) as typeof import("../packages/core/src/application/cad/observation-binding");
const adapter = load(
  "./dist/node-adapters/execution/atomic-observation",
) as typeof import("../packages/node-adapters/src/execution/atomic-observation");
export const {
  atomicObservationIdentityHash,
  assertAtomicObservationIdentity,
} = policy;
export const { assertAtomicObservationWire } = adapter;

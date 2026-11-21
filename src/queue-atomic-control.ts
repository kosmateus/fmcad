import { createRequire } from "node:module";
import type { ObservationPolicy } from "../packages/core/src/application/cad/observation-control";
const load = createRequire(__filename);
const policy = load(
  "./dist/core/application/cad/observation-control",
) as typeof import("../packages/core/src/application/cad/observation-control");
const observation = load("./atomic-workflow-observation") as {
  isAtomicObservationCandidate: ObservationPolicy["isCandidate"];
  atomicInvocationProjection: ObservationPolicy["projection"];
};
type WithoutFirst<T extends unknown[]> = T extends [unknown, ...infer Rest]
  ? Rest
  : never;
export const observeAtomic = policy.observeAtomic;
export const observationRequest = (
  ...args: WithoutFirst<Parameters<typeof policy.observationRequest>>
) =>
  policy.observationRequest(
    {
      isCandidate: observation.isAtomicObservationCandidate,
      projection: observation.atomicInvocationProjection,
    },
    ...args,
  );

import { executeReview } from "../../packages/core/src/application/review";
import { CompatibilityError } from "../api/compatibility";
import type {
  ReviewInvocation,
  ReviewServiceOptions,
  ReviewServices,
} from "../api/contracts";

/** Pure factory over the shared review workflow. The caller retains ownership
 * of its explicit broker/preparation/artifact ports and their lifecycle. */
export function createReviewServices(
  options: ReviewServiceOptions,
): ReviewServices {
  if (options?.version !== 1)
    throw new CompatibilityError("api", options?.version, 1);
  const ports = Object.freeze({ ...options.ports });
  let disposed = false;
  return Object.freeze({
    async execute(input: ReviewInvocation) {
      if (disposed) throw new Error("fmcad review services are disposed");
      if (input?.version !== 1)
        throw new CompatibilityError("dto", input?.version, 1);
      if (input.kind !== "review")
        throw new Error("Review invocation required");
      // Snapshot before preparation/claim/first await, retaining explicit pins,
      // request identity and host/Fusion output mapping without an argv parser.
      return executeReview(structuredClone(input.request), ports);
    },
    async dispose() {
      disposed = true;
    },
  });
}

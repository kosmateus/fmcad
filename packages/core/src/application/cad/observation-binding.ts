import { hash } from "./json";
import { record } from "./contracts";

/** Semantic identity hash; never substitute the source/wire byte hash. */
export const atomicObservationIdentityHash = hash;
export function assertAtomicObservationIdentity(
  identity: unknown,
  declaredHash: unknown,
  expectedHash: unknown,
): void {
  if (
    !record(identity) ||
    typeof expectedHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedHash) ||
    declaredHash !== expectedHash ||
    atomicObservationIdentityHash(identity) !== expectedHash
  )
    throw Object.assign(
      new Error(
        "Observation identity binding differs from the independently pinned identity",
      ),
      { code: "WORKFLOW_IDENTITY_MISMATCH" },
    );
}

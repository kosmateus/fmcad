import { isDeepStrictEqual as same } from "node:util";
import type { PhysicalGenerationDescriptor } from "../packages/node-adapters/src/execution/physical-generation";
import type {
  NativeRuntimeActivationCompletion,
  NativeRuntimeActivationPublication,
  NativeRuntimeRebaselinePins,
} from "../packages/node-adapters/src/execution/runtime-rebaseline-native";
import type { NativeRuntimeRebaselineReaderPorts } from "../packages/node-adapters/src/execution/runtime-rebaseline-reader";

export interface FreshHostContext {
  descriptor: PhysicalGenerationDescriptor;
  brokerBuild: string;
  brokerConfig: string;
  requestId: string;
  purpose: "isolated-stdout-v1";
  engineVersion: 2;
  kernelDigest: string;
  programDigest: string;
  wireDigest: string;
}

/** Private composition ports, never invocation DTOs. The lease must exclude
 * unqualified interpreter admissions, including while native verification awaits.
 * readCurrent must consult current process/grant/principal state, not a cache.
 * The caller owns a dedicated reader; revoking this factory invalidates it.
 */
export interface FreshHostProofPorts {
  reader: NativeRuntimeRebaselineReaderPorts;
  assertBootstrapHeld(): void;
  readCurrent(): FreshHostContext;
}

const missing = Object.freeze([
  "SUPPORTED_BOOTSTRAP_PURPOSE_PRODUCER",
  "AUTHENTICATED_BOOTSTRAP_CLOSURE",
] as const);

/** A diagnostic only. Neither its fields nor its private identity confer any
 * dispatch authority. JSON copies cannot be used even for diagnostic rechecks.
 */
export interface FreshHostAssessment {
  readonly status: "NOT_AUTHORITY";
  readonly missing: typeof missing;
}

export class FreshHostProofError extends Error {
  readonly notStarted = true;
  constructor(
    readonly code:
      | "FRESH_HOST_CONTEXT_CHANGED"
      | "FRESH_HOST_ASSESSMENT_REJECTED"
      | "FRESH_HOST_REVOKED"
      | "FRESH_HOST_NATIVE_ACTIVATION_UNPROVEN"
      | "BOOTSTRAP_CLOSURE_UNPROVEN",
  ) {
    super(code);
  }
  readonly missing = missing;
}

/**
 * Reverify the existing native MAC/original-receipt/current-activation path.
 * This intentionally cannot mint a host proof yet: the supported native
 * consume verifier authenticates intent-reference bytes, not stdout purpose,
 * full executable/autoload closure or post-startup admission-window semantics.
 * A trusted held lease cannot retroactively add those facts to that receipt.
 * No TTL, mtime, digest-only or caller-supplied "fresh" escape hatch exists.
 */
export function createFreshHostProofFactory(
  ports: FreshHostProofPorts,
  expectedContext: FreshHostContext,
  publication: NativeRuntimeActivationPublication,
  completion: NativeRuntimeActivationCompletion,
) {
  const expected = structuredClone(expectedContext);
  const originalPublication = structuredClone(publication);
  const originalCompletion = structuredClone(completion);
  const assessments = new WeakSet<object>();
  let revoked = false;

  function assertCurrent() {
    if (revoked) throw new FreshHostProofError("FRESH_HOST_REVOKED");
    ports.assertBootstrapHeld();
    if (
      expected.purpose !== "isolated-stdout-v1" ||
      expected.engineVersion !== 2 ||
      !same(ports.readCurrent(), expected)
    )
      throw new FreshHostProofError("FRESH_HOST_CONTEXT_CHANGED");
  }

  function assertPins(pins: NativeRuntimeRebaselinePins | undefined) {
    const d = expected.descriptor;
    if (
      !pins ||
      pins.handoffId !== d.handoffId ||
      !same(pins.generation, d.generation) ||
      !same(pins.process, {
        pid: d.physicalRuntime.pid,
        birth: d.physicalRuntime.birth,
      }) ||
      pins.source !== d.physicalRuntime.source ||
      pins.build !== d.physicalRuntime.build ||
      pins.endpoint !== d.endpointURL ||
      pins.admissionStore !== ports.reader.store
    )
      throw new FreshHostProofError("FRESH_HOST_NATIVE_ACTIVATION_UNPROVEN");
  }

  async function assess(): Promise<FreshHostAssessment> {
    assertCurrent();
    const verification = await ports.reader.verifyConsumed(
      structuredClone(originalPublication),
      structuredClone(originalCompletion),
    );
    try {
      assertCurrent();
      assertPins(verification.authenticatedCurrentPins);
      verification.finalize();
      const activation = await ports.reader.getVerifiedActivation(
        structuredClone(expected.descriptor),
      );
      assertCurrent();
      if (
        !activation ||
        activation.requestId !== originalCompletion.binding.requestId ||
        activation.newHead !== originalCompletion.binding.newHead ||
        activation.publicationDigest !==
          originalCompletion.binding.publicationDigest
      )
        throw new FreshHostProofError("FRESH_HOST_NATIVE_ACTIVATION_UNPROVEN");
      const assessment: FreshHostAssessment = Object.freeze({
        status: "NOT_AUTHORITY",
        missing,
      });
      assessments.add(assessment);
      return assessment;
    } catch (error) {
      verification.abort();
      throw error;
    }
  }

  return Object.freeze({
    assess,
    async requireForDispatch(assessment: FreshHostAssessment): Promise<never> {
      assertCurrent();
      if (!assessments.has(assessment))
        throw new FreshHostProofError("FRESH_HOST_ASSESSMENT_REJECTED");
      await assess();
      // No current supported producer certifies the missing semantics.
      // Never turn a successful integrity check into a dispatch capability.
      throw new FreshHostProofError("BOOTSTRAP_CLOSURE_UNPROVEN");
    },
    revoke() {
      revoked = true;
      ports.reader.invalidate();
    },
  });
}

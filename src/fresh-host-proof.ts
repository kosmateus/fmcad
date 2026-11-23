import { isDeepStrictEqual as same } from "node:util";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  createControlledFusionBootstrap,
  ControlledFusionBootstrapTranscript,
} from "./controlled-fusion-bootstrap";
import type { ProtocolMetadataPins } from "./protocol-metadata-broker";
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

type ControlledBootstrap = ReturnType<typeof createControlledFusionBootstrap>;
/** Original logical input, before kernel compilation or receipt wrapping.
 * Compiled program/RPC and final native wire belong to later certificates;
 * none of these fields claims to be a final wire digest. */
export interface ControlledHostPreparationContext {
  descriptor: PhysicalGenerationDescriptor;
  /** Actual full broker executable closure, including kernel preparation code.
   * The assembled kernel artifact is verified later by the compiler, not
   * represented here by a made-up pre-compilation manifest. */
  brokerBuild: string;
  brokerConfig: string;
  purpose: "isolated-stdout-v1";
  engineVersion: 2;
  originalRequestDigest: string;
  originalLogicalRpcDigest: string;
  sourceDigest: string;
}
export interface ControlledHostProofPorts extends Omit<
  FreshHostProofPorts,
  "readCurrent"
> {
  readCurrent(): ControlledHostPreparationContext;
  /** The original live controller, not a reconstructed transcript reader. */
  controller: Pick<
    ControlledBootstrap,
    | "prepareOriginalWitness"
    | "assertPreparedWitness"
    | "readOriginalIntent"
    | "readOriginalEvidence"
    | "readOriginalTranscriptReference"
  >;
  transcript: ControlledFusionBootstrapTranscript;
  readCompilerPins(): ProtocolMetadataPins;
}

/**
 * Compose the controlled OS/bootstrap origin with the existing authenticated
 * native activation. This is private broker composition, not an invocation API.
 * The returned synchronous compiler port is valid only in this held preparation
 * window. Native physical-turn validation is still mandatory at actual send.
 * Use a dedicated native reader; a failure permanently revokes this factory.
 */
export function createControlledHostProofFactory(
  ports: ControlledHostProofPorts,
  expectedContext: ControlledHostPreparationContext,
  publication: NativeRuntimeActivationPublication,
  completion: NativeRuntimeActivationCompletion,
) {
  const expected = structuredClone(expectedContext);
  const originalPublication = structuredClone(publication);
  const originalCompletion = structuredClone(completion);
  const controller = ports.controller;
  const originalTranscript = ports.transcript;
  const load = createRequire(__filename);
  const { bindBootstrapEntryEvidence, bootstrapInstalledFilesDigest } = load(
    "./dist/node-adapters/execution/bootstrap-entry-evidence",
  ) as typeof import("../packages/node-adapters/src/execution/bootstrap-entry-evidence");
  let revoked = false;
  const reject = (): never => {
    throw new FreshHostProofError("BOOTSTRAP_CLOSURE_UNPROVEN");
  };
  function synchronous(check: () => void) {
    const result: unknown = check();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      reject();
    }
  }
  function current() {
    if (revoked) throw new FreshHostProofError("FRESH_HOST_REVOKED");
    synchronous(() => ports.assertBootstrapHeld());
    if (
      expected.purpose !== "isolated-stdout-v1" ||
      expected.engineVersion !== 2 ||
      ![
        expected.originalRequestDigest,
        expected.originalLogicalRpcDigest,
        expected.sourceDigest,
      ].every((digest) => /^[a-f0-9]{64}$/.test(digest)) ||
      ports.controller !== controller ||
      ports.transcript !== originalTranscript ||
      !same(ports.readCurrent(), expected)
    )
      throw new FreshHostProofError("FRESH_HOST_CONTEXT_CHANGED");
  }
  function revoke() {
    revoked = true;
    ports.reader.invalidate();
  }
  return Object.freeze({
    revoke,
    async prepare() {
      let verification:
        | Awaited<
            ReturnType<NativeRuntimeRebaselineReaderPorts["verifyConsumed"]>
          >
        | undefined;
      try {
        current();
        const compilerPins = structuredClone(ports.readCompilerPins());
        if (
          compilerPins.buildHash !== expected.brokerBuild ||
          compilerPins.configHash !== expected.brokerConfig ||
          typeof compilerPins.generation !== "string" ||
          !compilerPins.generation
        )
          reject();
        const witness = await ports.controller.prepareOriginalWitness(
          ports.transcript,
        );
        current();
        const intent = await ports.controller.readOriginalIntent(
          ports.transcript,
        );
        current();
        const originals = await ports.controller.readOriginalEvidence(
          ports.transcript,
        );
        current();
        const transcript =
          await ports.controller.readOriginalTranscriptReference(
            ports.transcript,
          );
        current();
        const c = witness.context;
        const runtime = expected.descriptor.physicalRuntime;
        if (
          !same(c.process, { pid: runtime.pid, birth: runtime.birth }) ||
          c.installedSource !== runtime.source ||
          c.installedBuild !== runtime.build ||
          intent.nonce !== c.nonce ||
          !same(intent.process, c.process) ||
          intent.installed.source !== c.installedSource ||
          intent.installed.directory !== c.installedDirectory ||
          bootstrapInstalledFilesDigest(intent.installed.files) !==
            c.installedBuild
        )
          reject();
        const forkEntry = /^[A-Za-z]:[\\/]/.test(c.installedDirectory)
          ? path.win32.join(c.installedDirectory, "AutodeskFusionMCP.py")
          : path.posix.join(c.installedDirectory, "AutodeskFusionMCP.py");
        const bound = bindBootstrapEntryEvidence(intent, originals, forkEntry);
        if (!bound) return reject();
        verification = await ports.reader.verifyConsumed(
          structuredClone(originalPublication),
          structuredClone(originalCompletion),
        );
        current();
        const pins = verification.authenticatedCurrentPins;
        const descriptor = expected.descriptor;
        if (
          !pins ||
          pins.handoffId !== descriptor.handoffId ||
          !same(pins.generation, descriptor.generation) ||
          !same(pins.process, c.process) ||
          pins.source !== runtime.source ||
          pins.build !== runtime.build ||
          pins.endpoint !== descriptor.endpointURL ||
          pins.admissionStore !== ports.reader.store
        )
          reject();
        const signed = verification.authenticatedIntentReferences;
        const required = [
          ...c.originalRefs,
          ...bound.references.map((ref) => ({
            nativePath: ref.path,
            sha256: ref.sha256,
          })),
          transcript,
        ];
        if (
          !signed ||
          required.some(
            (ref) =>
              !signed.some(
                (native) =>
                  native.sha256 === ref.sha256 &&
                  (native.path === ref.nativePath ||
                    native.path === c.nativePathMappings[ref.nativePath]),
              ),
          )
        )
          reject();
        synchronous(() => ports.controller.assertPreparedWitness(witness));
        verification.finalize();
        const activation = await ports.reader.getVerifiedActivation(descriptor);
        current();
        if (
          !activation ||
          activation.requestId !== originalCompletion.binding.requestId ||
          activation.newHead !== originalCompletion.binding.newHead ||
          activation.publicationDigest !==
            originalCompletion.binding.publicationDigest
        )
          reject();
        const proofHash = createHash("sha256")
          .update(
            JSON.stringify({ expected, references: required, activation }),
          )
          .digest("hex");
        const recheck = () => {
          try {
            current();
            if (!same(ports.readCompilerPins(), compilerPins))
              throw new FreshHostProofError("FRESH_HOST_CONTEXT_CHANGED");
            synchronous(() => ports.controller.assertPreparedWitness(witness));
          } catch (error) {
            revoke();
            throw error;
          }
        };
        recheck();
        return Object.freeze({
          recheck,
          verifyHostBindings(pins: ProtocolMetadataPins) {
            recheck();
            if (!same(pins, compilerPins)) {
              revoke();
              throw new FreshHostProofError("FRESH_HOST_CONTEXT_CHANGED");
            }
            return Object.freeze({
              proofHash,
              profileVersion: "isolated-stdout-v1" as const,
            });
          },
        });
      } catch (error) {
        verification?.abort();
        revoke();
        throw error;
      }
    },
  });
}

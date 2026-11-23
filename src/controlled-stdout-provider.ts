import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual as same } from "node:util";
import type { QueueRequest } from "@fmcad/core";
import {
  createControlledHostProofFactory,
  FreshHostProofError,
  type ControlledHostPreparationContext,
  type ControlledHostProofPorts,
} from "./fresh-host-proof";
import {
  pythonStdoutInputDigests,
  type StdoutCompilationPorts,
} from "./python-diagnostic-broker";
import type { ProtocolMetadataPins } from "./protocol-metadata-broker";
import type {
  NativeRuntimeActivationCompletion,
  NativeRuntimeActivationPublication,
} from "../packages/node-adapters/src/execution/runtime-rebaseline-native";

const load = createRequire(__filename);
const { prepareIsolatedStdout } = load(
  "./dist/python/isolated-stdout",
) as typeof import("../packages/node-adapters/src/python/isolated-stdout");

type HostIdentity = Pick<
  ControlledHostPreparationContext,
  "descriptor" | "brokerBuild" | "brokerConfig" | "purpose" | "engineVersion"
>;
export interface ControlledStdoutProviderPorts {
  controller: ControlledHostProofPorts["controller"];
  transcript: ControlledHostProofPorts["transcript"];
  assertBootstrapHeld(): void;
  /** Current trusted descriptor/owner/build, not an invocation or JSON proof. */
  readCurrentHost(): HostIdentity;
  /** A dedicated reader per preparation; no shared approval-generation cache. */
  createReader():
    | ControlledHostProofPorts["reader"]
    | Promise<ControlledHostProofPorts["reader"]>;
}

/** Compose only the original controlled host with the actual bounded kernel.
 * Returns the private broker Options port, never an RPC-supplied capability.
 * The compiler and final physical-turn certificate still bind their own later
 * program, receipt wrapper and actual transport wire.
 */
export function createControlledStdoutProvider(
  ports: ControlledStdoutProviderPorts,
  publication: NativeRuntimeActivationPublication,
  completion: NativeRuntimeActivationCompletion,
): (
  input: QueueRequest,
  pins: ProtocolMetadataPins,
) => Promise<StdoutCompilationPorts> {
  const originalPublication = structuredClone(publication);
  const originalCompletion = structuredClone(completion);
  const controller = ports.controller;
  const transcript = ports.transcript;
  return async (input, pins) => {
    const request = structuredClone(input);
    const expectedInput = pythonStdoutInputDigests(request);
    const host = structuredClone(ports.readCurrentHost());
    const originalPins = structuredClone(pins);
    if (
      host.brokerBuild !== originalPins.buildHash ||
      host.brokerConfig !== originalPins.configHash
    )
      throw new FreshHostProofError("FRESH_HOST_CONTEXT_CHANGED");
    const reader = await ports.createReader();
    const factory = createControlledHostProofFactory(
      {
        reader,
        controller,
        transcript,
        assertBootstrapHeld: () => ports.assertBootstrapHeld(),
        readCurrent: () => ({
          ...ports.readCurrentHost(),
          ...pythonStdoutInputDigests(request),
        }),
        readCompilerPins: () => ({ ...originalPins }),
      },
      { ...host, ...expectedInput },
      originalPublication,
      originalCompletion,
    );
    const prepared = await factory.prepare();
    const recheck = () => {
      prepared.recheck();
      if (!same(pythonStdoutInputDigests(request), expectedInput)) {
        factory.revoke();
        throw new FreshHostProofError("FRESH_HOST_CONTEXT_CHANGED");
      }
    };
    return Object.freeze({
      recheck,
      currentPins() {
        recheck();
        // The broker additionally compares these against its own live pins.
        return { ...originalPins };
      },
      verifyHostBindings: prepared.verifyHostBindings,
      prepareKernel(source: string) {
        recheck();
        if (
          createHash("sha256").update(source, "utf8").digest("hex") !==
          expectedInput.sourceDigest
        ) {
          factory.revoke();
          throw new FreshHostProofError("FRESH_HOST_CONTEXT_CHANGED");
        }
        const kernel = prepareIsolatedStdout(source);
        recheck();
        return kernel;
      },
    });
  };
}

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import {
  createRuntimeRebaselineAuthority,
  runtimeRebaselineRoot,
} from "./queue-runtime-rebaseline";
import type {
  PhysicalRuntimeRootAuthorization,
  PhysicalRootVerificationContext,
  VerifiedPhysicalOperatorProfile,
} from "../packages/node-adapters/src/execution/physical-generation-profile";
import type { NativeRuntimeRebaselineOptions } from "../packages/node-adapters/src/execution/runtime-rebaseline-native";

const load = createRequire(__filename);
const { createNativeRuntimeRebaselineAuthorityPorts } = load(
  "./dist/node-adapters/execution/runtime-rebaseline-native",
) as typeof import("../packages/node-adapters/src/execution/runtime-rebaseline-native");
const { readBytes } = load(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");

export type RuntimeRootVerificationContext = PhysicalRootVerificationContext;
export type ApprovedRuntimeRoot = NonNullable<
  Awaited<ReturnType<typeof runtimeRebaselineRoot>>
>;
export interface RuntimeRootPhysicalWiring {
  physicalProfileDependencies: {
    runtimeRoot: PhysicalRuntimeRootAuthorization<ApprovedRuntimeRoot>;
  };
  verifyRuntimeRootBeforeRestore(
    context: RuntimeRootVerificationContext,
  ): Promise<ApprovedRuntimeRoot>;
}
function rejected(): never {
  throw Object.assign(
    new Error("Native-authenticated runtime root is required"),
    {
      code: "RUNTIME_ROOT_AUTHORITY_REQUIRED",
      notStarted: true,
    },
  );
}

/** Two ordered stages: await verification before choosing a restore root;
 * supply this SAME native closure to the post-claim private physical profile.
 * Historical snapshots remain unproven evidence, never an empty replacement. */
export function createRuntimeRootPhysicalWiring(
  options: NativeRuntimeRebaselineOptions,
): RuntimeRootPhysicalWiring {
  const ports = createNativeRuntimeRebaselineAuthorityPorts(options);
  const authority = createRuntimeRebaselineAuthority(ports);
  const nativeProvision = structuredClone(options.native);
  Object.freeze(nativeProvision.installedPackageFiles);
  Object.freeze(nativeProvision);
  let verified:
    | {
        directory: string;
        device: number;
        inode: number;
        recordFile: string;
        recordDigest: string;
        headBytes: string;
      }
    | undefined;
  let revision = 0;
  const runtimeRoot: PhysicalRuntimeRootAuthorization<ApprovedRuntimeRoot> = {
    nativeProvision,
    getVerifiedActivation: ports.getVerifiedActivation,
    verifyRuntimeRootBeforeRestore,
    assertVerifiedRoot(directory) {
      const current = verified;
      if (
        !current ||
        directory !== current.directory ||
        fs.realpathSync(directory) !== directory
      )
        rejected();
      const stat = fs.statSync(directory);
      if (stat.dev !== current.device || stat.ino !== current.inode) rejected();
      const record = readBytes(
        current.recordFile,
        128 * 1024 * 1024,
        fs,
        current.recordFile,
      );
      if (
        createHash("sha256").update(record).digest("hex") !==
        current.recordDigest
      )
        rejected();
      const head = path.join(directory, "runtime-rebaseline-head.json");
      if (
        readBytes(head, 1024 * 1024, fs, head).toString("utf8") !==
        current.headBytes
      )
        rejected();
      try {
        fs.lstatSync(
          path.join(directory, "runtime-rebaseline-publication.json"),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      rejected();
    },
  };
  async function verifyRuntimeRootBeforeRestore(
    context: RuntimeRootVerificationContext,
  ): Promise<ApprovedRuntimeRoot> {
    const currentRevision = ++revision;
    verified = undefined;
    if (
      context.directory !== ports.store ||
      fs.realpathSync(context.directory) !== context.directory ||
      !/^[a-f0-9]{64}$/.test(context.buildHash) ||
      !/^[a-f0-9]{64}$/.test(context.configHash)
    )
      rejected();
    const root = await runtimeRebaselineRoot(context.directory, authority);
    if (!root || revision !== currentRevision) rejected();
    const recordFile = path.join(
      root.record.store,
      "runtime-rebaselines",
      root.record.request.requestId,
      "record.json",
    );
    const recordDigest = createHash("sha256")
      .update(JSON.stringify(root.record))
      .digest("hex");
    verified = {
      directory: root.record.store,
      device: root.record.storeDevice,
      inode: root.record.storeInode,
      recordFile,
      recordDigest,
      headBytes: JSON.stringify({
        version: 1,
        newHead: root.record.receipt.newHead,
        record: { path: recordFile, sha256: recordDigest },
      }),
    };
    runtimeRoot.assertVerifiedRoot(context.directory);
    return root;
  }
  return {
    physicalProfileDependencies: { runtimeRoot },
    verifyRuntimeRootBeforeRestore,
  };
}

/** Called inside the single verified profile read. Additional operator authority
 * comes only from trusted composition, never from profile/ENV/completion JSON. */
export function createRuntimeRootPhysicalProfileFactory(
  createOptions: (
    profile: VerifiedPhysicalOperatorProfile,
  ) => NativeRuntimeRebaselineOptions,
) {
  return (
    profile: VerifiedPhysicalOperatorProfile,
  ): PhysicalRuntimeRootAuthorization<ApprovedRuntimeRoot> => {
    const options = createOptions(profile),
      runtime = profile.runtime;
    if (
      !isDeepStrictEqual(options.native, profile.nativeProvision) ||
      options.runtimeVersion !== runtime.physicalRuntime.version ||
      !isDeepStrictEqual(
        {
          handoffId: options.pins.handoffId,
          generation: options.pins.generation,
          endpointURL: options.pins.endpoint,
          physicalRuntime: {
            ...options.pins.process,
            version: options.runtimeVersion,
            source: options.pins.source,
            build: options.pins.build,
          },
        },
        {
          handoffId: runtime.handoffId,
          generation: runtime.generation,
          endpointURL: runtime.endpointURL,
          physicalRuntime: runtime.physicalRuntime,
        },
      )
    )
      rejected();
    return createRuntimeRootPhysicalWiring(options).physicalProfileDependencies
      .runtimeRoot;
  };
}

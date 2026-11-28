import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  createRuntimeRebaselineReaderAuthority,
  runtimeRebaselineRoot,
} from "./queue-runtime-rebaseline";
import type {
  PhysicalRuntimeRootAuthorization,
  PhysicalRootVerificationContext,
  VerifiedPhysicalOperatorProfile,
} from "../packages/node-adapters/src/execution/physical-generation-profile";
import type { NativeRuntimeRebaselineReaderPorts } from "../packages/node-adapters/src/execution/runtime-rebaseline-reader";

const load = createRequire(__filename);
const { readBytes } = load(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");

export type RuntimeRootVerificationContext = PhysicalRootVerificationContext;
type AuthenticatedRuntimeRoot = NonNullable<
  Awaited<ReturnType<typeof runtimeRebaselineRoot>>
>;
/** Frozen pre-rebaseline ledgers are never the current restart snapshot. Any
 * core-authenticated currentView stays distinct at the top level. */
export type ApprovedRuntimeRoot = Omit<
  AuthenticatedRuntimeRoot,
  "snapshot" | "snapshots"
> & {
  frozenBaseline: Pick<AuthenticatedRuntimeRoot, "snapshot" | "snapshots">;
  currentFiles: Readonly<Record<string, Buffer | null>>;
};
export interface RuntimeRootOperatorContext {
  store: string;
  admissionStore: string;
  publicationAuthority: {
    keyId: string;
    keyReference: { path: string; sha256: string };
    nativeOperatorFile: string;
  };
}
export type RuntimeRootOperatorFactory = (
  profile: VerifiedPhysicalOperatorProfile,
  context: RuntimeRootVerificationContext,
) => RuntimeRootOperatorContext;
export type RuntimeRootPhysicalWiring =
  PhysicalRuntimeRootAuthorization<ApprovedRuntimeRoot>;

/** Reclaim ownership only after native authentication, preserving the complete
 * current ledger for the next supported startup. A historical migration is not
 * the current recovery authority for a consumed native root. */
export async function reclaimRuntimeRootOwner(options: {
  directory: string;
  buildHash: string;
  configHash: string;
  runtimeRoot: RuntimeRootPhysicalWiring;
  reclaimOwner(
    directory: string,
    recoverCurrent: undefined,
    assertReclaimable: (owner: unknown) => void,
  ): unknown;
}): Promise<unknown> {
  const root = await options.runtimeRoot.verifyRuntimeRootBeforeRestore({
    directory: options.directory,
    buildHash: options.buildHash,
    configHash: options.configHash,
  });
  if (!root || root.record.store !== options.directory) rejected();
  const files = Object.entries(root.currentFiles).map(([name, bytes]) => {
    if (path.isAbsolute(name) || name.split(/[\\/]/).some(part => !part || part === "." || part === ".."))
      rejected();
    return [name, bytes === null ? null : Buffer.from(bytes)] as const;
  });
  if (!files.some(([name]) => name === "queue-state.json")) rejected();
  const guard = () => {
    options.runtimeRoot.assertVerifiedRoot(options.directory);
    for (const [name, bytes] of files) {
      const file = path.join(options.directory, name);
      if (bytes === null) {
        try {
          fs.lstatSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        rejected();
      }
      if (!readBytes(file, 128 * 1024 * 1024, fs, file).equals(bytes))
        rejected();
    }
  };
  guard();
  // The primitive rechecks this synchronous guard under recovery.lock and
  // exact PID/birth ownership fencing, including immediately before unlink.
  return options.reclaimOwner(options.directory, undefined, guard);
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
function defaultOperator(
  profile: VerifiedPhysicalOperatorProfile,
  context: RuntimeRootVerificationContext,
): RuntimeRootOperatorContext {
  try {
    const { readRuntimeVerificationRealm } = load(
      "./dist/node-adapters/execution/runtime-verification-realm",
    ) as typeof import("../packages/node-adapters/src/execution/runtime-verification-realm");
    const realm = readRuntimeVerificationRealm(context.directory);
    return {
      store: context.directory,
      admissionStore: path.win32.join(
        profile.nativeProvision.localAppData,
        "fmcad",
        "addin-admission",
        "admission.sqlite3",
      ),
      publicationAuthority: {
        ...realm,
        nativeOperatorFile: path.win32.join(
          profile.nativeProvision.nativePrivateDirectory,
          "runtime-rebaseline-operator.json",
        ),
      },
    };
  } catch {
    throw Object.assign(
      new Error("An existing private runtime verification realm is required"),
      {
        code: "RUNTIME_ROOT_CONTROLLER_REQUIRED",
        notStarted: true,
      },
    );
  }
}

/** Two ordered stages: await verification before choosing a restore root;
 * supply this SAME native closure to the post-claim private physical profile.
 * Historical snapshots remain unproven evidence, never an empty replacement. */
export function createRuntimeRootPhysicalWiring(
  profile: VerifiedPhysicalOperatorProfile,
  createOperator: RuntimeRootOperatorFactory = defaultOperator,
): RuntimeRootPhysicalWiring {
  const nativeProvision = structuredClone(profile.nativeProvision);
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
  let reader:
    | {
        ports: NativeRuntimeRebaselineReaderPorts;
        authority: ReturnType<typeof createRuntimeRebaselineReaderAuthority>;
      }
    | undefined;
  const runtimeRoot: PhysicalRuntimeRootAuthorization<ApprovedRuntimeRoot> = {
    nativeProvision,
    get getVerifiedActivation() {
      if (!reader || !verified) rejected();
      return reader.ports.getVerifiedActivation;
    },
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
        !readBytes(head, 1024 * 1024, fs, head).equals(
          Buffer.from(current.headBytes, "utf8"),
        )
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
    reader?.ports.invalidate();
    try {
      if (
        fs.realpathSync(context.directory) !== context.directory ||
        !/^[a-f0-9]{64}$/.test(context.buildHash) ||
        !/^[a-f0-9]{64}$/.test(context.configHash)
      )
        rejected();
      if (!reader) {
        const operator = createOperator(profile, context),
          runtime = profile.runtime;
        if (
          Object.keys(operator).sort().join(",") !==
            "admissionStore,publicationAuthority,store" ||
          operator.store !== context.directory
        )
          rejected();
        const { createNativeRuntimeRebaselineReaderPorts } = load(
          "./dist/node-adapters/execution/runtime-rebaseline-reader",
        ) as typeof import("../packages/node-adapters/src/execution/runtime-rebaseline-reader");
        const ports = createNativeRuntimeRebaselineReaderPorts({
          store: operator.store,
          publicationAuthority: operator.publicationAuthority,
          pins: {
            handoffId: runtime.handoffId,
            admissionStore: operator.admissionStore,
            generation: runtime.generation,
            process: {
              pid: runtime.physicalRuntime.pid,
              birth: runtime.physicalRuntime.birth,
            },
            source: runtime.physicalRuntime.source,
            build: runtime.physicalRuntime.build,
            endpoint: runtime.endpointURL,
          },
          runtimeVersion: runtime.physicalRuntime.version,
          native: {
            nativePython: nativeProvision.nativePython,
            mappedNativePython: nativeProvision.mappedNativePython,
            nativePythonSha256: nativeProvision.nativePythonSha256,
            installedForkDirectory: nativeProvision.installedForkDirectory,
            mappedInstalledForkDirectory:
              nativeProvision.mappedInstalledForkDirectory,
            installedPackageFiles: nativeProvision.installedPackageFiles,
            provisionPath: nativeProvision.provisionPath,
            localAppData: nativeProvision.localAppData,
            nativePrivateDirectory: nativeProvision.nativePrivateDirectory,
            ...(nativeProvision.timeoutMs === undefined
              ? {}
              : { timeoutMs: nativeProvision.timeoutMs }),
          },
        });
        reader = {
          ports,
          authority: createRuntimeRebaselineReaderAuthority(ports),
        };
      }
      if (reader.ports.store !== context.directory) rejected();
      const root = await runtimeRebaselineRoot(
        context.directory,
        reader.authority,
      );
      if (!root || !root.currentFiles || revision !== currentRevision)
        rejected();
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
      const { snapshot, snapshots, ...current } = root;
      return {
        ...current,
        currentFiles: root.currentFiles,
        frozenBaseline: { snapshot, snapshots },
      };
    } catch (error) {
      // An older attempt must not revoke the newer reader generation.
      if (revision === currentRevision) {
        verified = undefined;
        reader?.ports.invalidate();
      }
      throw error;
    }
  }
  return runtimeRoot;
}

/** Called inside the single verified profile read. Additional operator authority
 * comes only from trusted composition, never from profile/ENV/completion JSON. */
export function createRuntimeRootPhysicalProfileFactory(
  createOperator: RuntimeRootOperatorFactory = defaultOperator,
) {
  return (
    profile: VerifiedPhysicalOperatorProfile,
  ): PhysicalRuntimeRootAuthorization<ApprovedRuntimeRoot> => {
    return createRuntimeRootPhysicalWiring(profile, createOperator);
  };
}

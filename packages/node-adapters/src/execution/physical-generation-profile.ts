import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeAdmissionJson } from "./admission-json";
import { durable } from "../persistence/records";
import { prepareBrokerPhysicalGeneration } from "./physical-generation-broker";
import {
  createNativePhysicalGenerationProvision,
  type NativePhysicalGenerationProvisionOptions,
} from "./physical-generation-provision";
import type { PhysicalGenerationDescriptor } from "./physical-generation";
import type { PhysicalGenerationClaim } from "./physical-generation-broker";

/** Programmatic trusted composition only. No profile/ENV field can create this
 * closure; native consume authentication must have preceded assertVerifiedRoot. */
export interface PhysicalRootVerificationContext {
  directory: string;
  buildHash: string;
  configHash: string;
}
export interface PhysicalRuntimeRootAuthorization<ApprovedRoot = unknown> {
  readonly nativeProvision: Omit<
    NativePhysicalGenerationProvisionOptions,
    "getVerifiedActivation" | "assertBrokerOwner"
  >;
  assertVerifiedRoot(directory: string): void;
  verifyRuntimeRootBeforeRestore(
    context: PhysicalRootVerificationContext,
  ): Promise<ApprovedRoot>;
  getVerifiedActivation(
    descriptor: PhysicalGenerationDescriptor,
  ): ReturnType<
    NonNullable<
      NativePhysicalGenerationProvisionOptions["getVerifiedActivation"]
    >
  >;
}
export interface VerifiedPhysicalOperatorProfile {
  readonly clientId: string;
  readonly transport: "node" | "windows-curl";
  readonly runtime: Readonly<Omit<PhysicalGenerationDescriptor, "brokerOwner">>;
  readonly nativeProvision: PhysicalRuntimeRootAuthorization["nativeProvision"];
}
export function hasRuntimeRootEvidence(directory: string): boolean {
  for (const name of [
    "runtime-rebaseline-head.json",
    "runtime-rebaseline-publication.json",
  ])
    try {
      fs.lstatSync(path.join(directory, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  const archive = path.join(directory, "runtime-rebaselines");
  let entries: fs.Dirent[];
  try {
    const info = fs.lstatSync(archive);
    if (!info.isDirectory() || info.isSymbolicLink()) rejected();
    entries = fs.readdirSync(archive, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) rejected();
    try {
      fs.lstatSync(path.join(archive, entry.name, "completion.json"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}
function assertNoRootWithoutAuthority(directory: string) {
  if (hasRuntimeRootEvidence(directory))
    throw Object.assign(
      new Error("A trusted runtime root operator controller is required"),
      {
        code: "RUNTIME_ROOT_CONTROLLER_REQUIRED",
        notStarted: true,
      },
    );
}

function rejected(): never {
  throw Object.assign(
    new Error("Private physical operator profile is unavailable"),
    {
      code: "PHYSICAL_OPERATOR_PROFILE_REJECTED",
      notStarted: true,
    },
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) rejected();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(","))
    rejected();
}
function text(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result) rejected();
  return result;
}
function integer(value: Record<string, unknown>, key: string): number {
  const result = value[key];
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result <= 0
  )
    rejected();
  return result;
}

function readProfile(file: string): unknown {
  let fd: number | undefined;
  try {
    const uid = process.getuid?.();
    const parent = path.dirname(file);
    if (
      uid === undefined ||
      !path.isAbsolute(file) ||
      path.normalize(file) !== file ||
      fs.realpathSync(parent) !== parent ||
      fs.realpathSync(file) !== file
    )
      rejected();
    const directory = fs.statSync(parent);
    if (directory.uid !== uid || (directory.mode & 0o077) !== 0) rejected();
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(uid) ||
      (before.mode & 0o077n) !== 0n ||
      before.size > 131072n
    )
      rejected();
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (current.isSymbolicLink()) rejected();
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const)
      if (before[key] !== after[key] || before[key] !== current[key])
        rejected();
    return decodeAdmissionJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return rejected();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Native runtime settings, not an invocation DTO or capability. Saved settings
 * still require authenticated root verification and an actual broker claim. */
export function physicalBrokerPortsFromEnvironment<ApprovedRoot = unknown>(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: {
    directory?: string;
    normalRuntime?: VerifiedPhysicalOperatorProfile;
    provisionFactory?: typeof createNativePhysicalGenerationProvision;
    runtimeRoot?: PhysicalRuntimeRootAuthorization<ApprovedRoot>;
    runtimeRootFactory?: (
      profile: VerifiedPhysicalOperatorProfile,
    ) => PhysicalRuntimeRootAuthorization<ApprovedRoot>;
  } = {},
) {
  let file = environment["FMCAD_PHYSICAL_OPERATOR_PROFILE"];
  if (
    file === undefined &&
    dependencies.directory !== undefined &&
    hasRuntimeRootEvidence(dependencies.directory)
  ) {
    const configured = path.join(
      dependencies.directory,
      "runtime-physical-profile.json",
    );
    try {
      fs.lstatSync(configured);
      file = configured;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") rejected();
    }
  }
  if (file === undefined && dependencies.normalRuntime === undefined) return undefined;
  try {
    if (file !== undefined && dependencies.normalRuntime !== undefined) rejected();
    const profile = object(file === undefined
      ? { version: 1, ...dependencies.normalRuntime }
      : readProfile(file));
    keys(profile, [
      "version",
      "clientId",
      "transport",
      "runtime",
      "nativeProvision",
    ]);
    if (profile["version"] !== 1) rejected();
    const transport = profile["transport"];
    if (transport !== "node" && transport !== "windows-curl") rejected();
    const runtime = object(profile["runtime"]);
    keys(runtime, [
      "kind",
      "version",
      "handoffId",
      "generation",
      "endpointURL",
      "physicalRuntime",
    ]);
    if (runtime["kind"] !== "fmcad-physical-grant" || runtime["version"] !== 1)
      rejected();
    const generation = object(runtime["generation"]);
    keys(generation, ["instance", "epoch"]);
    const physical = object(runtime["physicalRuntime"]);
    keys(physical, ["pid", "birth", "version", "source", "build"]);
    const native = object(profile["nativeProvision"]);
    const nativeKeys = [
      "nativePython",
      "mappedNativePython",
      "nativePythonSha256",
      "installedForkDirectory",
      "mappedInstalledForkDirectory",
      "installedPackageFiles",
      "provisionPath",
      "localAppData",
      "nativePrivateDirectory",
      "mappedPrivateDirectory",
      "linuxGrantDirectory",
    ];
    keys(
      native,
      native["timeoutMs"] === undefined
        ? nativeKeys
        : [...nativeKeys, "timeoutMs"],
    );
    const files = object(native["installedPackageFiles"]);
    const installedPackageFiles: Record<string, string> = {};
    for (const [name, hash] of Object.entries(files)) {
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) rejected();
      Object.defineProperty(installedPackageFiles, name, {
        value: hash,
        enumerable: true,
      });
    }
    const options: NativePhysicalGenerationProvisionOptions = {
      nativePython: text(native, "nativePython"),
      mappedNativePython: text(native, "mappedNativePython"),
      nativePythonSha256: text(native, "nativePythonSha256"),
      installedForkDirectory: text(native, "installedForkDirectory"),
      mappedInstalledForkDirectory: text(
        native,
        "mappedInstalledForkDirectory",
      ),
      installedPackageFiles,
      provisionPath: text(native, "provisionPath"),
      localAppData: text(native, "localAppData"),
      nativePrivateDirectory: text(native, "nativePrivateDirectory"),
      mappedPrivateDirectory: text(native, "mappedPrivateDirectory"),
      linuxGrantDirectory: text(native, "linuxGrantDirectory"),
      ...(native["timeoutMs"] === undefined
        ? {}
        : { timeoutMs: integer(native, "timeoutMs") }),
    };
    const clientId = text(profile, "clientId");
    const descriptor = {
      kind: "fmcad-physical-grant" as const,
      version: 1 as const,
      handoffId: text(runtime, "handoffId"),
      generation: {
        instance: text(generation, "instance"),
        epoch: text(generation, "epoch"),
      },
      endpointURL: text(runtime, "endpointURL"),
      physicalRuntime: {
        pid: integer(physical, "pid"),
        birth: text(physical, "birth"),
        version: text(physical, "version"),
        source: text(physical, "source"),
        build: text(physical, "build"),
      },
    };
    const factory =
      dependencies.provisionFactory ?? createNativePhysicalGenerationProvision;
    if (dependencies.runtimeRoot && dependencies.runtimeRootFactory) rejected();
    Object.freeze(options.installedPackageFiles);
    Object.freeze(options);
    Object.freeze(descriptor.generation);
    Object.freeze(descriptor.physicalRuntime);
    Object.freeze(descriptor);
    const runtimeRoot =
      dependencies.runtimeRootFactory?.(
        Object.freeze({
          clientId,
          transport,
          runtime: descriptor,
          nativeProvision: options,
        }),
      ) ?? dependencies.runtimeRoot;
    if (dependencies.normalRuntime && runtimeRoot) rejected();
    if (runtimeRoot && !isDeepStrictEqual(options, runtimeRoot.nativeProvision))
      rejected();
    // Legacy generations keep the existing path. An approved-root issuer is
    // constructed only under the actual post-claim owner.
    let provider = runtimeRoot || dependencies.normalRuntime ? undefined : factory(options);
    const preparedPhysical = prepareBrokerPhysicalGeneration({
      runtime: descriptor,
      clientId,
      transport,
      provision: (descriptor) => {
        if (!provider) rejected();
        return provider.provision(descriptor);
      },
    });
    let attempted = false;
    return {
      ...preparedPhysical,
      async verifyRuntimeRootBeforeRestore(
        context: PhysicalRootVerificationContext,
      ) {
        if (runtimeRoot)
          return runtimeRoot.verifyRuntimeRootBeforeRestore(context);
        assertNoRootWithoutAuthority(context.directory);
        return undefined;
      },
      async preparePhysicalGeneration(context: PhysicalGenerationClaim) {
        if (attempted) rejected();
        attempted = true;
        context.assertBrokerOwner();
        if (!runtimeRoot) {
          assertNoRootWithoutAuthority(context.directory);
          if (dependencies.normalRuntime)
            provider = factory({ ...options, assertBrokerOwner: context.assertBrokerOwner });
        }
        if (runtimeRoot) {
          runtimeRoot.assertVerifiedRoot(context.directory);
          const configured = path.join(
            context.directory,
            "runtime-physical-profile.json",
          );
          if (file !== configured) {
            durable(configured, {
              version: 1,
              clientId,
              transport,
              runtime: descriptor,
              nativeProvision: options,
            });
            context.assertBrokerOwner();
            runtimeRoot.assertVerifiedRoot(context.directory);
          }
          const assertBrokerOwner = () => {
            context.assertBrokerOwner();
            runtimeRoot.assertVerifiedRoot(context.directory);
          };
          provider = factory({
            ...options,
            getVerifiedActivation: runtimeRoot.getVerifiedActivation,
            assertBrokerOwner,
          });
        } else {
          // Presence is a refusal signal, never proof of authorization.
          assertNoRootWithoutAuthority(context.directory);
        }
        await preparedPhysical.preparePhysicalGeneration(context);
      },
    };
  } catch {
    return rejected();
  }
}

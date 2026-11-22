import fs from "node:fs";
import path from "node:path";
import { decodeAdmissionJson } from "./admission-json";
import { prepareBrokerPhysicalGeneration } from "./physical-generation-broker";
import {
  createNativePhysicalGenerationProvision,
  type NativePhysicalGenerationProvisionOptions,
} from "./physical-generation-provision";

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
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
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

/** Broker-only composition input. It is deliberately separate from public
 * fmcad configuration and cannot supply a broker owner, token or capability. */
export function physicalBrokerPortsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: {
    provisionFactory?: typeof createNativePhysicalGenerationProvision;
  } = {},
) {
  const file = environment["FMCAD_PHYSICAL_OPERATOR_PROFILE"];
  if (file === undefined) return undefined;
  try {
    const profile = object(readProfile(file));
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
    const provider = (
      dependencies.provisionFactory ?? createNativePhysicalGenerationProvision
    )(options);
    return prepareBrokerPhysicalGeneration({
      runtime: descriptor,
      clientId,
      transport,
      provision: provider.provision,
    });
  } catch {
    return rejected();
  }
}

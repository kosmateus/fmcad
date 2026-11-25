import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decodeAdmissionJson } from "./admission-json";
import {
  controlledFusionLaunchNative,
  normalObserverFusionLaunchNative,
  normalObserverNativeBootstrap,
} from "./controlled-fusion-launch-native";
import { ownedAutoloadLaunchNative } from "./owned-autoload-launch-native";
import { bootstrapInstalledFilesDigest } from "./bootstrap-entry-evidence";
import {
  planControlledFusionAutoload,
  planNormalObserverAutoload,
} from "./fusion-bootstrap-autoload";
import type {
  ControlledNativeAdapter,
  ControlledFile,
  ControlledLaunch,
  ControlledLaunchPaths,
  ControlledProcess,
  OwnedAutoloadLaunchPaths,
  OwnedIdentityPreparation,
  OwnedIdentityPreparationLaunch,
} from "./controlled-fusion-launch-types";

export interface ControlledFusionLaunchPins {
  readonly nativePython: string;
  readonly mappedNativePython: string;
  readonly nativePythonSha256: string;
  /** Qualified immutable helper package, not the currently installed add-in. */
  readonly sourceDirectory: string;
  readonly mappedSourceDirectory: string;
  readonly installedDirectory: string;
  readonly mappedInstalledDirectory: string;
  readonly installedSource: string;
  readonly installedBuild: string;
  readonly installedFiles: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly mappedExecutable: string;
  readonly executableSha256: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly paths: ControlledLaunchPaths;
  /** Additional ORIGINAL native audit refs emitted by trusted ROOT ports. */
  readonly originalPaths: readonly string[];
  /** Explicit trusted mappings for every profile/output/ROOT-port audit path. */
  readonly mappedOriginalPaths: Readonly<Record<string, string>>;
  readonly receiptTimeoutMs: number;
  readonly normalCloseTimeoutMs: number;
  readonly mainWindowClass: string;
}
export interface NormalObserverLaunchOriginals {
  readonly database: { readonly nativePath: string; readonly identity: string };
  readonly provisionSha256: string;
  readonly handoffRequest: {
    readonly nativePath: string;
    readonly sha256: string;
  };
  /** Original native mailbox completion, NOT a fabricated committed JSON copy. */
  readonly handoffReceipt: {
    readonly nativePath: string;
    readonly sha256: string;
  };
  readonly provisionBackupPath: string;
  readonly provisionReceiptPath: string;
  readonly retiredProcessPath: string;
  readonly coldProcessPath: string;
  /** Complete actual inventory, including existing bytecode; helper stays clean. */
  readonly installedFiles: Readonly<Record<string, string>>;
}
export interface NormalObserverLaunch extends ControlledLaunch {
  readonly profile: ControlledFile;
  readonly profileBackup: ControlledFile;
  readonly provision: ControlledFile;
  readonly provisionBackup: ControlledFile;
  readonly provisionReceipt: ControlledFile;
  readonly coldProcess: ControlledFile;
  readonly isolation: "NOT_PROVEN";
}
export interface NormalObserverLaunchPins extends ControlledFusionLaunchPins {
  readonly normal: NormalObserverLaunchOriginals;
  /** Trusted synchronous held lifecycle boundary, never JSON or a public flag. */
  assertHeld(): void;
}
export interface OwnedReplacementStep {
  readonly priorProvision: ControlledFile;
  readonly provisionReceipt: ControlledFile;
  readonly retiredProcess: ControlledFile;
}
type OwnedReplacement =
  | (OwnedReplacementStep & {
      readonly kind: "unregistered-created-process-v1";
    })
  | {
      readonly kind: "unregistered-created-process-chain-v1";
      readonly steps: readonly OwnedReplacementStep[];
    };
export interface OwnedAutoloadLaunchOriginals extends NormalObserverLaunchOriginals {
  /** Original provision's admission protocol identity, not installed native code. */
  readonly admissionPins: { readonly source: string; readonly build: string };
  readonly autorunOriginals: readonly [ControlledFile, ControlledFile];
  readonly discoveryOriginals: readonly ControlledFile[];
  /** Original native chain for a created but unregistered process already dead.
   * This selects a private verification contract, never a serialized grant. */
  readonly replacement?: OwnedReplacement;
}
export interface OwnedAutoloadLaunchPins extends ControlledFusionLaunchPins {
  readonly paths: OwnedAutoloadLaunchPaths;
  readonly identity: OwnedIdentityPreparationPins;
  readonly owned: OwnedAutoloadLaunchOriginals;
  assertHeld(): void;
  /** Actual ROOT startup/discovery witness fence; not a serialized grant. */
  assertBeforeResumeOriginals(): void;
}
export interface OwnedIdentityPreparationPins {
  readonly executable: string;
  readonly mappedExecutable: string;
  readonly sha256: string;
  readonly version: string;
  readonly arguments: readonly [
    "--process_name",
    "Autodesk.IDSDK.DefaultProcess-v2",
    "--server_name",
    "Autodesk.IDSDK.DefaultServer-v2",
  ];
  readonly logFile: string;
  readonly mappedLogFile: string;
  readonly preparationTimeoutMs: number;
}
type PrivateLaunchAdapter = ControlledNativeAdapter & {
  closeNormal(old: ControlledProcess): Promise<ControlledFile>;
  launchNormal(
    old: ControlledProcess,
    original: ControlledFile,
    bytes: Uint8Array,
    nonce: string,
  ): Promise<NormalObserverLaunch>;
  launchOwned(
    old: ControlledProcess,
    original: ControlledFile,
    bytes: Uint8Array,
    nonce: string,
  ): Promise<OwnedIdentityPreparationLaunch>;
};
export class ControlledFusionNativeError extends Error {
  readonly outcome = "UNKNOWN";
  constructor(
    readonly action: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(
      `Controlled native ${action} outcome unproven; preserve originals, no replay`,
    );
  }
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Closed native object required");
  return value as Record<string, unknown>;
}
function closed(value: unknown, keys: readonly string[]) {
  const record = object(value);
  if (Object.keys(record).sort().join() !== [...keys].sort().join())
    throw new Error("Closed native fields differ");
  return record;
}
function replacementSteps(
  proof: OwnedReplacement,
): readonly OwnedReplacementStep[] {
  if (proof.kind === "unregistered-created-process-v1") {
    closed(proof, [
      "kind",
      "priorProvision",
      "provisionReceipt",
      "retiredProcess",
    ]);
    return [proof];
  }
  if (proof.kind === "unregistered-created-process-chain-v1") {
    closed(proof, ["kind", "steps"]);
    if (!Array.isArray(proof.steps) || proof.steps.length < 2)
      throw new Error("Two or more original owned replacement steps required");
    for (const step of proof.steps)
      closed(step, ["priorProvision", "provisionReceipt", "retiredProcess"]);
    return proof.steps;
  }
  throw new Error("Explicit original owned replacement contract required");
}
function windowsPath(value: string): string {
  if (
    !/^[A-Za-z]:\\/.test(value) ||
    value.includes("\0") ||
    path.win32.normalize(value) !== value
  )
    throw new Error("Canonical local Windows path required");
  return value.toLowerCase();
}
function identity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const numbers: unknown = decodeAdmissionJson(value);
    return (
      Array.isArray(numbers) &&
      numbers.length === 11 &&
      numbers.every(
        (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0,
      )
    );
  } catch {
    return false;
  }
}
function validateSource(
  value: unknown,
  files: Readonly<Record<string, string>>,
  installedFiles: Readonly<Record<string, string>> = files,
) {
  const source = closed(value, ["helper", "installed"]);
  for (const key of ["helper", "installed"]) {
    const expectedFiles = key === "installed" ? installedFiles : files;
    const snapshot = source[key];
    if (snapshot === null && key === "installed") continue;
    const inventory = closed(snapshot, ["files", "directories"]);
    const actual = object(inventory["files"]);
    if (
      Object.keys(actual).sort().join("\0") !==
      Object.keys(expectedFiles).sort().join("\0")
    )
      throw new Error("Full source inventory differs");
    for (const [name, hash] of Object.entries(expectedFiles)) {
      const file = closed(actual[name], ["sha256", "identity"]);
      if (file["sha256"] !== hash || !identity(file["identity"]))
        throw new Error("Source bytes/identity unavailable");
    }
    const directories = object(inventory["directories"]);
    if (
      !Object.keys(directories).length ||
      Object.values(directories).some((item) => !identity(item))
    )
      throw new Error("Source directory identities unavailable");
  }
  return source;
}

/**
 * Concrete Windows operator primitives. Construction is trusted local ROOT
 * composition only. No public tool, CLI option or invocation supplies these pins.
 * Cancellation never kills an uncertain native operation; callers await its
 * bounded result then revoke their one-shot transcript. Missing/partial output
 * never causes a retry.
 */
export function createControlledFusionLaunchAdapter(
  options: ControlledFusionLaunchPins,
): ControlledNativeAdapter {
  const { launchNormal, launchOwned, closeNormal, ...controlled } =
    createLaunchAdapter(options);
  void launchNormal;
  void closeNormal;
  void launchOwned;
  return Object.freeze(controlled);
}

/** NORMAL only: no bootstrap intent, manual add-in start or isolation witness. */
export function createNormalObserverLaunchAdapter(
  options: NormalObserverLaunchPins,
) {
  const { normal, assertHeld, ...base } = options;
  if (typeof assertHeld !== "function")
    throw new Error("Private held normal lifecycle boundary required");
  const adapter = createLaunchAdapter(base, normal, assertHeld);
  let attempted = false,
    closeAttempted = false,
    closeFailed = false;
  return Object.freeze({
    /** Existing exact OS/image/birth/source normal-close primitive, NORMAL pins. */
    async requestNormalCloseAndWait(old: ControlledProcess) {
      if (closeAttempted || attempted)
        throw new Error("Normal close cannot be replayed or follow launch");
      closeAttempted = true;
      try {
        return await adapter.closeNormal(old);
      } catch (error) {
        closeFailed = true;
        throw error;
      }
    },
    async launchAfterDeath(old: ControlledProcess, nonce: string) {
      if (attempted || closeFailed)
        throw new Error(
          "Normal observer launch cannot be replayed after an attempted launch or unknown close",
        );
      attempted = true;
      await adapter.confirmDead(old);
      const original = await adapter.readProfileAfterDeath(old);
      const plan = planNormalObserverAutoload(
        original.bytes,
        path.win32.join(base.installedDirectory, "AutodeskFusionMCP.py"),
      );
      return adapter.launchNormal(
        old,
        original,
        plan.registrationBytes(),
        nonce,
      );
    },
  });
}

/** Separate original pre-resume owned producer. Never a NORMAL isolation flag. */
export function createOwnedAutoloadLaunchAdapter(
  options: OwnedAutoloadLaunchPins,
) {
  if ("normal" in options)
    throw new Error("Disjoint owned constructor; NORMAL options refused");
  const { owned, identity, assertHeld, assertBeforeResumeOriginals, ...base } =
    options;
  if (
    typeof assertHeld !== "function" ||
    typeof assertBeforeResumeOriginals !== "function"
  )
    throw new Error(
      "Actual held owned lifecycle and startup-original fences required",
    );
  const adapter = createLaunchAdapter(
    base,
    undefined,
    assertHeld,
    owned,
    assertBeforeResumeOriginals,
    identity,
  );
  let attempted = false;
  return Object.freeze({
    async launchAfterDeath(
      old: ControlledProcess,
      nonce: string,
    ): Promise<OwnedIdentityPreparationLaunch> {
      if (attempted)
        throw new Error("Owned autoload launch cannot be replayed");
      attempted = true;
      await adapter.confirmDead(old);
      const original = await adapter.readProfileAfterDeath(old);
      const entry = path.win32.join(
        base.installedDirectory,
        "AutodeskFusionMCP.py",
      );
      // Reuse only the strict closed registration parser; native owned policy
      // independently checks the final exact-one-ON/every-foreign-OFF bytes.
      const allOff = planControlledFusionAutoload(original.bytes, entry);
      const value = decodeAdmissionJson(
        Buffer.from(allOff.registrationBytes()).toString("utf8"),
      ) as {
        loadedScripts: Array<{ path: string; runOnStartup: boolean }>;
      };
      for (const row of value.loadedScripts)
        row.runOnStartup =
          path.win32.isAbsolute(row.path) &&
          windowsPath(path.win32.normalize(row.path)) === windowsPath(entry);
      return adapter.launchOwned(
        old,
        original,
        Buffer.from(JSON.stringify(value) + "\n"),
        nonce,
      );
    },
  });
}

function createLaunchAdapter(
  options: ControlledFusionLaunchPins,
  normalOptions?: NormalObserverLaunchOriginals,
  heldBoundary?: () => void,
  ownedOptions?: OwnedAutoloadLaunchOriginals,
  originalBoundary?: () => void,
  identityOptions?: OwnedIdentityPreparationPins,
): PrivateLaunchAdapter {
  const pins = structuredClone(options);
  if (normalOptions && ownedOptions)
    throw new Error("Disjoint native launch roles required");
  const owned = ownedOptions && structuredClone(ownedOptions);
  const identityPins = identityOptions && structuredClone(identityOptions);
  const originalReplacementSteps = owned?.replacement
    ? replacementSteps(owned.replacement)
    : [];
  const lifecycle = owned
    ? (({ admissionPins, replacement, ...originals }) => {
        void admissionPins;
        void replacement;
        return originals;
      })(owned)
    : normalOptions;
  const normal = lifecycle && structuredClone(lifecycle);
  if (Boolean(owned) !== Boolean(identityPins))
    throw new Error("Owned launch requires its pinned Identity preparation");
  const identityPaths = identityPins
    ? (pins.paths as OwnedAutoloadLaunchPaths)
    : undefined;
  if (
    identityPins &&
    ![
      identityPaths?.identityAttempt,
      identityPaths?.identityJournal,
      identityPaths?.identityPreparation,
    ].every((value) => typeof value === "string" && value)
  )
    throw new Error("Distinct owned Identity receipt paths required");
  if (owned) {
    const admission = closed(owned.admissionPins, ["source", "build"]);
    for (const key of ["source", "build"]) {
      const value = admission[key];
      if (
        typeof value !== "string" ||
        !value ||
        value.length > 65536 ||
        value.includes("\0") ||
        Buffer.from(value, "utf8").toString("utf8") !== value
      )
        throw new Error("Exact original admission identity required");
    }
  }
  const normalProgram = normal
    ? Buffer.from(
        owned
          ? ownedAutoloadLaunchNative()
          : normalObserverFusionLaunchNative(),
        "utf8",
      )
    : null;
  let ownedMapped: string[] | undefined;
  function assertHeld() {
    if (!heldBoundary) return;
    const result: unknown = heldBoundary();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("Synchronous held normal lifecycle boundary required");
    }
    if (owned) {
      if (!originalBoundary)
        throw new Error("Original owned startup fence required");
      const checked: unknown = originalBoundary();
      if (checked !== undefined) {
        void Promise.resolve(checked).catch(() => {});
        throw new Error("Synchronous original owned startup fence required");
      }
      const stamps = [
        ...owned.autorunOriginals,
        ...owned.discoveryOriginals,
        ...originalReplacementSteps.flatMap((step) => [
          step.priorProvision,
          step.provisionReceipt,
          step.retiredProcess,
        ]),
      ].map((file) => {
        const mapped = pins.mappedOriginalPaths[file.nativePath]!;
        if (fs.realpathSync(mapped) !== path.resolve(mapped))
          throw new Error("Mapped owned input alias refused");
        if (fs.lstatSync(mapped, { bigint: true }).nlink !== 1n)
          throw new Error("Mapped owned input hardlink refused");
        return mappedStamp(mapped, file.sha256);
      });
      if (ownedMapped && !isDeepStrictEqual(ownedMapped, stamps))
        throw new Error("Mapped original owned input identity changed");
      ownedMapped ??= stamps;
    }
  }
  for (const value of [
    pins.nativePython,
    pins.sourceDirectory,
    pins.installedDirectory,
    pins.executable,
    pins.workingDirectory,
    ...Object.values(pins.paths),
    ...pins.originalPaths,
  ])
    windowsPath(value);
  if (
    !sha(pins.nativePythonSha256) ||
    !sha(pins.executableSha256) ||
    !/^[a-f0-9]{40}$/.test(pins.installedSource) ||
    !Number.isSafeInteger(pins.receiptTimeoutMs) ||
    pins.receiptTimeoutMs < 1 ||
    pins.receiptTimeoutMs > 180000 ||
    !Number.isSafeInteger(pins.normalCloseTimeoutMs) ||
    pins.normalCloseTimeoutMs < 1 ||
    pins.normalCloseTimeoutMs > 180000 ||
    !pins.mainWindowClass ||
    pins.mainWindowClass.length > 256 ||
    pins.mainWindowClass.includes("\0") ||
    pins.arguments.some(
      (argument) => typeof argument !== "string" || argument.includes("\0"),
    )
  )
    throw new Error("Qualified native launch pins required");
  if (identityPins) {
    for (const value of [identityPins.executable, identityPins.logFile])
      windowsPath(value);
    if (
      !path.isAbsolute(identityPins.mappedExecutable) ||
      !path.isAbsolute(identityPins.mappedLogFile) ||
      !sha(identityPins.sha256) ||
      !/^[0-9]+(?:\.[0-9]+){1,3}$/.test(identityPins.version) ||
      identityPins.arguments.length !== 4 ||
      identityPins.arguments[0] !== "--process_name" ||
      identityPins.arguments[1] !== "Autodesk.IDSDK.DefaultProcess-v2" ||
      identityPins.arguments[2] !== "--server_name" ||
      identityPins.arguments[3] !== "Autodesk.IDSDK.DefaultServer-v2" ||
      !Number.isSafeInteger(identityPins.preparationTimeoutMs) ||
      identityPins.preparationTimeoutMs < 100 ||
      identityPins.preparationTimeoutMs > 30000
    )
      throw new Error("Exact bounded Identity preparation pins required");
    const ownedPaths = [
      ...Object.values(pins.paths),
      ...pins.originalPaths,
      ...[
        normal!.database.nativePath,
        normal!.handoffRequest.nativePath,
        normal!.handoffReceipt.nativePath,
        normal!.provisionBackupPath,
        normal!.provisionReceiptPath,
        normal!.retiredProcessPath,
        normal!.coldProcessPath,
      ],
    ].map(windowsPath);
    if (
      ownedPaths.includes(windowsPath(identityPins.executable)) ||
      ownedPaths.includes(windowsPath(identityPins.logFile)) ||
      windowsPath(identityPins.executable) === windowsPath(identityPins.logFile)
    )
      throw new Error("Identity executable/log must be distinct pinned inputs");
  }
  const names = Object.keys(pins.installedFiles);
  if (
    normal && !owned
      ? !sha(pins.installedBuild)
      : pins.installedBuild !==
        bootstrapInstalledFilesDigest(pins.installedFiles)
  )
    throw new Error("Qualified native build/full-manifest digest differs");
  if (
    !(
      normal
        ? [
            "AutodeskFusionMCP.py",
            "addon_runtime.py",
            "lib/physical_authority.py",
            "lib/request_admission.py",
            "lib/rebaseline_fence.py",
          ]
        : ["AutodeskFusionMCP.py", "addon_runtime.py", "lib/bootstrap_entry.py"]
    ).every((name) => names.includes(name)) ||
    names.some(
      (name) =>
        !name ||
        name.includes("\\") ||
        name.includes(":") ||
        path.posix.normalize(name) !== name ||
        name.startsWith("/") ||
        name.split("/").some((part) => part === ".." || part === ".") ||
        !sha(pins.installedFiles[name]),
    ) ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length
  )
    throw new Error("Closed qualified source manifest required");
  const filePaths = Object.entries(pins.paths)
    .filter(([key]) => key !== "receiptDirectory")
    .map(([, value]) => value);
  if (
    new Set(filePaths.map(windowsPath)).size !== filePaths.length ||
    path.win32.dirname(pins.paths.entry) !== pins.paths.receiptDirectory ||
    path.win32.dirname(pins.paths.returned) !== pins.paths.receiptDirectory
  )
    throw new Error("Fresh disjoint original paths required");
  for (const value of filePaths) {
    for (const root of [pins.sourceDirectory, pins.installedDirectory]) {
      const relative = path.win32.relative(root, value);
      if (
        relative !== ".." &&
        !relative.startsWith("..\\") &&
        !path.win32.isAbsolute(relative)
      )
        throw new Error("Outputs must not alias installed source");
    }
  }
  let expectedSource: Record<string, unknown> | null = null;
  let launchAttempted = false,
    profileAttempted = false;
  const published = new Set<string>();
  const allowed = new Set([
    ...Object.values(pins.paths),
    ...pins.originalPaths,
  ]);
  if (normal) {
    for (const value of [
      normal.database.nativePath,
      normal.handoffRequest.nativePath,
      normal.handoffReceipt.nativePath,
      normal.provisionBackupPath,
      normal.provisionReceiptPath,
      normal.retiredProcessPath,
      normal.coldProcessPath,
    ]) {
      windowsPath(value);
      if (!allowed.has(value))
        throw new Error("Pinned normal original/output mapping required");
    }
    if (
      !identity(normal.database.identity) ||
      !sha(normal.provisionSha256) ||
      !sha(normal.handoffRequest.sha256) ||
      !sha(normal.handoffReceipt.sha256) ||
      new Set(
        [
          ...filePaths,
          normal.database.nativePath,
          normal.handoffRequest.nativePath,
          normal.handoffReceipt.nativePath,
          normal.provisionBackupPath,
          normal.provisionReceiptPath,
          normal.retiredProcessPath,
          normal.coldProcessPath,
        ].map(windowsPath),
      ).size !==
        filePaths.length + 7
    )
      throw new Error("Disjoint original normal paths and pins required");
    const actualNames = Object.keys(normal.installedFiles);
    if (
      !actualNames.length ||
      new Set(actualNames.map((name) => name.toLowerCase())).size !==
        actualNames.length ||
      actualNames.some(
        (name) =>
          !name ||
          name.includes("\\") ||
          name.includes(":") ||
          path.posix.normalize(name) !== name ||
          name.startsWith("/") ||
          name
            .split("/")
            .some((part) => !part || part === "." || part === "..") ||
          !sha(normal.installedFiles[name]),
      ) ||
      names.some(
        (name) => normal.installedFiles[name] !== pins.installedFiles[name],
      )
    )
      throw new Error("Full normal installed/source inventory differs");
    for (const output of [
      normal.provisionBackupPath,
      normal.provisionReceiptPath,
      normal.retiredProcessPath,
      normal.coldProcessPath,
    ]) {
      for (const root of [pins.sourceDirectory, pins.installedDirectory]) {
        const relative = path.win32.relative(root, output);
        if (
          !relative.startsWith("..\\") &&
          relative !== ".." &&
          !path.win32.isAbsolute(relative)
        )
          throw new Error("Normal outputs must not alias source");
      }
    }
  }
  if (owned) {
    if (owned.autorunOriginals.length !== 2 || !owned.discoveryOriginals.length)
      throw new Error(
        "Two original autorun files and nonempty discovery originals required",
      );
    const inputs = [...owned.autorunOriginals, ...owned.discoveryOriginals];
    const seen = new Set<string>();
    const reserved = [
      ...Object.values(pins.paths),
      normal!.database.nativePath,
      normal!.handoffRequest.nativePath,
      normal!.handoffReceipt.nativePath,
      normal!.provisionBackupPath,
      normal!.provisionReceiptPath,
      normal!.retiredProcessPath,
      normal!.coldProcessPath,
    ].map(windowsPath);
    for (const input of inputs) {
      const name = windowsPath(input.nativePath);
      if (
        !pins.originalPaths.includes(input.nativePath) ||
        !allowed.has(input.nativePath) ||
        seen.has(name) ||
        reserved.includes(name) ||
        !identity(input.identity) ||
        !sha(input.sha256) ||
        digest(input.bytes) !== input.sha256
      )
        throw new Error(
          "Distinct pinned original owned input bytes/identity required",
        );
      seen.add(name);
    }
    if (owned.replacement) {
      const retirement = windowsPath(normal!.retiredProcessPath);
      for (const [index, proof] of originalReplacementSteps.entries()) {
        const last = index === originalReplacementSteps.length - 1;
        for (const [role, input] of [
          ["priorProvision", proof.priorProvision],
          ["provisionReceipt", proof.provisionReceipt],
          ["retiredProcess", proof.retiredProcess],
        ] as const) {
          const name = windowsPath(input.nativePath);
          if (
            !pins.originalPaths.includes(input.nativePath) ||
            !allowed.has(input.nativePath) ||
            seen.has(name) ||
            reserved.some(
              (value) =>
                value === name &&
                !(last && role === "retiredProcess" && name === retirement),
            ) ||
            (last && role === "retiredProcess" && name !== retirement) ||
            !identity(input.identity) ||
            !sha(input.sha256) ||
            digest(input.bytes) !== input.sha256
          )
            throw new Error(
              "Distinct pinned original owned replacement bytes/identity required",
            );
          seen.add(name);
        }
      }
    }
  }
  for (const nativePath of allowed) {
    if (
      nativePath !== pins.paths.receiptDirectory &&
      (typeof pins.mappedOriginalPaths[nativePath] !== "string" ||
        !path.isAbsolute(pins.mappedOriginalPaths[nativePath]!))
    )
      throw new Error("Explicit mapped original path required");
  }
  function mappedStamp(mapped: string, expectedHash?: string): string {
    const before = fs.lstatSync(mapped, { bigint: true });
    if (before.isSymbolicLink()) throw new Error("Mapped alias refused");
    if (!before.isFile()) throw new Error("Mapped regular file required");
    const fd = fs.openSync(
      mapped,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino)
        throw new Error("Mapped path/FD identity differs");
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(mapped, { bigint: true });
      const stamp = (info: typeof opened) =>
        [
          info.dev,
          info.ino,
          info.mode,
          info.nlink,
          info.size,
          info.mtimeNs,
          info.ctimeNs,
        ].join(":");
      if (
        stamp(before) !== stamp(opened) ||
        stamp(opened) !== stamp(after) ||
        stamp(after) !== stamp(current) ||
        (expectedHash && digest(bytes) !== expectedHash)
      )
        throw new Error("Mapped bytes or identity changed");
      return stamp(after);
    } finally {
      fs.closeSync(fd);
    }
  }
  function sourceMappedFiles(root: string, directories?: string[]): string[] {
    const found: string[] = [];
    const visit = (directory: string) => {
      if (fs.lstatSync(directory).isSymbolicLink())
        throw new Error("Mapped source alias refused");
      directories?.push(directory);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(name);
        else if (entry.isFile())
          found.push(path.relative(root, name).split(path.sep).join("/"));
        else throw new Error("Mapped source special file refused");
      }
    };
    visit(root);
    if (
      found.sort().join("\0") !==
      Object.keys(pins.installedFiles).sort().join("\0")
    )
      throw new Error("Mapped full source inventory changed");
    return found;
  }
  function file(value: unknown, expectedPath?: string): ControlledFile {
    const result = closed(value, [
      "nativePath",
      "sha256",
      "identity",
      "base64",
    ]);
    if (
      typeof result["nativePath"] !== "string" ||
      !allowed.has(result["nativePath"]) ||
      (expectedPath &&
        windowsPath(result["nativePath"]) !== windowsPath(expectedPath)) ||
      !sha(result["sha256"]) ||
      !identity(result["identity"]) ||
      typeof result["base64"] !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        result["base64"],
      )
    )
      throw new Error("Original native file fields differ");
    const bytes = Buffer.from(result["base64"], "base64");
    if (bytes.length > 8388608 || digest(bytes) !== result["sha256"])
      throw new Error("Original native bytes differ");
    return Object.freeze({
      nativePath: result["nativePath"],
      sha256: result["sha256"],
      identity: result["identity"],
      bytes,
    });
  }
  function process(value: unknown): ControlledProcess {
    const result = closed(value, ["pid", "birth"]);
    if (
      !Number.isSafeInteger(result["pid"]) ||
      (result["pid"] as number) <= 0 ||
      typeof result["birth"] !== "string" ||
      !/^[0-9]+$/.test(result["birth"])
    )
      throw new Error("Exact native process tuple required");
    return Object.freeze({
      pid: result["pid"] as number,
      birth: result["birth"],
    });
  }
  function identityPreparation(value: unknown): OwnedIdentityPreparation {
    if (!identityPins)
      throw new Error("Owned Identity preparation pins are absent");
    const result = closed(value, [
      "state",
      "origin",
      "process",
      "executable",
      "sha256",
      "version",
      "arguments",
      "commandLine",
      "inputIdleCode",
      "logEvent",
    ]);
    const preparedProcess = process(result["process"]);
    const logEvent = closed(result["logEvent"], [
      "pid",
      "timestamp",
      "offset",
      "line",
    ]);
    const timestamp =
      typeof logEvent["timestamp"] === "string"
        ? Date.parse(logEvent["timestamp"])
        : NaN;
    const timestampFileTime = Number.isFinite(timestamp)
      ? BigInt(timestamp) * 10000n + 116444736000000000n
      : -1n;
    if (
      result["state"] !== "PREPARATION_ONLY_NOT_SERVICE_READY" ||
      !["spawned", "adopted"].includes(String(result["origin"])) ||
      typeof result["executable"] !== "string" ||
      windowsPath(result["executable"]) !==
        windowsPath(identityPins.executable) ||
      result["sha256"] !== identityPins.sha256 ||
      result["version"] !== identityPins.version ||
      !Array.isArray(result["arguments"]) ||
      !isDeepStrictEqual(result["arguments"], identityPins.arguments) ||
      typeof result["commandLine"] !== "string" ||
      result["inputIdleCode"] !== 0 ||
      logEvent["pid"] !== preparedProcess.pid ||
      typeof logEvent["timestamp"] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        logEvent["timestamp"],
      ) ||
      !Number.isSafeInteger(logEvent["offset"]) ||
      (logEvent["offset"] as number) < 0 ||
      typeof logEvent["line"] !== "string" ||
      !logEvent["line"].startsWith(
        `${String(logEvent["timestamp"])} [AdskIdentityManager:${preparedProcess.pid}, `,
      ) ||
      !logEvent["line"].endsWith(
        "] [AdskIdentityManager INFO] SSO Server is ready",
      ) ||
      timestampFileTime <= BigInt(preparedProcess.birth)
    )
      throw new Error("Bounded Identity preparation evidence differs");
    return Object.freeze({
      state: "PREPARATION_ONLY_NOT_SERVICE_READY",
      origin: result["origin"] as "spawned" | "adopted",
      process: preparedProcess,
      executable: identityPins.executable,
      sha256: identityPins.sha256,
      version: identityPins.version,
      arguments: Object.freeze([...identityPins.arguments]),
      commandLine: result["commandLine"] as string,
      inputIdleCode: 0,
      logEvent: Object.freeze({
        pid: logEvent["pid"] as number,
        timestamp: logEvent["timestamp"] as string,
        offset: logEvent["offset"] as number,
        line: logEvent["line"] as string,
      }),
    });
  }
  function inputProcess(value: ControlledProcess): ControlledProcess {
    return process(value);
  }
  function reference(value: ControlledFile) {
    if (
      !allowed.has(value.nativePath) ||
      digest(value.bytes) !== value.sha256 ||
      !identity(value.identity)
    )
      throw new Error("Pinned original bytes/identity required");
    return {
      nativePath: value.nativePath,
      sha256: value.sha256,
      identity: value.identity,
    };
  }
  async function invoke(action: string, request: unknown): Promise<unknown> {
    assertHeld();
    if (
      digest(fs.readFileSync(pins.mappedNativePython)) !==
        pins.nativePythonSha256 ||
      digest(fs.readFileSync(pins.mappedExecutable)) !==
        pins.executableSha256 ||
      (identityPins &&
        digest(fs.readFileSync(identityPins.mappedExecutable)) !==
          identityPins.sha256)
    )
      throw new ControlledFusionNativeError(
        action,
        "",
        "Mapped native executable/Identity bytes differ before spawn",
      );
    const nativePins = {
      nativePython: pins.nativePython,
      nativePythonSha256: pins.nativePythonSha256,
      sourceDirectory: pins.sourceDirectory,
      installedDirectory: pins.installedDirectory,
      installedFiles: pins.installedFiles,
      ...(owned ? { installedSource: pins.installedSource } : {}),
      executable: pins.executable,
      executableSha256: pins.executableSha256,
      arguments: pins.arguments,
      workingDirectory: pins.workingDirectory,
      paths: pins.paths,
      originalPaths: pins.originalPaths,
      receiptTimeoutMs: pins.receiptTimeoutMs,
      normalCloseTimeoutMs: pins.normalCloseTimeoutMs,
      mainWindowClass: pins.mainWindowClass,
      ...(identityPins
        ? {
            identity: {
              executable: identityPins.executable,
              sha256: identityPins.sha256,
              version: identityPins.version,
              arguments: identityPins.arguments,
              logFile: identityPins.logFile,
              preparationTimeoutMs: identityPins.preparationTimeoutMs,
            },
          }
        : {}),
      ...(normal
        ? {
            [owned ? "owned" : "normal"]: {
              ...normal,
              ...(owned
                ? {
                    autorunOriginals: owned.autorunOriginals.map(reference),
                    discoveryOriginals: owned.discoveryOriginals.map(reference),
                    ...(owned.replacement
                      ? {
                          replacement:
                            owned.replacement.kind ===
                            "unregistered-created-process-v1"
                              ? {
                                  kind: owned.replacement.kind,
                                  priorProvision: reference(
                                    owned.replacement.priorProvision,
                                  ),
                                  provisionReceipt: reference(
                                    owned.replacement.provisionReceipt,
                                  ),
                                  retiredProcess: reference(
                                    owned.replacement.retiredProcess,
                                  ),
                                }
                              : {
                                  kind: owned.replacement.kind,
                                  steps: originalReplacementSteps.map(
                                    (step) => ({
                                      priorProvision: reference(
                                        step.priorProvision,
                                      ),
                                      provisionReceipt: reference(
                                        step.provisionReceipt,
                                      ),
                                      retiredProcess: reference(
                                        step.retiredProcess,
                                      ),
                                    }),
                                  ),
                                },
                        }
                      : {}),
                  }
                : {}),
              source: owned ? owned.admissionPins.source : pins.installedSource,
              build: owned ? owned.admissionPins.build : pins.installedBuild,
            },
          }
        : {}),
    };
    const raw = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          pins.mappedNativePython,
          [
            "-I",
            "-S",
            "-B",
            "-c",
            normal
              ? normalObserverNativeBootstrap
              : controlledFusionLaunchNative,
          ],
          {
            cwd: pins.mappedSourceDirectory,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...processEnv(), PYTHONDONTWRITEBYTECODE: "1" },
          },
        );
        let stdout = "",
          finalOutput = "",
          pending = "",
          checkpointIndex = 0,
          stderr = "",
          overflow = false;
        const expectedPhases = [
          "ready-before-create",
          "created-before-bind",
          "bound-before-resume",
        ];
        let created: ControlledProcess | undefined;
        const input = object(request);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (text: string) => {
          if (stdout.length + text.length <= 32 * 1024 * 1024) stdout += text;
          else overflow = true;
          if (action !== "normal-launch" && action !== "owned-autoload-launch")
            return;
          pending += text;
          while (pending.includes("\n")) {
            const end = pending.indexOf("\n"),
              line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            try {
              const value = object(decodeAdmissionJson(line));
              const ownedAction = action === "owned-autoload-launch";
              if (
                value["kind"] !==
                (ownedAction
                  ? "owned-autoload-checkpoint-v1"
                  : "normal-observer-checkpoint-v1")
              ) {
                if (
                  ownedAction &&
                  value["kind"] !== "controlled-fusion-native-v1"
                )
                  throw new Error("Unexpected owned checkpoint kind");
                finalOutput += line + "\n";
                continue;
              }
              closed(value, [
                "kind",
                "phase",
                "nonce",
                "process",
                "provision",
                ...(ownedAction ? ["intent"] : []),
              ]);
              if (
                value["phase"] !== expectedPhases[checkpointIndex] ||
                value["nonce"] !== input["nonce"] ||
                checkpointIndex > 2
              )
                throw new Error("Wrong normal native checkpoint");
              if (checkpointIndex === 0) {
                if (
                  value["process"] !== null ||
                  value["provision"] !== null ||
                  (ownedAction && value["intent"] !== null)
                )
                  throw new Error("Unexpected early normal process");
              } else {
                const current = process(value["process"]);
                if (created && !isDeepStrictEqual(created, current))
                  throw new Error("Normal checkpoint process changed");
                created = current;
                if (ownedAction && checkpointIndex === 2) {
                  for (const [key, target] of [
                    ["provision", pins.paths.provision],
                    ["intent", pins.paths.intent],
                  ]) {
                    const ref = closed(value[key!], [
                      "nativePath",
                      "sha256",
                      "identity",
                    ]);
                    if (
                      ref["nativePath"] !== target ||
                      !sha(ref["sha256"]) ||
                      !identity(ref["identity"])
                    )
                      throw new Error("Original owned checkpoint ref differs");
                  }
                } else if (
                  checkpointIndex === 1
                    ? value["provision"] !== null
                    : !sha(value["provision"])
                )
                  throw new Error("Normal checkpoint provision differs");
                if (
                  ownedAction &&
                  checkpointIndex === 1 &&
                  value["intent"] !== null
                )
                  throw new Error("Premature owned intent ref");
              }
              assertHeld();
              checkpointIndex++;
              child.stdin.write(
                JSON.stringify({
                  kind: ownedAction
                    ? "owned-autoload-continue-v1"
                    : "normal-observer-continue-v1",
                  phase: value["phase"],
                  nonce: value["nonce"],
                  process: value["process"],
                  provision: value["provision"],
                  ...(ownedAction ? { intent: value["intent"] } : {}),
                }) + "\n",
              );
            } catch {
              overflow = true;
              child.stdin.end(); // Refuse continuation, never kill/replay/resume.
            }
          }
        });
        child.stderr.on("data", (text: string) => {
          if (stderr.length + text.length <= 1024 * 1024) stderr += text;
          else overflow = true;
        });
        child.on("error", () =>
          reject(new ControlledFusionNativeError(action, stdout, stderr)),
        );
        child.stdin.on("error", () => {
          /* close/error owns the terminal result; never resend */
        });
        child.on("close", (code) =>
          code !== 0 ||
          overflow ||
          (action === "owned-autoload-launch" && checkpointIndex !== 3)
            ? reject(new ControlledFusionNativeError(action, stdout, stderr))
            : resolve({
                stdout:
                  action === "normal-launch" ||
                  action === "owned-autoload-launch"
                    ? finalOutput
                    : stdout,
                stderr,
              }),
        );
        const envelope = JSON.stringify({
          pins: nativePins,
          action,
          request,
          expectedSource,
        });
        const program = normalProgram;
        const prefix = program
          ? Buffer.concat([Buffer.from(`${program.length}\n`), program])
          : Buffer.alloc(0);
        if (action === "normal-launch" || action === "owned-autoload-launch") {
          child.stdin.write(prefix);
          child.stdin.write(envelope + "\n");
        } else child.stdin.end(Buffer.concat([prefix, Buffer.from(envelope)]));
      },
    );
    try {
      const envelope = closed(decodeAdmissionJson(raw.stdout), [
        "kind",
        "action",
        "source",
        "result",
      ]);
      if (
        envelope["kind"] !== "controlled-fusion-native-v1" ||
        envelope["action"] !== action
      )
        throw new Error("Wrong original native response");
      assertHeld();
      const source = validateSource(
        envelope["source"],
        pins.installedFiles,
        normal?.installedFiles,
      );
      if (
        action !== "dead" &&
        action !== "normal-close" &&
        source["installed"] === null
      )
        throw new Error("Installed source closure absent");
      if (
        expectedSource &&
        (!isDeepStrictEqual(source["helper"], expectedSource["helper"]) ||
          (expectedSource["installed"] !== null &&
            !isDeepStrictEqual(
              source["installed"],
              expectedSource["installed"],
            )))
      )
        throw new Error("Native source closure changed");
      expectedSource = source;
      return envelope["result"];
    } catch {
      throw new ControlledFusionNativeError(action, raw.stdout, raw.stderr);
    }
  }
  async function nothing(action: string, request: unknown) {
    if ((await invoke(action, request)) !== null)
      throw new ControlledFusionNativeError(
        action,
        "",
        "Unexpected native result",
      );
  }
  return Object.freeze({
    paths: Object.freeze({ ...pins.paths }),
    installedDirectory: pins.installedDirectory,
    installedSource: pins.installedSource,
    installedBuild: pins.installedBuild,
    installedFiles: Object.freeze({ ...pins.installedFiles }),
    nativePathMappings: Object.freeze({
      ...pins.mappedOriginalPaths,
      [pins.sourceDirectory]: pins.mappedSourceDirectory,
      [pins.installedDirectory]: pins.mappedInstalledDirectory,
      [pins.nativePython]: pins.mappedNativePython,
      [pins.executable]: pins.mappedExecutable,
      ...(identityPins
        ? {
            [identityPins.executable]: identityPins.mappedExecutable,
            [identityPins.logFile]: identityPins.mappedLogFile,
          }
        : {}),
    }),
    preflight: () => nothing("preflight", {}),
    requestNormalCloseAndWait: (value) =>
      nothing("normal-close", { process: inputProcess(value) }),
    confirmDead: (value) => nothing("dead", { process: inputProcess(value) }),
    readProfileAfterDeath: async (value) =>
      file(
        await invoke("read-profile", { process: inputProcess(value) }),
        pins.paths.profile,
      ),
    async applyProfileAfterDeath(old, original, bytes) {
      if (profileAttempted)
        throw new Error("Profile application cannot be replayed");
      profileAttempted = true;
      const result = closed(
        await invoke("replace-profile", {
          old: inputProcess(old),
          original: reference(original),
          base64: Buffer.from(bytes).toString("base64"),
        }),
        ["profile", "backup"],
      );
      return {
        profile: file(result["profile"], pins.paths.profile),
        backup: file(result["backup"], pins.paths.profileBackup),
      };
    },
    async launch(old, profile, nonce): Promise<ControlledLaunch> {
      if (launchAttempted) throw new Error("Native launch cannot be replayed");
      launchAttempted = true;
      if (!/^[a-f0-9]{32}$/.test(nonce))
        throw new Error("Fresh private launch nonce required");
      const result = closed(
        await invoke("launch", {
          old: inputProcess(old),
          profile: reference(profile),
          nonce,
        }),
        ["process", "journal", "attempt", "sourceClosure"],
      );
      return Object.freeze({
        process: process(result["process"]),
        journal: file(result["journal"], pins.paths.launchJournal),
        attempt: file(result["attempt"], pins.paths.launchAttempt),
        sourceClosure: file(result["sourceClosure"], pins.paths.sourceClosure),
      });
    },
    async launchNormal(
      old,
      original,
      bytes,
      nonce,
    ): Promise<NormalObserverLaunch> {
      if (!normal || launchAttempted || !/^[a-f0-9]{32}$/.test(nonce))
        throw new Error("Fresh private normal launch required");
      launchAttempted = true;
      const result = closed(
        await invoke("normal-launch", {
          old: inputProcess(old),
          original: reference(original),
          base64: Buffer.from(bytes).toString("base64"),
          nonce,
        }),
        [
          "process",
          "journal",
          "attempt",
          "sourceClosure",
          "profile",
          "profileBackup",
          "provisionBackup",
          "provision",
          "provisionReceipt",
          "coldProcess",
        ],
      );
      return Object.freeze({
        process: process(result["process"]),
        journal: file(result["journal"], pins.paths.launchJournal),
        attempt: file(result["attempt"], pins.paths.launchAttempt),
        sourceClosure: file(result["sourceClosure"], pins.paths.sourceClosure),
        profile: file(result["profile"], pins.paths.profile),
        profileBackup: file(result["profileBackup"], pins.paths.profileBackup),
        provisionBackup: file(
          result["provisionBackup"],
          normal.provisionBackupPath,
        ),
        provision: file(result["provision"], pins.paths.provision),
        provisionReceipt: file(
          result["provisionReceipt"],
          normal.provisionReceiptPath,
        ),
        coldProcess: file(result["coldProcess"], normal.coldProcessPath),
        isolation: "NOT_PROVEN",
      });
    },
    async launchOwned(
      old,
      original,
      bytes,
      nonce,
    ): Promise<OwnedIdentityPreparationLaunch> {
      if (!owned || launchAttempted || !/^[a-f0-9]{32}$/.test(nonce))
        throw new Error("Fresh private owned autoload launch required");
      launchAttempted = true;
      const result = closed(
        await invoke("owned-autoload-launch", {
          old: inputProcess(old),
          original: reference(original),
          base64: Buffer.from(bytes).toString("base64"),
          nonce,
        }),
        [
          "process",
          "journal",
          "attempt",
          "sourceClosure",
          "profile",
          "profileBackup",
          "provisionBackup",
          "provision",
          "provisionReceipt",
          "coldProcess",
          "intent",
          "identityAttempt",
          "identityJournal",
          "identityPreparationFile",
          "identityPreparation",
        ],
      );
      return Object.freeze({
        process: process(result["process"]),
        journal: file(result["journal"], pins.paths.launchJournal),
        attempt: file(result["attempt"], pins.paths.launchAttempt),
        identityAttempt: file(
          result["identityAttempt"],
          identityPaths!.identityAttempt,
        ),
        identityJournal: file(
          result["identityJournal"],
          identityPaths!.identityJournal,
        ),
        identityPreparationFile: file(
          result["identityPreparationFile"],
          identityPaths!.identityPreparation,
        ),
        identityPreparation: identityPreparation(result["identityPreparation"]),
        sourceClosure: file(result["sourceClosure"], pins.paths.sourceClosure),
        profile: file(result["profile"], pins.paths.profile),
        profileBackup: file(result["profileBackup"], pins.paths.profileBackup),
        provision: file(result["provision"], pins.paths.provision),
        provisionBackup: file(
          result["provisionBackup"],
          owned.provisionBackupPath,
        ),
        provisionReceipt: file(
          result["provisionReceipt"],
          owned.provisionReceiptPath,
        ),
        coldProcess: file(result["coldProcess"], owned.coldProcessPath),
        intent: file(result["intent"], pins.paths.intent),
        startupProven: false as const,
      });
    },
    async closeNormal(old) {
      if (!normal) throw new Error("Private normal close role required");
      return file(
        await invoke("normal-close", { process: inputProcess(old) }),
        normal.retiredProcessPath,
      );
    },
    assertProcess: (value) =>
      nothing("assert-process", { process: inputProcess(value) }),
    async readOriginal(nativePath) {
      if (!allowed.has(nativePath))
        throw new Error("Original native path is not pinned");
      return file(await invoke("read", { path: nativePath }), nativePath);
    },
    async publishOriginal(nativePath, bytes) {
      if (
        ![pins.paths.intent, pins.paths.transcript].includes(nativePath) ||
        published.has(nativePath)
      )
        throw new Error("Exclusive publication cannot be replayed");
      published.add(nativePath);
      return file(
        await invoke("publish", {
          path: nativePath,
          base64: Buffer.from(bytes).toString("base64"),
        }),
        nativePath,
      );
    },
    async assertOriginal(expected) {
      const actual = file(
        await invoke("read", { path: reference(expected).nativePath }),
        expected.nativePath,
      );
      if (
        actual.sha256 !== expected.sha256 ||
        actual.identity !== expected.identity
      )
        throw new Error("Original native file changed");
    },
    assertSource: () => nothing("preflight", {}),
    captureSynchronousFence(files) {
      if (!expectedSource || expectedSource["installed"] === null)
        throw new Error(
          "Async native source preflight required before sync capture",
        );
      const expected = new Map<string, { hash: string; stamp: string }>();
      const directories = new Map<string, string>();
      const directoryStamp = (directory: string) => {
        const info = fs.lstatSync(directory, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Mapped directory differs");
        return [info.dev, info.ino, info.mode, info.mtimeNs, info.ctimeNs].join(
          ":",
        );
      };
      const add = (mapped: string, hash: string) => {
        expected.set(mapped, { hash, stamp: mappedStamp(mapped, hash) });
      };
      for (const root of [
        pins.mappedSourceDirectory,
        pins.mappedInstalledDirectory,
      ]) {
        const names: string[] = [];
        for (const name of sourceMappedFiles(root, names))
          add(path.join(root, ...name.split("/")), pins.installedFiles[name]!);
        for (const directory of names)
          directories.set(directory, directoryStamp(directory));
      }
      add(pins.mappedNativePython, pins.nativePythonSha256);
      add(pins.mappedExecutable, pins.executableSha256);
      for (const file of files) {
        reference(file);
        const mapped = pins.mappedOriginalPaths[file.nativePath];
        if (!mapped)
          throw new Error("Original native/mapped reference unavailable");
        add(mapped, file.sha256);
      }
      let revoked = false;
      return () => {
        if (revoked) throw new Error("Mapped snapshot fence revoked");
        try {
          const currentDirectories: string[] = [];
          sourceMappedFiles(pins.mappedSourceDirectory, currentDirectories);
          sourceMappedFiles(pins.mappedInstalledDirectory, currentDirectories);
          if (
            [...new Set(currentDirectories)].sort().join("\0") !==
            [...directories.keys()].sort().join("\0")
          )
            throw new Error("Mapped source directory inventory differs");
          for (const [directory, stamp] of directories)
            if (directoryStamp(directory) !== stamp)
              throw new Error("Mapped source directory identity changed");
          for (const [mapped, original] of expected)
            if (mappedStamp(mapped, original.hash) !== original.stamp)
              throw new Error("Mapped original file identity changed");
        } catch (error) {
          revoked = true;
          throw error;
        }
      };
    },
    async awaitReceipts(value) {
      const result = closed(
        await invoke("receipts", { process: inputProcess(value) }),
        ["entry", "returned"],
      );
      return {
        entry: file(result["entry"], pins.paths.entry),
        returned: file(result["returned"], pins.paths.returned),
      };
    },
  } satisfies PrivateLaunchAdapter);
}

// Keep the local helper named process(...) separate from Node's environment.
function processEnv() {
  return { ...globalThis.process.env };
}

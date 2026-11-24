import path from "node:path";
import { createHash } from "node:crypto";
import { decodeAdmissionJson } from "./admission-json";

/** A structural data port, not the wire decoder and not a host capability. */
export interface StartupPolicyAudit {
  readonly preferences: { readonly defaultPathForScriptsAndAddIns: string };
  readonly scripts: {
    readonly countBefore: number;
    readonly countAfter: number;
    readonly items: readonly {
      readonly folder: string;
      readonly isAddIn: boolean;
      readonly isRunOnStartup: boolean | null;
      readonly isRunning: boolean;
      readonly manifest: { readonly sha256: string };
    }[];
  };
}
export interface StartupPolicyExpected {
  readonly defaultApiParent: string;
  readonly installedDirectory: string;
  readonly installedManifestHash: string;
  /** Exact global and current user-profile paths, from the held OS observer. */
  readonly autorunPaths: readonly [string, string];
}
export interface StartupAutorunOriginal {
  readonly nativePath: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export class ControlledStartupPolicyError extends Error {
  readonly code = "CONTROLLED_STARTUP_UNPROVEN";
  constructor() {
    super(
      "Original audited startup and disabled Python autorun inputs required",
    );
  }
}
function deny(): never {
  throw new ControlledStartupPolicyError();
}
function native(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z]:[\\/]/i.test(value) ||
    value.includes("\0")
  )
    deny();
  const normalized = path.win32.normalize(value);
  // Normalization may change slash spelling/case, not hide traversal.
  if (value.split(/[\\/]/).some((part) => part === "." || part === ".."))
    deny();
  return normalized.replace(/[\\]+$/, "").toLowerCase();
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * DATA POLICY ONLY. The caller must separately retain the original controller,
 * current native MAC references, OS file identities and private ingress lease.
 * In particular these two stored Python-autorun inputs are not a claim that SDK
 * ScriptCollection describes every vendor loader or every possible search root.
 * No booleans supplied here mint authority or replace those separate proofs.
 */
export function assertControlledStartupData(
  audit: StartupPolicyAudit,
  expected: StartupPolicyExpected,
  autorun: readonly StartupAutorunOriginal[],
): void {
  assertStartupData(audit, expected, autorun, "manual");
}

/** Separate byte/data policy for the owned pre-resume producer. This does not
 * grant authority or make manual v2 evidence valid for autoload. */
export function assertOwnedBootstrapStartupData(
  audit: StartupPolicyAudit,
  expected: StartupPolicyExpected,
  autorun: readonly StartupAutorunOriginal[],
): void {
  assertStartupData(audit, expected, autorun, "owned-autoload");
}

function assertStartupData(
  audit: StartupPolicyAudit,
  expected: StartupPolicyExpected,
  autorun: readonly StartupAutorunOriginal[],
  mode: "manual" | "owned-autoload",
): void {
  try {
    if (!/^[a-f0-9]{64}$/.test(expected.installedManifestHash)) deny();
    if (
      native(audit.preferences.defaultPathForScriptsAndAddIns) !==
      native(expected.defaultApiParent)
    )
      deny();
    const self = native(expected.installedDirectory);
    const collection = audit.scripts;
    if (
      !Number.isSafeInteger(collection.countBefore) ||
      collection.countBefore < 1 ||
      collection.countBefore > 1024 ||
      collection.countBefore !== collection.countAfter ||
      collection.items.length !== collection.countBefore
    )
      deny();
    const folders = new Set<string>();
    let ownRows = 0;
    for (const row of collection.items) {
      const folder = native(row.folder);
      if (
        folders.has(folder) ||
        typeof row.isRunning !== "boolean" ||
        typeof row.isAddIn !== "boolean" ||
        row.isRunOnStartup !==
          (row.isAddIn ? mode === "owned-autoload" && folder === self : null)
      )
        deny();
      folders.add(folder);
      if (folder === self) {
        ownRows++;
        // SDK may mark the entry running before addon_runtime is imported.
        // Only the separate owned-autoload policy permits its startup flag.
        if (
          !row.isAddIn ||
          (mode === "owned-autoload" && !row.isRunning) ||
          row.manifest.sha256 !== expected.installedManifestHash
        )
          deny();
      } else if (row.isRunning) {
        deny();
      }
    }
    if (ownRows !== 1) deny();
    assertControlledPythonAutorunData(expected.autorunPaths, autorun);
  } catch (error) {
    if (error instanceof ControlledStartupPolicyError) throw error;
    deny();
  }
}

/** The separate stored inputs may be checked before launch, without inventing
 * an SDK audit for a process which has not started. Still data, not authority. */
export function assertControlledPythonAutorunData(
  paths: readonly [string, string],
  autorun: readonly StartupAutorunOriginal[],
): void {
  try {
    if (paths.length !== 2 || autorun.length !== 2) deny();
    const required = paths.map(native);
    if (
      new Set(required).size !== 2 ||
      required.some(
        (file) => path.win32.basename(file) !== "pythonautorunmoduleinfo",
      )
    )
      deny();
    const seen = new Set<string>();
    for (const original of autorun) {
      const file = native(original.nativePath);
      if (
        !required.includes(file) ||
        seen.has(file) ||
        original.bytes.byteLength > 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(original.sha256) ||
        digest(original.bytes) !== original.sha256
      )
        deny();
      seen.add(file);
      const value = decodeAdmissionJson(
        new TextDecoder("utf-8", { fatal: true }).decode(original.bytes),
      );
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !==
          "enabledModules,lastAppInstallTime" ||
        !("enabledModules" in value) ||
        !Array.isArray(value.enabledModules) ||
        value.enabledModules.length !== 0 ||
        !("lastAppInstallTime" in value) ||
        typeof value.lastAppInstallTime !== "number" ||
        !Number.isSafeInteger(value.lastAppInstallTime) ||
        value.lastAppInstallTime < 0
      )
        deny();
    }
  } catch (error) {
    if (error instanceof ControlledStartupPolicyError) throw error;
    deny();
  }
}

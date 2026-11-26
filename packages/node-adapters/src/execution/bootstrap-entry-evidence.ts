import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import path from "node:path";
import { bootstrapProfileSemanticDigest } from "./bootstrap-profile-digest";
import {
  decodeAdmissionJson,
  validateOpaqueJsonObject,
} from "./admission-json";
import {
  matchesControlledFusionAutoload,
  matchesOwnedBootstrapAutoload,
} from "./fusion-bootstrap-autoload";

export interface BootstrapEntryExecutableReference {
  path: string;
  sha256: string;
}

export interface BootstrapEntryDataIntentV1 {
  kind: "fmcad-bootstrap-entry-intent";
  version: 1;
  nonce: string;
  process: { pid: number; birth: string };
  purpose: "bootstrap-entry-data-v1";
  engineVersion: 2;
  installed: {
    directory: string;
    source: string;
    files: Readonly<Record<string, string>>;
  };
  profile: { path: string; sha256: string };
  receipts: { directory: string; entry: string; returned: string };
}

/**
 * Transitional type for the v1-only controlled-host UI reader. It is retained
 * until that consumer moves to v2 and is never accepted by the data binder.
 */
export interface BootstrapEntryIsolatedStdoutIntentV1Legacy {
  kind: "fmcad-bootstrap-entry-intent";
  version: 1;
  nonce: string;
  process: { pid: number; birth: string };
  purpose: "isolated-stdout-v1";
  engineVersion: 2;
  installed: {
    directory: string;
    source: string;
    files: Readonly<Record<string, string>>;
  };
  profile: { path: string; sha256: string };
  receipts: { directory: string; entry: string; returned: string };
}

export interface BootstrapStartupAudit {
  readonly kind: "fmcad-startup-sdk-audit";
  readonly version: 1;
  readonly applicationVersion: string;
  readonly preferences: {
    readonly defaultPathForScriptsAndAddIns: string;
  };
  readonly scripts: {
    readonly countBefore: number;
    readonly countAfter: number;
    readonly items: readonly BootstrapStartupScript[];
  };
}

export interface BootstrapStartupScript {
  readonly index: number;
  readonly folder: string;
  readonly location: {
    readonly name: BootstrapScriptSourceLocation;
    readonly value: number;
  };
  readonly isAddIn: boolean;
  readonly isRunOnStartup: boolean | null;
  readonly isRunning: boolean;
  readonly isVisible: boolean;
  readonly manifest: {
    readonly content: string;
    readonly sha256: string;
    readonly parseStatus: "json-object";
  };
}

export type BootstrapScriptSourceLocation =
  | "AppStoreScriptSourceLocation"
  | "OtherInstalledScriptSourceLocation"
  | "UserDefinedScriptSourceLocation"
  | "InternalScriptSourceLocation"
  | "SamplesScriptSourceLocation"
  | "LinkedScriptSourceLocation";

export interface BootstrapEntryIntentV2 {
  kind: "fmcad-bootstrap-entry-intent";
  version: 2;
  nonce: string;
  process: { pid: number; birth: string };
  executable: BootstrapEntryExecutableReference;
  purpose: "isolated-stdout-v1";
  engineVersion: 2;
  installed: {
    directory: string;
    source: string;
    files: Readonly<Record<string, string>>;
  };
  profile: { path: string; sha256: string };
  receipts: { directory: string; entry: string; returned: string };
}

export interface BootstrapOwnedEntryIntentV3 extends Omit<
  BootstrapEntryIntentV2,
  "version" | "profile"
> {
  version: 3;
  mode: "owned-autoload-v1";
  provision: { path: string; sha256: string };
  generation: { instance: string; epoch: string };
  profile: { path: string; sha256: string; semanticSha256?: string };
}

/** Only v2 can bind controlled stdout; v1 forms remain refusal inputs. */
export type BootstrapEntryIntent =
  | BootstrapEntryDataIntentV1
  | BootstrapEntryIsolatedStdoutIntentV1Legacy
  | BootstrapEntryIntentV2;

export interface OriginalBootstrapBytes {
  /** Original native path, not a path of a subsequently copied evidence file. */
  nativePath: string;
  bytes: Uint8Array;
}
export interface BootstrapEntryOriginals {
  intent: OriginalBootstrapBytes;
  profile: OriginalBootstrapBytes;
  entry: OriginalBootstrapBytes;
  returned: OriginalBootstrapBytes;
}
export interface BootstrapOwnedEntryOriginals extends BootstrapEntryOriginals {
  provision: OriginalBootstrapBytes;
}
export interface BoundBootstrapEntryData {
  readonly kind: "bound-bootstrap-entry-data";
  readonly authority: "NONE";
  readonly nonce: string;
  readonly process: Readonly<{ pid: number; birth: string }>;
  readonly executable: Readonly<BootstrapEntryExecutableReference>;
  readonly entry: Readonly<{ path: string; sha256: string }>;
  readonly startupAudit: BootstrapStartupAudit;
  readonly references: readonly Readonly<{ path: string; sha256: string }>[];
}

const MAX_STARTUP_SCRIPTS = 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_STARTUP_AUDIT_BYTES = 4 * 1024 * 1024;

// Pinned ScriptSourceLocations values from the Autodesk Fusion API reference.
// https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/core_ScriptSourceLocations.htm
const SCRIPT_SOURCE_LOCATIONS = Object.freeze({
  AppStoreScriptSourceLocation: 0,
  OtherInstalledScriptSourceLocation: 1,
  UserDefinedScriptSourceLocation: 2,
  InternalScriptSourceLocation: 3,
  SamplesScriptSourceLocation: 4,
  LinkedScriptSourceLocation: 5,
} satisfies Readonly<Record<BootstrapScriptSourceLocation, number>>);

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
function asciiJson(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
function pythonOrder(a: string, b: string): number {
  const left = Array.from(a),
    right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference =
      (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
    if (difference) return difference;
  }
  return left.length - right.length;
}
/** Exact native request_admission._encode semantics for this string map. */
export function bootstrapInstalledFilesDigest(
  files: Readonly<Record<string, string>>,
): string {
  return sha(
    "{" +
      Object.keys(files)
        .sort(pythonOrder)
        .map((key) => asciiJson(key) + ":" + asciiJson(files[key] ?? ""))
        .join(",") +
      "}",
  );
}
function nativePath(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error("Invalid native evidence path");
  if (/^[A-Za-z]:[\\/]/.test(value))
    return path.win32.normalize(value).toLowerCase();
  if (path.posix.isAbsolute(value) && !value.startsWith("//"))
    return path.posix.normalize(value);
  throw new Error("Native evidence requires an absolute local path");
}
function canonicalNativePath(value: string): string {
  const normalized = nativePath(value);
  const canonical = /^[A-Za-z]:[\\/]/.test(value)
    ? path.win32.normalize(value)
    : path.posix.normalize(value);
  if (canonical !== value) throw new Error("Canonical native path required");
  return normalized;
}
function joinNative(directory: string, name: string): string {
  return /^[A-Za-z]:[\\/]/.test(directory)
    ? path.win32.join(directory, name)
    : path.posix.join(directory, name);
}
function outputName(name: string): boolean {
  return (
    /^[a-z0-9_-]+\.json$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.json$/.test(name)
  );
}
function keys(value: unknown, expected: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const names = expected.split(",").sort();
  return (
    actual.length === names.length &&
    actual.every((name, index) => name === names[index])
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function utf8(value: unknown, maximum: number): Buffer | null {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return null;
  }
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maximum ? bytes : null;
}
function auditEncodedBytes(value: unknown): number {
  // Native _encode uses compact json.dumps with ensure_ascii=True. The audit
  // schema contains only bounded integers, booleans, nulls and strings.
  const encoded = JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  return Buffer.byteLength(encoded, "ascii");
}
function frozenData<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>))
      frozenData(child);
    Object.freeze(value);
  }
  return value;
}
function validStartupAudit(value: unknown): value is BootstrapStartupAudit {
  if (
    !record(value) ||
    !keys(value, "applicationVersion,kind,preferences,scripts,version") ||
    value["kind"] !== "fmcad-startup-sdk-audit" ||
    value["version"] !== 1 ||
    !utf8(value["applicationVersion"], 65536) ||
    !record(value["preferences"]) ||
    !keys(value["preferences"], "defaultPathForScriptsAndAddIns") ||
    !record(value["scripts"]) ||
    !keys(value["scripts"], "countAfter,countBefore,items")
  )
    return false;
  const preferences = value["preferences"];
  const scripts = value["scripts"];
  const defaultPath = preferences["defaultPathForScriptsAndAddIns"];
  if (typeof defaultPath !== "string" || !utf8(defaultPath, 65536))
    return false;
  try {
    canonicalNativePath(defaultPath);
  } catch {
    return false;
  }
  const countBefore = scripts["countBefore"];
  const countAfter = scripts["countAfter"];
  const items = scripts["items"];
  if (
    typeof countBefore !== "number" ||
    !Number.isSafeInteger(countBefore) ||
    countBefore < 0 ||
    countBefore > MAX_STARTUP_SCRIPTS ||
    typeof countAfter !== "number" ||
    !Number.isSafeInteger(countAfter) ||
    countAfter !== countBefore ||
    !Array.isArray(items) ||
    items.length !== countBefore
  )
    return false;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (
      !record(item) ||
      !keys(
        item,
        "folder,index,isAddIn,isRunOnStartup,isRunning,isVisible,location,manifest",
      ) ||
      item["index"] !== index ||
      !Number.isSafeInteger(item["index"]) ||
      typeof item["isAddIn"] !== "boolean" ||
      typeof item["isRunning"] !== "boolean" ||
      typeof item["isVisible"] !== "boolean" ||
      (item["isAddIn"]
        ? typeof item["isRunOnStartup"] !== "boolean"
        : item["isRunOnStartup"] !== null) ||
      !record(item["location"]) ||
      !keys(item["location"], "name,value") ||
      typeof item["location"]["name"] !== "string" ||
      !Object.hasOwn(SCRIPT_SOURCE_LOCATIONS, item["location"]["name"]) ||
      item["location"]["value"] !==
        SCRIPT_SOURCE_LOCATIONS[
          item["location"]["name"] as BootstrapScriptSourceLocation
        ] ||
      !Number.isSafeInteger(item["location"]["value"]) ||
      !record(item["manifest"]) ||
      !keys(item["manifest"], "content,parseStatus,sha256") ||
      item["manifest"]["parseStatus"] !== "json-object" ||
      typeof item["manifest"]["sha256"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(item["manifest"]["sha256"])
    )
      return false;
    const folder = item["folder"];
    const manifest = item["manifest"];
    if (
      typeof folder !== "string" ||
      !utf8(folder, 65536) ||
      typeof manifest["content"] !== "string"
    )
      return false;
    try {
      canonicalNativePath(folder);
    } catch {
      return false;
    }
    const content = utf8(manifest["content"], MAX_MANIFEST_BYTES);
    if (!content || sha(content) !== manifest["sha256"]) return false;
    try {
      validateOpaqueJsonObject(
        new TextDecoder("utf-8", { fatal: true }).decode(content),
      );
    } catch {
      return false;
    }
  }
  try {
    return auditEncodedBytes(value) <= MAX_STARTUP_AUDIT_BYTES;
  } catch {
    return false;
  }
}

/**
 * Bind original bytes to the operator's expected native intent and phase order.
 * DATA ONLY: the caller must separately authenticate the references, controlled
 * launch and held ingress window. This never returns a host capability.
 */
export function bindBootstrapEntryEvidence(
  expected: BootstrapEntryIntent,
  originals: BootstrapEntryOriginals,
  installedForkEntry: string,
): BoundBootstrapEntryData | null {
  return bindEntryEvidence(expected, originals, installedForkEntry, false);
}

/** Separate v3 data binder. Manual v2 never accepts these startup bytes. */
export function bindOwnedBootstrapEntryEvidence(
  expected: BootstrapOwnedEntryIntentV3,
  originals: BootstrapOwnedEntryOriginals,
  installedForkEntry: string,
): BoundBootstrapEntryData | null {
  return bindEntryEvidence(expected, originals, installedForkEntry, true);
}

function bindEntryEvidence(
  expected: BootstrapEntryIntent | BootstrapOwnedEntryIntentV3,
  originals: BootstrapEntryOriginals | BootstrapOwnedEntryOriginals,
  installedForkEntry: string,
  owned: boolean,
): BoundBootstrapEntryData | null {
  try {
    expected = structuredClone(expected);
    const semanticProfile =
      owned &&
      expected.version === 3 &&
      Object.hasOwn(expected.profile, "semanticSha256");
    if (
      !keys(
        expected,
        owned
          ? "engineVersion,executable,generation,installed,kind,mode,nonce,process,profile,provision,purpose,receipts,version"
          : "engineVersion,executable,installed,kind,nonce,process,profile,purpose,receipts,version",
      ) ||
      expected.kind !== "fmcad-bootstrap-entry-intent" ||
      expected.version !== (owned ? 3 : 2) ||
      expected.purpose !== "isolated-stdout-v1" ||
      expected.engineVersion !== 2 ||
      !keys(expected.process, "birth,pid") ||
      !keys(expected.executable, "path,sha256") ||
      !keys(expected.installed, "directory,files,source") ||
      !keys(
        expected.profile,
        semanticProfile ? "path,sha256,semanticSha256" : "path,sha256",
      ) ||
      !keys(expected.receipts, "directory,entry,returned") ||
      !keys(
        originals,
        owned
          ? "entry,intent,profile,provision,returned"
          : "entry,intent,profile,returned",
      ) ||
      !/^[a-f0-9]{32}$/.test(expected.nonce) ||
      !Number.isSafeInteger(expected.process.pid) ||
      expected.process.pid <= 0 ||
      !utf8(expected.process.birth, 65536) ||
      !/^[a-f0-9]{40}$/.test(expected.installed.source) ||
      !/^[a-f0-9]{64}$/.test(expected.executable.sha256) ||
      !/^[a-f0-9]{64}$/.test(expected.profile.sha256) ||
      (semanticProfile &&
        (expected.version !== 3 ||
          typeof expected.profile.semanticSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(expected.profile.semanticSha256))) ||
      !outputName(expected.receipts.entry) ||
      !outputName(expected.receipts.returned) ||
      expected.receipts.entry === expected.receipts.returned ||
      !record(expected.installed.files) ||
      ![
        "AutodeskFusionMCP.py",
        "addon_runtime.py",
        "lib/bootstrap_entry.py",
      ].every((name) => Object.hasOwn(expected.installed.files, name)) ||
      Object.values(expected.installed.files).some(
        (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
      )
    )
      return null;
    const ownedIntent = expected.version === 3 ? expected : undefined;
    if (
      owned &&
      (!ownedIntent ||
        ownedIntent.mode !== "owned-autoload-v1" ||
        !keys(ownedIntent.provision, "path,sha256") ||
        !/^[a-f0-9]{64}$/.test(ownedIntent.provision.sha256) ||
        !keys(ownedIntent.generation, "epoch,instance") ||
        !utf8(ownedIntent.generation.instance, 65536) ||
        !utf8(ownedIntent.generation.epoch, 65536))
    )
      return null;
    canonicalNativePath(expected.executable.path);
    const copy = (original: OriginalBootstrapBytes) => ({
      nativePath: original.nativePath,
      bytes: Buffer.from(original.bytes),
    });
    const input = {
      intent: copy(originals.intent),
      profile: copy(originals.profile),
      entry: copy(originals.entry),
      returned: copy(originals.returned),
      ...(owned && "provision" in originals
        ? { provision: copy(originals.provision) }
        : {}),
    };
    if (
      new Set([
        ...Object.values(input).map((file) => nativePath(file.nativePath)),
        canonicalNativePath(expected.executable.path),
      ]).size !== (owned ? 6 : 5)
    )
      return null;
    const reference = (original: OriginalBootstrapBytes) => ({
      path: original.nativePath,
      sha256: sha(original.bytes),
    });
    const decode = (bytes: Uint8Array) =>
      decodeAdmissionJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    if (ownedIntent) {
      if (
        !input.provision ||
        nativePath(input.provision.nativePath) !==
          nativePath(ownedIntent.provision.path) ||
        sha(input.provision.bytes) !== ownedIntent.provision.sha256
      )
        return null;
      const provision = decode(input.provision.bytes);
      if (
        !record(provision) ||
        provision["pid"] !== ownedIntent.process.pid ||
        provision["birth"] !== ownedIntent.process.birth ||
        provision["instance"] !== ownedIntent.generation.instance ||
        provision["epoch"] !== ownedIntent.generation.epoch
      )
        return null;
    }
    if (
      !same(decode(input.intent.bytes), expected) ||
      nativePath(input.profile.nativePath) !==
        nativePath(expected.profile.path) ||
      (semanticProfile && ownedIntent
        ? bootstrapProfileSemanticDigest(input.profile.bytes) !==
          ownedIntent.profile.semanticSha256
        : sha(input.profile.bytes) !== expected.profile.sha256) ||
      !(
        owned ? matchesOwnedBootstrapAutoload : matchesControlledFusionAutoload
      )(input.profile.bytes, installedForkEntry) ||
      nativePath(input.entry.nativePath) !==
        nativePath(
          joinNative(expected.receipts.directory, expected.receipts.entry),
        ) ||
      nativePath(input.returned.nativePath) !==
        nativePath(
          joinNative(expected.receipts.directory, expected.receipts.returned),
        )
    )
      return null;
    const base = {
      kind: "fmcad-bootstrap-entry-receipt",
      version: owned ? 3 : 2,
      ...(ownedIntent
        ? {
            mode: ownedIntent.mode,
            provision: ownedIntent.provision,
            generation: ownedIntent.generation,
          }
        : {}),
      nonce: expected.nonce,
      process: expected.process,
      purpose: expected.purpose,
      engineVersion: 2,
      executable: expected.executable,
      intent: reference(input.intent),
      profile: expected.profile,
      installed: {
        directory: expected.installed.directory,
        source: expected.installed.source,
        filesDigest: bootstrapInstalledFilesDigest(expected.installed.files),
      },
    };
    const entry = decode(input.entry.bytes);
    const returned = decode(input.returned.bytes);
    const installed = (value: unknown) =>
      value && typeof value === "object" && "installed" in value
        ? (value as { installed: { directory: string } }).installed
        : undefined;
    if (
      nativePath(installed(entry)?.directory ?? "") !==
        nativePath(expected.installed.directory) ||
      nativePath(installed(returned)?.directory ?? "") !==
        nativePath(expected.installed.directory)
    )
      return null;
    const audit = record(entry) ? entry["startupAudit"] : undefined;
    if (!validStartupAudit(audit)) return null;
    // The native writer canonicalizes the installed directory with Path.
    const baseFor = (value: unknown) => ({
      ...base,
      installed: { ...base.installed, directory: installed(value)?.directory },
    });
    if (
      !same(entry, {
        ...baseFor(entry),
        phase: "entry-audited-before-addon-import",
        startupAudit: audit,
      }) ||
      !same(returned, {
        ...baseFor(returned),
        phase: "run-returned",
        entry: reference(input.entry),
      })
    )
      return null;
    return Object.freeze({
      kind: "bound-bootstrap-entry-data" as const,
      authority: "NONE" as const,
      nonce: expected.nonce,
      process: Object.freeze({ ...expected.process }),
      executable: Object.freeze({ ...expected.executable }),
      entry: Object.freeze(reference(input.entry)),
      startupAudit: frozenData(structuredClone(audit)),
      references: Object.freeze(
        // An explicit semantic profile is a fresh content witness, not an
        // immutable byte reference. Its original raw pin stays in the intent
        // and receipts; the private owned controller/rebound rechecks semantics.
        Object.entries(input)
          .filter(([name]) => !semanticProfile || name !== "profile")
          .map(([, original]) => Object.freeze(reference(original))),
      ),
    });
  } catch {
    return null;
  }
}

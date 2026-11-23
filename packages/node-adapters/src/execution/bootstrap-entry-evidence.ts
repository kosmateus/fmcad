import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import path from "node:path";
import { decodeAdmissionJson } from "./admission-json";
import { matchesControlledFusionAutoload } from "./fusion-bootstrap-autoload";

export interface BootstrapEntryIntent {
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
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === expected
  );
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
) {
  try {
    expected = structuredClone(expected);
    if (
      !keys(
        expected,
        "engineVersion,installed,kind,nonce,process,profile,purpose,receipts,version",
      ) ||
      !keys(expected.process, "birth,pid") ||
      !keys(expected.installed, "directory,files,source") ||
      !keys(expected.profile, "path,sha256") ||
      !keys(expected.receipts, "directory,entry,returned") ||
      !keys(originals, "entry,intent,profile,returned") ||
      expected.kind !== "fmcad-bootstrap-entry-intent" ||
      expected.version !== 1 ||
      expected.purpose !== "isolated-stdout-v1" ||
      expected.engineVersion !== 2 ||
      !/^[a-f0-9]{32}$/.test(expected.nonce) ||
      !Number.isSafeInteger(expected.process.pid) ||
      expected.process.pid <= 0 ||
      !expected.process.birth ||
      !/^[a-f0-9]{40}$/.test(expected.installed.source) ||
      !outputName(expected.receipts.entry) ||
      !outputName(expected.receipts.returned) ||
      expected.receipts.entry === expected.receipts.returned ||
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
    const copy = (original: OriginalBootstrapBytes) => ({
      nativePath: original.nativePath,
      bytes: Buffer.from(original.bytes),
    });
    const input = {
      intent: copy(originals.intent),
      profile: copy(originals.profile),
      entry: copy(originals.entry),
      returned: copy(originals.returned),
    };
    if (
      new Set(Object.values(input).map((file) => nativePath(file.nativePath)))
        .size !== 4
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
    if (
      !same(decode(input.intent.bytes), expected) ||
      nativePath(input.profile.nativePath) !==
        nativePath(expected.profile.path) ||
      sha(input.profile.bytes) !== expected.profile.sha256 ||
      !matchesControlledFusionAutoload(
        input.profile.bytes,
        installedForkEntry,
      ) ||
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
      version: 1,
      nonce: expected.nonce,
      process: expected.process,
      purpose: expected.purpose,
      engineVersion: 2,
      intent: reference(input.intent),
      profile: expected.profile,
      installed: {
        directory: expected.installed.directory,
        source: expected.installed.source,
        filesDigest: bootstrapInstalledFilesDigest(expected.installed.files),
      },
    };
    // Compare structured fields, never a receipt's self-reported success flag.
    const entry = decode(input.entry.bytes),
      returned = decode(input.returned.bytes);
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
    // The native writer canonicalizes the installed directory with Path.
    const baseFor = (value: unknown) => ({
      ...base,
      installed: { ...base.installed, directory: installed(value)?.directory },
    });
    if (
      !same(entry, { ...baseFor(entry), phase: "entry-before-addon-import" }) ||
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
      references: Object.freeze(
        Object.values(input).map((original) =>
          Object.freeze(reference(original)),
        ),
      ),
    });
  } catch {
    return null;
  }
}

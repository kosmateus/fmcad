import { createHash } from "node:crypto";
import path from "node:path";
import { decodeAdmissionJson } from "./admission-json";

type Entry = {
  name: string;
  path: string;
  location: number;
  isRemoved: boolean;
  isFavorite: boolean;
  runOnStartup: boolean;
};
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function refuse(): never {
  throw Object.assign(new Error("Fusion autoload registration is unproven"), {
    code: "FUSION_AUTOLOAD_UNPROVEN",
    notStarted: true,
  });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
function entryPath(value: string): string {
  if (!path.win32.isAbsolute(value) || value.includes("\0")) refuse();
  return path.win32.normalize(value).toLowerCase();
}
function registration(bytes: Uint8Array): Entry[] {
  let parsed: unknown;
  try {
    parsed = decodeAdmissionJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    refuse();
  }
  const record = object(parsed);
  if (
    Object.keys(record).join() !== "loadedScripts" ||
    !Array.isArray(record["loadedScripts"])
  )
    refuse();
  const paths = new Set<string>();
  return record["loadedScripts"].map((value: unknown) => {
    const row = object(value);
    if (
      Object.keys(row).sort().join() !==
        "isFavorite,isRemoved,location,name,path,runOnStartup" ||
      typeof row["name"] !== "string" ||
      !row["name"] ||
      typeof row["path"] !== "string" ||
      !row["path"] ||
      row["path"].includes("\0") ||
      !Number.isSafeInteger(row["location"]) ||
      typeof row["isRemoved"] !== "boolean" ||
      typeof row["isFavorite"] !== "boolean" ||
      typeof row["runOnStartup"] !== "boolean"
    )
      refuse();
    // Vendor entries use documented-in-profile symbolic paths. Preserve them,
    // but never enable one as the controlled, absolute fork entry.
    const key = path.win32.isAbsolute(row["path"])
      ? entryPath(row["path"])
      : row["path"].replaceAll("\\", "/").toLowerCase();
    if (paths.has(key)) refuse();
    paths.add(key);
    return { ...row } as Entry;
  });
}

/**
 * Disable every startup entry in the actual Fusion registration, not just
 * the add-in manifest:
 * JSLoadedScriptsinfo can override manifest.runOnStartup.
 *
 * This is a byte-bound operator plan, NOT a clean-process proof or permission
 * to write the live profile. Applying it requires the supported stopped-process
 * boundary. The selected fork is started explicitly only after native process
 * rebinding. A trusted launcher must separately fence discovery roots, installed
 * source bytes, process birth and the entire pre-entry admission window.
 */
export function planControlledFusionAutoload(
  original: Uint8Array,
  installedForkEntry: string,
) {
  const expected = entryPath(installedForkEntry);
  const rows = registration(original);
  const matches = rows.filter(
    (row) =>
      path.win32.isAbsolute(row.path) && entryPath(row.path) === expected,
  );
  const match = matches[0];
  if (matches.length !== 1 || !match || match.isRemoved) refuse();
  const planned = rows.map((row) => ({
    ...row,
    runOnStartup: false,
  }));
  const bytes = Buffer.from(
    JSON.stringify({ loadedScripts: planned }, null, 2) + "\n",
  );
  return Object.freeze({
    kind: "controlled-fusion-autoload-plan-v1" as const,
    authority: "NONE" as const,
    forkStart: "explicit-after-native-rebind" as const,
    originalSha256: digest(original),
    plannedSha256: digest(bytes),
    installedForkEntry: match.path,
    registrationBytes() {
      return Buffer.from(bytes);
    },
  });
}

/** Data validation only; neither a copied plan nor this result grants authority. */
export function matchesControlledFusionAutoload(
  actual: Uint8Array,
  installedForkEntry: string,
): boolean {
  const expected = entryPath(installedForkEntry);
  const rows = registration(actual);
  let found = 0;
  for (const row of rows) {
    if (row.runOnStartup) return false;
    if (path.win32.isAbsolute(row.path) && entryPath(row.path) === expected) {
      if (row.isRemoved) return false;
      found++;
    }
  }
  return found === 1;
}

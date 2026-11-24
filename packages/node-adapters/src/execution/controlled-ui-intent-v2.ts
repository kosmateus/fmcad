import { decodeAdmissionJson } from "./admission-json";
import type { ControlledProcess } from "./controlled-fusion-launch-types";

/** Frozen .17 audited-startup schema; no v1 isolated-stdout fallback.
 * Kept UI-local until the independently owned receipt reader lands.
 */
export interface ControlledUiEntryIntentV2 {
  readonly kind: "fmcad-bootstrap-entry-intent";
  readonly version: 2;
  readonly nonce: string;
  readonly process: ControlledProcess;
  readonly executable: { readonly path: string; readonly sha256: string };
  readonly purpose: "isolated-stdout-v1";
  readonly engineVersion: 2;
  readonly installed: {
    readonly directory: string;
    readonly source: string;
    readonly files: Readonly<Record<string, string>>;
  };
  readonly profile: { readonly path: string; readonly sha256: string };
  readonly receipts: {
    readonly directory: string;
    readonly entry: string;
    readonly returned: string;
  };
}

export function readControlledUiEntryIntentV2(
  raw: string,
): ControlledUiEntryIntentV2 {
  const v = decodeAdmissionJson(raw) as ControlledUiEntryIntentV2;
  const closed = (x: unknown, keys: string) =>
    x !== null &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    Object.keys(x).sort().join() === keys;
  if (
    !closed(
      v,
      "engineVersion,executable,installed,kind,nonce,process,profile,purpose,receipts,version",
    ) ||
    v.kind !== "fmcad-bootstrap-entry-intent" ||
    v.version !== 2 ||
    v.engineVersion !== 2 ||
    v.purpose !== "isolated-stdout-v1" ||
    typeof v.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(v.nonce) ||
    !closed(v.process, "birth,pid") ||
    !Number.isSafeInteger(v.process.pid) ||
    v.process.pid < 1 ||
    typeof v.process.birth !== "string" ||
    !/^[1-9][0-9]*$/.test(v.process.birth) ||
    !closed(v.executable, "path,sha256") ||
    typeof v.executable.path !== "string" ||
    typeof v.executable.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.executable.sha256) ||
    !closed(v.installed, "directory,files,source") ||
    typeof v.installed.directory !== "string" ||
    typeof v.installed.source !== "string" ||
    !/^[a-f0-9]{40}$/.test(v.installed.source) ||
    !v.installed.files ||
    typeof v.installed.files !== "object" ||
    Array.isArray(v.installed.files) ||
    Object.values(v.installed.files).some(
      (h) => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h),
    ) ||
    !closed(v.profile, "path,sha256") ||
    typeof v.profile.path !== "string" ||
    typeof v.profile.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.profile.sha256) ||
    !closed(v.receipts, "directory,entry,returned") ||
    Object.values(v.receipts).some((s) => typeof s !== "string")
  )
    throw new Error("Closed audited isolated-stdout UI intent v2 required");
  return v;
}

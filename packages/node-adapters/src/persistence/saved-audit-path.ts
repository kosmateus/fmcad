import path from "node:path";
import { createHash } from "node:crypto";
import { detectPlatform, toWindowsPath } from "../config-platform/platform";
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const fusionPath = (value: string): string =>
  toWindowsPath(value, detectPlatform());

export function savedAuditKind(prefix: string, requestId: string) {
  if (
    !["dp-", "sp-", "sr-"].includes(prefix) ||
    typeof requestId !== "string" ||
    !requestId.trim() ||
    requestId.length > 180
  )
    throw Object.assign(
      new Error("Exact saved audit purpose and request ID required"),
      { code: "INVALID_REQUEST" },
    );
  // Only the directory locator is shortened. Full request IDs/binding hashes
  // remain authoritative; a prefix collision fails the immutable intent key check.
  return prefix + hash(requestId).slice(0, 16);
}

export function savedAuditLegacyKind(prefix: string, requestId: string) {
  savedAuditKind(prefix, requestId); // Same strict input validation.
  return prefix + hash(requestId);
}

export function assertSavedAuditPathBudget(directory: string) {
  const receipt = path.join(
    directory,
    "remote-00000000-0000-0000-0000-000000000000.json",
  );
  const native =
    receipt.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(receipt)
      ? receipt
      : fusionPath(receipt);
  const atomicTempLength = native.length + 41; // Existing .<uuid>.tmp writer, unchanged.
  if (
    (native.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(native)) &&
    atomicTempLength > 259
  )
    throw Object.assign(
      new Error(
        "Saved audit receipt atomic temporary path exceeds Windows MAX_PATH; no SDK request submitted",
      ),
      {
        code: "SAVED_AUDIT_PATH_TOO_LONG",
        nativeReceiptLength: native.length,
        atomicTempLength,
      },
    );
  return { nativeReceiptLength: native.length, atomicTempLength };
}

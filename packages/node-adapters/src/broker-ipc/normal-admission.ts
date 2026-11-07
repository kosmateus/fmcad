import * as fs from "node:fs";
import path from "node:path";

export type AdmissionMode = "isolated-one-anchor" | "normal-multidocument";
/** A released normal queue uses the existing ordinary startup verification for
 * a new runtime. The immutable recovery close proof is checked first; it never
 * authorizes takeover of a dead process or rewriting quarantined jobs. */
export function epochStartupPinned(
  state: {
    readonly epoch: unknown;
    readonly admissionMode: string;
    readonly data: {
      readonly active?: unknown;
      readonly blocked?: unknown;
      readonly lease?: unknown;
      readonly localUnknown?: unknown;
      readonly controlBlocked?: unknown;
      readonly jobs: Readonly<Record<string, { readonly state: string }>>;
    };
    assertEpoch(normal: boolean): void;
  },
  previousBuild: unknown,
  currentBuild: string,
): boolean {
  if (!state.epoch) return false;
  if (
    state.admissionMode === "normal-multidocument" &&
    typeof previousBuild === "string" &&
    previousBuild !== currentBuild
  ) {
    state.assertEpoch(true);
    // This is the current store only. The retired history remains immutable,
    // not a reason to replay it or to discard a live current operation.
    const current = state.data;
    if (
      current.active ||
      current.blocked ||
      current.lease ||
      current.localUnknown ||
      current.controlBlocked ||
      Object.values(current.jobs).some(
        (job) =>
          !["succeeded", "failed", "cancelled", "expired"].includes(job.state),
      )
    ) {
      fail(
        "EPOCH_BUSY",
        "A runtime change requires known settled current work and no sequence or uncertain operation",
      );
    }
    return false;
  }
  return true;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** The original owner-selected close intent is the only release authority. */
export function validateCloseMode(
  mode: unknown,
  restoreRecorded: boolean,
): void {
  if (mode !== undefined && mode !== "normal-multidocument")
    fail(
      "INVALID_REQUEST",
      "Only explicit normal-multidocument admission after proven cleanup is supported",
    );
  if (mode && !restoreRecorded)
    fail(
      "EPOCH_CLOSE_UNPROVEN",
      "Ordinary admission requires the original captured active-document restore identity",
    );
}
export function closeModeFields(binding: {
  readonly admissionMode?: unknown;
}): { admissionMode?: "normal-multidocument" } {
  if (binding.admissionMode === undefined) return {};
  validateCloseMode(binding.admissionMode, true);
  return { admissionMode: "normal-multidocument" };
}
export function verifyCloseMode(
  closed: { readonly admissionMode?: unknown },
  binding: unknown,
  restoreRecorded: boolean,
  retained: boolean,
): void {
  if (
    closed.admissionMode !== undefined &&
    (closed.admissionMode !== "normal-multidocument" ||
      retained ||
      !restoreRecorded ||
      !record(binding) ||
      binding["admissionMode"] !== closed.admissionMode)
  )
    fail(
      "EPOCH_CLOSE_UNPROVEN",
      "Ordinary admission requires the original explicit owner close intent",
    );
}
export function readAdmissionMode(
  epochRoot: string | undefined,
  read: (file: string) => unknown,
  verify: (file: string) => void,
): AdmissionMode {
  if (!epochRoot) return "isolated-one-anchor";
  const file = path.join(epochRoot, "closed.json");
  if (!fs.existsSync(file)) return "isolated-one-anchor";
  const closed = read(file);
  if (!record(closed) || closed["admissionMode"] !== "normal-multidocument")
    return "isolated-one-anchor";
  verify(file);
  return "normal-multidocument";
}
export function verifyRepeatedClose(
  intentFile: string,
  mode: unknown,
  read: (file: string) => unknown,
): void {
  if (!fs.existsSync(intentFile)) return;
  const intent = read(intentFile);
  if (
    !record(intent) ||
    !record(intent["binding"]) ||
    (intent["binding"]["admissionMode"] ?? null) !== (mode ?? null)
  )
    fail(
      "REQUEST_CONFLICT",
      "The original close intent cannot change its admission disposition",
    );
}

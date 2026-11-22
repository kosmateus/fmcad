import path from "node:path";
import { decodeAdmissionJson } from "../execution/admission-json";

const rootInputs = [
  "physical-backend-head.json",
  "isolated-admission-epoch.json",
  "instance.json",
  "queue-state.json",
  "queue-state.pending.json",
  "runtime-rebaseline-head.json",
] as const;
const epochInputs = [
  "instance.json",
  "queue-state.json",
  "queue-state.pending.json",
] as const;

/** Pure shared literal-head layout. The pointer supplies only a validated epoch
 * identity, never arbitrary filenames or a caller-selected filesystem root. */
export function runtimeRebaselineManifestNames(
  store: string,
  pointer: Buffer | null,
): string[] {
  if (!pointer) return [...rootInputs];
  const value: unknown = decodeAdmissionJson(
    new TextDecoder("utf-8", { fatal: true }).decode(pointer),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid literal runtime epoch identity");
  const epoch = value as Record<string, unknown>;
  if (
    typeof epoch["epochId"] !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(epoch["epochId"]) ||
    epoch["root"] !== path.join(store, "admission-epochs", epoch["epochId"])
  )
    throw new Error("Invalid literal runtime epoch identity");
  return [
    ...rootInputs,
    ...epochInputs.map((name) =>
      path.join("admission-epochs", epoch["epochId"] as string, name),
    ),
  ];
}

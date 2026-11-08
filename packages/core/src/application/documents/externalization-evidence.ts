import { hash } from "./json";
import { slot, phaseOrder } from "./externalization";
import type {
  ExternalizationResult,
  ExternalizationRecord,
  ExternalizationState,
  ExternalizationStored,
  ExternalizationItem,
  ExternalizationEntry,
} from "./externalization";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label);
  return value as Record<string, unknown>;
}
function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function restoreKnownPendingEvidence(
  result: ExternalizationResult,
  records: ExternalizationRecord[],
): void {
  const pending = result.pending;
  if (!pending) return;
  const current = slot(result.byItem[pending.itemId]!, pending.phase);
  if (current?.status !== "unknown") return;
  for (let index = records.length - 1; index >= 0; index--) {
    const priorResult = records[index]!.result;
    if (
      priorResult?.pending?.itemId !== pending.itemId ||
      priorResult.pending.phase !== pending.phase
    )
      continue;
    const priorItem = priorResult.byItem?.[pending.itemId];
    const prior = slot(priorItem!, pending.phase);
    if (prior?.status !== "pending" || !Array.isArray(prior.receipt?.checks))
      continue;
    current.receipt = {
      ...prior.receipt,
      ...(current.receipt ?? {}),
      checks: current.receipt?.checks ?? prior.receipt.checks,
    };
    return;
  }
}
export function preserveKnownCursor(
  state: ExternalizationState,
  output: ExternalizationState,
): void {
  const previous = state.receipt?.cursor,
    current = output.receipt?.cursor;
  if (
    ["blocked", "pending"].includes(output.status) &&
    (output["notStarted"] === true ||
      output.receipt?.["notStarted"] === true) &&
    Number.isSafeInteger(previous) &&
    Number.isSafeInteger(current) &&
    current! < previous!
  )
    output.receipt = { ...output.receipt, cursor: previous! };
}
export function restoreBlockedCheckpoints(
  result: ExternalizationResult,
  records: ExternalizationRecord[],
): void {
  for (const [itemId, item] of Object.entries(result.byItem ?? {}))
    for (const phase of phaseOrder) {
      const state = slot(item, phase);
      if (
        !state ||
        state.status !== "blocked" ||
        state.receipt?.["notStarted"] !== true
      )
        continue;
      const cursor = state.receipt.cursor;
      if (!Number.isSafeInteger(cursor)) continue;
      for (let index = records.length - 1; index >= 0; index--) {
        const prior = records[index]!.result;
        const priorState = slot(
          prior?.byItem?.[itemId] ?? ({} as ExternalizationEntry),
          phase,
        );
        if (
          !["pending", "complete"].includes(priorState.status) ||
          !Number.isSafeInteger(priorState.receipt?.cursor) ||
          priorState.receipt!.cursor! <= cursor!
        )
          continue;
        const checks = new Map();
        for (const check of [
          ...(priorState.receipt!.checks ?? []),
          ...(state.receipt.checks ?? []),
        ])
          checks.set(check.checkId, check);
        state.receipt = {
          ...priorState.receipt,
          ...state.receipt,
          cursor: priorState.receipt!.cursor!,
          ...(checks.size ? { checks: [...checks.values()] } : {}),
        };
        break;
      }
    }
}
/** Reconstruct the original copy intent, including its nonce and exact version. */
export function copyIntent(
  stored: ExternalizationStored,
  item: ExternalizationItem,
  state: ExternalizationState,
  result: ExternalizationResult,
): unknown {
  if (stored["copyProtocol"] !== 1 || item["dataFileId"]) return undefined;
  const cursor = state.receipt?.cursor ?? 0;
  const manifest = object(
    stored.manifest,
    "Missing immutable externalization manifest",
  );
  const groups = manifest["extractionGroups"];
  const group =
    item["groupId"] && Array.isArray(groups)
      ? groups
          .map((value) => object(value, "Invalid extraction group"))
          .find((g) => g["id"] === item["groupId"])
      : undefined;
  const members = group?.["members"];
  const purpose =
    cursor === 0
      ? group
        ? "groupParent"
        : "component"
      : group && Array.isArray(members) && cursor === members.length + 5
        ? "groupChild"
        : null;
  if (!purpose) return undefined;
  let source = clone(
      object(manifest["source"], "Missing original copy source"),
    ),
    component = item["selection"];
  for (const row of Object.values(result.byItem)) {
    const published = optionalObject(
      row.phaseResults.finalize.receipt?.["file"],
    );
    if (published?.["fileId"] === source["fileId"])
      source["version"] = Math.max(
        Number(source["version"]),
        Number(published?.["version"]),
      );
  }
  if (purpose === "groupParent") component = { parentOf: clone(members) };
  if (purpose === "groupChild") {
    if (!state.receipt?.["stagingSource"] || !state.receipt["stagingComponent"])
      throw new Error("Missing exact staged group source receipt");
    source = clone(
      object(
        state.receipt["stagingSource"],
        "Missing exact staged group source receipt",
      ),
    );
    component = clone(state.receipt["stagingComponent"]);
  }
  const destination = {
    ...object(item["destination"], "Missing copy destination"),
    ...(purpose === "groupParent"
      ? {
          fileName:
            String(
              object(item["destination"], "Missing copy destination")[
                "fileName"
              ],
            ) +
            "__" +
            stored.operationId +
            "__staging",
        }
      : {}),
  };
  const binding = {
    operationId: stored.operationId,
    itemId: item.itemId,
    purpose,
    source,
    component,
    destination,
  };
  const nonce = hash({
    sessionNonce: stored.sessionNonce,
    requestHash: stored.requestHash,
    ...binding,
  });
  const finalDescription =
    purpose === "component"
      ? "Native externalization " + stored.operationId
      : purpose === "groupParent"
        ? "Isolated native group staging"
        : "Native extraction group";
  return {
    ...binding,
    nonce,
    finalDescription,
    description: finalDescription + " [fmcad-copy:" + nonce + "]",
  };
}

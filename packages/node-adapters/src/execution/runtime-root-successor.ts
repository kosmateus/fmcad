import type { PhysicalGenerationDescriptor } from "./physical-generation";
import { isDeepStrictEqual as same } from "node:util";
import { NativeRuntimeBarrierError } from "./runtime-rebaseline-native";

export type RuntimeRootPhysicalPins = Pick<
  PhysicalGenerationDescriptor,
  "handoffId" | "generation" | "physicalRuntime" | "endpointURL"
>;
export interface RuntimeRootSuccessionContext {
  requestId: string;
  admissionStore: string;
  originalRuntime: RuntimeRootPhysicalPins;
  currentRuntime: RuntimeRootPhysicalPins;
}

/** Structural validation only, never authority. The reader must authenticate the
 * original MAC and receive this evidence through its guarded native QUERY. */
export function validateNativeRootSuccession(
  value: unknown,
  context: RuntimeRootSuccessionContext,
): boolean {
  function deny(): never {
    throw new NativeRuntimeBarrierError("RUNTIME_BARRIER_CHANGED");
  }
  const record = (input: unknown, keys: string): Record<string, unknown> => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== keys.split(",").sort().join(",")
    )
      deny();
    return input as Record<string, unknown>;
  };
  const text = (input: unknown): input is string =>
    typeof input === "string" && input.length > 0;
  const generation = (input: unknown) => {
    const v = record(input, "instance,epoch");
    if (!text(v["instance"]) || !text(v["epoch"])) deny();
    return { instance: v["instance"], epoch: v["epoch"] };
  };
  const from = generation(context.originalRuntime.generation);
  const to = generation(context.currentRuntime.generation);
  if (same(from, to)) {
    if (
      !same(context.originalRuntime, context.currentRuntime) ||
      (value !== null && value !== undefined)
    )
      deny();
    return false;
  }
  // This bridge covers broker-owner transitions in the same physical runtime.
  // A Fusion process/source change needs its own authenticated runtime bridge.
  if (
    !same(
      context.originalRuntime.physicalRuntime,
      context.currentRuntime.physicalRuntime,
    ) ||
    context.originalRuntime.endpointURL !== context.currentRuntime.endpointURL
  )
    deny();
  const evidence = record(
    value,
    "kind,version,requestId,retirement,handoffs,currentRuntime,database",
  );
  if (
    evidence["kind"] !== "fmcad-runtime-root-successor-v1" ||
    evidence["version"] !== 1 ||
    evidence["requestId"] !== context.requestId ||
    !same(evidence["currentRuntime"], context.currentRuntime)
  )
    deny();
  const database = record(evidence["database"], "path,device,inode");
  if (
    database["path"] !== context.admissionStore ||
    !["device", "inode"].every(
      (key) =>
        typeof database[key] === "string" &&
        /^(0|[1-9][0-9]*)$/.test(database[key]),
    )
  )
    deny();
  const retirement = record(evidence["retirement"], "handoffId,nextGeneration");
  if (!text(retirement["handoffId"])) deny();
  const retiredNext = generation(retirement["nextGeneration"]);
  const links = evidence["handoffs"];
  if (!Array.isArray(links) || links.length === 0) deny();
  let current = from;
  const visited = new Set([JSON.stringify(from)]);
  const ids = new Set([context.originalRuntime.handoffId]);
  let lastId: string | undefined;
  for (const [index, raw] of links.entries()) {
    const link = record(raw, "handoffId,generation,nextGeneration,state");
    if (
      link["state"] !== "committed" ||
      !text(link["handoffId"]) ||
      ids.has(link["handoffId"]) ||
      !same(generation(link["generation"]), current)
    )
      deny();
    const next = generation(link["nextGeneration"]),
      key = JSON.stringify(next);
    if (
      visited.has(key) ||
      (index === 0 &&
        (link["handoffId"] !== retirement["handoffId"] ||
          !same(next, retiredNext)))
    )
      deny();
    ids.add(link["handoffId"]);
    visited.add(key);
    current = next;
    lastId = link["handoffId"];
  }
  if (!same(current, to) || lastId !== context.currentRuntime.handoffId) deny();
  return true;
}

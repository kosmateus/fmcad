import { createRequire } from "node:module";

export interface ProcessIdentity {
  pid: number;
  birth: string;
  version: string;
}
export type ProcessObserver = (instance: ProcessIdentity) => boolean | null;
const load = createRequire(__filename);
const { priorProcessAlive, sameInstance } = load("./queue-instance") as {
  priorProcessAlive: ProcessObserver;
  sameInstance(a: ProcessIdentity, b: ProcessIdentity): boolean;
};
export const processTuple = (value: ProcessIdentity): ProcessIdentity => ({
  pid: value.pid,
  birth: value.birth,
  version: value.version,
});
export function requireInstanceProcess(
  instance: ProcessIdentity,
  expected = "live",
  observe: ProcessObserver = priorProcessAlive,
  label = "Original Fusion",
) {
  if (!["live", "terminated"].includes(expected))
    throw Object.assign(new Error("Unknown process expectation"), {
      code: "INVALID_INSTANCE_EXPECTATION",
    });
  const live = observe(instance);
  if (live !== true && live !== false)
    throw Object.assign(
      new Error(label + " PID/birth liveness could not be established"),
      { code: "INSTANCE_LIVENESS_UNAVAILABLE" },
    );
  if (live !== (expected === "live"))
    throw Object.assign(
      new Error(
        expected === "live"
          ? label + " PID/birth is not live"
          : label + " process is not proven terminated",
      ),
      { code: "INSTANCE_CHANGED" },
    );
  return {
    ...processTuple(instance),
    live,
    observedAt: new Date().toISOString(),
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function processIdentity(value: unknown): value is ProcessIdentity {
  return (
    object(value) &&
    typeof value["pid"] === "number" &&
    typeof value["birth"] === "string" &&
    typeof value["version"] === "string"
  );
}
export function processLossAudit(upgrade: unknown): boolean {
  return (
    object(upgrade) &&
    typeof upgrade["purpose"] === "string" &&
    [
      "atomic-recovery-process-loss-audit-upgrade-v1",
      "isolated-scratch-epoch-upgrade-v1",
      "atomic-audit-facts-recovery-upgrade-v1",
    ].includes(upgrade["purpose"])
  );
}
export function requireRecoveryProcesses(
  original: ProcessIdentity,
  upgrade: unknown,
  observe: ProcessObserver = priorProcessAlive,
) {
  const lost = processLossAudit(upgrade);
  const historical = requireInstanceProcess(
    original,
    lost ? "terminated" : "live",
    observe,
  );
  let current = null;
  if (lost) {
    const selected = object(upgrade) ? upgrade["currentInstance"] : undefined;
    if (!processIdentity(selected))
      throw Object.assign(
        new Error(
          "Selected current Fusion PID/birth liveness could not be established",
        ),
        { code: "INSTANCE_LIVENESS_UNAVAILABLE" },
      );
    if (sameInstance(original, selected))
      throw Object.assign(
        new Error(
          "A process-loss audit cannot relabel the original instance as current",
        ),
        { code: "INSTANCE_CHANGED" },
      );
    current = requireInstanceProcess(
      selected,
      "live",
      observe,
      "Selected current Fusion",
    );
  }
  return {
    historical,
    current,
    historicalOutcome: "unknown",
    endpointVerified: false,
  };
}

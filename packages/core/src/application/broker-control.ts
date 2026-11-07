/** Shared CLI/MCP/web control contract. No action is retried after an unknown ACK. */
export type BrokerAction =
  | "inspect"
  | "start"
  | "stop"
  | "pause"
  | "drain"
  | "resume"
  | "reload"
  | "reset";

export interface BrokerControlFence {
  requestId: string;
  instanceId: string;
  expectedGeneration: number;
}

export interface BrokerControlSnapshot {
  protocol: number;
  instanceId: string;
  generation: number;
  phase: string;
  buildHash: string;
  activeOperations: number;
  unresolved: boolean;
  gateClosed: boolean;
  capabilities: Partial<Record<BrokerAction | "restart", boolean>>;
}

export interface BrokerControlPort {
  read(): Promise<BrokerControlSnapshot>;
  execute(action: BrokerAction, fence: BrokerControlFence): Promise<unknown>;
}

export function isBrokerControlSnapshot(
  value: unknown,
): value is BrokerControlSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record["protocol"] === 1 &&
    ["instanceId", "buildHash", "phase"].every(
      (key) => typeof record[key] === "string" && record[key].length > 0,
    ) &&
    ["generation", "activeOperations"].every(
      (key) => Number.isSafeInteger(record[key]) && Number(record[key]) >= 0,
    ) &&
    typeof record["unresolved"] === "boolean" &&
    typeof record["gateClosed"] === "boolean" &&
    !!record["capabilities"] &&
    typeof record["capabilities"] === "object" &&
    !Array.isArray(record["capabilities"]) &&
    Object.values(record["capabilities"]).every(
      (flag) => typeof flag === "boolean",
    )
  );
}

function deny(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function validateBrokerFence(value: BrokerControlFence): void {
  if (
    !value ||
    !["requestId", "instanceId", "expectedGeneration"].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    ![value.requestId, value.instanceId].every(
      (id) =>
        typeof id === "string" && id.trim().length > 0 && id.length <= 256,
    ) ||
    !Number.isSafeInteger(value.expectedGeneration) ||
    value.expectedGeneration < 0
  )
    deny(
      "INVALID_REQUEST",
      "Control requires requestId, instanceId and generation",
    );
}

/** The caller owns request IDs and must observe the original receipt on failure. */
export function createBrokerControl(port: BrokerControlPort) {
  return {
    read: () => port.read(),
    async execute(action: BrokerAction, fence: BrokerControlFence) {
      validateBrokerFence(fence);
      const intent = { ...fence };
      const before = await port.read();
      if (before.protocol !== 1 || before.capabilities[action] !== true)
        deny("UNSUPPORTED_BROKER", "The broker does not implement this action");
      if (before.instanceId !== intent.instanceId)
        deny("INSTANCE_CHANGED", "Read the current broker instance");
      if (before.generation !== intent.expectedGeneration)
        deny("STATE_CONFLICT", "Read the current control generation");
      if (action === "start" && before.phase !== "STOPPED")
        deny(
          "BROKER_ALREADY_RUNNING",
          "Start cannot resume or replace a running broker",
        );
      if (
        ["stop", "reload", "reset"].includes(action) &&
        (before.unresolved || before.activeOperations !== 0)
      )
        deny(
          "RECONCILIATION_REQUIRED",
          "Active or unresolved ownership must settle",
        );
      // Server repeats these fences atomically. This read is not authorization.
      return port.execute(action, intent);
    },
  };
}

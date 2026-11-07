import { isBrokerControlSnapshot } from "@fmcad/core";
import type {
  BrokerAction,
  BrokerControlFence,
  BrokerControlPort,
  BrokerControlSnapshot,
} from "@fmcad/core";

export interface BrokerControlClient {
  call(
    action: string,
    values?: { control: BrokerControlFence },
  ): Promise<unknown>;
}

/** Authentication and the queue directory belong to the injected IPC client. */
export function createBrokerControlPort(
  client: BrokerControlClient,
  local: {
    start?(fence: BrokerControlFence): Promise<unknown>;
    reset?(fence: BrokerControlFence): Promise<unknown>;
    stopped?(): Promise<BrokerControlSnapshot>;
  } = {},
): BrokerControlPort {
  return {
    async read() {
      let snapshot: BrokerControlSnapshot;
      try {
        const response = await client.call("control-status");
        if (!isBrokerControlSnapshot(response))
          throw Object.assign(new Error("Invalid broker control snapshot"), {
            code: "UNSUPPORTED_BROKER",
          });
        snapshot = response;
      } catch (error) {
        if (
          !local.stopped ||
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          !["ENOENT", "ECONNREFUSED", "QUEUE_NOT_RUNNING"].includes(
            String(error.code),
          )
        )
          throw error;
        snapshot = await local.stopped();
      }
      return {
        ...snapshot,
        capabilities: {
          ...snapshot.capabilities,
          start: !!local.start && snapshot.phase === "STOPPED",
          reset: !!local.reset,
        },
      };
    },
    execute(action: BrokerAction, fence: BrokerControlFence) {
      if (action === "start" && local.start) return local.start(fence);
      // Fusion reset is a separate, explicit application use case. Never an
      // alias for restarting a broker, nor a physical endpoint on this client.
      if (action === "reset" && local.reset) return local.reset(fence);
      if (action === "start" || action === "reset")
        throw Object.assign(
          new Error("Explicit local operation is unavailable"),
          {
            code: "UNSUPPORTED_BROKER",
          },
        );
      const actions = {
        inspect: "console-inspect",
        stop: "console-stop",
        pause: "pause",
        drain: "drain",
        resume: "resume",
        reload: "console-reload",
      } as const;
      return client.call(actions[action], { control: fence });
    },
  };
}

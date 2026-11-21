import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type {
  ServiceConfiguration,
  ServiceOptions,
} from "./library-console-services";
import type {
  SystemControlQueueClient,
  SystemControlRuntimeOptions,
} from "../../packages/node-adapters/src/control-center/system-controls";
const load = createRequire(__filename);
const { QueueClient } = load(
  "../../queue-client",
) as typeof import("../queue-client");
const { BrokerObservation } = load(
  "../node-adapters/control-center/broker-observation",
) as {
  BrokerObservation: new (
    factory: () => SystemControlQueueClient,
  ) => ServiceOptions["control"];
};
const { createServices } = load(
  "../../console-services",
) as typeof import("./library-console-services");
const { buildHash } = load("../../queue-instance") as { buildHash(): string };
const { createControlCenterSystemControls } = load(
  "../node-adapters/control-center/system-controls",
) as typeof import("../../packages/node-adapters/src/control-center/system-controls");

function controlClientId(): string {
  const identity = `${os.hostname()}\0${os.userInfo().username}`;
  return (
    "control-center:" + createHash("sha256").update(identity).digest("hex")
  );
}

/** Reuses the existing idle-only, start-paused lifecycle service. */
export function createControlCenterSystemControlsRuntime(
  cfg: ServiceConfiguration | undefined,
  registeredProjectIds: (() => readonly string[]) | undefined,
): ReturnType<typeof createControlCenterSystemControls> {
  if (cfg?.routing !== "queue") {
    throw Object.assign(
      new Error("System controls require the configured queue routing backend"),
      { code: "UNSUPPORTED_ROUTING" },
    );
  }
  if (typeof registeredProjectIds !== "function") {
    throw Object.assign(
      new Error(
        "Registered project identities are required for scoped controls",
      ),
      { code: "PRINCIPAL_UNAVAILABLE" },
    );
  }
  let startService: ReturnType<typeof createServices> | null = null;
  let startServiceClient: SystemControlQueueClient | null = null;
  const startStopped: SystemControlRuntimeOptions["startStopped"] =
    cfg.routing === "queue"
      ? (_fence, client) => {
          if (!startService || startServiceClient !== client) {
            startService = createServices({
              cfg,
              control: new BrokerObservation(() => client),
            });
            startServiceClient = client;
          }
          return startService.start();
        }
      : undefined;
  return createControlCenterSystemControls({
    client: () => new QueueClient(controlClientId()),
    buildHash,
    ...(startStopped ? { startStopped } : {}),
    authorize(principal, scope) {
      return (
        principal.globalRead &&
        (scope.kind === "global" ||
          registeredProjectIds().includes(scope.projectId))
      );
    },
  });
}

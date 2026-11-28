import { createRequire } from "node:module";
import type { FusionResetHost } from "../packages/node-adapters/src/execution/fusion-reset";
const load = createRequire(__filename);
const { createFusionReset } = load(
  "./dist/node-adapters/execution/fusion-reset",
) as typeof import("../packages/node-adapters/src/execution/fusion-reset");
const instance = load("./queue-instance") as Pick<
  FusionResetHost,
  "buildHash" | "processBirth"
>;
// Lazy broker/autostart access preserves initialization order and the existing
// host boundary. All reset/recovery decisions remain in the canonical adapter.
const reset: ReturnType<typeof createFusionReset> = createFusionReset({
  QueueClient: (load("./queue-client") as Pick<FusionResetHost, "QueueClient">)
    .QueueClient,
  QueueState: (load("./queue-state") as Pick<FusionResetHost, "QueueState">)
    .QueueState,
  buildHash: instance.buildHash,
  processBirth: instance.processBirth,
  ensureBroker: (...args) =>
    (
      load("./queue-autostart") as Pick<FusionResetHost, "ensureBroker">
    ).ensureBroker(...args),
  reclaim: (...args) =>
    (load("./queue-broker") as Pick<FusionResetHost, "reclaim">).reclaim(
      ...args,
    ),
  createBrokerControl: (...args) =>
    (
      load("./dist/core/application/broker-control") as Pick<
        FusionResetHost,
        "createBrokerControl"
      >
    ).createBrokerControl(...args),
  createBrokerControlPort: (...args) =>
    (
      load("./dist/node-adapters/broker-ipc/control") as Pick<
        FusionResetHost,
        "createBrokerControlPort"
      >
    ).createBrokerControlPort(...args),
});
export = reset;

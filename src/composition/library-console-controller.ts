import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { ObservedBrokerClient } from "../../packages/node-adapters/src/control-center/broker-observation";
import { sanitize } from "./library-console-logs";
const load = createRequire(__filename);
const { ConsoleModel: CoreConsoleModel, logMessage } = load(
  "../core",
) as typeof import("@fmcad/core");
const { createConsoleExporter } = load(
  "../node-adapters/console/export",
) as typeof import("../../packages/node-adapters/src/console/export");
const { BrokerObservation } = load(
  "../node-adapters/control-center/broker-observation",
) as typeof import("../../packages/node-adapters/src/control-center/broker-observation");
export class ConsoleModel extends CoreConsoleModel {
  constructor() {
    super(logMessage, structuredClone);
  }
}
export const exportRows = createConsoleExporter(sanitize);
export const { openOperation: open, consoleViews: views } = load(
  "../core",
) as typeof import("@fmcad/core");
function defaultClient(): ObservedBrokerClient {
  const { QueueClient } = load("../../queue-client") as {
    QueueClient: new (id: string) => ObservedBrokerClient;
  };
  return new QueueClient("console:" + process.pid + ":" + randomUUID());
}
export class BrokerControl<
  Client extends ObservedBrokerClient = ObservedBrokerClient,
> extends BrokerObservation<Client> {
  constructor(factory: () => Client = defaultClient as () => Client) {
    super(factory);
  }
}

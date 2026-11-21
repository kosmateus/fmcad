import { BrokerAddinClient } from "./addin.js";
import type { Dependencies, Server } from "./contracts.js";
import { assertAutodeskFusionBackend } from "@fmcad/core";

/** Internal composition entry, absent from workspace/public package exports. */
export function createBrokerTransport(
  server: Server,
  dependencies: Dependencies,
) {
  assertAutodeskFusionBackend(server);
  if (!server.backend || server.backend === "addin")
    return new BrokerAddinClient(server, dependencies);
  throw new Error("Unknown backend: " + server.backend);
}

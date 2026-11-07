import { BrokerMcpClient } from "./mcp.js";
import { BrokerAddinClient } from "./addin.js";
import type { Dependencies, Server } from "./contracts.js";

/** Internal composition entry, absent from workspace/public package exports. */
export function createBrokerTransport(
  server: Server,
  dependencies: Dependencies,
) {
  if (!server.backend || server.backend === "mcp")
    return new BrokerMcpClient(server, dependencies);
  if (server.backend === "addin")
    return new BrokerAddinClient(server, dependencies);
  throw new Error("Unknown backend: " + server.backend);
}

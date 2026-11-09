import { createRequire } from "node:module";
import type {
  CatalogServices,
  CatalogMcpTool,
  OperationContract,
} from "../api/contracts";
import {
  createCatalogPost as catalogPost,
  type McpCatalogState,
  type CatalogPost,
  type CatalogPostOptions,
} from "./library-mcp-catalog";
import {
  createQueuePost as queuePost,
  type McpQueueClient,
  type QueueConfiguration,
  type McpOwnerContext,
  type McpQueuePorts,
} from "./library-mcp-queue";
import { parseMcpResponseMessages } from "../entrypoints/mcp-framing";
export { createForwarder } from "./library-mcp-forwarder";
export { queueTools } from "./library-mcp-tools";
export const responseMessages: (
  raw: string,
) => import("./library-mcp-protocol").JsonRpcMessage[] =
  parseMcpResponseMessages;
const hostRequire = createRequire(__filename);
let state: McpCatalogState | undefined;
export function configureCatalogServices(
  catalog: CatalogServices,
  tools: readonly CatalogMcpTool[] = catalog.tools(),
  contracts: readonly OperationContract[] = catalog.list(),
): void {
  state = {
    tools,
    contracts: Object.fromEntries(
      contracts.map((contract) => [contract.operation, contract]),
    ),
    fromMcp: catalog.fromMcp,
    isLocal: catalog.isLocal,
  };
}
function catalog(): McpCatalogState {
  if (!state) {
    const api = hostRequire("../api") as {
      createCatalogServices(): CatalogServices;
    };
    configureCatalogServices(api.createCatalogServices());
  }
  return state!;
}
export function createCatalogPost(
  post: CatalogPost,
  options?: CatalogPostOptions,
) {
  return catalogPost(post, options, catalog);
}
const ports: McpQueuePorts = {
  catalog,
  resolveProjectDirectory(selection) {
    return (
      hostRequire("../../queue-client") as {
        resolveMcpProjectDirectory: McpQueuePorts["resolveProjectDirectory"];
      }
    ).resolveMcpProjectDirectory(selection);
  },
  buildHash() {
    return (
      hostRequire("../../queue-instance") as { buildHash(): string }
    ).buildHash();
  },
  readOwnedResult(...args) {
    return (
      hostRequire("../../queue-response-files") as {
        readOwnedResult: McpQueuePorts["readOwnedResult"];
      }
    ).readOwnedResult(...args);
  },
  responseMessages,
};
export function createQueuePost(
  client: McpQueueClient,
  cfg: QueueConfiguration,
  queueTimeoutMs?: number,
  context?: McpOwnerContext,
) {
  return queuePost(client, cfg, queueTimeoutMs, context, ports);
}

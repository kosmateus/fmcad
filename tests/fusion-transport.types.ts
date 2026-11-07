import type { Server, RequestOptions } from "../packages/node-adapters/src/fusion-transport/contracts.js";
// @ts-expect-error Physical SDK construction is not exported by the workspace API.
import { createBrokerTransport } from "../packages/node-adapters/src/index.js";
void createBrokerTransport;
declare const server: Server;
declare const options: RequestOptions;
// @ts-expect-error Request headers are immutable.
server.headers!["Authorization"] = "changed";
// @ts-expect-error Session identity belongs to an individual immutable request.
options.sessionId = "changed";

import { McpClient, type CompatibilityServer } from "./library-client";
import { createRequire } from "node:module";
const { ADDIN_CAPABILITIES } = createRequire(__filename)(
  "../fusion-transport/addin-capabilities",
) as typeof import("../../packages/node-adapters/src/fusion-transport/addin-capabilities");
export { ADDIN_CAPABILITIES };
/** Public metadata-only adapter; SDK calls still require an admitted broker turn. */
export class AddinClient extends McpClient {
  readonly capabilities = ADDIN_CAPABILITIES;
  constructor(server: CompatibilityServer) {
    super({
      ...server,
      protocolVersion: server["protocolVersion"] || "2025-06-18",
    });
  }
  executeUiGuardedScript(): Promise<never> {
    return Promise.reject(
      Object.assign(new Error("SDK access requires a broker turn"), {
        code: "QUEUE_REQUIRED",
      }),
    );
  }
}

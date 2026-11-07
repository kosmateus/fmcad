/** Stable public entrypoint. No host SDK, configuration discovery or process startup. */
export type * from "./contracts";
export {
  contractVersions,
  assertCompatibility,
  CompatibilityError,
} from "./compatibility";
export { createFmcad } from "../composition/library";
export { createCatalogServices } from "../composition/library-catalog";
export { createReviewServices } from "../composition/library-review";
export {
  createMcpExecutionContext,
  mcpRequestState,
} from "../../packages/core/src/application/mcp-context";

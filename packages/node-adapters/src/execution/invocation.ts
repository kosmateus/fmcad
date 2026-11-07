import { AsyncLocalStorage } from "node:async_hooks";
export {
  createInvocationContext,
  createMcpExecutionContext,
  mcpRequestState,
  description,
  parseInvocation,
} from "@fmcad/core";

export interface InvocationStore {
  description?: string | undefined;
  label?: string;
  document?: string;
  sourcePath?: string;
  sourceHash?: string;
  [key: string]: unknown;
}
export const context = new AsyncLocalStorage<InvocationStore>();

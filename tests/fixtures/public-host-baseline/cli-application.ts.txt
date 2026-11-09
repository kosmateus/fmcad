import { randomUUID } from "node:crypto";
import { createFmcad, createCatalogServices } from "../../api";
import type {
  CadWorkerInvocation,
  CatalogInvocation,
  ExecutionReceipt,
  ExecuteOptions,
  FmcadConfiguration,
  FmcadOptions,
  JsonValue,
} from "../../api";
import { CliError } from "./messages";

export const catalog = createCatalogServices();
export function assertBrokerRouting(config: { routing?: string }): void {
  if (config.routing === "direct") throw new CliError("direct");
}
export function catalogInput(
  operation: string,
  data: Record<string, JsonValue>,
  context: Omit<CatalogInvocation, "kind" | "version" | "operation" | "data">,
): CatalogInvocation {
  // Optional fields must be omitted, not materialized as undefined. This is
  // the exact same strict envelope decoder used by MCP and library callers.
  const defined = Object.fromEntries(
    Object.entries(context).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
  return catalog.validate({
    version: 1,
    kind: "cad",
    operation,
    data,
    ...defined,
  });
}
export interface CliApplicationPorts {
  createFmcad?: typeof createFmcad;
  wait?: (milliseconds: number) => Promise<void>;
  progress?: (receipt: ExecutionReceipt) => void;
  request?: (requestId: string, clientId: string) => void;
}
const terminal = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "needs_reconciliation",
  "unknown",
]);
/** Owns only this adapter's library session. Never cancels, replays or creates a backend. */
export async function execute(
  input: CadWorkerInvocation,
  options: {
    config: FmcadConfiguration;
    context: FmcadOptions["context"];
    requestId?: string;
    local?: boolean;
    execution?: Omit<ExecuteOptions, "requestId">;
  },
  ports: CliApplicationPorts = {},
): Promise<ExecutionReceipt> {
  assertBrokerRouting(options.config);
  const services = (ports.createFmcad ?? createFmcad)({
    version: 1,
    config: options.config,
    context: options.context,
  });
  try {
    if (!options.local) await services.start();
    const requestId = options.requestId ?? randomUUID();
    if (!options.local) ports.request?.(requestId, options.context.clientId);
    let receipt = await services.execute(input, {
      ...options.execution,
      requestId,
    });
    ports.progress?.(receipt);
    while (receipt.jobId && !terminal.has(receipt.state)) {
      await (
        ports.wait ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )(250);
      receipt = await services.query.result(receipt.jobId);
      ports.progress?.(receipt);
    }
    return receipt;
  } finally {
    await services.dispose();
  }
}
export function receiptExitCode(receipt: ExecutionReceipt): number {
  if (receipt.state !== "local") {
    if (
      receipt.state !== "succeeded" ||
      receipt.outcome.acceptance !== "accepted" ||
      receipt.outcome.executionOutcome !== "succeeded" ||
      !["not_checked", "pass", "partial"].includes(
        receipt.outcome.validation.status,
      )
    )
      return 1;
  }
  const result = receipt.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Readonly<Record<string, JsonValue>>;
    if (
      record["success"] === false ||
      ["failed", "unknown"].includes(String(record["status"])) ||
      record["outcome"] === "unknown"
    )
      return 1;
  }
  return 0;
}

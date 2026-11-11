import {
  successfulReferenceComputation,
  successfulImportComputation,
  successfulDrawingComputation,
} from "../../composition/library-local-outcome";
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
  if (options.local) {
    const invocation =
      input.kind === "cad-command"
        ? input.invocation
        : input.kind === "cad"
          ? input
          : null;
    if (!invocation)
      throw new Error("Local execution requires a CAD invocation");
    const { executeInvocation } =
      require("../../composition/catalog-execution.js") as typeof import("../../composition/catalog-execution.js");
    const result = await executeInvocation(
      invocation,
      null,
      undefined,
      options.context.projectDirectory === undefined
        ? {}
        : { projectDirectory: options.context.projectDirectory },
    );
    const { decodePublicResult } = require("../../core/domain/codec.js") as {
      decodePublicResult(value: unknown): ExecutionReceipt["outcome"];
    };
    const { id } = require("../../core/domain/contracts.js") as {
      id(kind: string, value: string): ExecutionReceipt["outcome"]["requestId"];
    };
    const requestId = options.requestId ?? randomUUID();
    const receipt: ExecutionReceipt = {
      version: 1,
      requestId,
      jobId: null,
      state: "local",
      outcome: {
        ...decodePublicResult(result),
        requestId: id("request", requestId),
      },
      result: structuredClone(result) as ExecutionReceipt["result"],
    };
    ports.progress?.(receipt);
    return receipt;
  }
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
export function receiptExitCode(
  receipt: ExecutionReceipt,
  operation?: string,
  preview = false,
): number {
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
  if (
    receipt.state === "local" &&
    (successfulReferenceComputation(operation, result) ||
      successfulImportComputation(operation, result) ||
      successfulDrawingComputation(operation, result))
  )
    return 0;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Readonly<Record<string, JsonValue>>;
    // A completed offline preview describes a plan, including unresolved data.
    // Its exit status does not certify the plan or a native model outcome.
    if (
      preview &&
      receipt.state === "local" &&
      record["success"] === true &&
      !["fail", "failed", "blocked"].includes(String(record["status"])) &&
      record["outcome"] !== "unknown" &&
      record["executionOutcome"] !== "unknown"
    )
      return 0;
    if (
      record["success"] === false ||
      ["fail", "failed", "blocked", "unknown"].includes(
        String(record["status"]),
      ) ||
      record["outcome"] === "unknown"
    )
      return 1;
  }
  return 0;
}

import { decodeCadWorkerInvocation as decode } from "@fmcad/core";
import { homedir } from "node:os";
import { isAbsolute, normalize, parse } from "node:path";
import type {
  CadWorkerInvocation,
  FmcadServices,
  ExecuteOptions,
} from "../../../../src/api/contracts";
import type { Dependencies, Invocation } from "./contracts";

export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FmcadAdapterError";
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdapterError("FMCAD_INVALID_INPUT", "Expected an object");
  return value as Record<string, unknown>;
}
/** Abort the local wait, never remote work. The settled continuation stays observed. */
export function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () =>
      reject(
        signal.reason ??
          new DOMException(
            "Local wait aborted; remote outcome may be unknown",
            "AbortError",
          ),
      );
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}

export function createTools(
  deps: Dependencies,
  options: Record<string, unknown>,
) {
  const services = new Map<string, FmcadServices>();
  let disposed = false;
  function service(ctx: Invocation): FmcadServices {
    if (disposed)
      throw new AdapterError("FMCAD_DISPOSED", "Plugin is disposed");
    const key = JSON.stringify([ctx.sessionID, ctx.agent, ctx.directory]);
    let value = services.get(key);
    if (!value) {
      value = deps.create({
        version: 1,
        config: deps.config(ctx.directory, options),
        context: {
          clientId: deps.clientID(ctx.sessionID, ctx.agent),
          sessionId: ctx.sessionID,
          projectId: ctx.projectId ?? null,
          instanceId: deps.instanceID,
          source: "opencode",
          projectDirectory: ctx.directory,
        },
      });
      services.set(key, value);
    }
    return value;
  }
  return {
    async help(input: unknown, ctx: Invocation): Promise<string> {
      ctx.signal.throwIfAborted();
      const args = object(structuredClone(input));
      if (
        Object.keys(args).some((key) => key !== "operation") ||
        (args["operation"] !== undefined &&
          typeof args["operation"] !== "string")
      )
        throw new AdapterError(
          "FMCAD_INVALID_INPUT",
          "Help accepts an optional operation name",
        );
      if (disposed)
        throw new AdapterError("FMCAD_DISPOSED", "Plugin is disposed");
      const catalog = deps.catalog.list();
      const result =
        args["operation"] === undefined
          ? catalog
          : catalog.filter((item) => item.operation === args["operation"]);
      return JSON.stringify({
        version: 1,
        directory: ctx.directory,
        operations: result,
      });
    },
    async execute(input: unknown, ctx: Invocation): Promise<string> {
      ctx.signal.throwIfAborted();
      const directory = normalize(ctx.directory);
      if (
        !isAbsolute(directory) ||
        directory === parse(directory).root ||
        directory === normalize(homedir())
      )
        throw new AdapterError(
          "FMCAD_SESSION_LOCATION",
          "Choose an explicit project directory, not home or filesystem root",
        );
      const args = object(structuredClone(input));
      const action = args["action"] ?? "execute";
      if (
        Object.keys(args).some(
          (key) =>
            ![
              "action",
              "invocation",
              "requestId",
              "jobId",
              "sequence",
              "expectedRevision",
              "queueTimeoutMs",
            ].includes(key),
        )
      )
        throw new AdapterError("FMCAD_INVALID_INPUT", "Unexpected tool field");
      if (
        ![
          "execute",
          "result",
          "request",
          "status",
          "cancel",
          "reconcile",
        ].includes(String(action))
      )
        throw new AdapterError("FMCAD_INVALID_INPUT", "Unknown action");
      if (["plan", "explore"].includes(ctx.agent))
        throw new AdapterError(
          "FMCAD_PERMISSION_DENIED",
          `Execution denied for ${ctx.agent}; use fmcad_help`,
        );
      let invocation: CadWorkerInvocation | undefined;
      if (action === "execute") {
        try {
          invocation = decode(args["invocation"]);
        } catch (error) {
          throw new AdapterError(
            "FMCAD_INVALID_INPUT",
            error instanceof Error ? error.message : "Invalid invocation",
          );
        }
        const catalogInput =
          invocation.kind === "cad"
            ? invocation
            : invocation.kind === "cad-command"
              ? invocation.invocation
              : undefined;
        if (catalogInput) deps.catalog.validate(catalogInput);
      }
      for (const key of ["requestId", "jobId"] as const) {
        if (
          args[key] !== undefined &&
          (typeof args[key] !== "string" ||
            !(args[key] as string).trim() ||
            (args[key] as string).length > 256)
        )
          throw new AdapterError(
            "FMCAD_INVALID_INPUT",
            `${key} requires 1..256 characters`,
          );
      }
      if (
        ["result", "cancel", "reconcile"].includes(String(action)) &&
        !args["jobId"]
      )
        throw new AdapterError("FMCAD_INVALID_INPUT", "jobId is required");
      if (action === "request" && !args["requestId"])
        throw new AdapterError("FMCAD_INVALID_INPUT", "requestId is required");
      const requestId =
        (args["requestId"] as string | undefined) ?? deps.requestID();
      if (
        action !== "execute" &&
        ["invocation", "sequence", "expectedRevision", "queueTimeoutMs"].some(
          (key) => args[key] !== undefined,
        )
      )
        throw new AdapterError(
          "FMCAD_INVALID_INPUT",
          "Execution fields require action=execute",
        );
      const resource = `fmcad ${String(action)} ${JSON.stringify({ ...args, requestId })}`;
      await wait(
        ctx.authorize(resource, {
          directory: ctx.directory,
          requestId,
          input: args,
          action,
          remoteCancellation: false,
        }),
        ctx.signal,
      );
      ctx.signal.throwIfAborted();
      const api = service(ctx);
      const work = (async () => {
        const local =
          invocation &&
          (invocation.kind === "cad"
            ? deps.catalog.isLocal(invocation)
            : invocation.kind === "cad-command" &&
              deps.catalog.isLocal(invocation.invocation));
        if (!local) await api.start();
        ctx.signal.throwIfAborted();
        if (invocation)
          return api.execute(invocation, {
            requestId,
            ...(args["sequence"] !== undefined
              ? {
                  sequence: args["sequence"] as NonNullable<
                    ExecuteOptions["sequence"]
                  >,
                }
              : {}),
            ...(args["expectedRevision"] !== undefined
              ? { expectedRevision: args["expectedRevision"] as number }
              : {}),
            ...(args["queueTimeoutMs"] !== undefined
              ? { queueTimeoutMs: args["queueTimeoutMs"] as number }
              : {}),
          });
        const jobId = args["jobId"] as string;
        if (action === "status") return api.query.status();
        if (action === "result") return api.query.result(jobId);
        if (action === "request") return api.query.request(requestId);
        return api.control({
          version: 1,
          action: action as "cancel" | "reconcile",
          jobId,
        });
      })();
      return JSON.stringify(await wait(work, ctx.signal));
    },
    async dispose() {
      disposed = true;
      // Pending calls retain rejection observers; local disposal never waits
      // for unknown remote physical completion and never sends cancellation.
      await Promise.all([...services.values()].map((value) => value.dispose()));
      services.clear();
    },
  };
}

export const helpSchema = {
  type: "object",
  properties: { operation: { type: "string" } },
  additionalProperties: false,
} as const;
export const executeSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["execute", "result", "request", "status", "cancel", "reconcile"],
    },
    invocation: {
      type: "object",
      description:
        "Version 1 CadWorkerInvocation (cad, cad-command or run), including purpose and document pins.",
    },
    requestId: { type: "string", minLength: 1, maxLength: 256 },
    jobId: { type: "string", minLength: 1, maxLength: 256 },
    sequence: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["begin", "continue", "end"] },
        id: { type: "string" },
        mode: { type: "string", enum: ["automatic", "exclusive"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
    expectedRevision: { type: "integer", minimum: 0, maximum: 2147483647 },
    queueTimeoutMs: { type: "integer", minimum: 1, maximum: 2147483647 },
  },
  additionalProperties: false,
} as const;

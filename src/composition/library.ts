import {
  createInvocationContext,
  resolveFmcadConfiguration,
  id,
  decodeCadWorkerInvocation,
  decodePublicResult,
} from "../../packages/core/src";
import type {
  CatalogInvocation,
  CadWorkerInvocation,
  FmcadOptions,
  FmcadServices,
  ExecutionReceipt,
  ExecuteOptions,
  ControlRequest,
  StageServices,
  StageInspection,
  StageResumePlan,
} from "../api/contracts";
import { CompatibilityError, contractVersions } from "../api/compatibility";
import { createQueueSession, validateExecuteOptions } from "./library-queue";
import { createCatalogServices } from "./library-catalog";
function snapshot<T>(value: T): T {
  return structuredClone(value);
}
function token(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new Error(`${label} must contain 1..256 characters`);
}

export function createFmcad(options: FmcadOptions): FmcadServices {
  if (options?.version !== 1)
    throw new CompatibilityError("api", options?.version, 1);
  const config = resolveFmcadConfiguration({
    adapter: { ...snapshot(options.config) },
    environment: {},
    file: {},
    platformDefaults: {},
    acceptedService: null,
  });
  const context = createInvocationContext(options.context);
  token(context.clientId, "clientId");
  const cwd = options.context.projectDirectory;
  if (
    cwd !== undefined &&
    (typeof cwd !== "string" || !require("node:path").isAbsolute(cwd))
  )
    throw new Error("projectDirectory must be absolute");
  let disposed = false;
  let session: ReturnType<typeof createQueueSession> | undefined;
  let starting: Promise<void> | undefined;
  const catalog = createCatalogServices();
  const live = () => {
    if (disposed) throw new Error("fmcad services are disposed");
  };
  const ready = () => {
    live();
    if (!session?.ready)
      throw new Error("Call and await start() before broker operations");
    return session;
  };
  const validate = (input: CatalogInvocation) => {
    live();
    if (input?.version !== 1)
      throw new CompatibilityError("dto", input?.version, 1);
    return catalog.validate(input);
  };
  return Object.freeze({
    versions: contractVersions,
    query: Object.freeze({
      catalog: () => {
        live();
        return catalog.list();
      },
      validate,
      status: async () => ready().status(),
      result: async (jobId: string) => {
        token(jobId, "jobId");
        return ready().result(jobId);
      },
      request: async (requestId: string) => {
        token(requestId, "requestId");
        return ready().request(requestId);
      },
    }),
    async execute(
      value: CadWorkerInvocation,
      execution: ExecuteOptions,
    ): Promise<ExecutionReceipt> {
      live();
      token(execution?.requestId, "requestId");
      const executionOptions = snapshot(execution);
      validateExecuteOptions(executionOptions);
      if (value?.version !== 1)
        throw new CompatibilityError("dto", value?.version, 1);
      const input = decodeCadWorkerInvocation(snapshot(value));
      if (
        context.purpose &&
        input.kind !== "cad-command" &&
        input.purpose === undefined
      )
        input.purpose = context.purpose;
      const invocation =
        input.kind === "cad"
          ? input
          : input.kind === "cad-command"
            ? input.invocation
            : undefined;
      if (invocation) {
        if (context.purpose && invocation.purpose === undefined)
          invocation.purpose = context.purpose;
        const valid = validate(invocation);
        if (input.kind === "cad") Object.assign(input, valid);
        else if (input.kind === "cad-command") input.invocation = valid;
        if (catalog.isLocal(valid)) {
          if (
            executionOptions.sequence ||
            executionOptions.expectedRevision !== undefined ||
            executionOptions.queueTimeoutMs !== undefined
          )
            throw new Error("Queue controls require a broker operation");
          const result: unknown =
            await require("../catalog/execute").executeInvocation(valid, null, undefined, {
              projectDirectory: cwd,
            });
          return {
            version: 1,
            requestId: execution.requestId,
            jobId: null,
            state: "local",
            outcome: {
              ...decodePublicResult(result),
              requestId: id("request", execution.requestId),
            },
            result: snapshot(result) as ExecutionReceipt["result"],
          };
        }
      }
      return ready().execute(input, executionOptions);
    },
    async control(request: ControlRequest) {
      if (request?.version !== 1)
        throw new CompatibilityError("controlApi", request?.version, 1);
      if (!["cancel", "reconcile"].includes(request.action))
        throw new Error("Unsupported control action");
      token(request.jobId, "jobId");
      return ready().control(request.action, request.jobId);
    },
    async stage(jobId: string): Promise<StageServices> {
      token(jobId, "jobId");
      return ready().stage(jobId);
    },
    async journalInspect(jobId: string, expectedHead?: string): Promise<StageInspection> {
      token(jobId, "jobId");
      return (await ready().stage(jobId)).journalInspect(expectedHead);
    },
    async resumePlan(jobId: string, expectedHead?: string): Promise<StageResumePlan> {
      token(jobId, "jobId");
      return (await ready().stage(jobId)).resumePlan(expectedHead);
    },
    start() {
      live();
      if (!cwd) throw new Error("A validated projectDirectory is required for broker operations");
      if (!starting) {
        session = createQueueSession(
          config,
          context.clientId!,
          cwd!,
          context.instanceId,
        );
        starting = session.start().catch((error) => {
          session?.dispose();
          session = undefined;
          starting = undefined;
          throw error;
        });
      }
      return starting;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await starting;
      } finally {
        session?.dispose();
      }
    },
  });
}

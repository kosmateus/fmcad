import { randomUUID } from "node:crypto";
import {
  mcpRequestState,
  redactDiagnostic,
  formatJsonError,
} from "@fmcad/core";
import type {
  JsonRpcRequest,
  JsonRpcMessage,
  McpResponse,
  OwnedMcpArtifactReference,
} from "./library-mcp-protocol";
import { catalogResult, type McpCatalogState } from "./library-mcp-catalog";
import { queueMetadata } from "./library-mcp-metadata";
import { queueTools, validateQueueHelperArguments } from "./library-mcp-tools";
export interface QueueJob {
  id: string;
  requestId: string;
  state: string;
  clientId?: string;
  revision?: number;
  sequenceId?: string;
  sequenceState?: string;
  code?: string;
}
export interface QueueResult {
  job: QueueJob;
  context?: unknown;
  stdout?: string;
  rpc?: McpResponse;
  outputs?: {
    stdout?: { artifact?: OwnedMcpArtifactReference };
    rpc?: { artifact?: OwnedMcpArtifactReference };
  };
  execution?: {
    pythonCheck?: { status?: string };
    code?: string;
    executionOutcome?: string;
    mayHaveMutated?: boolean;
  };
}
export type QueueRecovery = QueueResult | { job: null; context: unknown };
export interface QueueConfiguration {
  backend?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  url?: string;
}
export interface McpOwnerContext {
  sessionId?: string;
  clientId?: string;
  projectDirectory?: string | null;
}
export interface QueueRequestContext extends Record<string, unknown> {
  clientId: string;
  requestId: string;
  sessionId: string | undefined;
  projectDirectory?: string;
  projectId?: string;
  doc?: string;
  docId?: string;
  docFileId?: string;
  purpose?: string;
  expectedRevision?: number;
}
export interface McpQueueClient {
  dir: string;
  auth: { clientId: string };
  register(options: { autoStart: boolean }): Promise<unknown>;
  call(action: string, args?: Record<string, unknown>): Promise<unknown>;
  submit(input: Record<string, unknown>): Promise<QueueJob>;
  findRequest(requestId: string): Promise<QueueRecovery | null | undefined>;
  wait(jobId: string, options: { signal: AbortSignal }): Promise<QueueResult>;
  persistRequestContext?(requestId: string, context: QueueRequestContext): void;
  readRequestContext?(requestId: string): unknown;
  dispose?(): void;
}
export interface McpQueuePorts {
  catalog(): McpCatalogState;
  resolveProjectDirectory(selection: {
    projectDirectory?: string;
    roots?: { uri: string; name?: string }[];
  }): { projectDirectory: string | null; source: string };
  buildHash(): string;
  readOwnedResult(
    directory: string,
    owner: { jobId: string; cwd?: string },
    reference: OwnedMcpArtifactReference,
    maxBytes: number,
  ): { toString(encoding: "utf8"): string };
  responseMessages(raw: string): JsonRpcMessage[];
}
interface QueueError extends Error {
  code?: string;
  notStarted?: boolean;
  pythonCheck?: unknown;
}
const QUEUED_ACCEPT_MS = 1000;
const MAX_OWNED_MCP_RESPONSE_BYTES = 128 * 1024 * 1024;
function invalidQueueParams(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_QUEUE_PARAMS" });
}
function receipt(job: QueueJob) {
  return {
    jobId: job.id,
    revision: job.revision ?? null,
    sequenceId: job.sequenceId ?? null,
    sequenceState: job.sequenceState ?? null,
    state: job.state,
  };
}
export function createQueuePost(
  client: McpQueueClient,
  cfg: QueueConfiguration,
  queueTimeoutMs: number | undefined,
  context: McpOwnerContext = {},
  ports: McpQueuePorts,
) {
  let registration: Promise<unknown> | undefined;
  const ready = (autoStart = true) =>
    (registration ||= Promise.resolve()
      .then(() => client.register({ autoStart }))
      .catch((error) => {
        registration = undefined;
        throw error;
      }));
  const post = async (
    request: JsonRpcRequest,
    session?: string,
    version?: string,
  ): Promise<McpResponse> => {
    const { tools, fromMcp: mcpInvocation } = ports.catalog();
    const byMcpName = new Set(tools.map((tool) => tool.name));
    let requestId: string = randomUUID(),
      job: QueueJob | undefined,
      clientContext: QueueRequestContext | undefined,
      admissionAttempted = false;
    const reply = (result: unknown) => ({
      status: 200,
      raw: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    });
    const helperResult = (value: unknown) =>
      reply({
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
      });
    try {
      const helper =
        request.method === "tools/call" &&
        queueTools.find((tool) => tool.name === request.params?.["name"]);
      const { payload, options } = queueMetadata(request);
      requestId = options.requestId || requestId;
      if (
        context.sessionId &&
        options.sessionId &&
        options.sessionId !== context.sessionId
      ) {
        invalidQueueParams("sessionId is assigned by the MCP owner context");
      }
      const catalogCall =
        request.method === "tools/call" &&
        byMcpName.has(request.params?.["name"] as string)
          ? mcpInvocation(
              request.params!["name"] as string,
              request.params!["arguments"],
            )
          : null;
      if (helper) {
        if (!Object.hasOwn(request, "id"))
          throw Object.assign(new Error("Queue helpers require a request id"), {
            code: "unsupported_queue_route",
          });
        if (
          request.params?.["_meta"] &&
          Object.hasOwn(request.params!["_meta"] as object, "fmcad")
        )
          invalidQueueParams("Queue helper tools do not accept fmcad metadata");
        const args = validateQueueHelperArguments(
          helper,
          request.params!["arguments"],
        );
        await ready(helper.name === "fmcad_queue_begin");
        switch (helper.name) {
          case "fmcad_queue_end":
            return helperResult(
              await client.call("release", { sequenceId: args["sequenceId"] }),
            );
          case "fmcad_queue_status":
            return helperResult(await client.call("queue-summary"));
          case "fmcad_queue_result": {
            const value = (await client.call("result", {
              jobId: args["jobId"],
            })) as QueueResult;
            const context =
              client.readRequestContext?.(value.job.requestId) ?? null;
            const response = helperResult({ ...value, context });
            return {
              ...response,
              queueReceipt: {
                ...receipt(value.job),
                requestId: value.job.requestId,
                requestStatus: mcpRequestState(value.job.state),
                context,
              },
            };
          }
          case "fmcad_queue_request": {
            const value = await client.findRequest(args["requestId"]!);
            const result = value?.job
              ? Object.assign(
                  {
                    requestId: args["requestId"]!,
                    jobId: value.job.id,
                    status: mcpRequestState(value.job.state),
                    job: value.job,
                    context: value.context,
                  },
                  value,
                )
              : {
                  requestId: args["requestId"]!,
                  jobId: null,
                  status: "needs_reconciliation",
                  context: value?.context ?? null,
                  instruction:
                    "No owned receipt is visible in this broker snapshot. Do not resubmit an uncertain request; inspect again after reconnecting.",
                };
            const response = helperResult(result);
            return {
              ...response,
              ...(value?.job ? { queueReceipt: receipt(value.job) } : {}),
            };
          }
          case "fmcad_queue_reconcile": {
            const value = (await client.call("reconcile", {
              jobId: args["jobId"],
              ...(args["acceptedOutcome"] === undefined
                ? {}
                : { acceptedOutcome: args["acceptedOutcome"] }),
            })) as QueueJob;
            const job = (await client.call("status", {
              jobId: args["jobId"],
            })) as QueueJob | null;
            const context =
              job?.clientId === client.auth.clientId
                ? (client.readRequestContext?.(job.requestId) ?? null)
                : null;
            return {
              ...helperResult({ ...value, context }),
              queueReceipt: {
                ...receipt(job || value),
                ...(job?.clientId === client.auth.clientId
                  ? { requestId: job.requestId, context }
                  : {}),
              },
            };
          }
        }
      }
      const begin = helper && helper.name === "fmcad_queue_begin";
      const selectedProject = begin
        ? { projectDirectory: null, source: "none" }
        : ports.resolveProjectDirectory({
            ...(options.projectDirectory !== undefined
              ? { projectDirectory: options.projectDirectory }
              : context.projectDirectory !== undefined &&
                  context.projectDirectory !== null
                ? { projectDirectory: context.projectDirectory }
                : {}),
            ...(options.roots !== undefined ? { roots: options.roots } : {}),
          });
      if (!begin && !selectedProject.projectDirectory) {
        throw Object.assign(
          new Error(
            "A validated projectDirectory is required for queued MCP execution; select --project or provide one validated MCP root",
          ),
          { code: "MCP_PROJECT_REQUIRED", notStarted: true },
        );
      }
      clientContext = {
        clientId: client.auth?.clientId ?? context.clientId ?? "mcp-client",
        requestId,
        sessionId: options.sessionId || context.sessionId,
        ...(selectedProject.projectDirectory
          ? { projectDirectory: selectedProject.projectDirectory }
          : {}),
        ...(catalogCall?.invocation.projectId
          ? { projectId: catalogCall.invocation.projectId }
          : options.projectId !== undefined
            ? { projectId: options.projectId }
            : {}),
        ...(catalogCall?.invocation.doc
          ? { doc: catalogCall.invocation.doc }
          : options.doc !== undefined
            ? { doc: options.doc }
            : {}),
        ...(catalogCall?.invocation.docId
          ? { docId: catalogCall.invocation.docId }
          : options.docId !== undefined
            ? { docId: options.docId }
            : {}),
        ...(catalogCall?.invocation.docFileId
          ? { docFileId: catalogCall.invocation.docFileId }
          : options.docFileId !== undefined
            ? { docFileId: options.docFileId }
            : {}),
        ...(catalogCall?.invocation.purpose
          ? { purpose: catalogCall.invocation.purpose }
          : options.purpose
            ? { purpose: options.purpose }
            : options.description
              ? { purpose: options.description }
              : {}),
        ...(options.expectedRevision !== undefined
          ? { expectedRevision: options.expectedRevision }
          : {}),
      };
      const {
        projectDirectory: _projectDirectory,
        roots: _roots,
        sessionId: _sessionId,
        doc: _doc,
        docId: _docId,
        docFileId: _docFileId,
        projectId: _projectId,
        purpose: _purpose,
        ...queueOptions
      } = options;
      void [
        _projectDirectory,
        _roots,
        _sessionId,
        _doc,
        _docId,
        _docFileId,
        _projectId,
        _purpose,
      ];
      await ready();
      const input = {
        ...(catalogCall
          ? {
              kind: "command",
              argv: catalogCall.argv,
              payload: catalogCall.invocation,
              buildHash: ports.buildHash(),
              ...(catalogCall.invocation.purpose !== undefined
                ? { description: catalogCall.invocation.purpose }
                : {}),
            }
          : {
              kind: "rpc",
              payload: begin
                ? { jsonrpc: "2.0", id: request.id, method: "ping" }
                : payload,
            }),
        ...(session ? { sessionId: session } : {}),
        ...(version ? { protocolVersion: version } : {}),
        timeoutMs: cfg.timeoutMs,
        ...(selectedProject.projectDirectory
          ? { cwd: selectedProject.projectDirectory }
          : {}),
        clientContext,
        requestId,
        backend: cfg.backend,
        ...queueOptions,
        ...(queueTimeoutMs !== undefined ? { queueTimeoutMs } : {}),
        ...(begin ? { sequence: { action: "begin", mode: "exclusive" } } : {}),
      };
      if (!begin) client.persistRequestContext?.(requestId, clientContext);
      let recovered: QueueRecovery | null | undefined;
      try {
        admissionAttempted = !begin;
        job = await client.submit(input);
      } catch (error) {
        try {
          recovered = await client.findRequest(requestId);
        } catch {
          throw error;
        }
        if (!recovered?.job) throw error;
        job = recovered.job;
      }
      const controller = new AbortController();
      const completion = (
        recovered
          ? Promise.resolve(recovered as QueueResult)
          : client.wait(job.id, { signal: controller.signal })
      ).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ error, value: undefined }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([
        completion,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), QUEUED_ACCEPT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (first === null) {
        const current = (await client.call("result", {
          jobId: job.id,
        })) as QueueResult;
        if (
          [
            "preparing",
            "processing",
            "queued",
            "running",
            "sending",
            "needs_reconciliation",
          ].includes(current.job?.state)
        ) {
          controller.abort();
          const accepted = {
            status: current.job.state === "queued" ? "QUEUED" : "ACCEPTED",
            jobId: job.id,
            state: current.job.state,
            ...(current.job.state === "queued" ? { executed: false } : {}),
            instruction:
              "Poll fmcad_queue_result with this jobId; do not resubmit this task.",
          };
          return {
            ...reply({
              content: [{ type: "text", text: JSON.stringify(accepted) }],
              structuredContent: accepted,
            }),
            queueReceipt: {
              ...receipt(current.job),
              requestId,
              requestStatus: mcpRequestState(current.job.state),
              context: clientContext,
            },
            queueTools: true,
          };
        }
      }
      const outcome = first || (await completion);
      if (outcome.error) throw outcome.error;
      const value = outcome.value!;
      job = value.job;
      if (value.execution?.pythonCheck) {
        const result = {
          success: false,
          status: value.execution.pythonCheck.status,
          code: value.execution.code,
          executionOutcome: value.execution.executionOutcome,
          mayHaveMutated: value.execution.mayHaveMutated,
          pythonCheck: value.execution.pythonCheck,
        };
        return {
          ...reply({
            isError: true,
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          }),
          queueReceipt: receipt(job),
          queueTools: true,
        };
      }
      if (catalogCall) {
        if (!["succeeded", "failed"].includes(job.state))
          throw Object.assign(
            new Error(
              "Catalog job requires reconciliation; inspect its owned result, do not resubmit",
            ),
            { code: "QUEUE_RESULT_UNAVAILABLE" },
          );
        let stdout = value.stdout;
        if (value.outputs?.stdout) {
          const reference = value.outputs.stdout.artifact;
          if (reference?.name !== "stdout.txt")
            throw new Error("Missing owned catalog result artifact reference");
          stdout = ports
            .readOwnedResult(
              client.dir,
              { jobId: job.id, ...(input.cwd ? { cwd: input.cwd } : {}) },
              reference,
              MAX_OWNED_MCP_RESPONSE_BYTES,
            )
            .toString("utf8");
        }
        if (typeof stdout !== "string" || !stdout.trim())
          throw Object.assign(
            new Error(
              "Catalog result unavailable; inspect owned job diagnostics before any resubmission",
            ),
            { code: "QUEUE_RESULT_UNAVAILABLE" },
          );
        const result = JSON.parse(stdout);
        return {
          ...reply(
            catalogResult(
              result,
              catalogCall.operation,
              job.state !== "succeeded",
            ),
          ),
          queueReceipt: {
            ...receipt(job),
            requestId,
            requestStatus: mcpRequestState(job.state),
            context: clientContext,
          },
          artifactOwner: {
            jobId: job.id,
            ...(input.cwd ? { cwd: input.cwd } : {}),
          },
          queueTools: true,
        };
      }
      const ownedArtifact = value.outputs?.rpc?.artifact;
      if (!value.rpc && value.outputs?.rpc) {
        const reference = value.outputs.rpc.artifact;
        if (reference?.name !== "rpc-result.json")
          throw new Error("Missing owned RPC artifact reference");
        value.rpc = JSON.parse(
          ports
            .readOwnedResult(
              client.dir,
              { jobId: job.id, ...(input.cwd ? { cwd: input.cwd } : {}) },
              reference,
              MAX_OWNED_MCP_RESPONSE_BYTES,
            )
            .toString("utf8"),
        );
      }
      if (!["succeeded", "failed"].includes(job.state) || !value.rpc) {
        throw Object.assign(
          new Error(
            "Queue job " +
              job.id +
              " is " +
              job.state +
              " (" +
              (job.code || value.execution?.code || "RAW_RESULT_UNAVAILABLE") +
              "); inspect its result before any resubmission",
          ),
          { code: "QUEUE_RESULT_UNAVAILABLE" },
        );
      }
      const response = {
        ...value.rpc,
        ...(ownedArtifact?.name === "rpc-result.json" ? { ownedArtifact } : {}),
        queueReceipt: {
          ...receipt(job),
          requestId,
          requestStatus: mcpRequestState(job.state),
          context: clientContext,
        },
        artifactOwner: {
          jobId: job.id,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        },
        queueTools: true,
      };
      if (begin) {
        // Validate the physical ping before replacing its payload with the lease receipt.
        const messages = ports.responseMessages(response.raw);
        const ping = messages.find(
          (message) =>
            message.id === request.id &&
            (Object.hasOwn(message, "result") ||
              Object.hasOwn(message, "error")),
        );
        if (
          response.status < 200 ||
          response.status >= 300 ||
          !ping ||
          messages.some((message) => message.jsonrpc !== "2.0")
        ) {
          throw new Error(
            "Missing or invalid matching MCP response for queue sequence begin",
          );
        }
        if (ping["error"]) return response;
        if (job.state !== "succeeded")
          throw new Error("Queue sequence begin failed; inspect job " + job.id);
        const result = {
          content: [{ type: "text", text: JSON.stringify(receipt(job)) }],
          structuredContent: receipt(job),
        };
        const replies = messages.map((message) =>
          message === ping ? { ...message, result } : message,
        );
        return {
          ...response,
          raw:
            replies.length === 1
              ? JSON.stringify(replies[0])
              : replies
                  .map((message) => "data: " + JSON.stringify(message) + "\n\n")
                  .join(""),
        };
      }
      return response;
    } catch (caught) {
      const error = caught as QueueError;
      if (!Object.hasOwn(request, "id")) throw error;
      const validationRequired =
        error.notStarted === true ||
        [
          "INVALID_QUEUE_PARAMS",
          "MCP_PROJECT_REQUIRED",
          "unsupported_queue_route",
          "REQUEST_CONTEXT_CONFLICT",
        ].includes(error.code!);
      const requestStatus = job
        ? mcpRequestState(job.state)
        : validationRequired || !admissionAttempted
          ? "rejected-before-admission"
          : "needs_reconciliation";
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message:
              error instanceof SyntaxError
                ? formatJsonError(error)
                : redactDiagnostic(
                    (error.code ? error.code + ": " : "") + error.message,
                    cfg,
                  ),
            data: {
              requestId,
              requestStatus,
              ...(validationRequired
                ? {
                    validation: {
                      status: "required",
                      diagnostics: [error.message],
                    },
                  }
                : {}),
              ...(clientContext ? { context: clientContext } : {}),
              ...(job
                ? {
                    fmcad: {
                      ...receipt(job),
                      requestId,
                      requestStatus,
                      context: clientContext ?? null,
                    },
                  }
                : {}),
              ...(error.pythonCheck ? { pythonCheck: error.pythonCheck } : {}),
              ...(error.notStarted
                ? { executionOutcome: "not_started", mayHaveMutated: false }
                : {}),
            },
          },
        }),
      };
    }
  };
  post.close = () => client.dispose?.();
  return post;
}

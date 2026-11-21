import { randomUUID } from "node:crypto";
import { createCatalogServices } from "../api";
import type {
  CatalogMcpTool,
  CatalogServices,
  CatalogInvocation,
  ExecutionReceipt,
  FmcadServices,
  McpClientContextPort,
  McpExecutionContext,
} from "../api";
import { createMcpExecutionContext, mcpRequestState } from "../api";

type RecordValue = Record<string, unknown>;
export interface McpRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: RecordValue;
}
export interface McpResponse {
  status: number;
  raw: string;
  /** Preserve the accepted job owner if a large typed result is externalized. */
  queueReceipt?: unknown;
  artifactOwner?: { jobId: string; cwd?: string };
}
export interface McpApplicationOptions {
  catalog?: CatalogServices;
  catalogTools?: readonly CatalogMcpTool[];
  catalogContracts?: ReturnType<CatalogServices["list"]>;
  services(local: boolean, context?: McpExecutionContext): FmcadServices;
  clientContext?: McpClientContextPort;
  compatibility(
    request: McpRequest,
    session?: string,
    version?: string,
  ): Promise<McpResponse>;
  queueTools: readonly {
    readonly name: string;
    readonly inputSchema: {
      readonly required: readonly string[];
      readonly properties?: Readonly<
        Record<
          string,
          { readonly type?: string; readonly enum?: readonly string[] }
        >
      >;
    };
  }[];
  diagnostic?(message: string): string;
}
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: -32602 });
}
function exact(
  value: unknown,
  keys: readonly string[],
  label: string,
): RecordValue {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key)))
    invalid(`${label} must be an object containing only ${keys.join(", ")}`);
  return value;
}
const projectApplicationTools = (contextProperties: RecordValue) => [
  {
    name: "fmcad_execute",
    description:
      "Execute a structured catalog operation through the shared fmcad service. No shell or CLI command strings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation", "data"],
      properties: {
        operation: { type: "string", minLength: 1 },
        data: { type: "object" },
        context: {
          type: "object",
          additionalProperties: false,
          properties: contextProperties,
        },
      },
    },
  },
  {
    name: "fmcad_help",
    description:
      "Local installed operation contracts and schemas; no Fusion or configuration access.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { operation: { type: "string", minLength: 1 } },
    },
  },
];
// These names are physical-backend compatibility, not native fmcad capabilities.
// No dynamic upstream tool catalog is promoted into this application's capabilities.
export const legacyTools = [
  "execute_python",
  "fusion_mcp_execute",
  "fusion_mcp_read",
  "fetch_api_documentation",
  "fetch_design_guide",
  "capture_viewport",
  "get_viewport",
].map((name) => ({
  name,
  description:
    "Deprecated physical-backend compatibility adapter. Broker only; use fmcad_execute with a catalog operation when possible.",
  annotations: { deprecated: true },
  inputSchema:
    name === "execute_python"
      ? {
          type: "object",
          required: ["code", "persistent"],
          properties: {
            code: { type: "string", minLength: 1 },
            persistent: { const: false },
          },
          additionalProperties: true,
        }
      : name === "fusion_mcp_execute"
        ? {
            type: "object",
            required: ["featureType", "object"],
            properties: {
              featureType: { enum: ["script", "document"] },
              object: { type: "object" },
            },
            additionalProperties: true,
          }
        : { type: "object", properties: {}, additionalProperties: true },
}));

/** Local MCP protocol termination. Effects are injected and never needed for metadata. */
export function createMcpApplication(options: McpApplicationOptions) {
  const catalog = options.catalog ?? createCatalogServices();
  const projected = options.catalogTools ?? catalog.tools();
  const contracts = options.catalogContracts ?? catalog.list();
  const contextProperties = {
    ...Object.fromEntries(
      Object.entries(projected[0]?.inputSchema.properties ?? {}).filter(
        ([key]) => key !== "data",
      ),
    ),
    projectDirectory: { type: "string", minLength: 1 },
  };
  const applicationTools = projectApplicationTools(contextProperties);
  const names = new Set(projected.map((tool) => tool.name));
  const queueByName = new Map(
    options.queueTools.map((tool) => [tool.name, tool]),
  );
  return async (
    request: McpRequest,
    session?: string,
    version?: string,
  ): Promise<McpResponse> => {
    const hasId = Object.hasOwn(request, "id");
    const reply = (
      result: unknown,
      ownership: Pick<McpResponse, "queueReceipt" | "artifactOwner"> = {},
    ): McpResponse => ({
      status: 200,
      raw: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      ...ownership,
    });
    const toolResult = (value: unknown, isError = false) =>
      reply({
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
        isError,
      });
    let validating = false;
    let accepted: ExecutionReceipt | undefined;
    let requestIdentity: string | undefined;
    let executionContext: McpExecutionContext | undefined;
    let services: FmcadServices | undefined;
    let admissionAttempted = false;
    // Notifications never execute tool mutations and never generate a response.
    if (!hasId) return { status: 204, raw: "" };
    try {
      if (request.params !== undefined && !object(request.params))
        invalid("MCP method params must be an object");
      switch (request.method) {
        case "initialize": {
          const params = request.params;
          if (
            !object(params) ||
            typeof params["protocolVersion"] !== "string" ||
            !object(params["capabilities"])
          )
            invalid("initialize requires protocolVersion and capabilities");
          const supported = [
            "2024-11-05",
            "2025-03-26",
            "2025-06-18",
            "2025-11-25",
          ];
          return reply({
            protocolVersion: supported.includes(params["protocolVersion"])
              ? params["protocolVersion"]
              : "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fmcad", version: "0.1.0" },
          });
        }
        case "ping":
          return reply({});
        case "tools/list":
          return reply({
            tools: [
              ...applicationTools,
              ...projected,
              ...options.queueTools,
              ...legacyTools,
            ],
          });
        // Optional catalogs retain the physical response semantics but enter
        // through the shared broker. Authorization failures are never hidden.
        case "resources/list":
        case "resources/templates/list":
          return await options.compatibility(request, session, version);
        case "tools/call":
          break;
        default:
          throw Object.assign(
            new Error(`Method not found: ${request.method}`),
            { code: -32601 },
          );
      }
      validating = true;
      const params = exact(
        request.params,
        ["name", "arguments", "_meta"],
        "tools/call params",
      );
      const name = params["name"];
      if (typeof name !== "string") invalid("Tool name must be a string");
      const args = params["arguments"] ?? {};
      if (name === "fmcad_help") {
        const input = exact(args, ["operation"], "fmcad_help arguments");
        if (
          input["operation"] !== undefined &&
          (typeof input["operation"] !== "string" || !input["operation"])
        )
          invalid("operation must be a nonempty string");
        const availableContracts = contracts.filter(
          (contract) =>
            input["operation"] === undefined ||
            contract.operation === input["operation"],
        );
        if (!availableContracts.length)
          invalid(`Unknown operation: ${String(input["operation"])}`);
        return toolResult({ operations: availableContracts });
      }
      const queueTool = queueByName.get(name);
      if (queueTool || legacyTools.some((tool) => tool.name === name)) {
        if (!object(args)) invalid("Compatibility arguments must be an object");
        if (queueTool) {
          const keys = queueTool.inputSchema.required;
          const properties = queueTool.inputSchema.properties;
          const input = exact(
            args,
            properties ? Object.keys(properties) : keys,
            name,
          );
          for (const key of keys) {
            const value = input[key];
            if (
              typeof value !== "string" ||
              !value.trim() ||
              value.length > 256
            )
              invalid(`${name} requires ${key} containing 1..256 characters`);
          }
          for (const key of properties ? Object.keys(properties) : []) {
            if (keys.includes(key) || !Object.hasOwn(input, key)) continue;
            const value = input[key];
            const allowed = properties?.[key]?.enum;
            if (
              typeof value !== "string" ||
              !value.trim() ||
              value.length > 256 ||
              (allowed && !allowed.includes(value))
            )
              invalid(`${name} has an invalid optional ${key}`);
          }
          if (
            object(params["_meta"]) &&
            Object.hasOwn(params["_meta"], "fmcad")
          )
            invalid("Queue helpers do not accept fmcad metadata");
        }
        if (
          name === "execute_python" &&
          (typeof args["code"] !== "string" ||
            !args["code"].trim() ||
            args["persistent"] !== false)
        )
          invalid("Legacy Python requires nonempty code and persistent:false");
        if (
          name === "fusion_mcp_execute" &&
          (!["script", "document"].includes(String(args["featureType"])) ||
            !object(args["object"]))
        )
          invalid(
            "Legacy execute requires featureType script|document and object",
          );
        validating = false;
        return await options.compatibility(request, session, version);
      }
      let invocation: CatalogInvocation;
      let explicitProjectDirectory: string | undefined;
      if (name === "fmcad_execute") {
        const input = exact(
          args,
          ["operation", "data", "context"],
          "fmcad_execute arguments",
        );
        const context = exact(
          input["context"] ?? {},
          Object.keys(contextProperties),
          "context",
        );
        const {
          projectDirectory: selectedProjectDirectory,
          ...catalogContext
        } = context;
        explicitProjectDirectory =
          typeof selectedProjectDirectory === "string"
            ? selectedProjectDirectory
            : undefined;
        invocation = catalog.validate({
          version: 1,
          kind: "cad",
          operation: input["operation"],
          data: input["data"],
          ...catalogContext,
        } as CatalogInvocation);
      } else if (names.has(name))
        invocation = catalog.fromMcp(name, args).invocation;
      else invalid(`Unknown tool: ${name}`);
      const meta = params["_meta"];
      let requestId: string = randomUUID();
      let fmcadMetadata: RecordValue = {};
      if (meta !== undefined) {
        if (!object(meta)) invalid("_meta must be an object");
        if (meta["fmcad"] !== undefined) {
          const control = exact(
            meta["fmcad"],
            [
              "requestId",
              "description",
              "sequence",
              "expectedRevision",
              "projectDirectory",
              "roots",
              "sessionId",
              "doc",
              "docId",
              "docFileId",
              "projectId",
              "purpose",
            ],
            "_meta.fmcad",
          );
          fmcadMetadata = control;
          if (control["requestId"] !== undefined) {
            if (
              typeof control["requestId"] !== "string" ||
              !control["requestId"].trim() ||
              control["requestId"].length > 256
            )
              invalid("requestId must contain 1..256 characters");
            requestId = control["requestId"];
          }
          if (control["description"] !== undefined) {
            if (
              typeof control["description"] !== "string" ||
              !control["description"].trim()
            )
              invalid("description must be nonempty");
            if (
              invocation.purpose !== undefined &&
              invocation.purpose !== control["description"]
            )
              invalid("Conflicting purpose and description");
            invocation = catalog.validate({
              ...invocation,
              purpose: control["description"],
            });
          }
          if (
            control["projectDirectory"] !== undefined &&
            (typeof control["projectDirectory"] !== "string" ||
              !control["projectDirectory"].trim() ||
              control["projectDirectory"].length > 4096)
          )
            invalid("projectDirectory must contain 1..4096 characters");
          for (const key of [
            "doc",
            "docId",
            "docFileId",
            "projectId",
          ] as const) {
            if (
              control[key] !== undefined &&
              (typeof control[key] !== "string" ||
                !control[key].trim() ||
                control[key].length > 256)
            )
              invalid(`${key} must contain 1..256 characters`);
          }
          if (
            control["sessionId"] !== undefined &&
            (typeof control["sessionId"] !== "string" ||
              !control["sessionId"].trim() ||
              control["sessionId"].length > 256)
          )
            invalid("sessionId must contain 1..256 characters");
          if (
            options.clientContext &&
            control["sessionId"] !== undefined &&
            control["sessionId"] !== options.clientContext.identity.sessionId
          )
            invalid("sessionId is assigned by the MCP owner context");
          if (control["purpose"] !== undefined) {
            if (
              typeof control["purpose"] !== "string" ||
              !control["purpose"].trim()
            )
              invalid("purpose must be nonempty");
            if (
              invocation.purpose !== undefined &&
              invocation.purpose !== control["purpose"]
            )
              invalid("Conflicting purpose and metadata purpose");
            invocation = catalog.validate({
              ...invocation,
              purpose: control["purpose"],
            });
          }
          const metadataPins = [
            "doc",
            "docId",
            "docFileId",
            "projectId",
          ] as const;
          for (const key of metadataPins) {
            const supplied = control[key];
            if (supplied === undefined) continue;
            if (invocation[key] !== undefined && invocation[key] !== supplied)
              invalid(`Conflicting ${key} in operation context and metadata`);
            invocation = catalog.validate({ ...invocation, [key]: supplied });
          }
          if (
            control["expectedRevision"] !== undefined &&
            (!Number.isSafeInteger(control["expectedRevision"]) ||
              (control["expectedRevision"] as number) < 0)
          )
            invalid("expectedRevision must be a nonnegative safe integer");
          if (control["roots"] !== undefined) {
            if (
              !Array.isArray(control["roots"]) ||
              control["roots"].length > 32
            )
              invalid("roots must contain at most 32 entries");
            for (const [index, root] of control["roots"].entries()) {
              if (
                !object(root) ||
                Object.keys(root).some(
                  (key) => !["uri", "name"].includes(key),
                ) ||
                typeof root["uri"] !== "string" ||
                (root["name"] !== undefined && typeof root["name"] !== "string")
              )
                invalid(`roots[${index}] must contain a URI and optional name`);
            }
          }
        }
      }
      requestIdentity = requestId;
      const local = catalog.isLocal(invocation);
      const explicitProject =
        typeof fmcadMetadata["projectDirectory"] === "string"
          ? fmcadMetadata["projectDirectory"]
          : explicitProjectDirectory;
      if (
        explicitProjectDirectory !== undefined &&
        fmcadMetadata["projectDirectory"] !== undefined &&
        explicitProjectDirectory !== fmcadMetadata["projectDirectory"]
      )
        invalid("Conflicting projectDirectory in context and _meta.fmcad");
      const projectResolution = await options.clientContext?.resolveProject({
        ...(explicitProject !== undefined
          ? { projectDirectory: explicitProject }
          : {}),
        ...(Array.isArray(fmcadMetadata["roots"])
          ? {
              roots: fmcadMetadata["roots"] as {
                uri: string;
                name?: string;
              }[],
            }
          : {}),
      });
      const projectDirectory =
        projectResolution?.projectDirectory ??
        (options.clientContext ? null : (explicitProject ?? null));
      const identity = options.clientContext?.identity ?? {
        clientId: "mcp-local",
        instanceId: randomUUID(),
        sessionId: randomUUID(),
      };
      executionContext = createMcpExecutionContext({
        clientId: identity.clientId,
        sessionId:
          !options.clientContext &&
          typeof fmcadMetadata["sessionId"] === "string"
            ? fmcadMetadata["sessionId"]
            : identity.sessionId,
        requestId,
        projectDirectory,
        projectId: invocation.projectId ?? null,
        doc: invocation.doc ?? null,
        docId: invocation.docId ?? null,
        docFileId: invocation.docFileId ?? null,
        purpose: invocation.purpose ?? null,
        expectedRevision:
          typeof fmcadMetadata["expectedRevision"] === "number"
            ? fmcadMetadata["expectedRevision"]
            : null,
      });
      if (options.clientContext && !local && !executionContext.projectDirectory)
        invalid(
          "A validated projectDirectory is required for queued SDK execution; select a project or provide one validated MCP root",
        );
      if (!local && invocation.operation === "animation.play")
        invalid(
          "unsupported_queue_route: asynchronous animation.play has no terminal queue receipt",
        );
      if (
        object(meta) &&
        object(meta["fmcad"]) &&
        (meta["fmcad"]["sequence"] !== undefined ||
          meta["fmcad"]["expectedRevision"] !== undefined)
      ) {
        if (local)
          invalid(
            "Local operations do not accept queue sequence or revision metadata",
          );
        // Existing queue lease adapter retains typed worker payloads and its exact
        // document/purpose guards. No sequence semantics are invented in the API.
        const tool = projected.find(
          (tool) => tool._meta.fmcad.operation === invocation.operation,
        );
        if (!tool) invalid("Missing catalog projection");
        const argumentsValue: RecordValue = { ...invocation };
        delete argumentsValue["operation"];
        delete argumentsValue["version"];
        delete argumentsValue["kind"];
        validating = false;
        const metadata = {
          ...fmcadMetadata,
          ...(executionContext.projectDirectory
            ? { projectDirectory: executionContext.projectDirectory }
            : {}),
          sessionId: executionContext.sessionId,
        };
        return await options.compatibility(
          {
            ...request,
            params: {
              ...params,
              name: tool.name,
              arguments: argumentsValue,
              _meta: { ...meta, fmcad: metadata },
            },
          },
          session,
          version,
        );
      }
      validating = false;
      services = options.services(local, executionContext);
      if (!local) {
        try {
          await services.start();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            throw new Error(
              "FMCAD_BROKER_UNAVAILABLE: No running compatible fmcad broker; start it explicitly. No operation was submitted and no direct fallback was attempted.",
            );
          throw error;
        }
      }
      let receipt: ExecutionReceipt;
      admissionAttempted = !local;
      try {
        receipt = await services.execute(invocation, {
          requestId,
          ...(options.clientContext
            ? { sessionId: executionContext.sessionId }
            : {}),
          ...(executionContext.expectedRevision !== null
            ? { expectedRevision: executionContext.expectedRevision }
            : {}),
        });
      } catch (error) {
        if (local) throw error;
        try {
          const recovered = await services.query.request(requestId);
          if (recovered) {
            receipt = recovered;
            accepted = recovered;
          } else throw error;
        } catch (lookupError) {
          if (lookupError === error) throw error;
          throw Object.assign(
            new Error(
              "MCP admission acknowledgement is uncertain; inspect fmcad_queue_request with this requestId. Do not resubmit or cancel the SDK operation.",
            ),
            { code: "QUEUE_RESULT_UNAVAILABLE", cause: error },
          );
        }
      }
      accepted = receipt;
      // Keep the bounded synchronous completion window. Reads only; never replay
      // an active/unknown submission, and leave durable ownership with the broker.
      const deadline = Date.now() + 1000;
      let observed = false;
      while (
        receipt.jobId &&
        (!observed ||
          ["preparing", "processing", "queued", "running", "sending"].includes(
            receipt.state,
          )) &&
        Date.now() < deadline
      ) {
        observed = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          services.query.result(receipt.jobId),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(
              () => resolve(undefined),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]).finally(() => clearTimeout(timer));
        if (!next) break; // Stop observing, not the remote operation.
        receipt = next;
        accepted = receipt;
        if (
          ["preparing", "processing", "queued", "running", "sending"].includes(
            receipt.state,
          )
        )
          await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // An accepted receipt is not completion. Never resubmit or fabricate success.
      if (receipt.state === "succeeded" && receipt.result === null)
        throw new Error(
          "QUEUE_RESULT_UNAVAILABLE: Completed catalog output is unavailable; inspect the owned job, do not resubmit",
        );
      const pending = [
        "preparing",
        "processing",
        "queued",
        "running",
        "sending",
        "needs_reconciliation",
      ].includes(receipt.state);
      const value = receipt.result ?? {
        ...receipt,
        requestStatus: mcpRequestState(receipt.state),
        validation: receipt.outcome.validation,
        context: executionContext,
        ...(pending
          ? {
              status: receipt.state === "queued" ? "QUEUED" : "ACCEPTED",
              instruction:
                "Poll fmcad_queue_result with this jobId; do not resubmit this task.",
            }
          : {
              instruction:
                "Inspect this terminal receipt and owned diagnostics; no operation was resubmitted.",
            }),
      };
      const owner = receipt.jobId
        ? {
            queueReceipt: {
              jobId: receipt.jobId,
              requestId,
              state: receipt.state,
              requestStatus: mcpRequestState(receipt.state),
            },
            artifactOwner: {
              jobId: receipt.jobId,
              ...(executionContext.projectDirectory
                ? { cwd: executionContext.projectDirectory }
                : {}),
            },
          }
        : {};
      return reply(
        {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
          isError:
            ["failed", "cancelled", "expired"].includes(receipt.state) ||
            receipt.outcome.executionOutcome === "failed",
          ...(receipt.jobId
            ? {
                _meta: {
                  fmcad: {
                    clientId: executionContext.clientId,
                    instanceId: identity.instanceId,
                    sessionId: executionContext.sessionId,
                    requestId: executionContext.requestId,
                    jobId: receipt.jobId,
                    state: receipt.state,
                    requestStatus: mcpRequestState(receipt.state),
                    context: executionContext,
                    validation: receipt.outcome.validation,
                  },
                },
              }
            : {}),
        },
        owner,
      );
    } catch (error) {
      const failure = error as Error & {
        code?: number | string;
        boundary?: string;
        received?: unknown;
        supported?: unknown;
      };
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code:
              typeof failure.code === "number"
                ? failure.code
                : validating
                  ? -32602
                  : -32000,
            message: options.diagnostic?.(failure.message) ?? failure.message,
            ...(requestIdentity
              ? {
                  data: {
                    requestId: requestIdentity,
                    ...(typeof failure.code === "string"
                      ? { code: failure.code }
                      : {}),
                    ...(failure.boundary
                      ? {
                          compatibility: {
                            boundary: failure.boundary,
                            received: failure.received,
                            supported: failure.supported,
                          },
                        }
                      : {}),
                    ...(accepted
                      ? {
                          requestStatus: mcpRequestState(accepted.state),
                          ...(accepted.jobId ? { jobId: accepted.jobId } : {}),
                        }
                      : {
                          requestStatus:
                            admissionAttempted &&
                            (failure as Error & { notStarted?: boolean })
                              .notStarted !== true
                              ? "needs_reconciliation"
                              : "rejected-before-admission",
                          validation:
                            validating ||
                            (failure as Error & { notStarted?: boolean })
                              .notStarted === true
                              ? {
                                  status: "required",
                                  diagnostics: [failure.message],
                                }
                              : null,
                          ...(executionContext
                            ? { context: executionContext }
                            : {}),
                        }),
                    instruction:
                      "Observe the existing request/job; do not resubmit an uncertain operation.",
                    ...(accepted?.jobId
                      ? {
                          fmcad: {
                            jobId: accepted.jobId,
                            state: accepted.state,
                          },
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }),
      };
    }
  };
}

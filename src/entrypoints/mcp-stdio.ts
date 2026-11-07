import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import type { Readable, Writable } from "node:stream";
import type {
  CatalogMcpTool,
  CatalogServices,
  FmcadConfiguration,
  FmcadOptions,
  FmcadServices,
  McpClientContextPort,
  McpExecutionContext,
  McpProjectResolution,
  McpProjectSelection,
} from "../api";
import { createCatalogServices, createFmcad } from "../api";
import {
  createMcpApplication,
  type McpApplicationOptions,
  type McpRequest,
  type McpResponse,
} from "./mcp.js";
import {
  boundedDiagnosticLine,
  type InputFrame,
  type JsonRpcRequest,
  type OwnedMcpResultReporter,
} from "./mcp-framing.js";
import {
  createMcpStdioTransport,
  createOwnedMcpResponseWriter,
  createStdioFrameHandler,
  queueHelperRequest,
  type DurableBytesPort,
  type OwnedResponseStore,
  type StdioWritable,
} from "./mcp-stdio-transport.js";

const runtimeRequire = createRequire(__filename);
const runtimeModules = {
  config: runtimeRequire("../../config.js") as {
    loadConfig(options: ConfigSelection): { cfg: FmcadConfiguration };
  },
  invocation: runtimeRequire("../../invocation.js") as {
    parseInvocation(args: string[]): { argv: string[] };
  },
  queue: runtimeRequire("../../queue-client.js") as {
    QueueClient: QueueClientConstructor;
    defaultMcpClientId(): string;
    resolveMcpProjectDirectory(
      selection: McpProjectSelection,
    ): McpProjectResolution;
  },
  diagnostics: runtimeRequire("../../diagnostics.js") as {
    redactDiagnostic(
      message: string,
      config: Partial<FmcadConfiguration>,
    ): string;
  },
  i18n: runtimeRequire("../../i18n.js") as { t(key: string): string },
  queueConnection: runtimeRequire("../../queue-connection.js") as {
    queueDirectory(): string;
  },
  queueResponseFiles: runtimeRequire(
    "../../queue-response-files.js",
  ) as OwnedResponseStore,
  durableRecords: runtimeRequire(
    "../node-adapters/persistence/records.js",
  ) as DurableBytesPort,
  compatibility: runtimeRequire(
    "../../mcp-stdio-compat.js",
  ) as McpCompatibility,
};

interface ConfigSelection {
  backend?: string;
  routing?: string;
  timeout?: number;
}

interface QueueClientConstructor {
  new (
    clientId: string,
    options: { cfg: FmcadConfiguration; instanceId: string },
  ): unknown;
}

interface QueuePostContext {
  clientId: string;
  instanceId: string;
  sessionId: string;
  projectDirectory: string | null;
}

interface QueuePost {
  (
    request: McpRequest,
    session?: string,
    version?: string,
  ): Promise<McpResponse>;
  close?(): Promise<void>;
}

interface McpCompatibility {
  configureCatalogServices(
    catalog: CatalogServices,
    tools: readonly CatalogMcpTool[],
    contracts: ReturnType<CatalogServices["list"]>,
  ): void;
  readonly queueTools: McpApplicationOptions["queueTools"];
  readonly responseMessages: (raw: string) => unknown[];
  readonly createForwarder: (...args: never[]) => unknown;
  readonly createCatalogPost: (...args: never[]) => unknown;
  createQueuePost(
    client: unknown,
    config: FmcadConfiguration,
    queueTimeoutMs: number | undefined,
    context: QueuePostContext,
  ): QueuePost;
}

export interface McpStdioDependencies {
  loadConfig?(selection: ConfigSelection): { cfg: FmcadConfiguration };
  QueueClient?: QueueClientConstructor;
  createFmcad?(options: FmcadOptions): FmcadServices;
  createTelemetry?(): McpStdioTelemetry;
  onOwnedResult?: OwnedMcpResultReporter;
  stdin?: Readable;
  stdout?: StdioWritable;
  stderr?: Writable;
}

export interface McpStdioTelemetry {
  publishOwnedResult: OwnedMcpResultReporter;
  close(): Promise<void>;
}

function defaultMcpSessionId(clientId: string): string {
  return (
    "mcp-session:" +
    createHash("sha256").update(clientId).digest("hex").slice(0, 32)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compose the typed MCP application and stdio transport with broker adapters. */
export function startStdio(
  input: string[] = [],
  dependencies: McpStdioDependencies = {},
): { closed: Promise<PromiseSettledResult<void>[]> } | undefined {
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const args = runtimeModules.invocation.parseInvocation(input).argv;
  const { values } = parseArgs({
    args,
    options: {
      backend: { type: "string" },
      routing: { type: "string" },
      client: { type: "string" },
      "project-directory": { type: "string" },
      timeout: { type: "string" },
      "queue-timeout": { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (
    values.backend !== undefined &&
    !["mcp", "addin"].includes(values.backend)
  )
    throw new Error(
      `Invalid backend: ${values.backend} (expected mcp or addin)`,
    );
  if (values.help) {
    stdout.write(runtimeModules.i18n.t("mcpHelp") + "\n");
    return;
  }
  for (const name of ["timeout", "queue-timeout"] as const) {
    const value = values[name];
    if (
      value !== undefined &&
      (!/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) <= 0)
    )
      throw new Error(`--${name} must be a positive integer in milliseconds`);
  }
  const selection: ConfigSelection = {
    ...(values.backend !== undefined ? { backend: values.backend } : {}),
    ...(values.routing !== undefined ? { routing: values.routing } : {}),
    ...(values.timeout !== undefined
      ? { timeout: Number(values.timeout) }
      : {}),
  };
  if (values.routing !== undefined && values.routing !== "queue")
    throw new Error(
      "routing=direct is no longer supported; use the shared fmcad broker",
    );
  const clientId =
    values.client ??
    process.env["FMCAD_CLIENT"] ??
    runtimeModules.queue.defaultMcpClientId();
  const instanceId = randomUUID();
  const sessionId = defaultMcpSessionId(clientId);
  const configuredProjectDirectory =
    values["project-directory"] ?? process.env["FMCAD_PROJECT_DIRECTORY"];
  const validatedProjectDirectory =
    configuredProjectDirectory === undefined
      ? null
      : runtimeModules.queue.resolveMcpProjectDirectory({
          projectDirectory: configuredProjectDirectory,
        }).projectDirectory;
  const loadConfig =
    dependencies.loadConfig ?? runtimeModules.config.loadConfig;
  const QueueClient =
    dependencies.QueueClient ?? runtimeModules.queue.QueueClient;
  const makeServices = dependencies.createFmcad ?? createFmcad;
  let config: FmcadConfiguration | undefined;
  let queuePost: QueuePost | undefined;
  const localServices = new Map<string, FmcadServices>();
  const sdkServices = new Map<string, FmcadServices>();
  const diagnosticConfig: { routing: string; backend?: string } = {
    routing: "queue",
    ...(values.backend ? { backend: values.backend } : {}),
  };
  const configuration = (): FmcadConfiguration => {
    if (!config) {
      const candidate = loadConfig(selection).cfg;
      if (candidate.routing !== "queue")
        throw new Error(
          "routing=direct is no longer supported; use the shared fmcad broker",
        );
      config = candidate;
      Object.assign(diagnosticConfig, config);
    }
    return config;
  };
  const compatibility = (
    request: McpRequest,
    session?: string,
    version?: string,
  ): Promise<McpResponse> => {
    const cfg = configuration();
    if (!queuePost)
      queuePost = runtimeModules.compatibility.createQueuePost(
        new QueueClient(clientId, { cfg, instanceId }),
        cfg,
        values["queue-timeout"] !== undefined
          ? Number(values["queue-timeout"])
          : cfg.queue?.waitTimeoutMs,
        {
          clientId,
          instanceId,
          sessionId,
          projectDirectory: validatedProjectDirectory,
        },
      );
    return queuePost(request, session, version);
  };
  const services = (
    local: boolean,
    executionContext?: McpExecutionContext,
  ): FmcadServices => {
    const projectDirectory =
      executionContext?.projectDirectory ?? validatedProjectDirectory;
    const cache = local ? localServices : sdkServices;
    const cacheKey = projectDirectory ?? "";
    const previous = cache.get(cacheKey);
    if (previous) return previous;
    const service = makeServices({
      version: 1,
      config: local
        ? {
            backend: "addin",
            routing: "queue",
            url: "http://127.0.0.1:8765/mcp",
            headers: {},
            timeoutMs: 180000,
            tool: "execute_python",
            transport: "node",
            protocolVersion: "2025-06-18",
            queue: {},
            controlCenter: { port: 4748 },
          }
        : configuration(),
      context: {
        clientId,
        instanceId,
        sessionId: executionContext?.sessionId ?? sessionId,
        source: "mcp",
        ...(projectDirectory ? { projectDirectory } : {}),
      },
    });
    cache.set(cacheKey, service);
    return service;
  };
  const clientContext: McpClientContextPort = {
    identity: {
      clientId: clientId as McpClientContextPort["identity"]["clientId"],
      instanceId: instanceId as McpClientContextPort["identity"]["instanceId"],
      sessionId: sessionId as McpClientContextPort["identity"]["sessionId"],
    },
    async resolveProject(projectSelection: McpProjectSelection) {
      return runtimeModules.queue.resolveMcpProjectDirectory({
        ...(projectSelection.projectDirectory
          ? { projectDirectory: projectSelection.projectDirectory }
          : validatedProjectDirectory
            ? { projectDirectory: validatedProjectDirectory }
            : {}),
        ...(projectSelection.roots ? { roots: projectSelection.roots } : {}),
      });
    },
  };
  const resolveArtifactProject = async (
    request: JsonRpcRequest,
  ): Promise<string | null> => {
    const params = request.params ?? {};
    const metaValue = params["_meta"];
    const meta =
      isRecord(metaValue) && isRecord(metaValue["fmcad"])
        ? metaValue["fmcad"]
        : {};
    const argumentsValue = params["arguments"];
    const operationArguments = isRecord(argumentsValue) ? argumentsValue : {};
    const contextValue = operationArguments["context"];
    const operationContext = isRecord(contextValue) ? contextValue : {};
    const explicit =
      typeof operationContext["projectDirectory"] === "string"
        ? operationContext["projectDirectory"]
        : meta["projectDirectory"];
    const roots = meta["roots"];
    const resolution = await clientContext.resolveProject({
      ...(typeof explicit === "string" ? { projectDirectory: explicit } : {}),
      ...(Array.isArray(roots)
        ? { roots: roots as NonNullable<McpProjectSelection["roots"]> }
        : {}),
    });
    return resolution.projectDirectory;
  };
  // Build one immutable catalog projection for both typed and compatibility
  // routes, after help and argument validation have returned.
  const mcpCatalog = createCatalogServices();
  const mcpCatalogTools = mcpCatalog.tools();
  const mcpCatalogContracts = mcpCatalog.list();
  runtimeModules.compatibility.configureCatalogServices(
    mcpCatalog,
    mcpCatalogTools,
    mcpCatalogContracts,
  );
  const application = createMcpApplication({
    catalog: mcpCatalog,
    catalogTools: mcpCatalogTools,
    catalogContracts: mcpCatalogContracts,
    services,
    clientContext,
    compatibility,
    queueTools: runtimeModules.compatibility.queueTools,
    diagnostic: (message) =>
      runtimeModules.diagnostics.redactDiagnostic(message, config ?? {}),
  });
  let telemetry: McpStdioTelemetry | undefined;
  try {
    telemetry = dependencies.createTelemetry?.();
  } catch {
    try {
      stderr.write(
        "fmcad: passive telemetry unavailable; MCP remains available.\n",
      );
    } catch {
      // Telemetry diagnostics must not affect MCP or CAD execution.
    }
  }
  const onOwnedResult =
    telemetry?.publishOwnedResult ?? dependencies.onOwnedResult;
  const externalize = createOwnedMcpResponseWriter({
    directory: runtimeModules.queueConnection.queueDirectory(),
    store: runtimeModules.queueResponseFiles,
    durable: runtimeModules.durableRecords,
    ...(onOwnedResult ? { onOwnedResult } : {}),
    resolveProject: resolveArtifactProject,
  });
  // The input handler needs the writer created by the transport below.
  // eslint-disable-next-line prefer-const
  let forward!: (frame: InputFrame) => Promise<void>;
  const transport = createMcpStdioTransport({
    input: stdin,
    output: stdout,
    handle: (frame) => forward(frame),
    isConcurrent: queueHelperRequest,
    externalize,
    ...(onOwnedResult ? { onOwnedResult } : {}),
    onDiagnostic: (line) => {
      try {
        stderr.write(line + "\n");
      } catch {
        // Diagnostics must never write to or interrupt MCP stdout.
      }
    },
  });
  forward = createStdioFrameHandler(transport.writer, application, {
    queueTools: runtimeModules.compatibility.queueTools,
    backend:
      diagnosticConfig.backend === "mcp" || diagnosticConfig.backend === "addin"
        ? diagnosticConfig.backend
        : "unknown",
    routing: "queue",
    log: (record) => {
      try {
        stderr.write(boundedDiagnosticLine(record) + "\n");
      } catch {
        // Diagnostics must never write to or interrupt MCP stdout.
      }
    },
  });
  const closed = transport.closed.then(() =>
    Promise.allSettled([
      Promise.resolve().then(() => queuePost?.close?.()),
      Promise.resolve().then(() => telemetry?.close()),
      ...[...localServices.values()].map((service) =>
        Promise.resolve().then(() => service.dispose()),
      ),
      ...[...sdkServices.values()].map((service) =>
        Promise.resolve().then(() => service.dispose()),
      ),
    ]),
  );
  return { closed };
}

export const responseMessages = runtimeModules.compatibility.responseMessages;
export const createForwarder = runtimeModules.compatibility.createForwarder;
export const createCatalogPost = runtimeModules.compatibility.createCatalogPost;

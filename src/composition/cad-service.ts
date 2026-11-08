import path from "node:path";
import { createRequire } from "node:module";
import type {
  CatalogInvocation,
  CadWorkerInvocation,
  ParsedCadWorkerCommand,
  OperationDeclaration,
  DiagnosticBackend,
  PythonArtifactManifest,
  RunCommandReply,
  RunCommandServices,
} from "@fmcad/core";
import type { NativeActionReply } from "../../packages/node-adapters/src/python/native-actions.js";
import type { RunScriptOptions } from "../../packages/node-adapters/src/python/run-script.js";
import type { CadClient, CadInternal } from "./cad-execution.js";

const load = createRequire(__filename);
const application = load(
  "../core/application/cad/worker-command.js",
) as typeof import("../../packages/core/src/application/cad/worker-command.js");
const catalog = load("../../catalog/index.js") as {
  catalog: Record<string, OperationDeclaration>;
  validateInvocation(value: unknown): CatalogInvocation;
};
const catalogExecution = load(
  "./catalog-execution.js",
) as typeof import("./catalog-execution.js");
const run = load("./run.js") as typeof import("./run.js");
const invocation = load(
  "../node-adapters/execution/invocation.js",
) as typeof import("../../packages/node-adapters/src/execution/invocation.js");
const core = load(
  "../core/index.js",
) as typeof import("../../packages/core/src/index.js");

export interface CommandBackend extends CadClient {
  server?: DiagnosticBackend & { timeoutMs?: number; backend?: string };
  capabilities?: { backend?: string; brokerSdkProbePort?: unknown };
  callTool(
    request: {
      featureType: "script";
      object: { script: string; readOnly?: boolean };
    },
    tool?: string,
    manifest?: PythonArtifactManifest,
  ): Promise<RunCommandReply & NativeActionReply>;
}
interface Writer {
  write(value: string): unknown;
}
export interface CommandInternal extends Omit<
  CadInternal,
  "stageDependencies"
> {
  stageDependencies?: NonNullable<CadInternal["stageDependencies"]> & {
    helper?: NonNullable<RunCommandServices["helperStages"]>;
  };
}

/** Caller-side conversion after parsing; workers consume only the typed payload. */
export function fromParsedCommand(
  command: ParsedCadWorkerCommand,
  options: RunScriptOptions = {},
) {
  let payload: unknown;
  if (command.kind === "cad") {
    const context = command.context || {};
    const value: Record<string, unknown> = {
      version: 1,
      kind: "cad",
      operation: command.operation,
      data: command.data,
    };
    for (const key of [
      "doc",
      "docId",
      "docFileId",
      "component",
      "projectId",
      "preview",
    ] as const)
      if (context[key] !== undefined && context[key] !== null)
        value[key] = context[key];
    if (command.purpose !== undefined) value["purpose"] = command.purpose;
    payload = {
      version: 1,
      kind: "cad-command",
      invocation: catalog.validateInvocation(value),
      output: {
        json: command.json === true,
        summary: command.summary === true,
      },
    };
  } else if (command.kind === "run") {
    const readOnlyOperations = Object.entries(catalog.catalog)
      .filter(([, spec]) => spec.readOnly)
      .map(([name]) => name);
    const request = {
      ...command.request,
      identity: { ...command.request.identity },
      name: run.resolveScript(command.request.name, options),
      readOnlyOperations:
        command.request.readOnlyOperations ??
        (command.request.helperVersion === "cad-v1" &&
        command.request.identity?.readOnly !== true
          ? []
          : readOnlyOperations),
    };
    payload = {
      version: 1,
      kind: "run",
      request,
      ...(command.purpose === undefined ? {} : { purpose: command.purpose }),
      ...(command.output === undefined
        ? {}
        : {
            output: {
              ...command.output,
              ...(command.output.path === undefined
                ? {}
                : { path: path.resolve(command.output.path) }),
            },
          }),
    };
  } else
    throw new Error("fromParsedCommand supports parsed CAD/batch and run only");
  const decoded = application.decodeCadWorkerInvocation(payload);
  return {
    payload: decoded,
    argv: application.cadWorkerPolicyArguments(decoded),
  };
}

export async function execute(
  request: { payload: unknown; argv?: unknown },
  backend: CommandBackend | null | undefined,
  onOutcome: (value: unknown) => void = () => {},
  io: { stdout?: Writer; stderr?: Writer } = {},
  internal: CommandInternal = {},
): Promise<number> {
  const stdout = io.stdout || process.stdout,
    stderr = io.stderr || process.stderr;
  const payload: CadWorkerInvocation = application.decodeCadWorkerInvocation(
    request.payload,
  );
  if (
    request.argv !== undefined &&
    JSON.stringify(request.argv) !==
      JSON.stringify(application.cadWorkerPolicyArguments(payload))
  )
    throw Object.assign(
      new Error("Typed CAD/run invocation differs from broker guard metadata"),
      { code: "INVALID_REQUEST" },
    );
  if (payload.kind === "cad" || payload.kind === "cad-command") {
    const value = payload.kind === "cad" ? payload : payload.invocation;
    const result = await catalogExecution.executeInvocation(
      value,
      backend,
      onOutcome,
      internal,
    );
    const output =
      payload.kind === "cad-command" ? payload.output : { json: true };
    const spec = catalog.catalog[value.operation]!;
    stdout.write(
      !output?.json && (output?.summary || spec["textSummary"])
        ? core.formatBatchSummary(result)
        : JSON.stringify(result, null, output?.json ? 0 : 2) + "\n",
    );
    return catalogExecution.invocationFailed(result, value.operation) ? 1 : 0;
  }
  if (!backend) throw new Error("Run command requires a backend");
  const publication = load(
    "../node-adapters/persistence/publish.js",
  ) as typeof import("../../packages/node-adapters/src/persistence/publish.js");
  const python = load(
    "../../python.js",
  ) as typeof import("../../packages/node-adapters/src/python/context-binding.js");
  return invocation.context.run({ description: payload.purpose }, async () => {
    try {
      const helperStages = internal.stageDependencies?.helper;
      const result = await application.executeRunCommand(payload, {
        ...(helperStages ? { helperStages } : {}),
        prepare: (input, trustedStageContext) =>
          run.prepareRunScript(
            input.name,
            input.args,
            input.hasArgs,
            input.doc || "",
            input.identity,
            input.helperVersion,
            input.readOnlyOperations,
            { trustedStageContext },
          ),
        execution: {
          execute: (turn) =>
            backend.callTool(
              {
                featureType: "script",
                object: {
                  script: turn.artifact.script,
                  ...(turn.readOnly ? { readOnly: true } : {}),
                },
              },
              "fusion_mcp_execute",
              python.pythonArtifactManifest(turn.artifact),
            ),
        },
        checkOutput: publication.checkPublishTarget,
        publish: publication.publishComplete,
        outcome: onOutcome,
        redact: (text) => core.redactDiagnostic(text, backend.server),
        backend:
          backend.capabilities?.backend ?? backend.server?.backend ?? "mcp",
      });
      stdout.write(result.stdout);
      if (result.stderr) stderr.write(result.stderr);
      return result.code;
    } catch (error) {
      const fields = core.record(error) ? error : {};
      if (typeof fields["stdout"] === "string" && fields["stdout"])
        stdout.write(fields["stdout"]);
      const message =
        typeof fields["message"] === "string"
          ? fields["message"]
          : String(error);
      stderr.write(
        core.redactDiagnostic("ERROR " + message + "\n", backend.server),
      );
      return 1;
    }
  });
}

export const decodeInvocation = application.decodeCadWorkerInvocation;
export const policyArguments = application.cadWorkerPolicyArguments;

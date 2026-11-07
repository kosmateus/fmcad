import {
  decodeCatalogInvocation,
  catalogPolicyArguments,
  type CatalogInvocation,
} from "../../catalog/invocation";
import type { PreparedPythonArtifact } from "../../domain/python-artifact";
import { failedOutcome } from "../../domain/outcome";
import {
  record,
  type CadOutput,
  type CadContext,
  type CadData,
  type CadExecutionRequest,
  type CadExecutionReply,
} from "./contracts";
import { canonical } from "./json";
import { formatRunOutput, validateRunRequest, type RunRequest } from "./run";

export interface RunInvocation {
  version: 1;
  kind: "run";
  request: RunRequest;
  purpose?: string;
  output?: { path?: string; format?: "text" | "json"; pretty?: boolean };
}
export interface CadCommandInvocation {
  version: 1;
  kind: "cad-command";
  invocation: CatalogInvocation;
  output?: { json?: boolean; summary?: boolean };
}
export type CadWorkerInvocation =
  CatalogInvocation | CadCommandInvocation | RunInvocation;
/** Already parsed by a CLI/MCP/library entrypoint, never created in a worker. */
export type ParsedCadWorkerCommand =
  | {
      kind: "cad";
      operation: string;
      data: CadData;
      context: CadContext;
      purpose?: string;
      json?: boolean;
      summary?: boolean;
    }
  | {
      kind: "run";
      request: Omit<RunRequest, "readOnlyOperations"> & {
        readOnlyOperations?: readonly string[];
      };
      purpose?: string;
      output?: RunInvocation["output"];
    };
function fields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`Unknown ${label} field`);
}
export function decodeCadWorkerInvocation(value: unknown): CadWorkerInvocation {
  if (!record(value) || value["version"] !== 1)
    throw new Error(
      "Versioned CAD/run worker payload required; argv is not executable input",
    );
  if (value["kind"] === "cad") return decodeCatalogInvocation(value);
  if (value["kind"] === "cad-command") {
    fields(value, ["version", "kind", "invocation", "output"], "CAD command");
    decodeCatalogInvocation(value["invocation"]);
    if (value["output"] !== undefined) {
      const output = value["output"];
      if (!record(output))
        throw new Error("CAD command output must be an object");
      fields(output, ["json", "summary"], "CAD command output");
      for (const key of ["json", "summary"])
        if (output[key] !== undefined && typeof output[key] !== "boolean")
          throw new Error(`${key} must be boolean`);
    }
    return value as unknown as CadCommandInvocation;
  }
  if (value["kind"] !== "run")
    throw new Error("Unsupported typed CAD/run worker payload");
  fields(
    value,
    ["version", "kind", "request", "purpose", "output"],
    "run invocation",
  );
  const request = value["request"];
  if (!record(request)) throw new Error("Run request must be an object");
  fields(
    request,
    [
      "name",
      "args",
      "hasArgs",
      "doc",
      "identity",
      "helperVersion",
      "readOnlyOperations",
    ],
    "run request",
  );
  if (
    typeof request["name"] !== "string" ||
    !request["name"] ||
    typeof request["hasArgs"] !== "boolean" ||
    !record(request["identity"]) ||
    !Array.isArray(request["readOnlyOperations"]) ||
    request["readOnlyOperations"].some(
      (operation) => typeof operation !== "string",
    )
  )
    throw new Error("Invalid typed run request");
  if (request["doc"] !== undefined && typeof request["doc"] !== "string")
    throw new Error("Run doc must be a string");
  if (
    request["helperVersion"] !== undefined &&
    typeof request["helperVersion"] !== "string"
  )
    throw new Error("Run helperVersion must be a string");
  fields(
    request["identity"],
    ["docId", "docFileId", "readOnly"],
    "run identity",
  );
  if (
    request["identity"]["readOnly"] !== undefined &&
    typeof request["identity"]["readOnly"] !== "boolean"
  )
    throw new Error("Run readOnly must be boolean");
  canonical(request["args"]);
  validateRunRequest(request as unknown as RunRequest);
  if (value["purpose"] !== undefined)
    decodeCatalogInvocation({
      version: 1,
      kind: "cad",
      operation: "run",
      data: {},
      purpose: value["purpose"],
    });
  if (value["output"] !== undefined) {
    const output = value["output"];
    if (!record(output)) throw new Error("Run output must be an object");
    fields(output, ["path", "format", "pretty"], "run output");
    if (
      output["path"] !== undefined &&
      (typeof output["path"] !== "string" || !output["path"])
    )
      throw new Error("Run output path must be a nonempty string");
    if (
      output["format"] !== undefined &&
      output["format"] !== "text" &&
      output["format"] !== "json"
    )
      throw new Error("Run output format must be text or json");
    if (output["pretty"] !== undefined && typeof output["pretty"] !== "boolean")
      throw new Error("Run output pretty must be boolean");
    if (
      (output["format"] !== undefined || output["pretty"] !== undefined) &&
      output["path"] === undefined
    )
      throw new Error("Run output format and pretty require path");
    if (output["pretty"] !== undefined && output["format"] !== "json")
      throw new Error("Run pretty requires JSON format");
  }
  return value as unknown as RunInvocation;
}
/** Caller-side projection for existing broker guards; workers never parse it. */
export function cadWorkerPolicyArguments(value: CadWorkerInvocation): string[] {
  if (value.kind === "cad") return catalogPolicyArguments(value);
  if (value.kind === "cad-command")
    return catalogPolicyArguments(value.invocation);
  const request = value.request;
  const args = ["run", request.name];
  for (const [key, flag] of [
    ["docId", "--doc-id"],
    ["docFileId", "--doc-file-id"],
  ] as const) {
    const identity = request.identity[key];
    if (identity !== undefined) args.push(flag, identity);
  }
  if (request.doc) args.push("--doc", request.doc);
  if (request.identity.readOnly) args.push("--readonly");
  if (request.helperVersion) args.push("--helpers", request.helperVersion);
  return args;
}
export interface RunCommandReply extends CadExecutionReply {
  stderr?: string;
  data?: unknown;
  uiGuard?: CadOutput;
}
export interface RunCommandServices {
  prepare(
    request: RunRequest,
    trustedStageContext?: unknown,
  ): PreparedPythonArtifact;
  trustedStageContext?: unknown;
  execution: {
    execute(request: CadExecutionRequest): Promise<RunCommandReply>;
  };
  checkOutput(path: string): Promise<void>;
  publish(path: string, text: string): Promise<void>;
  outcome(value: unknown): void;
  redact(value: string): string;
  backend: string;
  helperStages?: {
    context(): unknown;
    plan(): void | Promise<void>;
    started(): void | Promise<void>;
  };
}
export interface WorkerCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  result?: unknown;
}
/** Batch report versions are not OperationResult DTO versions. Keep their exit
 * policy distinct without weakening unknown-version rejection for either family. */
export function cadCommandFailed(result: unknown, operation: string): boolean {
  if (
    record(result) &&
    ["batch.run", "definition.instantiate"].includes(operation) &&
    result["operation"] === operation &&
    (result["version"] === 1 || result["version"] === 2)
  )
    return result["success"] !== true || result["status"] !== "success";
  return (
    failedOutcome(result) ||
    (["batch.reconcile", "batch.finalize"].includes(operation) &&
      record(result) &&
      result["outcome"] === "unknown")
  );
}
export async function executeRunCommand(
  input: RunInvocation,
  services: RunCommandServices,
): Promise<WorkerCommandResult> {
  const { request, output } = input;
  if (output?.path !== undefined) await services.checkOutput(output.path);
  if (request.helperVersion && services.helperStages)
    await services.helperStages.plan();
  const trustedStageContext =
    request.helperVersion && services.helperStages
      ? services.helperStages.context()
      : services.trustedStageContext;
  const artifact = services.prepare(request, trustedStageContext);
  if (request.helperVersion && services.helperStages)
    await services.helperStages.started();
  const out: RunCommandReply = await services.execution.execute({
    operation: "run",
    artifact,
    readOnly: request.identity.readOnly === true,
    context: {
      ...(request.doc === undefined ? {} : { doc: request.doc }),
      ...(request.identity.docId === undefined
        ? {}
        : { docId: request.identity.docId }),
      ...(request.identity.docFileId === undefined
        ? {}
        : { docFileId: request.identity.docFileId }),
    },
  });
  if (out.data) services.outcome(out.data);
  if (out.uiGuard) {
    const notStarted =
      out.uiGuard["status"] === "rejected-before-mutation" &&
      out.uiGuard["notStarted"] === true;
    return {
      code: 1,
      stdout:
        JSON.stringify(
          {
            success: false,
            operation: "run",
            status: out.uiGuard["status"],
            script: request.name,
            userCodeSubmitted: notStarted ? false : null,
            activeCommand: out.uiGuard["activeCommand"] ?? null,
            activeCommandIdentityAvailable:
              out.uiGuard["identityAvailable"] === true,
            originalOperationOutcome: "notEvaluated",
            suggestedRecovery: ["ui.inspect", "ui.resolve"],
            limitations: [
              notStarted
                ? "This receipt proves only that this new script was rejected before user code; it does not resolve any underlying pending/unknown operation."
                : "This receipt does not establish whether user code started. Inspect the original operation before another run; no retry is automatic.",
            ],
          },
          null,
          2,
        ) + "\n",
      stderr: "",
    };
  }
  const text = out.text || "";
  const stderr =
    (request.identity.readOnly && services.backend === "addin"
      ? "WARNING: addin does not enforce a read-only sandbox; --readonly is a declaration only.\n"
      : "") + (out.stderr && !out.failed ? services.redact(out.stderr) : "");
  if (output?.path !== undefined && !out.failed) {
    try {
      await services.publish(
        output.path,
        formatRunOutput(text, output.format, output.pretty),
      );
    } catch (error) {
      throw Object.assign(
        new Error(
          `Run output was not confirmed published: ${error instanceof Error ? error.message : String(error)}. Script may have mutated Fusion; inspect before another run. No automatic retry.`,
        ),
        { stdout: text + "\n" },
      );
    }
  }
  return { code: out.failed ? 1 : 0, stdout: text + "\n", stderr };
}

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  PreparedPythonArtifact,
  PythonChecker,
  PythonCheckReport,
  PythonCheckRequest,
} from "@fmcad/core";
import { requirePythonAdmission } from "@fmcad/core";
import { verifyPythonArtifact } from "./artifact.js";
import { prepareWireArtifact } from "./source-units.js";
import { pythonUnitContexts } from "./context-binding.js";

type Rpc = Record<string, unknown>;
function object(value: unknown): Rpc {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rpc)
    : {};
}
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
const reject = (message: string): never => {
  throw Object.assign(new Error(message), {
    code: "PYTHON_ADMISSION_CHANGED",
    notStarted: true,
    executionOutcome: "not_started",
    userScriptSubmitted: false,
    mayHaveMutated: false,
  });
};

/** Closed classification. An unknown tool is not proof that it carries no code. */
export function classifyPythonRpc(
  payload: Rpc,
):
  | { kind: "python"; source: string; official: boolean }
  | { kind: "non-python" } {
  if (
    [
      "initialize",
      "notifications/initialized",
      "ping",
      "tools/list",
      "resources/list",
      "resources/templates/list",
    ].includes(
      String(payload["method"]),
    )
  )
    return { kind: "non-python" };
  const params = object(payload["params"]);
  const args = object(params["arguments"]);
  const name = params["name"];
  if (payload["method"] === "tools/call") {
    const official =
      name === "fusion_mcp_execute" && args["featureType"] === "script";
    if (name === "execute_python" || official) {
      const source = official ? object(args["object"])["script"] : args["code"];
      if (typeof source !== "string" || !source.trim())
        return reject("Missing final Python source");
      return { kind: "python", source, official };
    }
    if (
      [
        "fusion_mcp_read",
        "fetch_api_documentation",
        "fetch_design_guide",
        "capture_viewport",
        "get_viewport",
      ].includes(String(name)) ||
      (name === "fusion_mcp_execute" && args["featureType"] === "document")
    )
      return { kind: "non-python" };
  }
  return reject("RPC has no explicit non-Python classification");
}

/** Content, not mtimes. Checked resources cannot be replaced during a pause.
 * Directory inventory is included, so added/removed stubs invalidate evidence. */
export function pythonAdmissionResources(roots: readonly string[]): string {
  const hash = createHash("sha256");
  const visit = (file: string): void => {
    const stat = lstatSync(file);
    hash.update(JSON.stringify([file, stat.isDirectory(), stat.size]));
    if (stat.isSymbolicLink()) reject("Checker resources must not be symlinks");
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(join(file, name));
    } else if (stat.isFile()) hash.update(readFileSync(file));
    else reject("Unsupported checker resource");
  };
  roots.forEach(visit);
  return hash.digest("hex");
}

export interface PythonRpcAdmissionOptions {
  readonly runtime: string;
  readonly checker: PythonChecker;
  /** Explicit test port; production binds the engine, helper and definitions. */
  readonly resources?: () => string;
}
export interface PythonRpcCertificate {
  readonly kind: "python" | "non-python";
  readonly artifact?: PreparedPythonArtifact;
  readonly report?: PythonCheckReport;
  /** Synchronous final boundary. Never checks again or rewrites wire bytes. */
  fence(payload: Rpc): void;
}

export function createPythonRpcAdmission(options: PythonRpcAdmissionOptions) {
  const resources =
    options.resources ??
    (() =>
      pythonAdmissionResources([
        join(options.runtime, "typing"),
        dirname(require.resolve("basedpyright/package.json")),
      ]));
  const verifyResources = (expected: string): void => {
    let current: string;
    try {
      current = resources();
    } catch {
      return reject("Checker/stubs/context unavailable after analysis");
    }
    if (current !== expected)
      reject("Checker/stubs/context changed after analysis");
  };
  return {
    async check(
      payload: Rpc,
      prepared?: PreparedPythonArtifact,
      checkOptions: { readonly signal?: AbortSignal } = {},
    ): Promise<PythonRpcCertificate> {
      // Snapshot before any await; caller mutations cannot become checked bytes.
      const identity = JSON.stringify(payload);
      const classification = classifyPythonRpc(payload);
      if (classification.kind === "non-python") {
        return Object.freeze({
          kind: "non-python",
          fence(current: Rpc) {
            if (JSON.stringify(current) !== identity)
              reject("Non-Python RPC changed after classification");
          },
        });
      }
      const artifact = prepared
        ? freezeSnapshot(structuredClone(prepared))
        : prepareWireArtifact(options.runtime, classification.source);
      verifyPythonArtifact(artifact);
      if (artifact.script !== classification.source)
        reject("Prepared artifact differs from final wire source");
      const request: PythonCheckRequest = Object.freeze({
        artifact,
        context: Object.freeze({
          kind: "raw",
          ...(classification.official ? { entrypoint: "run" as const } : {}),
        }),
        unitContexts: pythonUnitContexts(artifact),
      });
      let resourceIdentity: string;
      let report: PythonCheckReport;
      try {
        resourceIdentity = resources();
        report = freezeSnapshot(
          JSON.parse(
            JSON.stringify(await options.checker.check(request, checkOptions)),
          ) as PythonCheckReport,
        );
      } catch (error) {
        const pythonCheck: PythonCheckReport = {
          status: "tool_error",
          diagnostics: [],
          reasons: [String(error)],
          provenance: {
            artifactHash: artifact.artifactHash,
            wireHash: artifact.sha256,
            checker: "basedpyright",
            checkerVersion: "1.40.2",
            checkerHash: null,
            pythonVersion: "3.11",
            pythonInterpreterVersion: null,
            definitionsHash: null,
            contextHash: createHash("sha256")
              .update(JSON.stringify(request.context))
              .digest("hex"),
            configHash: null,
            typingHash: null,
            analysisHash: null,
            cache: "disabled",
          },
        };
        throw Object.assign(
          new Error("Python checker unavailable or failed", { cause: error }),
          {
            code: "PYTHON_CHECK_TOOL_ERROR",
            executionOutcome: "not_started",
            mayHaveMutated: false,
            notStarted: true,
            pythonCheck,
          },
        );
      }
      requirePythonAdmission(artifact, report);
      if (JSON.stringify(payload) !== identity)
        reject("Final RPC changed during Python analysis");
      verifyResources(resourceIdentity);
      return Object.freeze({
        kind: "python",
        artifact,
        report,
        fence(current: Rpc) {
          verifyPythonArtifact(artifact);
          if (JSON.stringify(current) !== identity)
            reject("Final RPC changed after Python analysis");
          verifyResources(resourceIdentity);
        },
      });
    },
  };
}

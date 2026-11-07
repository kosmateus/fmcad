import { randomUUID } from "node:crypto";
import { BrokerMcpClient } from "./mcp.js";
import { ADDIN_CAPABILITIES } from "./addin-capabilities.js";
import { buildBridgeScript } from "./bridge.js";
import { object, unknownOutcome } from "./contracts.js";
import type { PythonArtifactManifest } from "@fmcad/core";
import { bindPythonArtifactManifest } from "../python/context-binding.js";
import type {
  Dependencies,
  ObjectValue,
  Server,
  ToolResult,
  PreparedToolCall,
} from "./contracts.js";

export { ADDIN_CAPABILITIES };

export class BrokerAddinClient extends BrokerMcpClient {
  readonly capabilities = ADDIN_CAPABILITIES;
  #session: Promise<string | undefined> | undefined;
  constructor(server: Server, dependencies: Dependencies) {
    super(
      { ...server, protocolVersion: server.protocolVersion ?? "2025-06-18" },
      dependencies,
    );
  }
  override _openSession(): Promise<string | undefined> {
    // Reuse even a rejected promise. Failed initialization must not silently retry.
    return (this.#session ??= super._openSession());
  }
  async #prepareScript(
    script: unknown,
    readOnly = false,
    bridge = false,
    guardedUiRoute = false,
    origin?: PythonArtifactManifest,
  ): Promise<PreparedToolCall> {
    if (typeof script !== "string" || !script.trim())
      throw new Error("A nonempty Python script is required");
    if (origin) origin = bindPythonArtifactManifest(script, origin);
    const guardToken = guardedUiRoute ? null : randomUUID();
    const guard =
      readOnly || guardedUiRoute
        ? ""
        : `import adsk.core as _fmcad_guard_core
import json as _fmcad_guard_json
_fmcad_guard_token = ${JSON.stringify(guardToken)}
_fmcad_guard_ui = _fmcad_guard_core.Application.get().userInterface
try:
    _fmcad_guard_command = _fmcad_guard_ui.activeCommand
except Exception as _fmcad_guard_error:
    print('FMCAD_UI_GUARD ' + _fmcad_guard_token + ' ' + _fmcad_guard_json.dumps({'status':'rejected-before-mutation','notStarted':True,'activeCommand':None,'identityAvailable':False,'error':type(_fmcad_guard_error).__name__}))
    raise RuntimeError('Interactive-command identity unavailable; user script not started. Inspect UI state; no retry is automatic.')
if _fmcad_guard_command not in ('', 'SelectCommand'):
    print('FMCAD_UI_GUARD ' + _fmcad_guard_token + ' ' + _fmcad_guard_json.dumps({'status':'rejected-before-mutation','notStarted':True,'activeCommand':_fmcad_guard_command,'identityAvailable':True}))
    raise RuntimeError('An interactive Fusion command is open (' + _fmcad_guard_command + '); user script not started. Use ui.inspect then authorized ui.resolve; no retry is automatic.')
`;
    const send = await super.prepareWireCall(
      { code: guard + script + '\n\nrun("")\n', persistent: false },
      "execute_python",
      origin,
    );
    const execute = async (): Promise<ToolResult> => {
      const output = await send();
      let decoded: unknown = output.data;
      if (!decoded) {
        try {
          decoded = JSON.parse(output.text) as unknown;
        } catch {
          /* Validate below. */
        }
      }
      const payload = object(decoded);
      if (
        typeof payload["success"] !== "boolean" ||
        typeof payload["stdout"] !== "string"
      )
        throw new Error(
          "Malformed add-in execution response; operation may have run. Inspect before retrying.",
        );
      const stdout = payload["stdout"];
      const failed =
        output.failed || !payload["success"] || /^ERROR /m.test(stdout);
      const text = failed
        ? [stdout, payload["error"], payload["traceback"], payload["stderr"]]
            .filter(Boolean)
            .join("\n")
        : stdout;
      let uiGuard: unknown = null;
      if (guardToken) {
        const prefix = "FMCAD_UI_GUARD " + guardToken + " ";
        const guardLine = stdout
          .split(/\r?\n/)
          .find((value) => value.startsWith(prefix));
        if (guardLine) {
          try {
            uiGuard = JSON.parse(guardLine.slice(prefix.length)) as unknown;
          } catch {
            uiGuard = {
              status: "unknown",
              notStarted: false,
              identityAvailable: false,
            };
          }
        }
      }
      const line = bridge
        ? text
            .split(/\r?\n/)
            .find((value) => value.startsWith("FMCAD_BRIDGE_RESULT "))
        : undefined;
      if (bridge && !failed && !line)
        throw new Error(
          "Missing add-in bridge result; inspect before retrying.",
        );
      let data: unknown = null;
      if (line) {
        try {
          data = JSON.parse(
            line.slice("FMCAD_BRIDGE_RESULT ".length),
          ) as unknown;
        } catch {
          throw unknownOutcome("Malformed add-in bridge result", "EPROTO");
        }
      }
      return {
        text: data ? JSON.stringify(data) : text,
        data,
        failed: failed || object(data)["success"] === false,
        ...(uiGuard ? { uiGuard } : {}),
        stderr: payload["stderr"],
        backend: "addin",
        readOnlyRequested: readOnly,
        readOnlyEnforced: false,
      };
    };
    return Object.assign(execute, { fence: () => send.fence() });
  }
  executeUiGuardedScript(
    script: string,
    origin?: PythonArtifactManifest,
  ): Promise<ToolResult> {
    return this.prepareUiGuardedScript(script, origin).then((send) => send());
  }
  prepareUiGuardedScript(
    script: string,
    origin?: PythonArtifactManifest,
  ): Promise<PreparedToolCall> {
    return this.#prepareScript(script, false, false, true, origin);
  }

  override async callTool(
    request: ObjectValue,
    toolName = "fusion_mcp_execute",
    origin?: PythonArtifactManifest,
  ): Promise<ToolResult> {
    return (await this.prepareCallTool(request, toolName, origin))();
  }
  override async prepareCallTool(
    request: ObjectValue,
    toolName = "fusion_mcp_execute",
    origin?: PythonArtifactManifest,
  ): Promise<PreparedToolCall> {
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new TypeError("Tool request must be a non-null object");
    if (
      origin &&
      toolName !== "execute_python" &&
      !(
        toolName === "fusion_mcp_execute" && request["featureType"] === "script"
      )
    )
      throw new Error("Source inventory requires a Python tool payload");
    if (
      toolName === "fusion_mcp_execute" &&
      request["featureType"] === "script"
    ) {
      if (
        !request["object"] ||
        typeof request["object"] !== "object" ||
        Array.isArray(request["object"])
      )
        throw new TypeError("Script object must be a non-null object");
      const value = object(request["object"]);
      if (
        Object.hasOwn(value, "readOnly") &&
        typeof value["readOnly"] !== "boolean"
      )
        throw new TypeError("readOnly must be boolean");
      return this.#prepareScript(
        value["script"],
        value["readOnly"] === true,
        false,
        false,
        origin,
      );
    }
    if (
      toolName === "fusion_mcp_read" &&
      request["queryType"] === "screenshot"
    ) {
      const args: ObjectValue = {};
      if (request["width"] !== undefined) args["width"] = request["width"];
      if (request["height"] !== undefined) args["height"] = request["height"];
      if (request["direction"] && request["direction"] !== "current") {
        const direction = String(request["direction"]);
        if (
          ![
            "front",
            "back",
            "top",
            "bottom",
            "left",
            "right",
            "iso-top-left",
            "iso-top-right",
            "iso-bottom-left",
            "iso-bottom-right",
          ].includes(direction)
        )
          throw new Error("Unknown screenshot direction: " + direction);
        args["view"] = direction.replaceAll("-", "_");
      }
      if (request["antiAliasing"] !== undefined)
        args["anti_aliasing"] = request["antiAliasing"];
      if (request["transparentBackground"] !== undefined)
        args["background"] = request["transparentBackground"]
          ? "transparent"
          : "viewport";
      return super.prepareCallTool(args, "capture_viewport");
    }
    if (
      toolName === "fusion_mcp_read" &&
      request["queryType"] === "apiDocumentation"
    ) {
      if (request["filter"])
        throw new Error(
          "Add-in API documentation does not support the native filter; use fetch_api_documentation or --backend mcp explicitly.",
        );
      const category: Record<string, string> = {
        class: "class_name",
        member: "member_name",
        description: "description",
        all: "all",
      };
      if (request["apiCategory"] && !category[String(request["apiCategory"])])
        throw new Error("Unknown API documentation category");
      return super.prepareCallTool(
        {
          search_term: request["searchPattern"] || "",
          category: category[String(request["apiCategory"])] ?? "all",
        },
        "fetch_api_documentation",
      );
    }
    if (toolName === "fusion_mcp_execute" || toolName === "fusion_mcp_read") {
      return this.#prepareScript(
        buildBridgeScript(toolName, request, this.dependencies.bridgeSource()),
        toolName === "fusion_mcp_read",
        true,
      );
    }
    if (
      toolName === "fusion_mcp_update" ||
      toolName === "fusion_mcp_electronics_read"
    )
      throw new Error(
        `${toolName} is unavailable on the addin backend; explicitly select --backend mcp. No fallback was performed.`,
      );
    return super.prepareCallTool(request, toolName, origin);
  }
}

import { parseNativeResult, unknownNativeOutcome } from "@fmcad/core";
import { pythonLiteral } from "./artifact.js";
import { prepareCadBundle } from "./bundle.js";
import { resolveRuntimePaths } from "../config-platform/runtime-paths.js";

export interface NativeActionReply {
  text?: string;
  failed?: boolean;
  uiGuard?: { notStarted?: boolean; activeCommand?: unknown };
}
export interface NativeActionClient {
  server?: { timeoutMs?: number };
  callTool(request: {
    featureType: "script";
    object: { script: string; readOnly: boolean };
  }): Promise<NativeActionReply>;
}

const referenceReadActions = new Set(["graph", "preflight"]);
export function buildReferencesActionScript(
  action: string,
  data: Record<string, unknown>,
): string {
  if (
    ![
      "graph",
      "preflight",
      "sdkUpdate",
      "nativeUpdate",
      "save",
      "coldVerify",
    ].includes(action)
  )
    throw new Error("Unsupported internal references.refresh SDK action");
  const request = pythonLiteral({ action, data });
  return prepareCadBundle(
    resolveRuntimePaths({ anchor: __filename }).installation,
    `\n\n_FMCAD_REFERENCE_REQUEST: JsonObject = ${request}\ndef run(_context: str) -> None:\n    import json\n    _request = _FMCAD_REFERENCE_REQUEST\n    _result = _references_refresh_internal(_request['action'], _request['data'])\n    print('FMCAD_RESULT ' + json.dumps(_cad_json(_result), allow_nan=False))\n`,
    { request: { action, data } },
  ).script;
}

export async function executeReferencesAction(
  client: NativeActionClient | null | undefined,
  action: string,
  data: Record<string, unknown>,
  input: { lifecycle?: string },
): Promise<Record<string, unknown>> {
  if (!client)
    throw new Error(
      `references.refresh ${action} requires the selected Fusion backend`,
    );
  const scriptData = { ...data };
  const nativeRpcTimeoutMs =
    action === "nativeUpdate" ? scriptData["nativeRpcTimeoutMs"] : null;
  delete scriptData["nativeRpcTimeoutMs"];
  const script = buildReferencesActionScript(action, scriptData);
  const readOnly =
    referenceReadActions.has(action) &&
    (input.lifecycle ?? "existingOnly") === "existingOnly";
  const server = client.server;
  const previousTimeoutMs = server?.timeoutMs;
  const timeoutAdjusted =
    typeof nativeRpcTimeoutMs === "number" &&
    Number.isFinite(nativeRpcTimeoutMs) &&
    nativeRpcTimeoutMs > 0 &&
    server &&
    typeof previousTimeoutMs === "number" &&
    Number.isFinite(previousTimeoutMs);
  if (timeoutAdjusted)
    server.timeoutMs = Math.min(previousTimeoutMs, nativeRpcTimeoutMs);
  let output: NativeActionReply;
  try {
    output = await client.callTool({
      featureType: "script",
      object: { script, readOnly },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("RPC not submitted:"))
      return { status: "notStarted", notStarted: true, error: message };
    throw unknownNativeOutcome(error);
  } finally {
    if (timeoutAdjusted) server.timeoutMs = previousTimeoutMs;
  }
  if (output.uiGuard?.notStarted === true)
    return {
      status: "blocked",
      notStarted: true,
      activeCommand: output.uiGuard.activeCommand ?? null,
      error:
        output.text ??
        "Fusion command preflight rejected the script before user code.",
    };
  const text = String(output.text ?? "");
  if (
    output.failed ||
    !text.split(/\r?\n/).some((line) => line.startsWith("FMCAD_RESULT "))
  ) {
    if (text.includes("RPC not submitted:"))
      return { status: "notStarted", notStarted: true, error: text };
    throw unknownNativeOutcome(
      new Error(
        `references.refresh ${action} failed; inspect before retry. ${text}`,
      ),
    );
  }
  return parseNativeResult(text);
}

export async function executeExternalizationAction(
  client: NativeActionClient | null | undefined,
  action: string,
  data: Record<string, unknown>,
  readOnly?: boolean,
): Promise<Record<string, unknown>> {
  if (!client)
    throw new Error(
      "component.externalize requires the selected Fusion backend",
    );
  if (!["inspect", "perform"].includes(action))
    throw new Error("Invalid private externalization action");
  const previous = client.server?.timeoutMs;
  const remaining = data["remainingMs"];
  const budget = Number(remaining ?? 180000);
  const scriptData = {
    ...data,
    copyRpcBudgetMs: Math.min(previous ?? 180000, budget),
  };
  const script = prepareCadBundle(
    resolveRuntimePaths({ anchor: __filename }).installation,
    `\n_EXTERNAL_REQUEST: JsonObject = ${pythonLiteral({ action, data: scriptData })}\ndef run(_context: str) -> None:\n    _result = _external_refresh_internal(_EXTERNAL_REQUEST['action'], _EXTERNAL_REQUEST['data'])\n    print('FMCAD_RESULT ' + json.dumps(_cad_json(_result), allow_nan=False))\n`,
    { request: { action, data: scriptData } },
  ).script;
  if (
    typeof remaining === "number" &&
    Number.isFinite(remaining) &&
    remaining < 1000
  )
    return {
      status: "pending",
      receipt: {
        cursor: 0,
        reason: "budgetExhausted",
        stopReason: "budgetExhausted",
      },
      notStarted: true,
    };
  if (
    client.server &&
    typeof remaining === "number" &&
    Number.isFinite(remaining)
  )
    client.server.timeoutMs = Math.min(previous ?? 180000, remaining);
  try {
    const output = await client.callTool({
      featureType: "script",
      object: { script, readOnly: action === "inspect" && readOnly === true },
    });
    if (output.uiGuard?.notStarted)
      return {
        status: "blocked",
        notStarted: true,
        receipt: { cursor: 0, reason: "interactiveCommandActive" },
      };
    const text = String(output.text ?? "");
    if (
      output.failed ||
      !text.split(/\r?\n/).some((line) => line.startsWith("FMCAD_RESULT "))
    )
      throw new Error(
        "External native outcome unknown; inspect existing operation. " + text,
      );
    return parseNativeResult(text);
  } catch (error) {
    throw unknownNativeOutcome(error);
  } finally {
    if (client.server) {
      if (previous === undefined) delete client.server.timeoutMs;
      else client.server.timeoutMs = previous;
    }
  }
}

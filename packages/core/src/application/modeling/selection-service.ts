import { record } from "../cad/contracts";
import type { CadContext } from "../cad/contracts";
export interface SelectionContext extends CadContext {
  purpose?: string | null;
}
export const publicOperations = new Set([
  "selection.rule.define",
  "selection.rule.inspect",
  "selection.rule.resolve",
  "selection.rule.check",
]);
export interface SelectionStore {
  read(
    owner: Readonly<Record<string, unknown>>,
    reference: unknown,
  ): Promise<Readonly<Record<string, unknown>> | null>;
  write(
    owner: Readonly<Record<string, unknown>>,
    manifest: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}
export interface SelectionPorts {
  store(): SelectionStore;
  executeNative(
    operation: string,
    payload: Record<string, unknown>,
    context: SelectionContext,
  ): Promise<unknown>;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!record(value)) throw new Error(label + " must be an object");
  return value;
}
function result(value: unknown): Record<string, unknown> {
  const output = object(value, "Selection-rule Fusion result");
  return object(output["result"] ?? output, "Selection-rule Fusion payload");
}
function assertInvocationOwner(
  context: SelectionContext,
  reference: Readonly<Record<string, unknown>>,
): void {
  for (const [key, actual, expected] of [
    ["projectId", context.projectId, reference["projectId"]],
    ["docFileId", context.docFileId, reference["documentFileId"]],
    ["docId", context.docId, reference["documentCreationId"]],
  ])
    if (
      actual !== undefined &&
      actual !== null &&
      expected !== undefined &&
      expected !== null &&
      actual !== expected
    )
      throw new Error(
        "Selection rule ownership conflict: pinned " + key + " differs",
      );
}
function cleanResolution(
  payload: Record<string, unknown>,
  reference: unknown,
  updatedReference: unknown,
): Record<string, unknown> {
  const { manifest, ...publicPayload } = payload;
  void manifest;
  return {
    success: payload["success"] === true,
    operation: payload["operation"],
    result: { ...publicPayload, artifact: updatedReference ?? reference },
  };
}
/** Exactly one settled native turn per operation; artifact reads never replay mutations. */
export async function executeSelectionRule(
  available: boolean,
  operation: string,
  data: Record<string, unknown>,
  context: SelectionContext,
  ports: SelectionPorts,
): Promise<Record<string, unknown>> {
  if (!publicOperations.has(operation))
    throw new Error("Unknown selection rule operation");
  if (!available)
    throw new Error(operation + " requires the selected Fusion backend");
  if (!context?.docId && !context?.docFileId)
    throw new Error(operation + " requires a pinned --doc-id or --doc-file-id");
  if (operation !== "selection.rule.define" && !context?.docFileId)
    throw new Error(
      operation + " requires --doc-file-id for exact artifact ownership",
    );
  const store = ports.store();
  const executeNative = async (op: string, payload: Record<string, unknown>) =>
    result(await ports.executeNative(op, payload, context));
  if (operation === "selection.rule.define") {
    const binding = { version: 1, service: "selection-rules", operation };
    const native = await executeNative("selection.rule.define_internal", {
      definition: data,
      _trustedBinding: binding,
    });
    const manifest = object(
      native["manifest"],
      "Defined selection rule manifest",
    );
    const owner = object(manifest["owner"], "Selection rule owner");
    assertInvocationOwner(context, owner);
    const artifact = await store.write(owner, manifest);
    return {
      success: native["success"] === true,
      operation,
      result: {
        schemaVersion: 1,
        status: native["status"],
        ruleId: native["ruleId"],
        count: native["count"],
        refs: native["refs"],
        entities: native["entities"],
        excludedCount: native["excludedCount"],
        artifact,
        provenance: native["provenance"],
        method: native["method"],
        limitations: native["limitations"],
      },
    };
  }
  const reference = object(
    data["artifact"],
    "Selection rule artifact reference",
  );
  assertInvocationOwner(context, reference);
  const owner = {
    projectId: reference["projectId"],
    documentFileId: reference["documentFileId"],
    documentCreationId: reference["documentCreationId"],
  };
  const manifest = await store.read(owner, reference);
  if (manifest === null)
    return {
      success: false,
      operation,
      result: {
        schemaVersion: 1,
        status: "missing",
        ruleId: null,
        artifact: reference,
      },
    };
  const native = await executeNative(operation + "_internal", {
    manifest,
    _trustedBinding: { version: 1, service: "selection-rules", operation },
  });
  if (operation === "selection.rule.inspect")
    return cleanResolution(native, reference, null);
  let updatedReference: unknown = null;
  if (
    native["status"] === "resolved" &&
    native["manifest"] &&
    JSON.stringify(native["manifest"]) !== JSON.stringify(manifest)
  ) {
    updatedReference = await store.write(
      owner,
      object(native["manifest"], "Selection rule manifest"),
    );
  }
  return cleanResolution(native, reference, updatedReference);
}

import type { QueueIsolationTarget } from "@fmcad/core";
import type { ParamCheckpointGuardV1 } from "../packages/node-adapters/src/python/cad-script";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, expected: string): boolean {
  return (
    Object.keys(value).sort().join(",") === expected.split(",").sort().join(",")
  );
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function json(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  return object(value) && Object.values(value).every(json);
}
function checkpoint(value: unknown): value is ParamCheckpointGuardV1 {
  if (
    !object(value) ||
    !fields(value, "schema,document,parameters") ||
    value["schema"] !== "fmcad.param-checkpoint-v1"
  )
    return false;
  const document = value["document"];
  if (
    !object(document) ||
    !fields(document, "identity,fingerprint") ||
    typeof document["fingerprint"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(document["fingerprint"])
  )
    return false;
  const identity = document["identity"];
  if (
    !object(identity) ||
    !fields(identity, "creationId,name,fileId,version,isSaved,isModified") ||
    !text(identity["creationId"]) ||
    !text(identity["name"]) ||
    typeof identity["isSaved"] !== "boolean" ||
    typeof identity["isModified"] !== "boolean"
  )
    return false;
  const file = identity["fileId"],
    version = identity["version"];
  if (
    (file !== null && !text(file)) ||
    (version !== null &&
      (typeof version !== "number" ||
        !Number.isSafeInteger(version) ||
        version < 1)) ||
    (file === null) !== (version === null) ||
    (identity["isSaved"] && file === null)
  )
    return false;
  if (!Array.isArray(value["parameters"])) return false;
  const names = new Set<string>();
  for (const parameter of value["parameters"]) {
    if (
      !object(parameter) ||
      !fields(
        parameter,
        "name,expression,unit,value,valueType,valueUnits,comment,metadata",
      ) ||
      !text(parameter["name"]) ||
      names.has(parameter["name"]) ||
      typeof parameter["expression"] !== "string" ||
      typeof parameter["unit"] !== "string" ||
      typeof parameter["comment"] !== "string" ||
      !object(parameter["metadata"]) ||
      !json(parameter["metadata"])
    )
      return false;
    names.add(parameter["name"]);
    if (
      (parameter["unit"].toLowerCase() === "text") !==
      (parameter["valueType"] === "text")
    )
      return false;
    if (parameter["valueType"] === "text") {
      if (
        typeof parameter["value"] !== "string" ||
        parameter["valueUnits"] !== null
      )
        return false;
    } else if (parameter["valueType"] === "numeric") {
      if (
        typeof parameter["value"] !== "number" ||
        !Number.isFinite(parameter["value"]) ||
        parameter["valueUnits"] !== "Fusion internal units (cm, rad, kg, s)"
      )
        return false;
    } else return false;
  }
  return true;
}

/** Decode only AFTER authenticating the original RPC, source and physical turn.
 * This codec proves the response shape and exact target, not producer authority.
 */
export function decodeDocumentCheckpointReadback(
  value: unknown,
  target: QueueIsolationTarget,
): ParamCheckpointGuardV1 {
  if (
    !checkpoint(value) ||
    !text(target.creationId) ||
    value.document.identity.creationId !== target.creationId ||
    (target.fileId !== undefined &&
      value.document.identity.fileId !== target.fileId)
  )
    throw Object.assign(
      new Error("Verified full checkpoint readback is unavailable"),
      {
        code: "DOCUMENT_STATE_CHANGED",
      },
    );
  return structuredClone(value);
}

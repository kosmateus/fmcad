import type { PreparedPythonArtifact } from "../../../core/src/domain/python-artifact";
import { verifyPythonArtifact } from "../python/artifact";
import type { BrokerToolCall } from "./broker-preparation";
import type { JsonValue } from "../../../core/src/domain/contracts";
import {
  createAddinAdmission,
  type AdmissionIdentity,
} from "./addin-admission-client";
import type { Response } from "../fusion-transport/contracts";
import { admissionData } from "./admission-json";

export type AddinAdmissionScope = Readonly<{
  endpoint: string;
  token: string;
  identity: AdmissionIdentity;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function base64(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    ) &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}

function toolResult(value: unknown): boolean {
  if (!object(value) || !Array.isArray(value["content"])) return false;
  if (Object.hasOwn(value, "isError") && typeof value["isError"] !== "boolean")
    return false;
  if (
    Object.hasOwn(value, "structuredContent") &&
    !object(value["structuredContent"])
  )
    return false;
  return value["content"].every((item: unknown) => {
    if (!object(item)) return false;
    switch (item["type"]) {
      case "text":
        return typeof item["text"] === "string";
      case "image":
      case "audio":
        return base64(item["data"]) && typeof item["mimeType"] === "string";
      case "resource_link":
        return (
          typeof item["uri"] === "string" && typeof item["name"] === "string"
        );
      case "resource": {
        const resource = item["resource"];
        return (
          object(resource) &&
          typeof resource["uri"] === "string" &&
          (typeof resource["text"] === "string" || base64(resource["blob"])) &&
          (!Object.hasOwn(resource, "blob") || base64(resource["blob"]))
        );
      }
      default:
        return false;
    }
  });
}

/** Final tools/call only: preparation, UI guard and entrypoint bytes are already fixed. */
export async function postAddinAdmission(
  scope: AddinAdmissionScope,
  outgoing: Record<string, JsonValue>,
  timeoutMs: number,
): Promise<Response> {
  scope = admissionData(scope) as AddinAdmissionScope;
  outgoing = admissionData(outgoing) as Record<string, JsonValue>;
  const id = outgoing["id"];
  const params = outgoing["params"];
  if (
    outgoing["method"] !== "tools/call" ||
    outgoing["jsonrpc"] !== "2.0" ||
    !(
      (typeof id === "string" && id.length > 0) ||
      (typeof id === "number" && Number.isSafeInteger(id))
    ) ||
    !object(params) ||
    typeof params["name"] !== "string" ||
    !params["name"].trim() ||
    !object(params["arguments"])
  )
    throw new Error("Admission only accepts the final tools/call envelope");
  const handle = createAddinAdmission(
    { endpoint: scope.endpoint, token: scope.token, timeoutMs },
    scope.identity,
    outgoing,
  );
  let evidence: Awaited<ReturnType<typeof handle.admitEvidence>>;
  try {
    evidence = await handle.admitEvidence();
  } catch (error) {
    throw Object.assign(
      error instanceof Error
        ? error
        : new Error("Admission outcome unavailable"),
      { code: "ADDIN_ADMISSION_UNCERTAIN", admissionBinding: handle.binding },
    );
  }
  if (
    evidence.record?.state !== "terminal" ||
    !toolResult(evidence.record.result)
  )
    throw Object.assign(
      new Error("Admission has no terminal execution evidence; do not replay"),
      {
        code: "ADDIN_ADMISSION_UNCERTAIN",
        rawResponse: evidence.raw,
        admissionBinding: handle.binding,
      },
    );
  return {
    status: 200,
    raw: evidence.raw,
    toolResponse: {
      jsonrpc: "2.0",
      id: outgoing["id"],
      result: evidence.record.result,
    },
  };
}

/** Final certificate and script checks, in the same turn as journal + send. */
export function fencePreparedWire<Payload extends BrokerToolCall>(prepared: {
  outgoing: Payload;
  pythonCertificate: { fence(payload: Payload): void };
  pythonArtifact?: PreparedPythonArtifact | undefined;
}): void {
  const { outgoing, pythonArtifact, pythonCertificate } = prepared;
  pythonCertificate.fence(outgoing);
  if (!pythonArtifact) return;
  verifyPythonArtifact(pythonArtifact);
  const args = outgoing.params?.arguments;
  const script =
    outgoing.params?.name === "execute_python"
      ? args?.code
      : args?.object?.script;
  if (script !== pythonArtifact.script)
    throw Object.assign(
      new Error("Final Python bytes changed after offline preparation"),
      { code: "INPUT_CHANGED" },
    );
}

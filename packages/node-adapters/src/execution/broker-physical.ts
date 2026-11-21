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

/** Final tools/call only: preparation, UI guard and entrypoint bytes are already fixed. */
export async function postAddinAdmission(
  scope: AddinAdmissionScope,
  outgoing: Record<string, JsonValue>,
  timeoutMs: number,
): Promise<Response> {
  scope = admissionData(scope) as AddinAdmissionScope;
  outgoing = admissionData(outgoing) as Record<string, JsonValue>;
  if (
    outgoing["method"] !== "tools/call" ||
    outgoing["jsonrpc"] !== "2.0" ||
    !Object.hasOwn(outgoing, "id")
  )
    throw new Error("Admission only accepts the final tools/call envelope");
  const handle = createAddinAdmission(
    { endpoint: scope.endpoint, token: scope.token, timeoutMs },
    scope.identity,
    outgoing,
  );
  const evidence = await handle.admitEvidence();
  if (evidence.record?.state !== "terminal")
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

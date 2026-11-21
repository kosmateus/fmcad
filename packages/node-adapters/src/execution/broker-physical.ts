import type { PreparedPythonArtifact } from "../../../core/src/domain/python-artifact";
import { verifyPythonArtifact } from "../python/artifact";
import type { BrokerToolCall } from "./broker-preparation";

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

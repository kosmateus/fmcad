import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PreparedPythonArtifact } from "../../../core/src/domain/python-artifact";
import { verifyPythonArtifact } from "../python/artifact";

export interface BrokerToolCall {
  params?: {
    name?: string;
    arguments?: {
      code?: string;
      persistent?: boolean;
      featureType?: string;
      object?: { script?: string; readOnly?: boolean };
    };
  };
}

/** Bind the receipt and source before producing the final bytes to certify. */
export function prepareBrokerScript(
  outgoing: BrokerToolCall,
  ports: {
    nativeMcp: boolean;
    bindSource(source: string, nativePublicPython: boolean): void;
    wrap(
      executable: string,
      official: boolean,
      nativePublicPython: boolean,
    ): PreparedPythonArtifact;
  },
) {
  const params = outgoing.params;
  const args = params?.arguments;
  const python = params?.name === "execute_python";
  const official =
    params?.name === "fusion_mcp_execute" && args?.featureType === "script";
  if (!python && !official) return undefined;
  const code = python ? args?.code : args?.object?.script;
  if (typeof code !== "string")
    throw Object.assign(new Error("Script source must be a string"), {
      code: "INVALID_SCRIPT",
    });
  if (python && args?.persistent !== false)
    throw Object.assign(
      new Error("Queued low-level Python must use persistent:false"),
      { code: "unsupported_queue_route" },
    );
  const nativePublicPython = python && ports.nativeMcp;
  ports.bindSource(code, nativePublicPython);
  // Native Fusion invokes run(context) and consumes printed JSON; its
  // compatibility wrapping is part of the checked bytes, not a send effect.
  const executable = nativePublicPython
    ? `import contextlib as _qp_contextlib
import io as _qp_io
import json as _qp_json
def run(_context: str) -> dict[str, object]:
    _qp_out, _qp_err = _qp_io.StringIO(), _qp_io.StringIO()
    try:
        with _qp_contextlib.redirect_stdout(_qp_out), _qp_contextlib.redirect_stderr(_qp_err):
            exec(compile(${JSON.stringify(code)}, '<fmcad-public-python>', 'exec'), {
                '__name__': '__main__',
                '__fmcad_native_lifecycle__': globals().get('__fmcad_native_lifecycle__')})
    except BaseException as _qp_exception:
        print(_qp_json.dumps({'success': False, 'stdout': _qp_out.getvalue(),
              'stderr': _qp_err.getvalue(), 'error': str(_qp_exception)}))
        raise
    _qp_result: dict[str, object] = {'success': True, 'stdout': _qp_out.getvalue(), 'stderr': _qp_err.getvalue()}
    print(_qp_json.dumps(_qp_result))
    return _qp_result
`
    : code;
  const artifact = ports.wrap(
    executable,
    official || nativePublicPython,
    nativePublicPython,
  );
  verifyPythonArtifact(artifact);
  if (nativePublicPython) {
    params!.name = "fusion_mcp_execute";
    params!.arguments = {
      featureType: "script",
      object: { script: artifact.script, readOnly: false },
    };
  } else if (python) args!.code = artifact.script;
  else args!.object!.script = artifact.script;
  return artifact;
}

type Stage = "preflight" | "postflight";
type FlightBinding = {
  jobId: string;
  rpcId: string;
  requestHash: string;
  buildHash: string;
};

/** Check both read-only flights locally before publishing the plan. */
export async function prepareBrokerFlights<Send>(ports: {
  jobId: string;
  directory: string;
  buildHash: string;
  hash(value: string): string;
  assertPreparing(): void;
  prepare(
    binding: FlightBinding,
    receiptPath: string,
    diagnosticPath: string,
  ): Promise<Send>;
}) {
  const prepare = async (stage: Stage) => {
    ports.assertPreparing();
    const rpcId = randomUUID();
    const binding = {
      jobId: ports.jobId,
      rpcId,
      requestHash: ports.hash(`${stage}:${ports.jobId}:${rpcId}`),
      buildHash: ports.buildHash,
    };
    const receipt = path.join(
      ports.directory,
      `${stage}-${rpcId}.receipt.json`,
    );
    const send = await ports.prepare(
      binding,
      receipt,
      path.join(ports.directory, `${stage}-result.json`),
    );
    ports.assertPreparing();
    return { binding, receipt, send };
  };
  return {
    preflight: await prepare("preflight"),
    postflight: await prepare("postflight"),
  };
}

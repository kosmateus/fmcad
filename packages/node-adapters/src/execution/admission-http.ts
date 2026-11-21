import { requestCurlBytes } from "../fusion-transport/curl";
import type { Spawn } from "../fusion-transport/contracts";

/** Private process-local dependency. Never put this capability in admission DTOs. */
export type AdmissionRequest = (request: {
  endpoint: string;
  token: string;
  body: Uint8Array;
  timeoutMs: number;
}) => Promise<{ status: number; body: Uint8Array }>;

export type AdmissionTransport = {
  transport?: string | undefined;
  curlPath?: string | undefined;
};

const windowsCurl = "/mnt/c/Windows/System32/curl.exe";
const maxBuffer = 16 * 1024 * 1024;

/** Selection and validation are local and happen once, before any intent. */
export function createAdmissionRequest(
  config: AdmissionTransport = {},
  dependencies: { spawn?: Spawn; fetch?: typeof fetch } = {},
): AdmissionRequest {
  const transport = config.transport ?? "node";
  if (transport !== "node" && transport !== "windows-curl")
    throw new Error("Unsupported admission transport");
  // Do not allow request/config-controlled executables to receive a credential.
  if (config.curlPath !== undefined && config.curlPath !== windowsCurl)
    throw new Error("Untrusted admission curl executable");
  if (transport === "windows-curl") {
    return async ({ endpoint, token, body, timeoutMs }) => {
      const response = await requestCurlBytes(
        {
          url: endpoint,
          curlPath: windowsCurl,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Content-Length": String(body.byteLength),
          },
          body,
          timeoutMs,
          maxBuffer,
        },
        dependencies.spawn,
      );
      return { status: response.status, body: response.body };
    };
  }
  const fetchOnce = dependencies.fetch ?? globalThis.fetch;
  return async ({ endpoint, token, body, timeoutMs }) => {
    const response = await fetchOnce(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: Buffer.from(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBuffer)
      throw new Error("Admission response too large");
    return { status: response.status, body: bytes };
  };
}

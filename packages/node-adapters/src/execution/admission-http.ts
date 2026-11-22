import { requestCurlBytes } from "../fusion-transport/curl";
import type { Spawn } from "../fusion-transport/contracts";
import { Agent } from "undici";

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
type Dependencies = {
  spawn?: Spawn | undefined;
  fetch?: typeof fetch | undefined;
  authorizePhysicalRequest?:
    ((endpoint: string) => Readonly<Record<string, string>>) | undefined;
};
export type PhysicalTurnStatusRequest = (request: {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  timeoutMs: number;
}) => Promise<{ status: number; body: Uint8Array }>;

/** Selection and validation are local and happen once, before any intent. */
export function createAdmissionRequest(
  config: AdmissionTransport = {},
  dependencies: Dependencies = {},
): AdmissionRequest {
  const post = createBytePost(config, dependencies, maxBuffer);
  return ({ token, ...request }) =>
    post({
      ...request,
      headers: { Authorization: `Bearer ${token}` },
    });
}

/** Read-only control endpoint. It cannot be redirected into MCP/SDK execution. */
export function createPhysicalTurnStatusRequest(
  config: AdmissionTransport = {},
  dependencies: Dependencies = {},
): PhysicalTurnStatusRequest {
  const post = createBytePost(config, dependencies, 65536);
  return (request) => {
    const endpoint = new URL(request.endpoint);
    if (
      endpoint.protocol !== "http:" ||
      endpoint.port !== "8765" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
      endpoint.pathname !== "/physical/v1/turn-status" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error(
        "Physical turn status requires its exact private control endpoint",
      );
    return post(request);
  };
}

function createBytePost(
  config: AdmissionTransport,
  dependencies: Dependencies,
  limit: number,
): PhysicalTurnStatusRequest {
  const transport = config.transport ?? "node";
  if (transport !== "node" && transport !== "windows-curl")
    throw new Error("Unsupported admission transport");
  // Do not allow request/config-controlled executables to receive a credential.
  if (config.curlPath !== undefined && config.curlPath !== windowsCurl)
    throw new Error("Untrusted admission curl executable");
  if (transport === "windows-curl") {
    return async ({ endpoint, headers, body, timeoutMs }) => {
      const response = await requestCurlBytes(
        {
          url: endpoint,
          curlPath: windowsCurl,
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Content-Length": String(body.byteLength),
            ...dependencies.authorizePhysicalRequest?.(endpoint),
          },
          body,
          timeoutMs,
          maxBuffer: limit,
        },
        dependencies.spawn,
      );
      return { status: response.status, body: response.body };
    };
  }
  const fetchOnce = dependencies.fetch ?? globalThis.fetch;
  return async ({ endpoint, headers, body, timeoutMs }) => {
    const physicalHeaders = dependencies.authorizePhysicalRequest?.(endpoint);
    const signal = AbortSignal.timeout(timeoutMs);
    // An explicit plain Agent bypasses both env proxy selection and the global
    // dispatcher. Its lifetime is one operation, including errors and aborts.
    const dispatcher = new Agent({ connections: 1, pipelining: 1 });
    const init = {
      method: "POST",
      redirect: "error",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        ...physicalHeaders,
      },
      body: Buffer.from(body),
      signal,
      // Node's declarations name the bundled undici version. The dispatcher
      // protocol is shared with pinned undici 6; real Node22/24 tests qualify
      // this one private inter-version boundary, not a global dispatcher.
      dispatcher,
    } satisfies Omit<RequestInit, "dispatcher"> & { dispatcher: Agent };
    try {
      // Some build targets use DOM RequestInit (no dispatcher), others use
      // Node's bundled undici types. Keep that version bridge at the call.
      const response = await fetchOnce(
        endpoint,
        init as unknown as RequestInit,
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > limit)
        throw new Error("Admission response too large");
      return { status: response.status, body: bytes };
    } finally {
      await dispatcher.destroy();
    }
  };
}

import { spawn } from "node:child_process";
import type {
  ObjectValue,
  RequestOptions,
  Response,
  Server,
  Spawn,
} from "./contracts.js";
import { unknownOutcome } from "./contracts.js";
import { requestSettings } from "./http.js";

const quote = (value: string) =>
  '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

type TransportPhase =
  "spawn" | "process" | "stdin" | "output" | "response" | "observation";
const CAUSE_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EINVAL",
  "EMFILE",
  "ENFILE",
  "EAGAIN",
  "ENOMEM",
  "ENOSYS",
  "ENOEXEC",
  "EPIPE",
  "ECONNRESET",
  "ETIMEDOUT",
  "ABORT_ERR",
  "EINTR",
  "ENOBUFS",
  "EIO",
  "ESRCH",
]);
function safeCauseCode(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "code");
    const code: unknown =
      descriptor && "value" in descriptor ? descriptor.value : undefined;
    return typeof code === "string" && CAUSE_CODES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

export function parseCurlBytes(output: Buffer | string): {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
} {
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
  let offset = 0;
  while (offset < buffer.length) {
    let end = buffer.indexOf("\r\n\r\n", offset);
    let separator = 4;
    const lfEnd = buffer.indexOf("\n\n", offset);
    if (lfEnd !== -1 && (end === -1 || lfEnd < end)) {
      end = lfEnd;
      separator = 2;
    }
    if (end === -1) break;
    const lines = buffer
      .subarray(offset, end)
      .toString("latin1")
      .split(/\r?\n/);
    const match = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s|$)/.exec(
      lines.shift() ?? "",
    );
    if (!match) break;
    const status = Number(match[1]);
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) throw new Error("Invalid curl response header");
      const key = line.slice(0, colon).toLowerCase();
      if (Object.hasOwn(headers, key))
        throw new Error("Duplicate curl response header");
      headers[key] = line.slice(colon + 1).trim();
    }
    offset = end + separator;
    if (status >= 100 && status < 200 && status !== 101) continue;
    if (status < 200 || status > 599) break;
    const body = buffer.subarray(offset);
    const length = headers["content-length"];
    if (
      length !== undefined &&
      !headers["transfer-encoding"] &&
      (!/^\d+$/.test(length) || Number(length) !== body.length)
    ) {
      throw new Error("curl response Content-Length mismatch");
    }
    return { status, headers, body };
  }
  throw new Error("Missing or invalid final curl HTTP response");
}

export function parseCurlResponse(
  output: Buffer | string,
  options: RequestOptions = {},
): Response {
  const response = parseCurlBytes(output);
  return mcpResponse(response, options);
}

function mcpResponse(
  response: ReturnType<typeof parseCurlBytes>,
  options: RequestOptions,
): Response {
  if (
    options.protocolVersion &&
    response.headers["mcp-protocol-version"] &&
    response.headers["mcp-protocol-version"] !== options.protocolVersion
  )
    throw new Error("curl response protocol mismatch");
  return {
    status: response.status,
    sessionId: response.headers["mcp-session-id"],
    raw: response.body.toString("utf8"),
  };
}

/** Internal broker adapter; the optional spawn seam is never a server option. */
export async function postCurl(
  server: Server,
  payload: ObjectValue,
  options: RequestOptions,
  spawnImpl: Spawn = spawn,
): Promise<Response> {
  const body = Buffer.from(JSON.stringify(payload));
  const settings = requestSettings(server, options, body);
  const response = await requestCurlBytes(
    {
      url: server.url,
      curlPath: server.curlPath,
      body,
      ...settings,
      signal: options.signal,
    },
    spawnImpl,
  );
  try {
    const result = mcpResponse(response, options);
    if (
      options.sessionId &&
      result.sessionId &&
      result.sessionId !== options.sessionId
    )
      throw new Error("session mismatch");
    return result;
  } catch {
    throw Object.assign(
      unknownOutcome(
        "windows-curl invalid HTTP response or session mismatch",
        "EPROTO",
      ),
      { transportPhase: "response" },
    );
  }
}

/** Private byte transport: neither JSON serialization nor UTF-8 decoding occurs here. */
export async function requestCurlBytes(
  request: {
    url: string;
    curlPath?: string | undefined;
    method?: "POST" | "GET";
    body?: Uint8Array;
    headers: Readonly<Record<string, string>>;
    timeoutMs: number;
    maxBuffer: number;
    signal?: AbortSignal | undefined;
  },
  spawnImpl: Spawn = spawn,
): Promise<ReturnType<typeof parseCurlBytes>> {
  if (
    request.method === "GET" &&
    (request.url !== "http://127.0.0.1:8765/health" ||
      request.body !== undefined ||
      Object.keys(request.headers).length !== 0)
  )
    throw new Error(
      "Private health GET requires the fixed endpoint without headers or body",
    );
  const url = new URL(request.url);
  if (
    /[\x00-\x1f\x7f]/.test(request.url) ||
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    return Promise.reject(
      new Error(
        "windows-curl requires an HTTP(S) loopback URL without userinfo",
      ),
    );
  }
  const { headers, timeoutMs, maxBuffer } = request;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer <= 0 ||
    Object.entries(headers).some(
      ([key, value]) =>
        !/^[A-Za-z0-9-]+$/.test(key) || /[\x00-\x1f\x7f]/.test(value),
    )
  )
    throw new Error("Invalid byte request settings");
  if (request.signal?.aborted)
    return Promise.reject(
      unknownOutcome("Observation aborted before submission", "ABORT_ERR"),
    );
  const args = [
    "--disable",
    "--silent",
    "--show-error",
    "--include",
    "--globoff",
    "--noproxy",
    "*",
    "--proxy",
    "",
    "--max-time",
    String(timeoutMs / 1000),
    "--request",
    request.method ?? "POST",
    "--config",
    "-",
  ];
  const prefix =
    [
      `url = ${quote(request.url)}`,
      ...Object.entries(headers).map(
        ([key, value]) => `header = ${quote(`${key}: ${value}`)}`,
      ),
    ].join("\n") + (request.method === "GET" ? "\n" : '\ndata-binary = "');
  // curl's stdin config has its own escaping. Escape bytewise: decoding the
  // body to a JavaScript string here could replace malformed UTF-8 bytes.
  const escapes: Readonly<Record<number, string>> = {
    34: '\\"',
    92: "\\\\",
    9: "\\t",
    10: "\\n",
    11: "\\v",
    13: "\\r",
  };
  if (request.method === "GET" && request.body !== undefined)
    throw new Error("GET byte requests must not carry a body");
  const body = Buffer.from(request.body ?? []);
  const bodyParts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    const byte = body[index]!;
    if (byte < 32 && escapes[byte] === undefined)
      throw new Error("Unsupported byte in curl config body");
    const escaped = escapes[byte];
    if (escaped !== undefined) {
      bodyParts.push(body.subarray(start, index), Buffer.from(escaped));
      start = index + 1;
    }
  }
  bodyParts.push(body.subarray(start));
  const config = Buffer.concat([
    Buffer.from(prefix),
    ...bodyParts,
    Buffer.from(request.method === "GET" ? "" : '"\n'),
  ]);
  return new Promise((resolve, reject) => {
    let child: ReturnType<Spawn> | undefined;
    const timer = setTimeout(
      () => fail(`timeout after ${timeoutMs} ms`, "ETIMEDOUT", "observation"),
      timeoutMs,
    );
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    };
    const fail = (
      message: string,
      code: string,
      transportPhase: TransportPhase,
      cause?: unknown,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      child?.kill("SIGKILL");
      // Local observation failures never establish remote SDK settlement.
      // Keep only bounded metadata, never native messages or request material.
      const causeCode = safeCauseCode(cause);
      reject(
        Object.assign(unknownOutcome(`windows-curl ${message}`, code), {
          transportPhase,
          ...(causeCode === undefined ? {} : { causeCode }),
        }),
      );
    };
    const abort = () => fail("observation aborted", "ABORT_ERR", "observation");
    try {
      child = spawnImpl(
        request.curlPath ?? "/mnt/c/Windows/System32/curl.exe",
        args,
        { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (error) {
      fail("spawn failed", "ECHILD", "spawn", error);
      return;
    }
    request.signal?.addEventListener("abort", abort, { once: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (const [stream, keep] of [
      [child.stdout, true],
      [child.stderr, false],
    ] as const) {
      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxBuffer)
          fail("output exceeds maxBuffer", "ENOBUFS", "output");
        else if (keep) chunks.push(chunk);
      });
      stream.on("error", (error) =>
        fail("output stream failed", "EIO", "output", error),
      );
    }
    child.on("error", (error) =>
      fail("process failed", "ECHILD", "process", error),
    );
    child.stdin.on("error", (error) =>
      fail("stdin failed", "EPIPE", "stdin", error),
    );
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        fail(
          `failed (exit ${code}, signal ${signal ?? "none"})`,
          code === 28 ? "ETIMEDOUT" : "ECHILD",
          "process",
        );
        return;
      }
      try {
        const response = parseCurlBytes(Buffer.concat(chunks));
        settled = true;
        cleanup();
        resolve(response);
      } catch {
        fail("invalid HTTP response or session mismatch", "EPROTO", "response");
      }
    });
    child.stdin.end(config);
  });
}

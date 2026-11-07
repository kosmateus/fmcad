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

export function parseCurlResponse(
  output: Buffer | string,
  options: RequestOptions = {},
): Response {
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
    if (
      options.protocolVersion &&
      headers["mcp-protocol-version"] &&
      headers["mcp-protocol-version"] !== options.protocolVersion
    ) {
      throw new Error("curl response protocol mismatch");
    }
    return {
      status,
      sessionId: headers["mcp-session-id"],
      raw: body.toString("utf8"),
    };
  }
  throw new Error("Missing or invalid final curl HTTP response");
}

/** Internal broker adapter; the optional spawn seam is never a server option. */
export async function postCurl(
  server: Server,
  payload: ObjectValue,
  options: RequestOptions,
  spawnImpl: Spawn = spawn,
): Promise<Response> {
  const url = new URL(server.url);
  if (
    /[\x00-\x1f\x7f]/.test(server.url) ||
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
  const body = Buffer.from(JSON.stringify(payload));
  const { headers, timeoutMs, maxBuffer } = requestSettings(
    server,
    options,
    body,
  );
  if (options.signal?.aborted)
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
    "--max-time",
    String(timeoutMs / 1000),
    "--request",
    "POST",
    "--config",
    "-",
  ];
  const config =
    [
      `url = ${quote(server.url)}`,
      ...Object.entries(headers).map(
        ([key, value]) => `header = ${quote(`${key}: ${value}`)}`,
      ),
      `data-binary = ${quote(body.toString("utf8"))}`,
    ].join("\n") + "\n";
  return new Promise((resolve, reject) => {
    let child: ReturnType<Spawn> | undefined;
    const timer = setTimeout(
      () => fail(`timeout after ${timeoutMs} ms`, "ETIMEDOUT"),
      timeoutMs,
    );
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const fail = (message: string, code: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      child?.kill("SIGKILL");
      reject(unknownOutcome(`windows-curl ${message}`, code));
    };
    const abort = () => fail("observation aborted", "ABORT_ERR");
    try {
      child = spawnImpl(
        server.curlPath ?? "/mnt/c/Windows/System32/curl.exe",
        args,
        { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch {
      fail("spawn failed", "ECHILD");
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (const [stream, keep] of [
      [child.stdout, true],
      [child.stderr, false],
    ] as const) {
      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxBuffer) fail("output exceeds maxBuffer", "ENOBUFS");
        else if (keep) chunks.push(chunk);
      });
      stream.on("error", () => fail("output stream failed", "EIO"));
    }
    child.on("error", () => fail("process failed", "ECHILD"));
    child.stdin.on("error", () => fail("stdin failed", "EPIPE"));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        fail(
          `failed (exit ${code}, signal ${signal ?? "none"})`,
          code === 28 ? "ETIMEDOUT" : "ECHILD",
        );
        return;
      }
      try {
        const response = parseCurlResponse(Buffer.concat(chunks), options);
        if (
          options.sessionId &&
          response.sessionId &&
          response.sessionId !== options.sessionId
        )
          throw new Error("session mismatch");
        settled = true;
        cleanup();
        resolve(response);
      } catch {
        fail("invalid HTTP response or session mismatch", "EPROTO");
      }
    });
    child.stdin.end(Buffer.from(config));
  });
}

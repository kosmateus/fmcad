import * as http from "node:http";
import * as https from "node:https";
import type {
  ObjectValue,
  RequestOptions,
  Response,
  Server,
} from "./contracts.js";
import { unknownOutcome } from "./contracts.js";

export const DEFAULT_LIMIT = 32 * 1024 * 1024;
export function requestSettings(
  server: Server,
  options: RequestOptions,
  body: Buffer,
) {
  const timeoutMs = server.timeoutMs ?? 180000;
  const maxBuffer = server.maxBuffer ?? DEFAULT_LIMIT;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2147483647 ||
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer <= 0 ||
    maxBuffer > DEFAULT_LIMIT
  ) {
    throw new Error(
      "Transport requires bounded positive timeoutMs and maxBuffer <= 32 MiB",
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      /[\x00-\x1f\x7f]/.test(value)
    ) {
      throw new Error("Invalid transport header");
    }
    headers[name.toLowerCase()] = value;
  }
  headers["content-type"] = "application/json";
  headers["accept"] = "application/json, text/event-stream";
  headers["content-length"] = String(body.length);
  if (options.sessionId) headers["mcp-session-id"] = options.sessionId;
  if (Object.hasOwn(options, "protocolVersion"))
    delete headers["mcp-protocol-version"];
  if (options.protocolVersion)
    headers["mcp-protocol-version"] = options.protocolVersion;
  for (const value of Object.values(headers)) {
    if (/[\x00-\x1f\x7f]/.test(value))
      throw new Error("Invalid transport header");
  }
  if (body.length > maxBuffer)
    throw new Error("Request exceeds transport byte limit");
  return { headers, timeoutMs, maxBuffer };
}

export async function postHttp(
  server: Server,
  payload: ObjectValue,
  options: RequestOptions,
): Promise<Response> {
  const body = Buffer.from(JSON.stringify(payload));
  const { headers, timeoutMs, maxBuffer } = requestSettings(
    server,
    options,
    body,
  );
  const url = new URL(server.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Transport requires an HTTP(S) URL without userinfo");
  }
  if (options.signal?.aborted)
    return Promise.reject(
      unknownOutcome("Observation aborted before submission", "ABORT_ERR"),
    );
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    let settled = false;
    let response: http.IncomingMessage | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const fail = (message: string, code: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      req.destroy();
      reject(unknownOutcome(message, code));
    };
    // No shared agent, redirects, retries or transport fallback. Closing the
    // local socket ends observation only, never remote SDK execution.
    const req = mod.request(
      url,
      { method: "POST", headers, agent: false },
      (res) => {
        response = res;
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBuffer)
            fail("Backend response exceeds byte limit", "ENOBUFS");
          else chunks.push(chunk);
        });
        res.on("error", () => fail("Backend response failed", "ECONNRESET"));
        res.on("aborted", () => fail("Backend response aborted", "ECONNRESET"));
        res.on("end", () => {
          if (settled) return;
          if (!res.complete) {
            fail("Incomplete backend response", "EPROTO");
            return;
          }
          const sid = res.headers["mcp-session-id"];
          if (
            Array.isArray(sid) ||
            (options.sessionId && sid && sid !== options.sessionId)
          ) {
            fail("Backend session mismatch", "EPROTO");
            return;
          }
          const version = res.headers["mcp-protocol-version"];
          if (
            Array.isArray(version) ||
            (options.protocolVersion &&
              version &&
              version !== options.protocolVersion)
          ) {
            fail("Backend protocol mismatch", "EPROTO");
            return;
          }
          settled = true;
          cleanup();
          resolve({
            status: res.statusCode ?? 0,
            sessionId: sid,
            raw: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    const abort = () => fail("Backend observation aborted", "ABORT_ERR");
    const timer = setTimeout(
      () => fail(`Backend timeout after ${timeoutMs} ms`, "ETIMEDOUT"),
      timeoutMs,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    req.on("error", () => fail("Backend request failed", "ECONNRESET"));
    req.end(body);
  });
}

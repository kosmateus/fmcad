import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  CONTROL_CENTER_PROTOCOL_VERSION,
  ConsoleHttpError,
  isRecord,
  parseDetailRequest,
  parseExportRequest,
  parseQueryRequest,
  parseRevision,
  parseRevisionEvent,
  parseScope,
  redactSensitiveFields,
  type ConsoleHttpAsset,
  type ConsoleHttpArtifactRequest,
  type ConsoleHttpExportRequest,
  type ConsoleHttpIdentity,
  type ConsoleHttpPrincipal,
  type ConsoleHttpQueryPort,
  type ConsoleHttpQueryRequest,
  type ConsoleHttpRevision,
  type ConsoleHttpScope,
  type ConsoleHttpSession,
} from "./protocol.js";
import { PROJECT_ACTIONS_ROUTE } from "../contracts/project-actions.js";
import type { ProjectActionsExecutor } from "./project-actions.js";

const SESSION_COOKIE = "fmcad_cc_session";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_STATIC_BYTES = 8 * 1024 * 1024;
const MAX_STATIC_TOTAL_BYTES = 64 * 1024 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const API_TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 10_000;
const SSE_QUEUE_LIMIT = 32;
const MAX_SSE_CONNECTIONS = 32;
const MAX_SSE_EVENT_BYTES = 16 * 1024;
const SSE_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;
const portSuffix = (port: number): string => (port === 80 ? "" : `:${port}`);
const HOSTS = (port: number): Set<string> =>
  new Set([`localhost${portSuffix(port)}`]);
const ORIGINS = (port: number): Set<string> =>
  new Set([`http://localhost${portSuffix(port)}`]);

interface SessionRecord {
  readonly session: ConsoleHttpSession;
  readonly csrf: string;
  readonly expiresAt: number;
  lastSeen: number;
}

export interface ControlCenterHttpOptions {
  readonly identity: ConsoleHttpIdentity;
  readonly query: ConsoleHttpQueryPort;
  readonly resolvePrincipal: (
    session: ConsoleHttpSession,
  ) => ConsoleHttpPrincipal | Promise<ConsoleHttpPrincipal>;
  readonly projectActions?: ProjectActionsExecutor | null;
  readonly assets?: readonly ConsoleHttpAsset[];
  readonly now?: () => number;
}

export interface ControlCenterHttpServer {
  readonly port: number;
  start(): Promise<void>;
  close(): Promise<void>;
}

const securityHeaders: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  if (response.headersSent || response.destroyed) return;
  let body: string;
  try {
    body = JSON.stringify(redactSensitiveFields(value));
  } catch {
    body = JSON.stringify({
      version: CONTROL_CENTER_PROTOCOL_VERSION,
      state: "error",
      code: "RESPONSE_ERROR",
      message: "Unable to encode response",
    });
    status = 500;
  }
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    status = 502;
    body = JSON.stringify({
      version: CONTROL_CENTER_PROTOCOL_VERSION,
      state: "error",
      code: "RESPONSE_TOO_LARGE",
      message: "Response exceeds the service limit",
    });
  }
  response.writeHead(status, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof ConsoleHttpError) {
    const state =
      error.status === 401 || error.status === 403
        ? "forbidden"
        : error.status === 408 || error.status === 504 || error.status === 503
          ? "unavailable"
          : "error";
    sendJson(response, error.status, {
      version: CONTROL_CENTER_PROTOCOL_VERSION,
      state,
      code: error.code,
      message: error.message,
    });
    return;
  }
  sendJson(response, 500, {
    version: CONTROL_CENTER_PROTOCOL_VERSION,
    state: "error",
    code: "INTERNAL_ERROR",
    message: "Control Center request failed",
  });
}

function assetMap(
  assets: readonly ConsoleHttpAsset[] = [],
): Map<string, ConsoleHttpAsset> {
  const result = new Map<string, ConsoleHttpAsset>();
  let totalBytes = 0;
  for (const asset of assets) {
    const allowlisted =
      asset.path === "/index.html" ||
      ["/styles.css", "/favicon.svg", "/index.js"].includes(asset.path) ||
      /^\/(?:assets|fonts|vendor)\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,100}\/)*[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?:js|css|svg|woff2|png|ico)$/.test(
        asset.path,
      );
    if (!allowlisted || result.has(asset.path))
      throw new Error(
        "Control Center assets must use unique allowlisted paths",
      );
    const expectedType =
      asset.path === "/index.html"
        ? "text/html; charset=utf-8"
        : asset.path.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : asset.path.endsWith(".css")
            ? "text/css; charset=utf-8"
            : asset.path.endsWith(".svg")
              ? "image/svg+xml"
              : asset.path.endsWith(".woff2")
                ? "font/woff2"
                : asset.path.endsWith(".png")
                  ? "image/png"
                  : "image/x-icon";
    if (asset.contentType !== expectedType)
      throw new Error("Control Center asset type is not allowlisted");
    const body =
      typeof asset.body === "string"
        ? Buffer.byteLength(asset.body)
        : asset.body.byteLength;
    if (body > MAX_STATIC_BYTES)
      throw new Error("Control Center asset exceeds the size limit");
    totalBytes += body;
    if (totalBytes > MAX_STATIC_TOTAL_BYTES)
      throw new Error("Control Center asset manifest exceeds the size limit");
    result.set(asset.path, asset);
  }
  return result;
}

function parseHost(request: IncomingMessage, port: number): void {
  const host = request.headers.host?.toLowerCase();
  if (!host || !HOSTS(port).has(host))
    throw new ConsoleHttpError(
      421,
      "INVALID_HOST",
      "Request Host is not allowed",
    );
  const origin = request.headers.origin;
  if (
    origin !== undefined &&
    (Array.isArray(origin) || !ORIGINS(port).has(origin))
  )
    throw new ConsoleHttpError(
      403,
      "INVALID_ORIGIN",
      "Request Origin is not allowed",
    );
  const fetchSite = request.headers["sec-fetch-site"];
  if (
    fetchSite !== undefined &&
    (Array.isArray(fetchSite) ||
      (fetchSite !== "same-origin" && fetchSite !== "none"))
  )
    throw new ConsoleHttpError(
      403,
      "CROSS_SITE_REQUEST",
      "Cross-origin browser requests are not allowed",
    );
}

function rawPath(request: IncomingMessage): string {
  const target = request.url ?? "";
  if (
    target.length > 8192 ||
    !target.startsWith("/") ||
    target.startsWith("//")
  )
    throw new ConsoleHttpError(414, "INVALID_URL", "Request URL is invalid");
  const path = target.split("?", 1)[0]!;
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    /%(?:2e|2f|5c|00)/i.test(path) ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new ConsoleHttpError(
      400,
      "INVALID_PATH",
      "Request path is not allowed",
    );
  return path;
}

function queryValue(url: URL, key: string): string | null {
  const values = url.searchParams.getAll(key);
  if (values.length > 1)
    throw new ConsoleHttpError(
      400,
      "INVALID_REQUEST",
      `${key} must appear once`,
    );
  return values[0] ?? null;
}

function parseJsonParameter(url: URL, key: string): unknown {
  const text = queryValue(url, key);
  if (text === null) return undefined;
  if (text.length > 64 * 1024)
    throw new ConsoleHttpError(400, "INVALID_REQUEST", `${key} is too large`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConsoleHttpError(400, "INVALID_REQUEST", `${key} must be JSON`);
  }
}

function scopeFromUrl(url: URL): ConsoleHttpScope {
  const kind = queryValue(url, "scope");
  const projectId = queryValue(url, "projectId");
  if (kind === "global" && projectId === null) return { kind: "global" };
  if (kind === "project" && projectId !== null)
    return parseScope({ kind: "project", projectId });
  throw new ConsoleHttpError(
    400,
    "INVALID_REQUEST",
    "scope and projectId do not match",
  );
}

function queryRequestFromUrl(
  url: URL,
  snapshotHeader: string | undefined,
  allowFormat = false,
): ConsoleHttpQueryRequest {
  const allowed = new Set([
    "scope",
    "projectId",
    "collection",
    "version",
    "search",
    "filters",
    "facetFields",
    "aggregateFields",
    "sort",
    "offset",
    "limit",
  ]);
  if (allowFormat) {
    allowed.add("format");
    allowed.delete("offset");
    allowed.delete("limit");
  }
  for (const key of url.searchParams.keys())
    if (!allowed.has(key))
      throw new ConsoleHttpError(
        400,
        "INVALID_REQUEST",
        "Query contains an unsupported parameter",
      );
  const scope = scopeFromUrl(url);
  if (!snapshotHeader || snapshotHeader.length > 128)
    throw new ConsoleHttpError(
      400,
      "INVALID_REQUEST",
      "X-Control-Center-Snapshot header is required",
    );
  const request: Record<string, unknown> = {
    version: Number(
      queryValue(url, "version") ?? CONTROL_CENTER_PROTOCOL_VERSION,
    ),
    scope,
    collection: queryValue(url, "collection"),
  };
  request["snapshotToken"] = snapshotHeader;
  const search = queryValue(url, "search");
  if (search !== null) request["search"] = search;
  for (const key of [
    "filters",
    "facetFields",
    "aggregateFields",
    "sort",
  ] as const) {
    const value = parseJsonParameter(url, key);
    if (value !== undefined) request[key] = value;
  }
  for (const key of allowFormat ? [] : (["offset", "limit"] as const)) {
    const value = queryValue(url, key);
    if (value === null) continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(value))
      throw new ConsoleHttpError(
        400,
        "INVALID_REQUEST",
        `${key} must be an integer`,
      );
    request[key] = Number(value);
  }
  return parseQueryRequest(request);
}

function exportRequestFromUrl(
  url: URL,
  snapshotHeader: string | undefined,
): ConsoleHttpExportRequest {
  const request = queryRequestFromUrl(url, snapshotHeader, true);
  return parseExportRequest({
    ...request,
    format: queryValue(url, "format"),
  });
}

function detailRequestFromUrl(
  url: URL,
  snapshotHeader: string | undefined,
): ConsoleHttpArtifactRequest {
  const allowed = new Set([
    "scope",
    "projectId",
    "taskId",
    "artifactId",
    "kind",
    "offset",
    "length",
  ]);
  for (const key of url.searchParams.keys())
    if (!allowed.has(key))
      throw new ConsoleHttpError(
        400,
        "INVALID_REQUEST",
        "Detail contains an unsupported parameter",
      );
  const scopeKind = queryValue(url, "scope");
  const projectId = queryValue(url, "projectId");
  if (scopeKind !== null && scopeKind !== "project")
    throw new ConsoleHttpError(
      400,
      "INVALID_REQUEST",
      "detail scope must identify a project",
    );
  const request: Record<string, unknown> = {
    version: CONTROL_CENTER_PROTOCOL_VERSION,
    scope: parseScope({ kind: "project", projectId }),
    taskId: queryValue(url, "taskId"),
    artifactId: queryValue(url, "artifactId"),
    kind: queryValue(url, "kind"),
  };
  if (!snapshotHeader || snapshotHeader.length > 128)
    throw new ConsoleHttpError(
      400,
      "INVALID_REQUEST",
      "X-Control-Center-Snapshot header is required",
    );
  request["snapshotToken"] = snapshotHeader;
  for (const key of ["offset", "length"] as const) {
    const value = queryValue(url, key);
    if (value === null) continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(value))
      throw new ConsoleHttpError(
        400,
        "INVALID_REQUEST",
        `${key} must be an integer`,
      );
    request[key] = Number(value);
  }
  return parseDetailRequest(request);
}

function snapshotHeader(request: IncomingMessage): string | undefined {
  const value = request.headers["x-control-center-snapshot"];
  if (Array.isArray(value))
    throw new ConsoleHttpError(
      400,
      "INVALID_REQUEST",
      "Snapshot header must appear once",
    );
  return value;
}

function requestWithSnapshotHeader(
  body: Record<string, unknown>,
  header: string | undefined,
): Record<string, unknown> {
  if (Object.hasOwn(body, "snapshotToken"))
    throw new ConsoleHttpError(
      400,
      "INVALID_REQUEST",
      "Snapshot token must be sent in X-Control-Center-Snapshot",
    );
  if (!header || header.length > 128)
    throw new ConsoleHttpError(
      400,
      "INVALID_REQUEST",
      "X-Control-Center-Snapshot header is required",
    );
  return { ...body, snapshotToken: header };
}

function scopeAllowed(
  principal: ConsoleHttpPrincipal,
  scope: ConsoleHttpScope,
): boolean {
  return scope.kind === "global"
    ? principal.globalRead
    : principal.globalRead || principal.projectIds.includes(scope.projectId);
}

function cookieValue(request: IncomingMessage): string | null {
  const header = request.headers.cookie;
  if (!header || Array.isArray(header)) return null;
  const matches = header
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(SESSION_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validatePrincipal(value: ConsoleHttpPrincipal): ConsoleHttpPrincipal {
  if (
    !value ||
    typeof value.subject !== "string" ||
    value.subject.length < 1 ||
    value.subject.length > 256 ||
    typeof value.globalRead !== "boolean" ||
    !Array.isArray(value.projectIds) ||
    value.projectIds.length > 10_000 ||
    value.projectIds.some(
      (id) => typeof id !== "string" || id.length < 1 || id.length > 256,
    )
  )
    throw new ConsoleHttpError(
      503,
      "PRINCIPAL_UNAVAILABLE",
      "Console access could not be established",
    );
  return value;
}

async function timeout<T>(promise: Promise<T>, duration: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ConsoleHttpError(
                504,
                "REQUEST_TIMEOUT",
                "Control Center query timed out",
              ),
            ),
          duration,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|\s*$)/i.test(contentType)
  )
    throw new ConsoleHttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Expected an application/json body",
    );
  const length = request.headers["content-length"];
  if (
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)
  ) {
    request.resume();
    throw new ConsoleHttpError(
      413,
      "BODY_TOO_LARGE",
      "Request body exceeds the service limit",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  try {
    const body = await new Promise<Buffer>((resolve, reject) => {
      timer = setTimeout(() => {
        request.resume();
        reject(
          new ConsoleHttpError(408, "BODY_TIMEOUT", "Request body timed out"),
        );
      }, BODY_TIMEOUT_MS);
      request.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_REQUEST_BYTES) {
          request.resume();
          reject(
            new ConsoleHttpError(
              413,
              "BODY_TOO_LARGE",
              "Request body exceeds the service limit",
            ),
          );
          return;
        }
        chunks.push(buffer);
      });
      request.once("error", reject);
      request.once("end", () => resolve(Buffer.concat(chunks, size)));
    });
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(body),
      );
    } catch {
      throw new ConsoleHttpError(
        400,
        "INVALID_JSON",
        "Request body must be valid UTF-8 JSON",
      );
    }
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype)
      throw new ConsoleHttpError(
        400,
        "INVALID_JSON",
        "Request body must be a JSON object",
      );
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("Allow", allow);
  sendJson(response, 405, {
    version: CONTROL_CENTER_PROTOCOL_VERSION,
    state: "error",
    code: "METHOD_NOT_ALLOWED",
    message: "HTTP method is not allowed for this route",
  });
}

function checkCsrf(
  request: IncomingMessage,
  session: SessionRecord,
  port: number,
): void {
  const origin = request.headers.origin;
  const csrf = request.headers["x-fmcad-csrf"];
  if (
    typeof origin !== "string" ||
    !ORIGINS(port).has(origin) ||
    typeof csrf !== "string" ||
    !secureEqual(csrf, session.csrf)
  )
    throw new ConsoleHttpError(
      403,
      "CSRF_REJECTED",
      "Request origin or CSRF token is invalid",
    );
}

function parseAssetPath(path: string): string | null {
  if (path === "/" || path === "/index.html") return "/index.html";
  if (
    /^\/(?:assets|fonts|vendor)\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,100}\/)*[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?:js|css|svg|woff2|png|ico)$/.test(
      path,
    )
  )
    return path;
  if (["/styles.css", "/favicon.svg", "/index.js"].includes(path)) return path;
  if (path === "/vendor/highlight.min.js") return path;
  return null;
}

function createSessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function jsonMethodError(response: ServerResponse, method: string): void {
  methodNotAllowed(response, method);
}

function eventId(revision: ConsoleHttpRevision): string {
  return `${revision.epoch}:${revision.revision}`;
}

function scopeVisible(
  changed: ConsoleHttpScope,
  subscription: ConsoleHttpScope,
  principal: ConsoleHttpPrincipal,
): boolean {
  if (
    !scopeAllowed(principal, changed) ||
    (subscription.kind === "project" &&
      (changed.kind !== "project" ||
        changed.projectId !== subscription.projectId))
  )
    return false;
  return (
    subscription.kind === "global" ||
    (changed.kind === "project" && changed.projectId === subscription.projectId)
  );
}

function sseFrame(
  event: unknown,
  subscription: ConsoleHttpScope,
  principal: ConsoleHttpPrincipal,
  forceResync = false,
): string | null {
  const value = parseRevisionEvent(event);
  if (!value) return null;
  if (!scopeVisible(value.scope, subscription, principal)) return null;
  const data = JSON.stringify(
    redactSensitiveFields({
      scope: value.scope,
      revision: value.revision,
      resyncRequired: value.resyncRequired || forceResync,
    }),
  );
  if (Buffer.byteLength(data) > MAX_SSE_EVENT_BYTES) return null;
  return `id: ${eventId(value.revision)}\ndata: ${data}\n\n`;
}

function createSse(
  response: ServerResponse,
  options: ControlCenterHttpOptions,
  scope: ConsoleHttpScope,
  principal: ConsoleHttpPrincipal,
  after: ConsoleHttpRevision | null,
  session: SessionRecord,
  release: () => void,
  now: () => number,
): void {
  let closed = false;
  let blocked = false;
  let ready = false;
  let overflow = false;
  let closeAfterQueue = false;
  let overflowFrame: string | null = null;
  const queue: string[] = [];
  let unsubscribe: (() => void) | undefined;
  const timers: { heartbeat?: NodeJS.Timeout } = {};
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (timers.heartbeat) clearInterval(timers.heartbeat);
    response.off("drain", flush);
    response.off("close", cleanup);
    try {
      unsubscribe?.();
    } catch {
      /* The stream is already closed; no transport action can repair the source. */
    }
    release();
  };
  const finishForResync = (): void => {
    if (
      closed ||
      blocked ||
      (!overflow && !closeAfterQueue) ||
      queue.length > 0
    )
      return;
    if (overflowFrame) response.write(overflowFrame);
    response.end();
    cleanup();
  };
  const flush = (): void => {
    if (closed || !ready) return;
    blocked = false;
    while (!blocked && queue.length > 0)
      blocked = !response.write(queue.shift()!);
    finishForResync();
  };
  const enqueue = (frame: string, resync: boolean, event: unknown): boolean => {
    if (closed) return false;
    if (queue.length >= SSE_QUEUE_LIMIT) {
      overflow = true;
      queue.length = 0;
      overflowFrame = sseFrame(event, scope, principal, true);
    } else if (!overflow) {
      queue.push(frame);
    } else overflowFrame = sseFrame(event, scope, principal, true);
    if (resync) closeAfterQueue = true;
    flush();
    if (blocked) {
      overflow = true;
      closeAfterQueue = true;
      queue.length = 0;
      overflowFrame = sseFrame(event, scope, principal, true);
      return false;
    }
    return !resync && !overflow;
  };
  try {
    if (response.destroyed)
      throw new ConsoleHttpError(
        499,
        "CLIENT_CLOSED",
        "Client closed the event stream",
      );
    const subscription = options.query.subscribe(
      scope,
      after,
      principal,
      (event) => {
        const frame = sseFrame(event, scope, principal);
        if (frame === null) return true;
        const parsed = parseRevisionEvent(event);
        return enqueue(frame, parsed?.resyncRequired === true, event);
      },
    );
    if (typeof subscription !== "function")
      throw new ConsoleHttpError(
        503,
        "SUBSCRIPTION_UNAVAILABLE",
        "Snapshot event subscription is unavailable",
      );
    unsubscribe = subscription;
  } catch {
    if (unsubscribe) unsubscribe();
    throw new ConsoleHttpError(
      503,
      "SUBSCRIPTION_UNAVAILABLE",
      "Snapshot event subscription is unavailable",
    );
  }
  response.writeHead(200, {
    ...securityHeaders,
    "Cache-Control": "no-store, no-transform",
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  response.write("retry: 3000\n\n");
  response.on("drain", flush);
  response.once("close", cleanup);
  timers.heartbeat = setInterval(() => {
    const current = now();
    if (
      current >= session.expiresAt ||
      current - session.session.createdAt > SSE_MAX_LIFETIME_MS
    ) {
      response.end();
      cleanup();
      return;
    }
    session.lastSeen = current;
    if (!closed && !blocked && queue.length === 0)
      blocked = !response.write(": keep-alive\n\n");
  }, 15_000);
  timers.heartbeat.unref();
  ready = true;
  flush();
}

function createRequestHandler(
  options: ControlCenterHttpOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const assets = assetMap(options.assets);
  const sessions = new Map<string, SessionRecord>();
  const now = options.now ?? Date.now;
  let activeStreams = 0;

  function sessionFor(request: IncomingMessage): SessionRecord | null {
    const id = cookieValue(request);
    if (!id) return null;
    const record = sessions.get(id);
    if (!record) return null;
    const current = now();
    if (
      current >= record.expiresAt ||
      current - record.lastSeen > SESSION_IDLE_MS
    ) {
      sessions.delete(id);
      return null;
    }
    record.lastSeen = current;
    return record;
  }

  function newSession(response: ServerResponse): SessionRecord {
    if (sessions.size >= 2048) {
      for (const [id, record] of sessions)
        if (
          now() >= record.expiresAt ||
          now() - record.lastSeen > SESSION_IDLE_MS
        )
          sessions.delete(id);
    }
    if (sessions.size >= 2048)
      throw new ConsoleHttpError(
        503,
        "SESSION_LIMIT",
        "The service has reached its session limit",
      );
    const current = now();
    const id = randomBytes(32).toString("hex");
    const record: SessionRecord = {
      session: { subject: id, createdAt: current },
      csrf: randomBytes(32).toString("hex"),
      expiresAt: current + SESSION_TTL_MS,
      lastSeen: current,
    };
    sessions.set(id, record);
    response.setHeader("Set-Cookie", createSessionCookie(id));
    return record;
  }

  async function principalFor(
    record: SessionRecord,
  ): Promise<ConsoleHttpPrincipal> {
    return validatePrincipal(
      await timeout(
        Promise.resolve(options.resolvePrincipal(record.session)),
        API_TIMEOUT_MS,
      ),
    );
  }

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    parseHost(request, options.identity.port);
    const path = rawPath(request);
    const url = new URL(
      request.url!,
      `http://localhost:${options.identity.port}`,
    );
    const method = request.method ?? "GET";
    if (
      (method === "GET" || method === "HEAD") &&
      (request.headers["transfer-encoding"] !== undefined ||
        (request.headers["content-length"] !== undefined &&
          request.headers["content-length"] !== "0"))
    ) {
      request.resume();
      throw new ConsoleHttpError(
        400,
        "UNEXPECTED_BODY",
        "GET and HEAD requests cannot have a body",
      );
    }

    if (path === "/__fmcad/health") {
      if (method !== "GET") return methodNotAllowed(response, "GET");
      const authorization = request.headers.authorization;
      if (
        typeof authorization !== "string" ||
        !authorization.startsWith("Bearer ") ||
        !secureEqual(authorization.slice(7), options.identity.probeSecret)
      )
        throw new ConsoleHttpError(404, "NOT_FOUND", "Route not found");
      sendJson(response, 200, {
        service: "fmcad-control-center",
        protocolVersion: options.identity.protocolVersion,
        buildIdentity: options.identity.buildIdentity,
        pid: options.identity.pid,
        processBirth: options.identity.processBirth,
        instanceNonce: options.identity.instanceNonce,
        port: options.identity.port,
      });
      return;
    }

    const assetPath = parseAssetPath(path);
    if (assetPath !== null) {
      if (method !== "GET" && method !== "HEAD")
        return methodNotAllowed(response, "GET, HEAD");
      let session = sessionFor(request);
      if (assetPath === "/index.html" && !session)
        session = newSession(response);
      if (!session)
        throw new ConsoleHttpError(
          401,
          "SESSION_REQUIRED",
          "Open the Control Center home page first",
        );
      const asset = assets.get(assetPath);
      if (!asset) {
        sendJson(response, 503, {
          version: CONTROL_CENTER_PROTOCOL_VERSION,
          state: "unavailable",
          code: "UI_UNAVAILABLE",
          message: "Control Center web assets are unavailable",
        });
        return;
      }
      const body =
        typeof asset.body === "string"
          ? Buffer.from(asset.body)
          : Buffer.from(asset.body);
      response.writeHead(200, {
        ...securityHeaders,
        "Cache-Control":
          assetPath === "/index.html" ? "no-store" : "public, max-age=3600",
        "Content-Type": asset.contentType,
        "Content-Length": body.length,
      });
      response.end(method === "HEAD" ? undefined : body);
      return;
    }

    if (!path.startsWith("/api/v1/console/")) {
      sendJson(response, 404, {
        version: CONTROL_CENTER_PROTOCOL_VERSION,
        state: "error",
        code: "NOT_FOUND",
        message: "Route not found",
      });
      return;
    }
    const record = sessionFor(request);
    if (!record)
      throw new ConsoleHttpError(
        401,
        "SESSION_REQUIRED",
        "Control Center session is required",
      );

    if (path === "/api/v1/console/session") {
      if (method !== "GET") return methodNotAllowed(response, "GET");
      if (
        request.headers.origin !== undefined &&
        !ORIGINS(options.identity.port).has(request.headers.origin)
      )
        throw new ConsoleHttpError(
          403,
          "INVALID_ORIGIN",
          "Request Origin is not allowed",
        );
      sendJson(response, 200, {
        version: CONTROL_CENTER_PROTOCOL_VERSION,
        csrfToken: record.csrf,
      });
      return;
    }

    const principal = await principalFor(record);
    if (response.destroyed) return;
    if (path === PROJECT_ACTIONS_ROUTE) {
      if (method !== "POST") return methodNotAllowed(response, "POST");
      if (url.searchParams.size > 0)
        throw new ConsoleHttpError(
          400,
          "INVALID_REQUEST",
          "Project actions do not accept query parameters",
        );
      checkCsrf(request, record, options.identity.port);
      const input = await readJsonBody(request);
      if (!options.projectActions) {
        sendJson(response, 503, {
          version: CONTROL_CENTER_PROTOCOL_VERSION,
          state: "unavailable",
          code: "PROJECT_ACTIONS_UNAVAILABLE",
          message: "Project actions are not connected to the registered stores",
        });
        return;
      }
      const result = await timeout(
        Promise.resolve(options.projectActions(principal, input)),
        API_TIMEOUT_MS,
      );
      sendJson(response, 200, result);
      return;
    }
    if (path === "/api/v1/console/snapshot") {
      if (method !== "GET") return methodNotAllowed(response, "GET");
      for (const key of url.searchParams.keys())
        if (!new Set(["scope", "projectId"]).has(key))
          throw new ConsoleHttpError(
            400,
            "INVALID_REQUEST",
            "Snapshot contains an unsupported parameter",
          );
      const scope = scopeFromUrl(url);
      if (!scopeAllowed(principal, scope))
        throw new ConsoleHttpError(
          403,
          "SCOPE_FORBIDDEN",
          "Requested scope is not available",
        );
      const value = await timeout(
        options.query.snapshot(scope, principal),
        API_TIMEOUT_MS,
      );
      sendJson(response, 200, value);
      return;
    }

    if (path === "/api/v1/console/events") {
      if (method !== "GET") return methodNotAllowed(response, "GET");
      const allowed = new Set(["scope", "projectId", "after"]);
      for (const key of url.searchParams.keys())
        if (!allowed.has(key))
          throw new ConsoleHttpError(
            400,
            "INVALID_REQUEST",
            "Events contains an unsupported parameter",
          );
      const scope =
        url.searchParams.has("scope") || url.searchParams.has("projectId")
          ? scopeFromUrl(url)
          : { kind: "global" as const };
      if (!scopeAllowed(principal, scope))
        throw new ConsoleHttpError(
          403,
          "SCOPE_FORBIDDEN",
          "Requested scope is not available",
        );
      const afterHeader = request.headers["last-event-id"];
      if (Array.isArray(afterHeader))
        throw new ConsoleHttpError(
          400,
          "INVALID_REQUEST",
          "Last-Event-ID must appear once",
        );
      const after = parseRevision(afterHeader ?? queryValue(url, "after"));
      if (activeStreams >= MAX_SSE_CONNECTIONS)
        throw new ConsoleHttpError(
          503,
          "SUBSCRIPTION_LIMIT",
          "Too many Control Center event streams are active",
        );
      activeStreams += 1;
      let reserved = true;
      const release = (): void => {
        if (!reserved) return;
        reserved = false;
        activeStreams -= 1;
      };
      try {
        createSse(
          response,
          options,
          scope,
          principal,
          after,
          record,
          release,
          now,
        );
      } catch (error) {
        release();
        throw error;
      }
      return;
    }

    if (path === "/api/v1/console/query") {
      let body: ConsoleHttpQueryRequest;
      if (method === "GET") {
        body = queryRequestFromUrl(url, snapshotHeader(request));
      } else if (method === "POST") {
        checkCsrf(request, record, options.identity.port);
        body = parseQueryRequest(
          requestWithSnapshotHeader(
            await readJsonBody(request),
            snapshotHeader(request),
          ),
        );
      } else return jsonMethodError(response, "GET, POST");
      if (!scopeAllowed(principal, body["scope"] as ConsoleHttpScope))
        throw new ConsoleHttpError(
          403,
          "SCOPE_FORBIDDEN",
          "Requested scope is not available",
        );
      sendJson(
        response,
        200,
        await timeout(options.query.query(body, principal), API_TIMEOUT_MS),
      );
      return;
    }

    if (path === "/api/v1/console/detail") {
      let body: ConsoleHttpArtifactRequest;
      if (method === "GET") {
        body = detailRequestFromUrl(url, snapshotHeader(request));
      } else if (method === "POST") {
        checkCsrf(request, record, options.identity.port);
        body = parseDetailRequest(
          requestWithSnapshotHeader(
            await readJsonBody(request),
            snapshotHeader(request),
          ),
        );
      } else return jsonMethodError(response, "GET, POST");
      if (!scopeAllowed(principal, body["scope"] as ConsoleHttpScope))
        throw new ConsoleHttpError(
          403,
          "SCOPE_FORBIDDEN",
          "Requested scope is not available",
        );
      sendJson(
        response,
        200,
        await timeout(options.query.detail(body, principal), API_TIMEOUT_MS),
      );
      return;
    }

    if (path === "/api/v1/console/export") {
      let body: ConsoleHttpExportRequest;
      if (method === "GET") {
        body = exportRequestFromUrl(url, snapshotHeader(request));
      } else if (method === "POST") {
        checkCsrf(request, record, options.identity.port);
        body = parseExportRequest(
          requestWithSnapshotHeader(
            await readJsonBody(request),
            snapshotHeader(request),
          ),
        );
      } else return jsonMethodError(response, "GET, POST");
      if (!scopeAllowed(principal, body["scope"] as ConsoleHttpScope))
        throw new ConsoleHttpError(
          403,
          "SCOPE_FORBIDDEN",
          "Requested scope is not available",
        );
      sendJson(
        response,
        200,
        await timeout(options.query.export(body, principal), API_TIMEOUT_MS),
      );
      return;
    }

    sendJson(response, 404, {
      version: CONTROL_CENTER_PROTOCOL_VERSION,
      state: "error",
      code: "NOT_FOUND",
      message: "Route not found",
    });
  }

  return (request, response) => {
    void route(request, response).catch((error: unknown) =>
      sendError(response, error),
    );
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true, ipv6Only: host === "::1" });
  });
}

export function createControlCenterHttpServer(
  options: ControlCenterHttpOptions,
): ControlCenterHttpServer {
  if (
    !Number.isInteger(options.identity.port) ||
    options.identity.port < 1 ||
    options.identity.port > 65535
  )
    throw new Error(
      "Control Center port must be an integer from 1 through 65535",
    );
  if (options.identity.protocolVersion !== CONTROL_CENTER_PROTOCOL_VERSION)
    throw new Error("Control Center protocol version is unsupported");
  if (!/^[a-f0-9]{64}$/.test(options.identity.instanceNonce))
    throw new Error("Control Center instance nonce is invalid");
  if (!/^[a-f0-9]{64}$/.test(options.identity.probeSecret))
    throw new Error("Control Center probe secret is invalid");
  if (
    !options.query ||
    typeof options.query.snapshot !== "function" ||
    typeof options.query.query !== "function" ||
    typeof options.query.export !== "function" ||
    typeof options.query.detail !== "function" ||
    typeof options.query.subscribe !== "function" ||
    typeof options.resolvePrincipal !== "function" ||
    (options.projectActions !== undefined &&
      options.projectActions !== null &&
      typeof options.projectActions !== "function")
  )
    throw new Error(
      "Control Center requires a complete typed query handler and principal resolver",
    );
  const handler = createRequestHandler(options);
  const servers = ["127.0.0.1", "::1"].map((host) => {
    const server = createServer({ maxHeaderSize: 16 * 1024 }, handler);
    server.requestTimeout = BODY_TIMEOUT_MS + 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 64;
    return { host, server };
  });
  let started = false;
  return {
    port: options.identity.port,
    async close(): Promise<void> {
      await Promise.all(
        servers.map(
          ({ server }) =>
            new Promise<void>((resolve) => {
              if (!server.listening) return resolve();
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
      started = false;
    },
    async start(): Promise<void> {
      if (started) return;
      const active: Server[] = [];
      let ipv6Unavailable = false;
      try {
        for (const { host, server } of servers) {
          try {
            await listen(server, options.identity.port, host);
            active.push(server);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (
              host === "::1" &&
              ["EAFNOSUPPORT", "EADDRNOTAVAIL", "ENOTFOUND"].includes(
                code ?? "",
              )
            ) {
              ipv6Unavailable = true;
              continue;
            }
            throw error;
          }
        }
        if (active.length === 0 || (ipv6Unavailable && active.length !== 1))
          throw new Error("Control Center could not bind loopback listeners");
        started = true;
      } catch (error) {
        await Promise.all(
          active.map(
            (server) =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
              }),
          ),
        );
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE")
          throw new Error(
            `Control Center port ${options.identity.port} is already in use`,
            { cause: error },
          );
        throw error;
      }
    },
  };
}

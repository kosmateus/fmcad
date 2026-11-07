import type {
  ConsoleArtifactRequest,
  ConsoleQueryExportRequest,
  ConsoleQueryHandler,
  ConsoleQueryPrincipal,
  ConsoleQueryRequest,
  ConsoleQueryScope,
  ConsoleRevision,
  ConsoleRevisionEvent,
} from "../contracts/index.js";
import {
  CONSOLE_QUERY_CONTRACT_VERSION,
  isConsoleArtifactKind,
} from "../contracts/index.js";

export const CONTROL_CENTER_PROTOCOL_VERSION = CONSOLE_QUERY_CONTRACT_VERSION;

export type ConsoleHttpScope = ConsoleQueryScope;
export type ConsoleHttpPrincipal = ConsoleQueryPrincipal;
export type ConsoleHttpRevision = ConsoleRevision;
export type ConsoleHttpRevisionEvent = ConsoleRevisionEvent;
export type ConsoleHttpQueryRequest = ConsoleQueryRequest;
export type ConsoleHttpExportRequest = ConsoleQueryExportRequest;
export type ConsoleHttpArtifactRequest = ConsoleArtifactRequest;

export interface ConsoleHttpSession {
  readonly subject: string;
  readonly createdAt: number;
}

export type ConsoleHttpQueryPort = ConsoleQueryHandler;

/** Bridges the shared typed query handler without duplicating its DTO definitions. */
export interface ConsoleHttpAsset {
  readonly path: string;
  readonly contentType:
    | "text/html; charset=utf-8"
    | "text/javascript; charset=utf-8"
    | "text/css; charset=utf-8"
    | "image/svg+xml"
    | "font/woff2"
    | "image/png"
    | "image/x-icon";
  readonly body: string | Uint8Array;
}

export interface ConsoleHttpIdentity {
  readonly port: number;
  readonly buildIdentity: string;
  readonly protocolVersion: typeof CONTROL_CENTER_PROTOCOL_VERSION;
  readonly pid: number;
  readonly processBirth: string;
  readonly instanceNonce: string;
  readonly probeSecret: string;
}

const sensitiveTerms = new Set([
  "token",
  "credential",
  "credentials",
  "secret",
  "password",
  "authorization",
]);

export class ConsoleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConsoleHttpError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new ConsoleHttpError(400, "INVALID_REQUEST", message);
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype)
    fail(`${name} must be an object`);
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key)))
    fail(`${name} contains an unsupported field`);
}

function boundedString(value: unknown, name: string, max = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    fail(`${name} must be a non-empty string no longer than ${max} characters`);
  return value;
}

function optionalString(
  value: unknown,
  name: string,
  max = 1024,
): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, name, max);
}

export function parseScope(value: unknown): ConsoleHttpScope {
  const scope = plainRecord(value, "scope");
  if (scope["kind"] === "global") {
    rejectUnknownKeys(scope, ["kind"], "scope");
    return { kind: "global" };
  }
  if (scope["kind"] === "project") {
    rejectUnknownKeys(scope, ["kind", "projectId"], "scope");
    return {
      kind: "project",
      projectId: boundedString(scope["projectId"], "scope.projectId", 256),
    };
  }
  return fail("scope.kind must be global or project");
}

function parseFilters(
  value: unknown,
): ConsoleQueryRequest["filters"] | undefined {
  if (value === undefined) return undefined;
  return plainRecord(value, "filters") as ConsoleQueryRequest["filters"];
}

function parseRequestBase(value: unknown): Record<string, unknown> {
  const request = plainRecord(value, "request");
  if (request["version"] !== CONTROL_CENTER_PROTOCOL_VERSION)
    fail("request.version is unsupported");
  const scope = parseScope(request["scope"]);
  const collection = boundedString(request["collection"], "collection", 32);
  const result: Record<string, unknown> = {
    version: CONTROL_CENTER_PROTOCOL_VERSION,
    scope,
    collection: collection as ConsoleQueryRequest["collection"],
  };
  result["snapshotToken"] = boundedString(
    request["snapshotToken"],
    "snapshotToken",
    128,
  );
  const search = optionalString(request["search"], "search", 512);
  if (search !== undefined) result["search"] = search;
  const filters = parseFilters(request["filters"]);
  if (filters !== undefined) result["filters"] = filters;
  if (request["facetFields"] !== undefined) {
    const fields = request["facetFields"];
    if (!Array.isArray(fields)) fail("facetFields is invalid");
    result["facetFields"] = fields;
  }
  if (request["aggregateFields"] !== undefined) {
    const fields = request["aggregateFields"];
    if (!Array.isArray(fields)) fail("aggregateFields is invalid");
    result["aggregateFields"] = fields;
  }
  if (request["sort"] !== undefined) {
    const sort = request["sort"];
    if (!Array.isArray(sort)) fail("sort is invalid");
    result["sort"] = sort;
  }
  for (const key of ["offset", "limit"] as const) {
    if (request[key] === undefined) continue;
    const maximum = key === "limit" ? 500 : Number.MAX_SAFE_INTEGER;
    const number = request[key];
    if (
      !Number.isSafeInteger(number) ||
      (number as number) < 0 ||
      (number as number) > maximum
    )
      fail(`${key} is out of range`);
    result[key] = number;
  }
  return result;
}

export function parseQueryRequest(value: unknown): ConsoleQueryRequest {
  const request = plainRecord(value, "request");
  rejectUnknownKeys(
    request,
    [
      "version",
      "scope",
      "collection",
      "snapshotToken",
      "search",
      "filters",
      "facetFields",
      "aggregateFields",
      "sort",
      "offset",
      "limit",
    ],
    "request",
  );
  return parseRequestBase(request) as unknown as ConsoleQueryRequest;
}

export function parseExportRequest(value: unknown): ConsoleQueryExportRequest {
  const request = plainRecord(value, "request");
  rejectUnknownKeys(
    request,
    [
      "version",
      "scope",
      "collection",
      "snapshotToken",
      "search",
      "filters",
      "facetFields",
      "aggregateFields",
      "sort",
      "format",
    ],
    "request",
  );
  if (request["format"] !== "json" && request["format"] !== "csv")
    fail("format must be csv or json");
  return {
    ...parseRequestBase(request),
    format: request["format"],
  } as unknown as ConsoleQueryExportRequest;
}

export function parseDetailRequest(value: unknown): ConsoleArtifactRequest {
  const request = plainRecord(value, "request");
  rejectUnknownKeys(
    request,
    [
      "version",
      "scope",
      "taskId",
      "artifactId",
      "kind",
      "snapshotToken",
      "offset",
      "length",
    ],
    "request",
  );
  if (request["version"] !== CONTROL_CENTER_PROTOCOL_VERSION)
    fail("request.version is unsupported");
  const scope = parseScope(request["scope"]);
  if (scope.kind !== "project") fail("detail scope must identify a project");
  const kind = request["kind"];
  if (!isConsoleArtifactKind(kind)) fail("kind is unsupported");
  const result: Record<string, unknown> = {
    version: CONTROL_CENTER_PROTOCOL_VERSION,
    scope,
    taskId: boundedString(request["taskId"], "taskId", 256),
    artifactId: boundedString(request["artifactId"], "artifactId", 256),
    kind,
  };
  result["snapshotToken"] = boundedString(
    request["snapshotToken"],
    "snapshotToken",
    128,
  );
  for (const key of ["offset", "length"] as const) {
    if (request[key] === undefined) continue;
    const maximum =
      key === "length" ? 2 * 1024 * 1024 : Number.MAX_SAFE_INTEGER;
    const number = request[key];
    if (
      !Number.isSafeInteger(number) ||
      (number as number) < 0 ||
      (number as number) > maximum
    )
      fail(`${key} is out of range`);
    result[key] = number;
  }
  return result as unknown as ConsoleArtifactRequest;
}

export function parseRevision(value: string | null): ConsoleRevision | null {
  if (value === null || value === "") return null;
  const match = /^([A-Za-z0-9_-]{1,128}):(0|[1-9][0-9]{0,15})$/.exec(value);
  if (!match) fail("revision cursor is invalid");
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision)) fail("revision cursor is invalid");
  return { epoch: match[1]!, revision };
}

export function parseRevisionEvent(
  value: unknown,
): ConsoleRevisionEvent | null {
  if (!isRecord(value) || !isRecord(value["revision"])) return null;
  let scope: ConsoleHttpScope;
  try {
    scope = parseScope(value["scope"]);
  } catch {
    return null;
  }
  const epoch = value["revision"]["epoch"];
  const revision = value["revision"]["revision"];
  if (
    typeof epoch !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(epoch) ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0 ||
    typeof value["resyncRequired"] !== "boolean"
  )
    return null;
  return {
    scope,
    revision: { epoch, revision: revision as number },
    resyncRequired: value["resyncRequired"],
  };
}

export function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (!isRecord(value)) return value;
  const redacted = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    const terms = normalized.split(/[^a-z0-9]+/).filter(Boolean);
    const credentialField =
      key !== "snapshotToken" &&
      key !== "csrfToken" &&
      (terms.some((term) => sensitiveTerms.has(term)) ||
        (terms.includes("api") && terms.includes("key")));
    if (!credentialField) redacted[key] = redactSensitiveFields(item);
  }
  return redacted;
}

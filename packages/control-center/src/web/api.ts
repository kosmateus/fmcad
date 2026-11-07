/// <reference lib="dom" />

/** Browser transport for the passive same-origin Console Query API v1. */

import type {
  ConsoleArtifactKind,
  ConsoleArtifactRequest,
  ConsoleArtifactResult,
  ConsoleQueryError,
  ConsoleQueryExport,
  ConsoleQueryExportRequest,
  ConsoleLogRecord,
  ConsoleQueryPage,
  ConsoleQueryRequest,
  ConsoleQueryScope,
  ConsoleQuerySnapshot,
  ConsoleRevision,
  ConsoleRevisionEvent,
  ConsoleSourceStatus,
} from "../contracts/query.js";
import { PROJECT_ACTIONS_ROUTE } from "../contracts/project-actions.js";
import type {
  ProjectActionRequest,
  ProjectActionResponse,
} from "./agents-projects.js";

export type {
  ConsoleArtifactKind,
  ConsoleArtifactRequest,
  ConsoleArtifactResult,
  ConsoleQueryCollection,
  ConsoleQueryError,
  ConsoleQueryExport,
  ConsoleQueryExportRequest,
  ConsoleLogRecord,
  ConsoleOverviewRecord,
  ConsoleQueryPage,
  ConsoleQueryRangeFilter,
  ConsoleQueryRequest,
  ConsoleQueryScope,
  ConsoleQuerySnapshot,
  ConsoleQueryTextFilter,
  ConsoleRevision,
  ConsoleRevisionEvent,
  ConsoleSourceStatus,
} from "../contracts/query.js";

export const API_VERSION: ConsoleQueryRequest["version"] = 1;
export const API_ROOT = "/api/v1/console";
export const SNAPSHOT_HEADER = "X-Control-Center-Snapshot";
export const CSRF_HEADER = "X-Fmcad-CSRF";

export interface ConsoleSessionBootstrap {
  readonly version: typeof API_VERSION;
  readonly csrfToken: string;
}

export type QueryScope = ConsoleQueryScope;
export type Revision = ConsoleRevision;
export type SourceStatus = ConsoleSourceStatus;
export type Snapshot = ConsoleQuerySnapshot;
export type QueryRequest = ConsoleQueryRequest;
export type QueryPage<Row = Record<string, unknown>> = ConsoleQueryPage<Row>;
export type ArtifactRequest = ConsoleArtifactRequest;
export type ArtifactResult = ConsoleArtifactResult;
export type QueryExport = ConsoleQueryExport;
export type RevisionEvent = ConsoleRevisionEvent;
export type ArtifactKind = ConsoleArtifactKind;

export class ConsoleApiError extends Error {
  constructor(
    message: string,
    readonly state: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ConsoleApiError";
  }
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ConsoleQueryClient {
  readonly #root: URL;
  #csrfToken: string | null = null;
  #sessionRequest: Promise<string> | null = null;

  constructor(
    origin: string,
    private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis),
  ) {
    this.#root = new URL(API_ROOT, origin);
    if (this.#root.origin !== new URL(origin).origin)
      throw new TypeError("Console Query API must use the current origin");
  }

  snapshot(scope: QueryScope, signal?: AbortSignal): Promise<Snapshot> {
    const url = this.url("snapshot");
    addScope(url.searchParams, scope);
    return this.get<Snapshot>(url, signal).then((value) =>
      validateSnapshot(value, scope),
    );
  }

  query<Row = Record<string, unknown>>(
    request: QueryRequest,
    signal?: AbortSignal,
  ): Promise<QueryPage<Row>> {
    const url = this.url("query");
    return this.post<QueryPage<Row>>(url, request, signal).then((value) =>
      validatePage(value, request),
    );
  }

  detail(
    request: ArtifactRequest,
    signal?: AbortSignal,
  ): Promise<ArtifactResult> {
    const url = this.url("detail");
    return this.post<ArtifactResult>(url, request, signal).then((value) =>
      validateArtifact(value, request),
    );
  }

  export(
    request: ConsoleQueryExportRequest,
    signal?: AbortSignal,
  ): Promise<QueryExport> {
    const url = this.url("export");
    return this.post<QueryExport>(url, request, signal).then((value) =>
      validateExport(value, request),
    );
  }

  projectAction(request: ProjectActionRequest): Promise<ProjectActionResponse> {
    const url = new URL(PROJECT_ACTIONS_ROUTE, this.#root.origin);
    return this.ensureSession().then((csrfToken) =>
      this.requestJson<ProjectActionResponse>(url, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          [CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify(request),
      }).then((value) => validateProjectActionResponse(value, request)),
    );
  }

  watch(
    scope: QueryScope,
    after: Revision | null,
    onRevision: (event: RevisionEvent) => void,
    onError: (event: Event) => void,
  ): EventSource {
    const url = this.url("events");
    addScope(url.searchParams, scope);
    if (after)
      url.searchParams.set("after", `${after.epoch}:${after.revision}`);
    const source = new EventSource(url, { withCredentials: false });
    const receive = (event: MessageEvent<string>) => {
      try {
        const value: unknown = JSON.parse(event.data);
        if (isRevisionEvent(value) && sameScope(value.scope, scope))
          onRevision(value);
        else onError(new Event("invalid-event"));
      } catch {
        onError(new Event("invalid-event"));
      }
    };
    source.onmessage = receive;
    source.addEventListener("revision", (event) =>
      receive(event as MessageEvent<string>),
    );
    source.onerror = onError;
    return source;
  }

  private url(resource: string): URL {
    return new URL(`${resource}`, `${this.#root.href}/`);
  }

  private async get<T>(
    url: URL,
    signal?: AbortSignal,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    await this.ensureSession();
    return this.requestJson<T>(url, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json", ...extraHeaders },
      ...(signal ? { signal } : {}),
    });
  }

  private async post<T>(
    url: URL,
    payload: object & { readonly snapshotToken: string },
    signal?: AbortSignal,
  ): Promise<T> {
    const csrfToken = await this.ensureSession();
    const { snapshotToken, ...body } = payload;
    return this.requestJson<T>(url, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...snapshotHeader(snapshotToken),
        [CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  private async ensureSession(): Promise<string> {
    if (this.#csrfToken) return this.#csrfToken;
    if (this.#sessionRequest) return this.#sessionRequest;
    const pending = this.requestJson<ConsoleSessionBootstrap>(
      this.url("session"),
      {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
      },
    )
      .then((value) => {
        if (
          !isRecord(value) ||
          value["version"] !== API_VERSION ||
          typeof value["csrfToken"] !== "string" ||
          !/^[a-f0-9]{64}$/.test(value["csrfToken"])
        )
          invalidPayload();
        this.#csrfToken = value["csrfToken"];
        return value["csrfToken"];
      })
      .finally(() => {
        if (this.#sessionRequest === pending) this.#sessionRequest = null;
      });
    this.#sessionRequest = pending;
    return pending;
  }

  private async requestJson<T>(url: URL, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      throw new ConsoleApiError(
        "Nie można połączyć się z lokalnym panelem.",
        "unavailable",
        "NETWORK_ERROR",
        0,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ConsoleApiError(
        response.ok
          ? "Serwer zwrócił nieczytelną odpowiedź."
          : "Odczyt API nie powiódł się.",
        response.ok ? "error" : "unavailable",
        "INVALID_RESPONSE",
        response.status,
      );
    }

    if (!response.ok) {
      const error = isApiError(body)
        ? body
        : {
            state: "error" as const,
            code: `HTTP_${response.status}`,
            message: "Odczyt API nie powiódł się.",
          };
      throw new ConsoleApiError(
        error.message,
        error.state,
        error.code,
        response.status,
      );
    }
    if (isApiError(body))
      throw new ConsoleApiError(
        body.message,
        body.state,
        body.code,
        response.status,
      );
    if (!isRecord(body) || body["version"] !== API_VERSION)
      throw new ConsoleApiError(
        "Serwer zwrócił niezgodny kontrakt Console Query API.",
        "error",
        "INVALID_RESPONSE",
        response.status,
      );
    return body as T;
  }
}

function addScope(params: URLSearchParams, scope: QueryScope): void {
  params.set("scope", scope.kind);
  if (scope.kind === "project") params.set("projectId", scope.projectId);
}

function snapshotHeader(token: string): Readonly<Record<string, string>> {
  if (!token.trim()) throw new TypeError("Snapshot token must be nonempty");
  return { [SNAPSHOT_HEADER]: token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isApiError(value: unknown): value is ConsoleQueryError {
  return (
    isRecord(value) &&
    value["version"] === API_VERSION &&
    ["unavailable", "error", "expired", "forbidden"].includes(
      String(value["state"]),
    ) &&
    typeof value["code"] === "string" &&
    typeof value["message"] === "string"
  );
}

function isRevisionEvent(value: unknown): value is RevisionEvent {
  if (!isRecord(value)) return false;
  const revision = value["revision"];
  const scope = value["scope"];
  if (!isRecord(revision) || !isRecord(scope)) return false;
  return (
    typeof revision["epoch"] === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(revision["epoch"]) &&
    Number.isSafeInteger(revision["revision"]) &&
    Number(revision["revision"]) >= 0 &&
    (scope["kind"] === "global" ||
      (scope["kind"] === "project" &&
        typeof scope["projectId"] === "string" &&
        scope["projectId"].trim().length > 0)) &&
    typeof value["resyncRequired"] === "boolean"
  );
}

function invalidPayload(): never {
  throw new ConsoleApiError(
    "Serwer zwrócił niekompletną odpowiedź Console Query API.",
    "error",
    "INVALID_RESPONSE",
    200,
  );
}

function isRevision(value: unknown): value is Revision {
  return (
    isRecord(value) &&
    typeof value["epoch"] === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value["epoch"]) &&
    Number.isSafeInteger(value["revision"]) &&
    Number(value["revision"]) >= 0
  );
}

function isSource(value: unknown): value is SourceStatus {
  return (
    isRecord(value) &&
    ["available", "partial", "stale", "unavailable", "no-data"].includes(
      String(value["state"]),
    ) &&
    typeof value["source"] === "string" &&
    (value["observedAt"] === null || typeof value["observedAt"] === "number")
  );
}

function validateSnapshot(value: Snapshot, expected: QueryScope): Snapshot {
  if (
    typeof value.snapshotToken !== "string" ||
    !value.snapshotToken.trim() ||
    !isRevision(value.revision) ||
    !Number.isFinite(value.capturedAt) ||
    !isRecord(value.sources) ||
    !isRecord(value.scope) ||
    value.scope.kind !== expected.kind ||
    (expected.kind === "project" &&
      value.scope.kind === "project" &&
      value.scope.projectId !== expected.projectId) ||
    !Object.values(value.sources).every(isSource)
  )
    invalidPayload();
  return value;
}

function sameScope(left: QueryScope, right: QueryScope): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "global" ||
      (right.kind === "project" && left.projectId === right.projectId))
  );
}

function validatePage<Row>(
  value: QueryPage<Row>,
  expected: QueryRequest,
): QueryPage<Row> {
  if (
    !isRevision(value.revision) ||
    !isSource(value.source) ||
    !Array.isArray(value.rows) ||
    !(
      value.total === null ||
      (Number.isSafeInteger(value.total) && value.total >= 0)
    ) ||
    !Number.isSafeInteger(value.offset) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 0 ||
    typeof value.snapshotToken !== "string" ||
    !value.snapshotToken.trim() ||
    value.snapshotToken !== expected.snapshotToken ||
    value.collection !== expected.collection ||
    !isRecord(value.scope) ||
    !sameScope(value.scope, expected.scope) ||
    (expected.offset !== undefined && value.offset !== expected.offset) ||
    (expected.limit !== undefined && value.limit !== expected.limit) ||
    !isRecord(value.facets) ||
    !isRecord(value.aggregates) ||
    (expected.collection === "logs" && !value.rows.every(isLogRecord))
  )
    invalidPayload();
  return value;
}

function isLogRecord(value: unknown): value is ConsoleLogRecord {
  if (!isRecord(value)) return false;
  const timestamp = value["timestamp"];
  return (
    typeof value["id"] === "string" &&
    (timestamp === null ||
      (typeof timestamp === "number" && Number.isFinite(timestamp)))
  );
}

function validateArtifact(
  value: ArtifactResult,
  expected: ArtifactRequest,
): ArtifactResult {
  if (
    !isRevision(value.revision) ||
    ![
      "available",
      "empty",
      "missing",
      "truncated",
      "expired",
      "error",
      "forbidden",
    ].includes(value.state) ||
    typeof value.artifactId !== "string" ||
    typeof value.kind !== "string" ||
    value.artifactId !== expected.artifactId ||
    value.kind !== expected.kind ||
    !(value.content === null || typeof value.content === "string") ||
    !Number.isSafeInteger(value.offset) ||
    !Number.isSafeInteger(value.length) ||
    !(
      value.totalLength === null ||
      (Number.isSafeInteger(value.totalLength) && value.totalLength >= 0)
    )
  )
    invalidPayload();
  return value;
}

function validateExport(
  value: QueryExport,
  expected: ConsoleQueryExportRequest,
): QueryExport {
  if (
    !isRevision(value.revision) ||
    value.snapshotToken !== expected.snapshotToken ||
    value.collection !== expected.collection ||
    !isRecord(value.scope) ||
    !sameScope(value.scope, expected.scope) ||
    value.format !== expected.format ||
    !Number.isSafeInteger(value.rowCount) ||
    value.rowCount < 0 ||
    typeof value.content !== "string"
  )
    invalidPayload();
  return value;
}

function validateProjectActionResponse(
  value: unknown,
  request: ProjectActionRequest,
): ProjectActionResponse {
  if (
    !isRecord(value) ||
    value["version"] !== API_VERSION ||
    !["ok", "blocked", "stale", "unavailable", "forbidden", "error"].includes(
      String(value["state"]),
    ) ||
    typeof value["code"] !== "string" ||
    value["projectId"] !== request.projectId ||
    !(value["revision"] === null || isRevision(value["revision"])) ||
    !(
      value["monitoring"] === null || typeof value["monitoring"] === "boolean"
    ) ||
    !(
      value["archivedAtMs"] === null || Number.isFinite(value["archivedAtMs"])
    ) ||
    !(value["alias"] === null || typeof value["alias"] === "string") ||
    !Array.isArray(value["reasons"]) ||
    value["reasons"].some(
      (reason) => !isRecord(reason) || typeof reason["key"] !== "string",
    )
  )
    invalidPayload();
  return value as unknown as ProjectActionResponse;
}

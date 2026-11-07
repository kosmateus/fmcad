import {
  CONSOLE_QUERY_CONTRACT_VERSION,
  type ConsoleArtifactRequest,
  type ConsoleArtifactResult,
  isConsoleArtifactKind,
  type ConsoleQueryError,
  type ConsoleQueryExport,
  type ConsoleQueryExportRequest,
  type ConsoleQueryHandler,
  type ConsoleQueryPage,
  type ConsoleQueryPrincipal,
  type ConsoleQueryRecord,
  type ConsoleQueryRequest,
  type ConsoleQueryScope,
  type ConsoleQuerySnapshot,
  type ConsoleRevision,
  type ConsoleRevisionEvent,
  type ConsoleRevisionListener,
  type ConsoleSourceStatus,
} from "../contracts/index.js";
import { redactDiagnostic } from "@fmcad/core";
import {
  buildAggregates,
  buildFacets,
  boundedId,
  errorResult,
  filterRows,
  isRecord,
  nonempty,
  normalizeSource,
  sameScope,
  sortRows,
  stablePage,
  supportedCollection,
  validFilters,
  validPrincipal,
  validRevision,
  validScope,
  validSorts,
} from "./query/engine.js";
import type {
  ConsoleArtifactLocator,
  ConsoleOwnedArtifactReference,
  ConsoleQueryApiOptions,
  ConsoleQueryDataSnapshot,
  ConsoleQueryReadPort,
} from "./query/port.js";

interface StoredSnapshot {
  token: string;
  principalKey: string;
  data: ConsoleQueryDataSnapshot;
  createdAt: number;
  sources: Record<string, ConsoleSourceStatus>;
}

interface Listener {
  scope: ConsoleQueryScope;
  principal: ConsoleQueryPrincipal;
  callback: ConsoleRevisionListener;
}

interface RevisionState {
  latest: ConsoleRevision | null;
  history: ConsoleRevisionEvent[];
  seenEpochs: Set<string>;
}

export interface ConsoleQueryApi extends ConsoleQueryHandler {
  /** Called by the server's one existing revision stream; never polls itself. */
  invalidate(event: ConsoleRevisionEvent): void;
}

const COLLECTIONS = [
  "projects",
  "overview",
  "tasks",
  "agents",
  "sessions",
  "files",
  "logs",
  "system",
] as const;
const SEARCH_COLLECTIONS = ["projects", "agents", "tasks"] as const;
const SECRET_FIELD =
  /^(?:access[_-]?token|refresh[_-]?token|(?:api|session|bearer|mcp)[_-]?token|token|api[_-]?key|private[_-]?key|key|secret|password|signature|sig|credential|authorization|proxy-authorization|cookie|set-cookie|mcp[-_]?session[-_]?id|client[_-]?secret)$/i;
const DEFAULT_RANGE = 64 * 1024;
const MAX_ARTIFACT_OFFSET = 64 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_FACET_FIELDS = 32;
const MAX_EXPORT_COLUMNS = 2048;
const MAX_EXPORT_CELLS = 1_000_000;

function error(
  state: ConsoleQueryError["state"],
  code: string,
  message: string,
): ConsoleQueryError {
  return errorResult(state, code, message);
}

function utf8Length(value: string): number {
  let length = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    length += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return length;
}

function newSnapshotToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  const token = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `ccq1-${token}`;
}

function projectAllowed(
  scope: ConsoleQueryScope,
  principal: ConsoleQueryPrincipal,
): boolean {
  return scope.kind === "global"
    ? principal.globalRead
    : principal.globalRead || principal.projectIds.includes(scope.projectId);
}

function cloneScope(scope: ConsoleQueryScope): ConsoleQueryScope {
  return scope.kind === "global" ? { kind: "global" } : { ...scope };
}

function scopeKey(scope: ConsoleQueryScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.projectId}`;
}

function clonePrincipal(
  principal: ConsoleQueryPrincipal,
): ConsoleQueryPrincipal {
  return {
    subject: principal.subject,
    projectIds: [...new Set(principal.projectIds)],
    globalRead: principal.globalRead,
  };
}

function cloneSource(source: ConsoleSourceStatus): ConsoleSourceStatus {
  return {
    ...source,
    ...(source.reason
      ? {
          reason: redactDiagnostic(source.reason).replace(
            /(?:[A-Za-z]:\\[^\s<>"']+|\/(?:[^\s<>"']+\/)*[^\s<>"']+)/g,
            "[local path]",
          ),
        }
      : {}),
  };
}

function redact(value: unknown, preserveArtifactLocators = false): unknown {
  if (Array.isArray(value))
    return value.map((item) => redact(item, preserveArtifactLocators));
  if (typeof value === "string") return redactDiagnostic(value);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          preserveArtifactLocators ||
          (key !== "locator" && key !== "sourcePath"),
      )
      .map(([key, item]) => [
        key,
        preserveArtifactLocators && key === "locator"
          ? item
          : SECRET_FIELD.test(key)
            ? "[REDACTED]"
            : redact(item, preserveArtifactLocators),
      ]),
  );
}

function normalizeLogTimestamps(snapshot: ConsoleQueryDataSnapshot): void {
  const logs = snapshot.collections["logs"];
  if (!logs) return;
  snapshot.collections["logs"] = logs.map((row) => {
    const timestamp = row.timestamp;
    if (
      typeof timestamp === "number" &&
      Number.isSafeInteger(timestamp) &&
      timestamp >= 0
    )
      return { ...row, timestamp };
    const timestampRaw =
      typeof timestamp === "string"
        ? timestamp
        : typeof row["timestampRaw"] === "string" ||
            typeof row["timestampRaw"] === "number"
          ? row["timestampRaw"]
          : typeof timestamp === "number"
            ? timestamp
            : undefined;
    return {
      ...row,
      timestamp: null,
      ...(timestampRaw === undefined ? {} : { timestampRaw }),
    };
  });
}

function csvCell(value: unknown): string {
  const text =
    value === undefined
      ? ""
      : value === null
        ? "null"
        : typeof value === "string"
          ? value
          : typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : JSON.stringify(value);
  const safe =
    typeof value === "number" && Number.isFinite(value)
      ? text
      : /^(?:\s*[-=+@]|[\t\r\n])/.test(text)
        ? `'${text}`
        : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csv(
  rows: readonly ConsoleQueryRecord[],
  columns: readonly string[],
): string {
  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) =>
      columns.map((key) => csvCell(redact(row[key]))).join(","),
    ),
  ].join("\r\n");
}

function errorSource(message: string): ConsoleSourceStatus {
  return {
    state: "unavailable",
    source: "query-api",
    observedAt: null,
    reason: message,
  };
}

function isSourceStatus(value: unknown): value is ConsoleSourceStatus {
  return (
    isRecord(value) &&
    ["available", "partial", "stale", "unavailable", "no-data"].includes(
      String(value["state"]),
    ) &&
    nonempty(value["source"]) &&
    value["source"].length <= 128 &&
    (value["observedAt"] === null ||
      (typeof value["observedAt"] === "number" &&
        Number.isFinite(value["observedAt"]))) &&
    (value["reason"] === undefined ||
      (typeof value["reason"] === "string" && value["reason"].length <= 2048))
  );
}

function searchSource(
  sources: Record<string, ConsoleSourceStatus>,
  data: ConsoleQueryDataSnapshot,
): ConsoleSourceStatus {
  const parts = SEARCH_COLLECTIONS.map((collection) => sources[collection]!);
  const available = parts.filter((source) => source.state !== "unavailable");
  const incompleteIdentity = SEARCH_COLLECTIONS.some((collection) =>
    (data.collections[collection] ?? []).some(
      (row) =>
        !boundedId(row.id) ||
        (collection !== "projects" &&
          data.scope.kind === "global" &&
          !boundedId(row.projectId)),
    ),
  );
  const state: ConsoleSourceStatus["state"] =
    available.length === 0
      ? "unavailable"
      : available.length === parts.length &&
          available.every((source) => source.state === "no-data")
        ? "no-data"
        : incompleteIdentity ||
            available.length !== parts.length ||
            available.some((source) => source.state === "partial")
          ? "partial"
          : available.some((source) => source.state === "stale")
            ? "stale"
            : "available";
  const observed = parts.flatMap((source) =>
    source.observedAt === null ? [] : [source.observedAt],
  );
  const reasons = [
    ...new Set(
      parts.flatMap((source) => (source.reason ? [source.reason] : [])),
    ),
  ];
  return {
    state,
    source: "global-search",
    observedAt: observed.length ? Math.min(...observed) : null,
    ...(reasons.length ? { reason: reasons.join("; ").slice(0, 2048) } : {}),
  };
}

function searchRows(stored: StoredSnapshot): ConsoleQueryRecord[] {
  return SEARCH_COLLECTIONS.flatMap((collection) => {
    if (
      stored.sources[collection]?.state === "unavailable" ||
      stored.sources[collection]?.state === "no-data"
    )
      return [];
    const resultType =
      collection === "projects"
        ? "project"
        : collection === "agents"
          ? "agent"
          : "task";
    return (stored.data.collections[collection] ?? []).flatMap((record) => {
      if (!boundedId(record.id)) return [];
      const projectId =
        collection === "projects"
          ? record.id
          : boundedId(record.projectId)
            ? record.projectId
            : stored.data.scope.kind === "project"
              ? stored.data.scope.projectId
              : null;
      if (!projectId) return [];
      return [
        { ...record, id: record.id, projectId, collection, resultType, record },
      ];
    });
  });
}

function principalKey(principal: ConsoleQueryPrincipal): string {
  return JSON.stringify([
    principal.subject,
    principal.globalRead,
    [...new Set(principal.projectIds)].sort(),
  ]);
}

function isLaterRevision(
  left: ConsoleRevision,
  right: ConsoleRevision,
): boolean {
  return left.epoch !== right.epoch || left.revision > right.revision;
}

/** Artifact ownership is based on retained IDs, never caller-provided paths. */
function isArtifactRef(value: unknown): value is ConsoleOwnedArtifactReference {
  return (
    isRecord(value) &&
    boundedId(value["projectId"]) &&
    boundedId(value["taskId"]) &&
    boundedId(value["artifactId"]) &&
    isConsoleArtifactKind(value["kind"]) &&
    (value["locator"] === undefined || validArtifactLocator(value["locator"]))
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string): boolean {
  return Object.keys(value).sort().join(",") === keys;
}

function isRetainedArtifactChannel(value: unknown): value is {
  state: "available";
  artifactId: string;
  sourceHash: string;
  provenance:
    | "retained-owned-result"
    | "retained-project-file"
    | "retained-artifact-store";
} {
  return (
    isRecord(value) &&
    hasExactKeys(value, "artifactId,provenance,sourceHash,state") &&
    value["state"] === "available" &&
    boundedId(value["artifactId"]) &&
    typeof value["sourceHash"] === "string" &&
    /^[a-f0-9]{64}$/u.test(value["sourceHash"]) &&
    [
      "retained-owned-result",
      "retained-project-file",
      "retained-artifact-store",
    ].includes(String(value["provenance"]))
  );
}

function validArtifactLocator(value: unknown): value is ConsoleArtifactLocator {
  if (!isRecord(value)) return false;
  const type = value["type"];
  if (
    type === "missing" ||
    type === "expired" ||
    type === "error" ||
    type === "forbidden"
  )
    return hasExactKeys(value, "type");
  if (type === "inline-event")
    return (
      hasExactKeys(value, "content,type") &&
      typeof value["content"] === "string" &&
      utf8Length(value["content"]) <= 256 * 1024
    );
  if (type === "artifact-store") {
    const context = value["context"];
    return (
      hasExactKeys(value, "context,sha256,type") &&
      typeof value["sha256"] === "string" &&
      /^[a-f0-9]{64}$/u.test(value["sha256"]) &&
      isRecord(context) &&
      hasExactKeys(
        context,
        "clientId,documentId,instanceId,projectId,purpose,requestId,sessionId",
      ) &&
      boundedId(context["projectId"], 256) &&
      boundedId(context["documentId"], 256) &&
      boundedId(context["clientId"], 256) &&
      boundedId(context["requestId"], 256) &&
      (context["sessionId"] === null || boundedId(context["sessionId"], 256)) &&
      (context["instanceId"] === null ||
        boundedId(context["instanceId"], 256)) &&
      (context["purpose"] === null || boundedId(context["purpose"], 128))
    );
  }
  if (type === "project-file")
    return (
      (hasExactKeys(value, "path,sha256,type") ||
        hasExactKeys(value, "bytes,path,sha256,type")) &&
      boundedId(value["path"], 4096) &&
      (value["sha256"] === null ||
        (typeof value["sha256"] === "string" &&
          /^[a-f0-9]{64}$/u.test(value["sha256"]))) &&
      (value["bytes"] === undefined ||
        value["bytes"] === null ||
        (Number.isSafeInteger(value["bytes"]) &&
          (value["bytes"] as number) >= 0))
    );
  if (type === "owned-result") {
    const reference = value["reference"];
    return (
      isRecord(reference) &&
      hasExactKeys(value, "reference,type") &&
      Object.keys(reference).sort().join(",") ===
        "bytes,jobId,name,scope,sha256,storage,version" &&
      reference["version"] === 1 &&
      boundedId(reference["jobId"], 256) &&
      boundedId(reference["scope"], 128) &&
      (reference["storage"] === "project" ||
        reference["storage"] === "legacy") &&
      ["stdout.txt", "stderr.txt", "rpc-result.json"].includes(
        String(reference["name"]),
      ) &&
      Number.isSafeInteger(reference["bytes"]) &&
      (reference["bytes"] as number) >= 0 &&
      typeof reference["sha256"] === "string" &&
      /^[a-f0-9]{64}$/u.test(reference["sha256"])
    );
  }
  return false;
}

function retainedOutputBinding(
  locator: ConsoleArtifactLocator | undefined,
): { sourceHash: string; provenance: string } | null {
  if (locator?.type === "project-file" && locator.sha256)
    return {
      sourceHash: locator.sha256,
      provenance: "retained-project-file",
    };
  if (locator?.type === "owned-result")
    return {
      sourceHash: locator.reference.sha256,
      provenance: "retained-owned-result",
    };
  if (locator?.type === "artifact-store")
    return {
      sourceHash: locator.sha256,
      provenance: "retained-artifact-store",
    };
  return null;
}

function validRetainedOutputChannels(
  snapshot: ConsoleQueryDataSnapshot,
): boolean {
  const refs = (snapshot.artifacts ?? []).filter(isArtifactRef);
  const fields = [
    ["stdout", "stdout"],
    ["stderr", "stderr"],
    ["rpc", "rpc"],
  ] as const;
  for (const row of snapshot.collections["tasks"] ?? []) {
    if (!boundedId(row.id)) continue;
    const projectId = boundedId(row.projectId)
      ? row.projectId
      : snapshot.scope.kind === "project"
        ? snapshot.scope.projectId
        : null;
    if (!projectId || !isRecord(row.artifacts)) continue;
    for (const [field, kind] of fields) {
      const channel = row.artifacts[field];
      if (channel === undefined) continue;
      if (!isRecord(channel)) return false;
      if (
        channel["state"] === "missing" ||
        channel["state"] === "unavailable"
      ) {
        if (
          !hasExactKeys(channel, "reason,state") ||
          typeof channel["reason"] !== "string" ||
          !channel["reason"].trim()
        )
          return false;
        continue;
      }
      if (!isRetainedArtifactChannel(channel)) return false;
      const reference = refs.find(
        (item) =>
          item.projectId === projectId &&
          item.taskId === row.id &&
          item.artifactId === channel.artifactId &&
          item.kind === kind,
      );
      const binding = reference
        ? retainedOutputBinding(reference.locator)
        : null;
      if (
        !binding ||
        binding.sourceHash !== channel.sourceHash ||
        binding.provenance !== channel.provenance
      )
        return false;
    }
  }
  return true;
}

function retainedArtifacts(
  snapshot: ConsoleQueryDataSnapshot,
): ConsoleOwnedArtifactReference[] {
  const rows = [
    ...(snapshot.collections["tasks"] ?? []),
    ...(snapshot.collections["overview"] ?? []),
  ];
  const refs = (snapshot.artifacts ?? []).filter(isArtifactRef);
  const taskIdentity = (
    row: ConsoleQueryRecord,
  ): { projectId: string; taskId: string } | null => {
    if (!boundedId(row.id)) return null;
    const projectId = boundedId(row.projectId)
      ? row.projectId
      : snapshot.scope.kind === "project"
        ? snapshot.scope.projectId
        : null;
    return projectId ? { projectId, taskId: row.id } : null;
  };
  const kinds = [
    ["originalSource", "original-source"],
    ["sentSource", "sent-source"],
    ["currentFile", "current-file"],
    ["response", "response"],
  ] as const;
  const outputKinds = [
    ["stdout", "stdout"],
    ["stderr", "stderr"],
    ["rpc", "rpc"],
  ] as const;
  for (const row of rows) {
    const identity = taskIdentity(row);
    const artifacts = row.artifacts;
    if (!identity || !isRecord(artifacts)) continue;
    for (const [field, kind] of kinds) {
      const item = artifacts[field];
      if (isRecord(item) && boundedId(item["artifactId"]))
        refs.push({ ...identity, artifactId: item["artifactId"], kind });
    }
    for (const [field, kind] of outputKinds) {
      const item = artifacts[field];
      if (isRetainedArtifactChannel(item))
        refs.push({ ...identity, artifactId: item["artifactId"], kind });
    }
    const events = artifacts["events"];
    if (Array.isArray(events))
      for (const item of events)
        if (isRecord(item) && boundedId(item["artifactId"]))
          refs.push({
            ...identity,
            artifactId: item["artifactId"],
            kind: "event",
          });
  }
  return refs;
}

export function createConsoleQueryApi(
  port: ConsoleQueryReadPort,
  options: ConsoleQueryApiOptions = {},
): ConsoleQueryApi {
  const now = options.now ?? Date.now;
  const ttl = options.snapshotTtlMs ?? 60_000;
  const maxSnapshots = options.maxSnapshots ?? 4;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? 16 * 1024 * 1024;
  const maxPageBytes = options.maxPageBytes ?? 1024 * 1024;
  const maxPageSize = options.maxPageSize ?? 200;
  const maxArtifactRange = options.maxArtifactRange ?? 1024 * 1024;
  const maxSubscribers = options.maxSubscribers ?? 128;
  const revisionHistory = options.revisionHistory ?? 256;
  const maxExportBytes = options.maxExportBytes ?? 32 * 1024 * 1024;
  const snapshots = new Map<string, StoredSnapshot>();
  const listeners = new Map<number, Listener>();
  const revisionStates = new Map<string, RevisionState>();
  let nextListener = 0;

  const optionsValid =
    [
      ttl,
      maxSnapshots,
      maxSnapshotBytes,
      maxPageBytes,
      maxPageSize,
      maxArtifactRange,
      maxSubscribers,
      revisionHistory,
      maxExportBytes,
    ].every((n) => Number.isSafeInteger(n) && n > 0) &&
    ttl <= 5 * 60_000 &&
    maxSnapshots <= 8 &&
    maxSnapshotBytes <= 16 * 1024 * 1024 &&
    maxPageBytes <= 2 * 1024 * 1024 &&
    maxPageSize <= 500 &&
    maxArtifactRange <= 2 * 1024 * 1024 &&
    maxSubscribers <= 256 &&
    revisionHistory <= 1024 &&
    maxExportBytes <= 32 * 1024 * 1024;

  function hasActiveScope(key: string): boolean {
    return (
      [...snapshots.values()].some(
        (snapshot) => scopeKey(snapshot.data.scope) === key,
      ) ||
      [...listeners.values()].some(
        (listener) => scopeKey(listener.scope) === key,
      )
    );
  }

  function pruneRevisionStates(): void {
    for (const key of revisionStates.keys())
      if (!hasActiveScope(key)) revisionStates.delete(key);
  }

  function revisionState(
    scope: ConsoleQueryScope,
    create: boolean,
  ): RevisionState | null {
    const key = scopeKey(scope);
    const current = revisionStates.get(key);
    if (current || !create) return current ?? null;
    pruneRevisionStates();
    const maximumScopes = maxSnapshots + maxSubscribers;
    if (revisionStates.size >= maximumScopes) return null;
    const state: RevisionState = {
      latest: null,
      history: [],
      seenEpochs: new Set(),
    };
    revisionStates.set(key, state);
    return state;
  }

  function pruneSnapshots(): void {
    const current = now();
    for (const [token, snapshot] of snapshots)
      if (current - snapshot.createdAt > ttl) snapshots.delete(token);
    while (snapshots.size > maxSnapshots) {
      const oldest = snapshots.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
    pruneRevisionStates();
  }

  function authorizedSnapshot(
    token: string,
    scope: ConsoleQueryScope,
    principal: ConsoleQueryPrincipal,
  ): StoredSnapshot | ConsoleQueryError {
    pruneSnapshots();
    const stored = snapshots.get(token);
    if (!stored || stored.principalKey !== principalKey(principal))
      return error(
        "expired",
        "SNAPSHOT_EXPIRED",
        "Snapshot is unavailable or expired; request a fresh snapshot.",
      );
    if (!sameScope(stored.data.scope, scope))
      return error(
        "forbidden",
        "SNAPSHOT_SCOPE_MISMATCH",
        "Snapshot does not belong to the requested scope.",
      );
    if (!projectAllowed(scope, principal))
      return error(
        "forbidden",
        "SCOPE_FORBIDDEN",
        "The requested scope is not authorized.",
      );
    return stored;
  }

  async function createSnapshot(
    scope: ConsoleQueryScope,
    principal: ConsoleQueryPrincipal,
  ): Promise<ConsoleQuerySnapshot | ConsoleQueryError> {
    if (!validPrincipal(principal) || !validScope(scope))
      return error(
        "error",
        "INVALID_REQUEST",
        "Invalid principal or query scope.",
      );
    const selectedScope = cloneScope(scope);
    const authorizedPrincipal = clonePrincipal(principal);
    if (!projectAllowed(selectedScope, authorizedPrincipal))
      return error(
        "forbidden",
        "SCOPE_FORBIDDEN",
        "The requested scope is not authorized.",
      );
    let data: ConsoleQueryDataSnapshot;
    try {
      data = await port.readSnapshot(cloneScope(selectedScope));
    } catch {
      return error(
        "unavailable",
        "READ_MODEL_UNAVAILABLE",
        "The retained read model is unavailable.",
      );
    }
    if (
      !data ||
      !validScope(data.scope) ||
      !sameScope(data.scope, selectedScope) ||
      !validRevision(data.revision) ||
      !Number.isFinite(data.capturedAt) ||
      !isRecord(data.collections) ||
      !isRecord(data.sources)
    )
      return error(
        "error",
        "INVALID_READ_MODEL",
        "The read model returned an invalid snapshot.",
      );
    if (
      Object.entries(data.collections).some(
        ([collection, items]) =>
          !supportedCollection(collection) ||
          collection === "search" ||
          !Array.isArray(items),
      )
    )
      return error(
        "error",
        "INVALID_READ_MODEL",
        "The read model returned an invalid collection.",
      );
    if (
      Object.entries(data.sources).some(
        ([collection, source]) =>
          !supportedCollection(collection) ||
          collection === "search" ||
          !isSourceStatus(source),
      ) ||
      (data.artifacts !== undefined && !Array.isArray(data.artifacts))
    )
      return error(
        "error",
        "INVALID_READ_MODEL",
        "The read model returned invalid source or artifact metadata.",
      );
    const rows = Object.values(data.collections).flatMap(
      (items) => items ?? [],
    );
    if (rows.length > MAX_ROWS || rows.some((row) => !isRecord(row)))
      return error(
        "unavailable",
        "READ_MODEL_LIMIT",
        "The retained snapshot exceeds the query budget.",
      );
    if (
      selectedScope.kind === "project" &&
      Object.entries(data.collections).some(([collection, items]) =>
        items!.some((row) =>
          collection === "projects"
            ? row.id !== selectedScope.projectId
            : nonempty(row.projectId) &&
              row.projectId !== selectedScope.projectId,
        ),
      )
    )
      return error(
        "forbidden",
        "PROJECT_SCOPE_LEAK",
        "The read model returned a record from another project.",
      );
    if (
      (data.artifacts ?? []).some(
        (ref) =>
          !isArtifactRef(ref) ||
          (selectedScope.kind === "project" &&
            ref.projectId !== selectedScope.projectId),
      )
    )
      return error(
        "forbidden",
        "ARTIFACT_SCOPE_LEAK",
        "The read model returned an artifact from another project.",
      );
    if (!validRetainedOutputChannels(data))
      return error(
        "error",
        "INVALID_ARTIFACT_CHANNEL",
        "An output channel is not bound to an exact retained, hash-verified artifact.",
      );
    let encoded: string;
    try {
      encoded = JSON.stringify(data);
    } catch {
      return error(
        "error",
        "INVALID_READ_MODEL",
        "The read model returned non-serializable snapshot data.",
      );
    }
    if (utf8Length(encoded) > maxSnapshotBytes)
      return error(
        "unavailable",
        "READ_MODEL_LIMIT",
        "The retained snapshot exceeds the query budget.",
      );

    try {
      data = JSON.parse(
        JSON.stringify(redact(data, true)),
      ) as ConsoleQueryDataSnapshot;
      normalizeLogTimestamps(data);
    } catch {
      return error(
        "error",
        "INVALID_READ_MODEL",
        "The read model snapshot could not be copied safely.",
      );
    }
    const sources: Record<string, ConsoleSourceStatus> = {};
    for (const collection of COLLECTIONS) {
      const collectionRows = data.collections[collection] ?? [];
      sources[collection] = cloneSource(
        normalizeSource(data.sources[collection], collectionRows.length),
      );
    }
    sources["search"] = searchSource(sources, data);
    pruneSnapshots();
    const revision = revisionState(selectedScope, true);
    if (!revision)
      return error(
        "unavailable",
        "REVISION_SCOPE_LIMIT",
        "The revision stream is at its scope limit; reconnect after a fresh snapshot.",
      );
    if (
      revision.latest &&
      data.revision.epoch !== revision.latest.epoch &&
      revision.seenEpochs.has(data.revision.epoch)
    )
      return error(
        "unavailable",
        "STALE_READ_MODEL_EPOCH",
        "The read model returned an older instance snapshot.",
      );
    if (
      revision.latest &&
      data.revision.epoch === revision.latest.epoch &&
      data.revision.revision < revision.latest.revision
    )
      return error(
        "unavailable",
        "STALE_READ_MODEL_REVISION",
        "The read model snapshot is older than the observed revision.",
      );
    const token = newSnapshotToken();
    if (!nonempty(token) || token.length > 128 || snapshots.has(token))
      return error(
        "error",
        "TOKEN_GENERATION_FAILED",
        "The snapshot correlation handle could not be created.",
      );
    const stored: StoredSnapshot = {
      token,
      principalKey: principalKey(authorizedPrincipal),
      data,
      createdAt: now(),
      sources,
    };
    snapshots.set(token, stored);
    pruneSnapshots();
    if (!revision.latest) {
      revision.latest = { ...data.revision };
      revision.seenEpochs.add(data.revision.epoch);
    } else if (isLaterRevision(data.revision, revision.latest)) {
      advanceRevision({
        scope: selectedScope,
        revision: data.revision,
        resyncRequired: true,
      });
    }
    return {
      version: CONSOLE_QUERY_CONTRACT_VERSION,
      revision: { ...data.revision },
      capturedAt: data.capturedAt,
      scope: cloneScope(selectedScope),
      snapshotToken: token,
      sources: Object.fromEntries(
        Object.entries(sources).map(([key, value]) => [
          key,
          cloneSource(value),
        ]),
      ),
    };
  }

  function getSnapshot(
    token: string,
    scope: ConsoleQueryScope,
    principal: ConsoleQueryPrincipal,
  ): StoredSnapshot | ConsoleQueryError {
    if (!nonempty(token) || token.length > 128)
      return error(
        "error",
        "INVALID_SNAPSHOT_TOKEN",
        "Invalid snapshot token.",
      );
    return authorizedSnapshot(token, scope, principal);
  }

  function validateQuery(
    request: ConsoleQueryRequest,
  ): ConsoleQueryError | null {
    if (!isRecord(request))
      return error("error", "INVALID_QUERY", "Invalid query request.");
    if (!nonempty(request.snapshotToken) || request.snapshotToken.length > 128)
      return error(
        "expired",
        "SNAPSHOT_REQUIRED",
        "Request a snapshot first and send its token in X-Control-Center-Snapshot.",
      );
    const filterFields = isRecord(request.filters)
      ? Object.keys(request.filters)
      : [];
    const requestedFacetFields = Array.isArray(request.facetFields)
      ? request.facetFields
      : [];
    const facetFields = [...filterFields, ...requestedFacetFields];
    if (
      request.version !== CONSOLE_QUERY_CONTRACT_VERSION ||
      !validScope(request.scope) ||
      !supportedCollection(request.collection) ||
      !validFilters(request.filters) ||
      new Set(facetFields).size > MAX_FACET_FIELDS ||
      !validSorts(request.sort) ||
      (request.facetFields !== undefined &&
        (!Array.isArray(request.facetFields) ||
          request.facetFields.length > MAX_FACET_FIELDS ||
          request.facetFields.some(
            (field) => !nonempty(field) || field.length > 200,
          ))) ||
      (request.aggregateFields !== undefined &&
        (!Array.isArray(request.aggregateFields) ||
          request.aggregateFields.length > MAX_FACET_FIELDS ||
          request.aggregateFields.some(
            (field) => !nonempty(field) || field.length > 200,
          ))) ||
      (request.collection === "search" && !nonempty(request.search)) ||
      (request.search !== undefined &&
        (typeof request.search !== "string" || request.search.length > 512))
    )
      return error(
        "error",
        "INVALID_QUERY",
        "Invalid query version, collection, filter, sort, or search.",
      );
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 50;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > maxPageSize
    )
      return error(
        "error",
        "INVALID_PAGE",
        `Page size must be between 1 and ${maxPageSize}; offset must be nonnegative.`,
      );
    return null;
  }

  function queryPage<T>(
    request: ConsoleQueryRequest,
    stored: StoredSnapshot,
  ): ConsoleQueryPage<T> | ConsoleQueryError {
    const source =
      stored.sources[request.collection] ??
      errorSource("Source status was not recorded.");
    const allRows =
      source.state === "unavailable" || source.state === "no-data"
        ? []
        : request.collection === "search"
          ? searchRows(stored)
          : (stored.data.collections[request.collection] ?? []);
    const filtered = filterRows(
      allRows,
      request.search ?? "",
      request.filters ?? {},
    );
    const sorted = sortRows(filtered, request.sort ?? []);
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 50;
    const facets =
      source.state === "unavailable" || source.state === "no-data"
        ? {}
        : buildFacets(
            allRows,
            request.filters ?? {},
            request.facetFields ?? [],
            request.search ?? "",
          );
    if (facets === null)
      return error(
        "error",
        "FACET_LIMIT",
        "A requested facet has too many distinct values.",
      );
    const aggregates =
      source.state === "unavailable" || source.state === "no-data"
        ? {}
        : buildAggregates(filtered, request.aggregateFields ?? []);
    const page: ConsoleQueryPage<T> = {
      version: CONSOLE_QUERY_CONTRACT_VERSION,
      revision: { ...stored.data.revision },
      scope: cloneScope(stored.data.scope),
      collection: request.collection,
      source: cloneSource(source),
      rows: stablePage(sorted, offset, limit).map((row) => redact(row) as T),
      offset,
      limit,
      total:
        source.state === "unavailable" ||
        source.state === "partial" ||
        source.state === "no-data"
          ? null
          : filtered.length,
      facets,
      aggregates,
      snapshotToken: stored.token,
    };
    try {
      if (utf8Length(JSON.stringify(page)) > maxPageBytes)
        return error(
          "error",
          "QUERY_RESPONSE_LIMIT",
          "The query page exceeds the response byte limit; request fewer rows or use bounded detail reads.",
        );
    } catch {
      return error(
        "error",
        "QUERY_RESPONSE_INVALID",
        "The query page could not be encoded safely.",
      );
    }
    return page;
  }

  function exportRows(
    request: ConsoleQueryExportRequest,
    stored: StoredSnapshot,
  ): ConsoleQueryExport | ConsoleQueryError {
    const source =
      stored.sources[request.collection] ??
      errorSource("Source status was not recorded.");
    if (source.state === "unavailable")
      return error(
        "unavailable",
        "SOURCE_UNAVAILABLE",
        "The selected collection is unavailable; export was not created.",
      );
    const allRows =
      request.collection === "search"
        ? searchRows(stored)
        : (stored.data.collections[request.collection] ?? []);
    const rows = sortRows(
      filterRows(allRows, request.search ?? "", request.filters ?? {}),
      request.sort ?? [],
    ).map((row) => redact(row) as ConsoleQueryRecord);
    const query = redact({
      search: request.search ?? "",
      filters: request.filters ?? {},
      sort: request.sort ?? [],
    }) as {
      search: string;
      filters: NonNullable<ConsoleQueryRequest["filters"]>;
      sort: NonNullable<ConsoleQueryRequest["sort"]>;
    };
    const metadata = {
      version: CONSOLE_QUERY_CONTRACT_VERSION,
      revision: stored.data.revision,
      scope: stored.data.scope,
      collection: request.collection,
      source: redact(source),
      query,
    };
    const columns = [
      ...new Set(rows.flatMap((row) => Object.keys(row))),
    ].sort();
    if (
      request.format === "csv" &&
      (columns.length > MAX_EXPORT_COLUMNS ||
        rows.length * columns.length > MAX_EXPORT_CELLS)
    )
      return error(
        "error",
        "EXPORT_LIMIT",
        "The complete CSV result exceeds the export cell limit.",
      );
    const content =
      request.format === "csv"
        ? csv(rows, columns)
        : JSON.stringify(
            {
              ...metadata,
              rows,
            },
            null,
            2,
          );
    if (utf8Length(content) > maxExportBytes)
      return error(
        "error",
        "EXPORT_LIMIT",
        "The complete retained result exceeds the export size limit.",
      );
    return {
      version: CONSOLE_QUERY_CONTRACT_VERSION,
      revision: { ...stored.data.revision },
      scope: cloneScope(stored.data.scope),
      collection: request.collection,
      snapshotToken: stored.token,
      source: cloneSource(source),
      format: request.format,
      search: query.search,
      filters: query.filters,
      sort: query.sort,
      rowCount: rows.length,
      content,
    };
  }

  function allowedEvent(
    event: ConsoleRevisionEvent,
    scope: ConsoleQueryScope,
    principal: ConsoleQueryPrincipal,
  ): ConsoleRevisionEvent | null {
    if (!sameScope(event.scope, scope) || !projectAllowed(scope, principal))
      return null;
    return {
      scope: cloneScope(event.scope),
      revision: { ...event.revision },
      resyncRequired: event.resyncRequired,
    };
  }

  function emit(event: ConsoleRevisionEvent): void {
    for (const [id, { scope, principal, callback }] of listeners) {
      const visible = allowedEvent(event, scope, principal);
      if (!visible) continue;
      try {
        if (callback(visible) === false) listeners.delete(id);
      } catch {
        // Listener failures are isolated; HTTP owns transport errors/backpressure.
        listeners.delete(id);
      }
    }
  }

  function advanceRevision(input: ConsoleRevisionEvent): void {
    const state = revisionState(input.scope, false);
    if (!state) return;
    if (
      state.latest &&
      input.revision.epoch === state.latest.epoch &&
      input.revision.revision <= state.latest.revision
    )
      return;
    if (
      state.latest &&
      input.revision.epoch !== state.latest.epoch &&
      state.seenEpochs.has(input.revision.epoch)
    )
      return;
    const epochChanged =
      state.latest !== null && input.revision.epoch !== state.latest.epoch;
    const gap =
      state.latest !== null &&
      !epochChanged &&
      input.revision.revision !== state.latest.revision + 1;
    const event: ConsoleRevisionEvent = {
      scope: cloneScope(input.scope),
      revision: { ...input.revision },
      resyncRequired:
        input.resyncRequired || epochChanged || gap || state.latest === null,
    };
    state.latest = event.revision;
    state.seenEpochs.delete(event.revision.epoch);
    state.seenEpochs.add(event.revision.epoch);
    while (state.seenEpochs.size > 32) {
      const oldest = state.seenEpochs.values().next().value as
        string | undefined;
      if (oldest === undefined) break;
      state.seenEpochs.delete(oldest);
    }
    state.history.push(event);
    if (state.history.length > revisionHistory)
      state.history.splice(0, state.history.length - revisionHistory);
    emit(event);
  }

  function needsResync(
    scope: ConsoleQueryScope,
    after: ConsoleRevision,
  ): boolean {
    const state = revisionState(scope, false);
    const latest = state?.latest;
    if (
      !latest ||
      after.epoch !== latest.epoch ||
      after.revision > latest.revision
    )
      return true;
    if (after.revision === latest.revision) return false;
    const replay = state.history.filter(
      (event) =>
        event.revision.epoch === after.epoch &&
        event.revision.revision > after.revision,
    );
    if (!replay.length || replay[0]!.revision.revision !== after.revision + 1)
      return true;
    return replay.some(
      (event, index) =>
        event.resyncRequired ||
        event.revision.revision !== after.revision + index + 1,
    );
  }

  const api: ConsoleQueryApi = {
    async snapshot(scope, principal) {
      if (!optionsValid)
        return error(
          "error",
          "INVALID_CONFIGURATION",
          "Query API limits must be positive safe integers.",
        );
      return createSnapshot(scope, principal);
    },

    async query<T = Record<string, unknown>>(
      request: ConsoleQueryRequest,
      principal: ConsoleQueryPrincipal,
    ) {
      const invalid = validateQuery(request);
      if (invalid) return invalid;
      if (!optionsValid)
        return error(
          "error",
          "INVALID_CONFIGURATION",
          "Query API limits must be positive safe integers.",
        );
      if (!validPrincipal(principal))
        return error(
          "forbidden",
          "INVALID_PRINCIPAL",
          "No authorized read principal was supplied.",
        );
      const stored = getSnapshot(
        request.snapshotToken,
        request.scope,
        principal,
      );
      if ("state" in stored) return stored;
      return queryPage<T>(request, stored);
    },

    async export(
      request: ConsoleQueryExportRequest,
      principal: ConsoleQueryPrincipal,
    ) {
      if (!isRecord(request))
        return error("error", "INVALID_EXPORT", "Invalid export request.");
      if (request.format !== "json" && request.format !== "csv")
        return error(
          "error",
          "INVALID_EXPORT_FORMAT",
          "Export format must be CSV or JSON.",
        );
      const queryRequest: ConsoleQueryRequest = {
        ...request,
        version: request.version,
      };
      const invalid = validateQuery(queryRequest);
      if (invalid) return invalid;
      if (!optionsValid)
        return error(
          "error",
          "INVALID_CONFIGURATION",
          "Query API limits must be positive safe integers.",
        );
      if (!validPrincipal(principal))
        return error(
          "forbidden",
          "INVALID_PRINCIPAL",
          "No authorized read principal was supplied.",
        );
      const stored = getSnapshot(
        request.snapshotToken,
        request.scope,
        principal,
      );
      if ("state" in stored) return stored;
      return exportRows(request, stored);
    },

    async detail(
      request: ConsoleArtifactRequest,
      principal: ConsoleQueryPrincipal,
    ): Promise<ConsoleArtifactResult | ConsoleQueryError> {
      if (!isRecord(request))
        return error(
          "error",
          "INVALID_ARTIFACT_REQUEST",
          "Invalid artifact request.",
        );
      const offset = request.offset ?? 0;
      const length = request.length ?? DEFAULT_RANGE;
      if (
        request.version !== CONSOLE_QUERY_CONTRACT_VERSION ||
        !validScope(request.scope) ||
        request.scope.kind !== "project" ||
        !boundedId(request.taskId) ||
        !boundedId(request.artifactId) ||
        !nonempty(request.snapshotToken) ||
        !isConsoleArtifactKind(request.kind) ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > MAX_ARTIFACT_OFFSET ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > maxArtifactRange
      )
        return error(
          "error",
          "INVALID_ARTIFACT_REQUEST",
          "Artifact identity or bounded range is invalid.",
        );
      if (!optionsValid)
        return error(
          "error",
          "INVALID_CONFIGURATION",
          "Query API limits must be positive safe integers.",
        );
      const scope = {
        kind: "project",
        projectId: request.scope.projectId,
      } as const;
      const taskId = request.taskId;
      const artifactId = request.artifactId;
      const kind = request.kind;
      const snapshotToken = request.snapshotToken;
      if (!validPrincipal(principal) || !projectAllowed(scope, principal))
        return error(
          "forbidden",
          "SCOPE_FORBIDDEN",
          "The requested project is not authorized.",
        );
      const stored = getSnapshot(snapshotToken, scope, principal);
      if ("state" in stored) return stored;
      const taskExists = [
        ...(stored.data.collections["tasks"] ?? []),
        ...(stored.data.collections["overview"] ?? []),
      ].some(
        (row) =>
          boundedId(row.id) &&
          row.id === taskId &&
          (!nonempty(row.projectId) || row.projectId === scope.projectId),
      );
      const ref =
        taskExists &&
        retainedArtifacts(stored.data).find(
          (item) =>
            item.projectId === scope.projectId &&
            item.taskId === taskId &&
            item.artifactId === artifactId &&
            item.kind === kind,
        );
      if (!ref)
        return error(
          "forbidden",
          "ARTIFACT_NOT_OWNED",
          "Artifact is not an exact retained artifact of the selected task and project.",
        );
      const boundedRequest: ConsoleArtifactRequest = {
        version: CONSOLE_QUERY_CONTRACT_VERSION,
        scope,
        taskId,
        artifactId,
        kind,
        snapshotToken: stored.token,
        offset,
        length,
      };
      try {
        const result = await port.readArtifact({ ...ref }, boundedRequest);
        if (
          !result ||
          ![
            "available",
            "empty",
            "missing",
            "truncated",
            "expired",
            "error",
            "forbidden",
          ].includes(result.state) ||
          (result.content !== null && typeof result.content !== "string") ||
          (result.state === "available" && result.content === null) ||
          (result.state === "empty" &&
            result.content !== null &&
            result.content !== "") ||
          (result.state === "truncated" && result.content === null) ||
          (["missing", "expired", "error", "forbidden"].includes(
            result.state,
          ) &&
            result.content !== null) ||
          !Number.isSafeInteger(result.offset) ||
          result.offset < 0 ||
          !Number.isSafeInteger(result.length) ||
          result.length < 0 ||
          (result.content === null && result.length !== 0) ||
          result.length > length ||
          (result.content !== null && utf8Length(result.content) > length) ||
          (result.content !== null &&
            utf8Length(result.content) !== result.length) ||
          result.offset < offset ||
          result.offset > offset + 3 ||
          result.offset + result.length > offset + length ||
          (result.totalLength !== null &&
            (!Number.isSafeInteger(result.totalLength) ||
              result.totalLength < 0))
        )
          return error(
            "error",
            "INVALID_ARTIFACT_READ",
            "Artifact reader returned an invalid bounded range.",
          );
        const content =
          result.content === null ? null : redactDiagnostic(result.content);
        if (content !== null && utf8Length(content) > maxArtifactRange)
          return error(
            "error",
            "ARTIFACT_RESPONSE_LIMIT",
            "Artifact redaction expanded the selected range beyond the response limit.",
          );
        const state =
          content === "" && result.state === "available"
            ? "empty"
            : result.state;
        return {
          version: CONSOLE_QUERY_CONTRACT_VERSION,
          revision: { ...stored.data.revision },
          state,
          artifactId,
          kind,
          content,
          offset: result.offset,
          length: result.length,
          totalLength: result.totalLength,
          ...(state !== "available" && state !== "empty"
            ? {
                reason:
                  state === "missing"
                    ? "Artifact is missing from retained storage."
                    : state === "truncated"
                      ? "Only the requested bounded artifact range is available."
                      : state === "expired"
                        ? "Artifact retention has expired."
                        : state === "forbidden"
                          ? "Artifact access was denied."
                          : "Artifact read failed.",
              }
            : {}),
        };
      } catch {
        return {
          version: CONSOLE_QUERY_CONTRACT_VERSION,
          revision: { ...stored.data.revision },
          state: "error",
          artifactId,
          kind,
          content: null,
          offset,
          length: 0,
          totalLength: null,
          reason: "Artifact read failed.",
        };
      }
    },

    subscribe(scope, after, principal, callback) {
      if (
        !optionsValid ||
        !validScope(scope) ||
        (after !== null && !validRevision(after)) ||
        !validPrincipal(principal) ||
        typeof callback !== "function" ||
        !projectAllowed(scope, principal) ||
        listeners.size >= maxSubscribers
      )
        return null;
      const id = ++nextListener;
      const selectedScope = cloneScope(scope);
      const authorizedPrincipal = clonePrincipal(principal);
      const state = revisionState(selectedScope, true);
      if (!state) return null;
      listeners.set(id, {
        scope: selectedScope,
        principal: authorizedPrincipal,
        callback,
      });
      const notify = (event: ConsoleRevisionEvent): boolean => {
        const visible = allowedEvent(event, selectedScope, authorizedPrincipal);
        if (!visible) return true;
        try {
          if (callback(visible) === false) {
            listeners.delete(id);
            return false;
          }
          return true;
        } catch {
          // The HTTP owner handles a failed transport write.
          listeners.delete(id);
          return false;
        }
      };
      if (!after) {
        if (state.latest)
          notify({
            scope: cloneScope(scope),
            revision: state.latest,
            resyncRequired: true,
          });
      } else if (needsResync(selectedScope, after)) {
        notify({
          scope: cloneScope(scope),
          revision: state.latest ?? after,
          resyncRequired: true,
        });
      } else {
        const replay = state.history.filter(
          (event) =>
            event.revision.epoch === after.epoch &&
            event.revision.revision > after.revision,
        );
        for (const event of replay) if (!notify(event)) break;
      }
      return () => listeners.delete(id);
    },

    invalidate(input) {
      if (
        !optionsValid ||
        !input ||
        !validScope(input.scope) ||
        !validRevision(input.revision) ||
        typeof input.resyncRequired !== "boolean"
      )
        return;
      pruneSnapshots();
      if (!revisionStates.has(scopeKey(input.scope))) return;
      advanceRevision(input);
    },
  };

  return api;
}

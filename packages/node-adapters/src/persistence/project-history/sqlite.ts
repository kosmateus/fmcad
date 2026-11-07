import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as SQLiteDatabaseSync } from "node:sqlite";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ProjectHistoryAvailability,
  ProjectHistoryActivityFence,
  ProjectHistoryAgentAlias,
  ProjectHistoryAgentIdentityKind,
  ProjectHistoryEvent,
  ProjectHistoryEventRecord,
  ProjectHistoryFileReference,
  ProjectHistoryGap,
  ProjectHistoryIngestBatch,
  ProjectHistoryIngestResult,
  ProjectHistoryJobRecord,
  ProjectHistoryPage,
  ProjectHistoryProjectLifecycle,
  ProjectHistoryRevision,
  ProjectHistoryReadSnapshot,
  ProjectHistoryReplayCursor,
  ProjectHistorySessionRecord,
  ProjectHistorySnapshot,
  ProjectHistorySourceCursor,
  ProjectHistorySourceStatus,
} from "../../../../core/src/domain/project-history";
import type {
  ProjectHistoryPageRequest,
  ProjectHistoryAgentAliasIdentity,
  ProjectHistoryStore,
  ProjectHistorySynchronousResult,
} from "../../../../core/src/ports/project-history";
import type { ProjectRegistryStore } from "../../../../core/src/ports/project-registry";

const SCHEMA_VERSION = 7;
const DATABASE_NAME = "control-center.sqlite";
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 60_000;
const DEFAULT_DATABASE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_WAL_AUTOCHECKPOINT_PAGES = 256;
const MAX_PAGE_SIZE = 500;
const MAX_GAPS_PER_SOURCE = 256;
const MAX_READ_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const sqliteRequire = createRequire(__filename);

type DatabaseSync = SQLiteDatabaseSync;

function loadDatabaseSync(): typeof SQLiteDatabaseSync {
  return (
    sqliteRequire("node:sqlite") as {
      DatabaseSync: typeof SQLiteDatabaseSync;
    }
  ).DatabaseSync;
}

export interface OpenProjectHistoryOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly readOnly?: boolean;
  /** Applied only to a brand-new DB; normal reopen never auto-enables monitoring. */
  readonly initialMonitoring?: boolean;
  readonly busyTimeoutMs?: number;
  /** Only project registration should create a new database. */
  readonly initializeIfMissing?: boolean;
  readonly expectedDatabaseId?: string;
  /** Overrides the default 32 MiB SQLite database cap on writable opens. */
  readonly maxDatabasePages?: number;
  /** WAL is opt-in and is rejected unless the project is on an allow-listed local filesystem. */
  readonly journalMode?: "delete" | "wal";
  readonly now?: () => number;
}

export class ProjectHistoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectHistoryError";
  }
}

type Row = Record<string, string | number | bigint | null | Uint8Array>;

interface MetaRow extends Row {
  project_id: string;
  database_id: string;
  epoch: string;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface CursorRow extends Row {
  source_id: string;
  epoch: string;
  position: number;
  position_kind: "sequence" | "revision";
  event_id: string | null;
  updated_at_ms: number;
  gap_history_truncated: number;
}

interface GapRow extends Row {
  source_id: string;
  epoch: string;
  from_position: number | null;
  to_position: number | null;
  position_kind: "sequence" | "revision";
  detected_at_ms: number;
  reason: ProjectHistoryGap["reason"];
}

function errorWithCode(
  code: string,
  message: string,
  cause?: unknown,
): ProjectHistoryError {
  return new ProjectHistoryError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function mapSqliteError(error: unknown): ProjectHistoryError {
  if (error instanceof ProjectHistoryError) return error;
  const input = error as NodeJS.ErrnoException & {
    errcode?: number;
    errstr?: string;
  };
  const text = `${input?.code ?? ""} ${input?.message ?? error}`.toLowerCase();
  if (
    input?.errcode === 13 ||
    /sqlite_full|database or disk is full/u.test(text)
  )
    return errorWithCode(
      "HISTORY_DB_FULL",
      "Project history database is full",
      error,
    );
  if (
    input?.errcode === 8 ||
    /sqlite_readonly|readonly database|read-only database/u.test(text)
  ) {
    return errorWithCode(
      "HISTORY_DB_READ_ONLY",
      "Project history database is read-only",
      error,
    );
  }
  if (
    input?.errcode === 5 ||
    input?.errcode === 6 ||
    /sqlite_busy|database is locked|database is busy/u.test(text)
  ) {
    return errorWithCode(
      "HISTORY_DB_BUSY",
      "Project history database is busy; retry after the current writer completes",
      error,
    );
  }
  if (
    input?.errcode === 11 ||
    input?.errcode === 26 ||
    /not a database|database disk image is malformed|sqlite_corrupt|sqlite_notadb/u.test(
      text,
    )
  ) {
    return errorWithCode(
      "HISTORY_DB_CORRUPT",
      "Project history database is corrupt; it was not replaced",
      error,
    );
  }
  return errorWithCode(
    "HISTORY_STORAGE_UNAVAILABLE",
    `Project history storage is unavailable: ${input?.message ?? String(error)}`,
    error,
  );
}

function assertSafeProjectRoot(projectRoot: string): string {
  if (!isAbsolute(projectRoot))
    throw errorWithCode(
      "PROJECT_PATH_INVALID",
      "Project root must be absolute",
    );
  let canonical: string;
  try {
    canonical = realpathSync(resolve(projectRoot));
  } catch (error) {
    throw errorWithCode(
      "PROJECT_MISSING",
      "Project root does not exist; history is not created elsewhere",
      error,
    );
  }
  if (!statSync(canonical).isDirectory())
    throw errorWithCode(
      "PROJECT_PATH_INVALID",
      "Project root must be a directory",
    );
  return canonical;
}

function assertWalFilesystem(projectRoot: string): void {
  if (process.platform !== "linux")
    throw errorWithCode(
      "WAL_UNSUPPORTED_FILESYSTEM",
      "WAL is only enabled on allow-listed Linux local filesystems",
    );
  let mounts: string;
  try {
    mounts = readFileSync("/proc/self/mountinfo", "utf8");
  } catch (error) {
    throw errorWithCode(
      "WAL_UNSUPPORTED_FILESYSTEM",
      "Cannot verify the filesystem type for WAL mode",
      error,
    );
  }
  let selected: { mountPoint: string; type: string } | null = null;
  for (const line of mounts.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const mountFields = line.slice(0, separator).split(" ");
    const fileSystemType = line.slice(separator + 3).split(" ", 1)[0];
    const encodedMountPoint = mountFields[4];
    if (!encodedMountPoint || !fileSystemType) continue;
    const mountPoint = encodedMountPoint.replace(
      /\\([0-7]{3})/gu,
      (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)),
    );
    if (
      (projectRoot === mountPoint ||
        projectRoot.startsWith(`${mountPoint.replace(/\/$/u, "")}/`)) &&
      (!selected || mountPoint.length > selected.mountPoint.length)
    ) {
      selected = { mountPoint, type: fileSystemType };
    }
  }
  const supported = new Set([
    "ext2",
    "ext3",
    "ext4",
    "xfs",
    "btrfs",
    "f2fs",
    "jfs",
    "reiserfs",
    "zfs",
    "tmpfs",
  ]);
  if (!selected || !supported.has(selected.type))
    throw errorWithCode(
      "WAL_UNSUPPORTED_FILESYSTEM",
      `WAL is disabled on filesystem ${selected?.type ?? "unknown"}; rollback journaling remains available`,
    );
}

function usesWalJournal(databasePath: string): boolean {
  const fd = openSync(databasePath, "r");
  try {
    const header = Buffer.alloc(100);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    return bytesRead >= 20 && header[18] === 2 && header[19] === 2;
  } finally {
    closeSync(fd);
  }
}

function ensureChildDirectory(
  parent: string,
  child: string,
  allowCreate: boolean,
): string {
  const target = join(parent, child);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw errorWithCode(
        "HISTORY_PATH_INVALID",
        `Project history directory must be a real directory: ${target}`,
      );
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!allowCreate)
      throw errorWithCode(
        "HISTORY_DB_MISSING",
        "Project history database is missing in read-only mode",
        error,
      );
    mkdirSync(target, { mode: 0o700 });
    return target;
  }
}

function ensureDatabaseFile(file: string, allowCreate: boolean): boolean {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw errorWithCode(
        "HISTORY_PATH_INVALID",
        "Project history database must be a regular, non-symlink file",
      );
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!allowCreate)
      throw errorWithCode(
        "HISTORY_DB_MISSING",
        "Project history database is missing in read-only mode",
      );
    const fd = openSync(file, "wx", 0o600);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  }
}

function readPragmaInteger(db: DatabaseSync, name: string): number {
  const value = db.prepare(`PRAGMA ${name}`).get() as Row | undefined;
  const result = value?.[name];
  if (typeof result !== "number" || !Number.isSafeInteger(result))
    throw errorWithCode("HISTORY_DB_CORRUPT", `Invalid SQLite ${name} value`);
  return result;
}

function migrate(
  db: DatabaseSync,
  readOnly: boolean,
  isNewFile: boolean,
  initializeIfMissing: boolean,
  initialMonitoring: boolean,
): void {
  let version = readPragmaInteger(db, "user_version");
  if (version > SCHEMA_VERSION)
    throw errorWithCode(
      "HISTORY_DB_VERSION",
      `Project history schema ${version} is newer than supported schema ${SCHEMA_VERSION}`,
    );
  if (readOnly) {
    if (version !== SCHEMA_VERSION && version !== 6)
      throw errorWithCode(
        "HISTORY_DB_VERSION",
        `Project history schema ${version} requires a writable migration to ${SCHEMA_VERSION}`,
      );
    return;
  }
  while (version < SCHEMA_VERSION) {
    db.exec("BEGIN IMMEDIATE");
    try {
      version = readPragmaInteger(db, "user_version");
      if (version > SCHEMA_VERSION)
        throw errorWithCode(
          "HISTORY_DB_VERSION",
          `Project history schema ${version} is newer than supported schema ${SCHEMA_VERSION}`,
        );
      if (version === SCHEMA_VERSION) {
        db.exec("COMMIT");
        return;
      }
      if (version === 0) {
        if (!isNewFile) {
          const existing = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
            )
            .get();
          if (existing)
            throw errorWithCode(
              "HISTORY_DB_VERSION",
              "Unversioned non-empty SQLite file is not a project history database",
            );
          if (!initializeIfMissing)
            throw errorWithCode(
              "HISTORY_DB_MISSING",
              "Uninitialized SQLite file requires explicit project registration",
            );
        }
        db.exec(`
          CREATE TABLE project_meta (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            project_id TEXT NOT NULL,
            database_id TEXT NOT NULL,
            epoch TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision >= 0),
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE history_events (
            row_id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT,
            source_id TEXT,
            epoch TEXT,
            sequence INTEGER,
            observed_at_ms INTEGER,
            read_at_ms INTEGER NOT NULL,
            project_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            identity_json TEXT NOT NULL,
            availability_json TEXT NOT NULL,
            data_json TEXT NOT NULL,
            event_json TEXT NOT NULL,
            inserted_revision INTEGER NOT NULL DEFAULT 0
          ) STRICT;
          CREATE UNIQUE INDEX history_events_event_id
            ON history_events(source_id, event_id)
            WHERE event_id IS NOT NULL AND source_id IS NOT NULL;
          CREATE INDEX history_events_by_job
            ON history_events(json_extract(identity_json, '$.jobId'), row_id DESC);
          CREATE TABLE observations (
            row_id INTEGER PRIMARY KEY REFERENCES history_events(row_id) ON DELETE CASCADE,
            source_id TEXT,
            observed_at_ms INTEGER,
            event_json TEXT NOT NULL
          ) STRICT;
          CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY,
            row_id INTEGER NOT NULL UNIQUE REFERENCES history_events(row_id) ON DELETE CASCADE,
            state TEXT,
            phase TEXT,
            observed_at_ms INTEGER,
            event_json TEXT NOT NULL
          ) STRICT;
          CREATE TABLE agent_sessions (
            session_id TEXT PRIMARY KEY,
            row_id INTEGER NOT NULL UNIQUE REFERENCES history_events(row_id) ON DELETE CASCADE,
            client_id TEXT,
            agent_id TEXT,
            presence TEXT,
            observed_at_ms INTEGER,
            event_json TEXT NOT NULL
          ) STRICT;
          CREATE TABLE presence_history (
            row_id INTEGER PRIMARY KEY REFERENCES history_events(row_id) ON DELETE CASCADE,
            source_id TEXT,
            session_id TEXT,
            client_id TEXT,
            pid INTEGER,
            presence TEXT,
            observed_at_ms INTEGER,
            event_json TEXT NOT NULL
          ) STRICT;
          CREATE TABLE file_references (
            reference_id TEXT PRIMARY KEY,
            row_id INTEGER NOT NULL REFERENCES history_events(row_id) ON DELETE CASCADE,
            job_id TEXT,
            kind TEXT NOT NULL,
            path TEXT,
            file_id TEXT,
            artifact_id TEXT,
            sha256 TEXT,
            provenance TEXT,
            observed_at_ms INTEGER,
            event_json TEXT NOT NULL
          ) STRICT;
          CREATE INDEX file_references_by_job ON file_references(job_id, row_id DESC);
          CREATE TABLE aliases (
            alias_key TEXT PRIMARY KEY,
            alias TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE project_lifecycle (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            monitoring INTEGER NOT NULL CHECK (monitoring IN (0, 1)),
            archived_at_ms INTEGER,
            updated_at_ms INTEGER NOT NULL,
            CHECK (archived_at_ms IS NULL OR monitoring = 0)
          ) STRICT;
          CREATE TABLE source_cursors (
            source_id TEXT NOT NULL,
            epoch TEXT NOT NULL,
            position INTEGER NOT NULL,
            position_kind TEXT NOT NULL CHECK (position_kind IN ('sequence', 'revision')),
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY (source_id, epoch, position_kind)
          ) STRICT;
          CREATE TABLE source_gaps (
            gap_id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id TEXT NOT NULL,
            epoch TEXT NOT NULL,
            from_position INTEGER,
            to_position INTEGER,
            position_kind TEXT NOT NULL CHECK (position_kind IN ('sequence', 'revision')),
            detected_at_ms INTEGER NOT NULL,
            reason TEXT NOT NULL,
            CHECK (from_position IS NULL OR to_position IS NULL OR from_position <= to_position)
          ) STRICT;
          CREATE INDEX source_gaps_by_source
            ON source_gaps(source_id, epoch, position_kind, from_position);
          INSERT INTO project_lifecycle(singleton, monitoring, archived_at_ms, updated_at_ms)
            VALUES (1, ${initialMonitoring ? 1 : 0}, NULL, 0);
          PRAGMA user_version = 1;
        `);
        version = 1;
      } else if (version === 1) {
        db.exec(`
          ALTER TABLE history_events ADD COLUMN source_revision INTEGER;
          PRAGMA user_version = 2;
        `);
        version = 2;
      } else if (version === 2) {
        db.exec(`
          ALTER TABLE source_cursors ADD COLUMN gap_history_truncated INTEGER NOT NULL DEFAULT 0
            CHECK (gap_history_truncated IN (0, 1));
          DROP INDEX history_events_event_id;
          CREATE UNIQUE INDEX history_events_event_id
            ON history_events(source_id, event_id)
            WHERE event_id IS NOT NULL AND source_id IS NOT NULL;
          CREATE UNIQUE INDEX history_events_unscoped_event_id
            ON history_events(event_id)
            WHERE event_id IS NOT NULL AND source_id IS NULL;
          PRAGMA user_version = 3;
        `);
        version = 3;
      } else if (version === 3) {
        db.exec(`
          ALTER TABLE source_cursors ADD COLUMN event_id TEXT;
          PRAGMA user_version = 4;
        `);
        version = 4;
      } else if (version === 4) {
        db.exec(`
          CREATE TABLE source_status (
            source_id TEXT PRIMARY KEY,
            epoch TEXT,
            state TEXT NOT NULL CHECK (state IN ('available', 'partial', 'unavailable', 'no-data')),
            observed_at_ms INTEGER,
            read_at_ms INTEGER NOT NULL,
            reason TEXT
          ) STRICT;
          CREATE UNIQUE INDEX source_gaps_exact
            ON source_gaps(source_id, epoch, from_position, to_position, position_kind, reason)
            WHERE from_position IS NOT NULL AND to_position IS NOT NULL;
          PRAGMA user_version = 5;
        `);
        version = 5;
      } else if (version === 5) {
        db.exec(`
          DROP INDEX IF EXISTS history_events_source_sequence;
          PRAGMA user_version = 6;
        `);
        version = 6;
      } else if (version === 6) {
        db.exec(`
          CREATE TABLE agent_aliases (
            identity_kind TEXT NOT NULL CHECK (identity_kind IN ('agent', 'client', 'session')),
            identity_id TEXT NOT NULL,
            alias TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY(identity_kind, identity_id)
          ) STRICT;
          PRAGMA user_version = 7;
        `);
        version = 7;
      } else {
        throw errorWithCode(
          "HISTORY_DB_VERSION",
          `No migration path is registered from project history schema ${version}`,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw mapSqliteError(error);
    }
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function withoutReadTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutReadTimes);
  const record = jsonRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "readAtMs")
      .map(([key, item]) => [key, withoutReadTimes(item)]),
  );
}

function replayFingerprint(eventJson: string): string {
  return stableJson(withoutReadTimes(JSON.parse(eventJson) as unknown));
}

function hasInlineArtifactBody(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasInlineArtifactBody);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      /^(stdout|stderr|stdoutText|stderrText|rpcResult|response|responseText|sourceText|sentSource|outputText)$/iu.test(
        key,
      ) || hasInlineArtifactBody(item),
  );
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function valueOf(value: unknown): unknown {
  const record = jsonRecord(value);
  if (record && Object.hasOwn(record, "value")) return record["value"];
  return value;
}

function stringValue(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = valueOf(record?.[key]);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = valueOf(record?.[key]);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function sourceStringValue(
  record: Record<string, unknown> | null,
  key: string,
  maxLength: number,
): string | null {
  const raw = valueOf(record?.[key]);
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string")
    throw errorWithCode(
      "HISTORY_EVENT_INVALID",
      `Telemetry ${key} must be a string or null`,
    );
  return checkedSourceString(raw, key, maxLength);
}

function sourceNumberValue(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const raw = valueOf(record?.[key]);
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)
    throw errorWithCode(
      "HISTORY_EVENT_INVALID",
      `Telemetry ${key} must be a non-negative integer or null`,
    );
  return raw;
}

interface SourceEventMetadata {
  readonly eventId: string | null;
  readonly sourceId: string | null;
  readonly epoch: string | null;
  readonly sequence: number | null;
  readonly revision: number | null;
  readonly observedAtMs: number | null;
  readonly readAtMs: number;
  readonly sourceProjectId: string | null;
  readonly eventType: string;
  readonly identity: Record<string, unknown>;
  readonly availability: Record<string, unknown>;
  readonly data: Record<string, unknown>;
}

type ReplayPosition = ProjectHistoryReplayCursor;

interface PreparedEvent<TSourceEvent extends ProjectHistoryEvent> {
  readonly event: ProjectHistoryEvent<TSourceEvent>;
  readonly eventJson: string;
  readonly metadata: SourceEventMetadata;
}

function checkedSourceString(
  value: string | null,
  field: string,
  maxLength: number,
): string | null {
  if (
    value !== null &&
    (!value.trim() ||
      value.length > maxLength ||
      /[\x00-\x1f\x7f]/u.test(value))
  ) {
    throw errorWithCode(
      "HISTORY_EVENT_INVALID",
      `Telemetry ${field} is invalid`,
    );
  }
  return value;
}

function collectAvailability(
  value: unknown,
  path = "event",
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const visit = (item: unknown, currentPath: string): void => {
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${currentPath}[${index}]`));
      return;
    }
    const record = jsonRecord(item);
    if (!record) return;
    if (typeof record["availability"] === "string")
      output[currentPath] = record["availability"];
    for (const [key, child] of Object.entries(record)) {
      if (
        key === "availability" ||
        key === "value" ||
        key === "source" ||
        key === "unit" ||
        key === "scope" ||
        key === "reason" ||
        key === "readAtMs" ||
        key === "observedAtMs"
      )
        continue;
      visit(child, `${currentPath}.${key}`);
    }
  };
  visit(value, path);
  return output;
}

function projectTelemetryEvent<TSourceEvent extends ProjectHistoryEvent>(
  source: ProjectHistoryEvent<TSourceEvent>,
  expectedProjectId: string,
): PreparedEvent<TSourceEvent> {
  const event = jsonRecord(source);
  if (!event || event["version"] !== 1)
    throw errorWithCode(
      "HISTORY_EVENT_INVALID",
      "Unsupported telemetry event version",
    );
  const eventType = event["eventType"];
  if (
    typeof eventType !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,127}$/u.test(eventType)
  )
    throw errorWithCode(
      "HISTORY_EVENT_INVALID",
      "Telemetry event type is invalid",
    );
  if (hasInlineArtifactBody(source))
    throw errorWithCode(
      "LARGE_ARTIFACT_INLINE",
      "Large result content must remain in the project artifact store",
    );
  const metadata = jsonRecord(event["metadata"]) ?? event;
  const identity = jsonRecord(event["identity"]);
  const sourceId = sourceStringValue(metadata, "sourceId", 256);
  const epoch = sourceStringValue(metadata, "epoch", 256);
  const eventId = sourceStringValue(metadata, "eventId", 512);
  const sequence = sourceNumberValue(metadata, "sequence");
  const revision = sourceNumberValue(metadata, "revision");
  const observedAtMs = sourceNumberValue(metadata, "observedAtMs");
  const readAtMs = sourceNumberValue(metadata, "readAtMs");
  if (readAtMs === null)
    throw errorWithCode(
      "HISTORY_EVENT_INVALID",
      "Telemetry source event must report its readAtMs value",
    );
  const sourceProjectId =
    sourceStringValue(identity, "projectId", 256) ??
    sourceStringValue(event, "projectId", 256);
  if (sourceProjectId === null)
    throw errorWithCode(
      "HISTORY_PROJECT_ID_MISSING",
      "Source event has no canonical project identity and cannot enter a project store",
    );
  if (sourceProjectId !== null && sourceProjectId !== expectedProjectId)
    throw errorWithCode(
      "PROJECT_ID_MISMATCH",
      "Project history event belongs to another project",
    );
  const sourceData = jsonRecord(event["data"]);
  const state = stringValue(sourceData, "state") ?? stringValue(event, "state");
  const phase = stringValue(sourceData, "phase") ?? stringValue(event, "phase");
  const worker = jsonRecord(event["worker"]);
  const alive = valueOf(worker?.["alive"]);
  const aliveAvailability = stringValue(
    jsonRecord(worker?.["alive"]),
    "availability",
  );
  const presence = eventType.includes("presence")
    ? aliveAvailability === "stale"
      ? "stale"
      : aliveAvailability !== "available"
        ? "unknown"
        : alive === true
          ? "observed"
          : alive === false
            ? "offline"
            : "unknown"
    : null;
  const data: Record<string, unknown> = {
    ...(sourceData ?? {}),
    ...(state === null ? {} : { state }),
    ...(phase === null ? {} : { phase }),
    ...(numberValue(event, "physicalTurns") === null
      ? {}
      : { physicalTurns: numberValue(event, "physicalTurns") }),
    ...(typeof valueOf(worker?.["alive"]) === "boolean"
      ? { workerAlive: valueOf(worker?.["alive"]) }
      : {}),
    ...(presence === null ? {} : { presence }),
  };
  const files: unknown[] = [];
  for (const [field, defaultKind] of [
    ["sourceFiles", "source"],
    ["outputFiles", "output"],
  ] as const) {
    const found =
      valueOf(event[field]) ??
      sourceData?.[field === "sourceFiles" ? "sourceFiles" : "outputFiles"];
    if (!Array.isArray(found)) continue;
    for (const file of found) {
      const reference = jsonRecord(file);
      if (!reference) continue;
      files.push({
        ...reference,
        kind: stringValue(reference, "kind") ?? defaultKind,
      });
    }
  }
  if (files.length) data["files"] = files;
  const serialized = stableJson(source);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024)
    throw errorWithCode(
      "EVENT_TOO_LARGE",
      "Project history event exceeds its size limit",
    );
  return {
    event: source,
    eventJson: serialized,
    metadata: {
      eventId,
      sourceId,
      epoch,
      sequence,
      revision,
      observedAtMs,
      readAtMs,
      sourceProjectId,
      eventType,
      identity: identity ?? {},
      availability:
        jsonRecord(event["availability"]) ?? collectAvailability(source),
      data,
    },
  };
}

function hasUnavailableValue(value: unknown): boolean {
  if (typeof value === "string")
    return [
      "unknown",
      "stale",
      "missing",
      "unavailable",
      "error",
      "unsupported",
    ].includes(value.toLowerCase());
  if (Array.isArray(value)) return value.some(hasUnavailableValue);
  const record = jsonRecord(value);
  return record ? Object.values(record).some(hasUnavailableValue) : false;
}

function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row;
  const value = row["count"];
  if (typeof value !== "number")
    throw errorWithCode("HISTORY_DB_CORRUPT", "Invalid row count");
  return value;
}

function validatePageRequest(request: ProjectHistoryPageRequest): {
  after: number | null;
  limit: number;
} {
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_PAGE_SIZE
  ) {
    throw new Error(
      `History page limit must be between 1 and ${MAX_PAGE_SIZE}`,
    );
  }
  if (
    request.after !== undefined &&
    (!Number.isSafeInteger(request.after) || request.after < 0)
  ) {
    throw new Error("History page cursor must be a non-negative row ID");
  }
  return { after: request.after ?? null, limit: request.limit };
}

function gapFromRow(row: GapRow): ProjectHistoryGap {
  return {
    sourceId: row.source_id,
    epoch: row.epoch,
    fromPosition: row.from_position,
    toPosition: row.to_position,
    positionKind: row.position_kind,
    detectedAtMs: row.detected_at_ms,
    reason: row.reason,
  };
}

function validateAlias(alias: string): string {
  const label = alias.trim();
  if (
    !label ||
    Array.from(label).length > 128 ||
    /[\x00-\x1f\x7f-\x9f]/u.test(label)
  )
    throw new Error(
      "Alias must be a safe non-empty label of at most 128 characters",
    );
  return label;
}

function validateLifecycle(lifecycle: ProjectHistoryProjectLifecycle): void {
  if (
    typeof lifecycle.monitoring !== "boolean" ||
    !Number.isFinite(lifecycle.updatedAtMs) ||
    lifecycle.updatedAtMs < 0 ||
    (lifecycle.archivedAtMs !== null &&
      (!Number.isFinite(lifecycle.archivedAtMs) ||
        lifecycle.archivedAtMs < 0)) ||
    (lifecycle.archivedAtMs !== null && lifecycle.monitoring)
  )
    throw new Error("Project lifecycle state is invalid");
}

class SQLiteProjectHistoryStore<
  TSourceEvent extends ProjectHistoryEvent,
> implements ProjectHistoryStore<TSourceEvent> {
  private closed = false;
  private writing = false;
  private transactionDepth = 0;

  constructor(
    private readonly db: DatabaseSync,
    readonly projectId: string,
    readonly databaseId: string,
    private readonly epoch: string,
    private readonly schemaVersion: number,
    private readonly readOnly: boolean,
    private readonly now: () => number,
    private readonly databasePath: string,
    private readonly openedDevice: number,
    private readonly openedInode: number,
  ) {}

  private verifyPath(): void {
    let current;
    try {
      current = lstatSync(this.databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.closed = true;
        this.db.close();
        throw errorWithCode(
          "HISTORY_DB_MISSING",
          "Project history database disappeared; old handles were closed",
          error,
        );
      }
      throw error;
    }
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== this.openedDevice ||
      current.ino !== this.openedInode
    ) {
      this.closed = true;
      this.db.close();
      throw errorWithCode(
        "HISTORY_DB_REPLACED",
        "Project history database changed identity; the old handle was closed",
      );
    }
  }

  private assertOpen(): void {
    if (this.closed)
      throw errorWithCode("HISTORY_STORE_CLOSED", "History store is closed");
    this.verifyPath();
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.readOnly)
      throw errorWithCode(
        "HISTORY_DB_READ_ONLY",
        "Project history database is read-only",
      );
  }

  private assertExpectedRevision(expected: ProjectHistoryRevision): void {
    const current = this.meta();
    if (
      !expected ||
      expected.epoch !== this.epoch ||
      !Number.isSafeInteger(expected.revision) ||
      expected.revision !== current.revision
    )
      throw errorWithCode(
        "HISTORY_REVISION_CONFLICT",
        "Project history changed since the requested mutation was prepared",
      );
  }

  private assertProjectMonitoringEnabled(): void {
    const lifecycle = this.db
      .prepare(
        "SELECT monitoring, archived_at_ms FROM project_lifecycle WHERE singleton = 1",
      )
      .get() as
      (Row & { monitoring: number; archived_at_ms: number | null }) | undefined;
    if (!lifecycle)
      throw errorWithCode(
        "HISTORY_DB_CORRUPT",
        "Project lifecycle metadata is missing",
      );
    if (lifecycle.monitoring !== 1 || lifecycle.archived_at_ms !== null)
      throw errorWithCode(
        "HISTORY_PROJECT_ARCHIVED",
        "Project history is read-only while the project is archived",
      );
  }

  private transact<T>(operation: () => T): T {
    this.assertWritable();
    if (this.writing)
      throw errorWithCode(
        "HISTORY_DB_BUSY",
        "Project history writer is already active",
      );
    this.writing = true;
    let began = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.transactionDepth++;
      began = true;
      const result = operation();
      this.assertOpen();
      this.db.exec("COMMIT");
      this.transactionDepth--;
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the original write failure.
        }
        this.transactionDepth--;
      }
      throw mapSqliteError(error);
    } finally {
      this.writing = false;
    }
  }

  private readConsistent<T>(operation: () => T): T {
    this.assertOpen();
    const ownsTransaction = this.transactionDepth === 0;
    let began = false;
    try {
      if (ownsTransaction) {
        this.db.exec("BEGIN DEFERRED");
        this.transactionDepth++;
        began = true;
      }
      const result = operation();
      this.assertOpen();
      if (began) {
        this.db.exec("COMMIT");
        this.transactionDepth--;
        began = false;
      }
      return result;
    } catch (error) {
      if (began) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the read failure.
        }
        this.transactionDepth--;
      }
      throw mapSqliteError(error);
    }
  }

  private meta(): MetaRow {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM project_meta WHERE singleton = 1")
      .get() as MetaRow | undefined;
    if (!row)
      throw errorWithCode(
        "HISTORY_DB_CORRUPT",
        "Project history metadata is missing",
      );
    return row;
  }

  private nextRevision(): number {
    const revision = this.meta().revision;
    if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER)
      throw errorWithCode(
        "HISTORY_DB_VERSION",
        "Project history revision is exhausted",
      );
    return revision + 1;
  }

  private commitRevision(revision: number, updatedAtMs: number): void {
    this.db
      .prepare(
        "UPDATE project_meta SET revision = ?, updated_at_ms = ? WHERE singleton = 1",
      )
      .run(revision, updatedAtMs);
  }

  private allGaps(sourceId?: string): ProjectHistoryGap[] {
    this.assertOpen();
    const rows = sourceId
      ? (this.db
          .prepare(
            "SELECT * FROM source_gaps WHERE source_id = ? ORDER BY epoch, from_position",
          )
          .all(sourceId) as GapRow[])
      : (this.db
          .prepare(
            "SELECT * FROM source_gaps ORDER BY source_id, epoch, from_position",
          )
          .all() as GapRow[]);
    return rows.map(gapFromRow);
  }

  private cursors(sourceId?: string): ProjectHistorySourceCursor[] {
    const rows = sourceId
      ? (this.db
          .prepare(
            "SELECT * FROM source_cursors WHERE source_id = ? ORDER BY updated_at_ms DESC",
          )
          .all(sourceId) as CursorRow[])
      : (this.db
          .prepare(
            "SELECT * FROM source_cursors ORDER BY source_id, updated_at_ms DESC",
          )
          .all() as CursorRow[]);
    return rows.map((row) => ({
      sourceId: row.source_id,
      epoch: row.epoch,
      position: row.position,
      positionKind: row.position_kind,
      eventId: row.event_id,
      updatedAtMs: row.updated_at_ms,
    }));
  }

  private projectAvailability(): ProjectHistoryAvailability {
    const status = this.snapshotSources();
    if (count(this.db, "history_events") === 0) {
      if (status.some((source) => source.state === "unavailable"))
        return "unavailable";
      if (status.some((source) => source.state === "partial")) return "partial";
      return "no-data";
    }
    if (this.allGaps().length > 0) return "partial";
    return status.some((source) => source.state !== "available")
      ? "partial"
      : "available";
  }

  private agentAliasRows(): ProjectHistoryAgentAlias[] {
    return (
      this.db
        .prepare(
          "SELECT identity_kind, identity_id, alias, updated_at_ms FROM agent_aliases ORDER BY identity_kind, identity_id",
        )
        .all() as (Row & {
        identity_kind: ProjectHistoryAgentIdentityKind;
        identity_id: string;
        alias: string;
        updated_at_ms: number;
      })[]
    ).map((row) => ({
      kind: row.identity_kind,
      id: row.identity_id,
      alias: row.alias,
      updatedAtMs: row.updated_at_ms,
    }));
  }

  private snapshotSources(): ProjectHistorySourceStatus[] {
    const eventRows = this.db
      .prepare(
        "SELECT source_id, COUNT(*) AS event_count, MAX(observed_at_ms) AS last_observed FROM history_events GROUP BY source_id ORDER BY source_id",
      )
      .all() as (Row & {
      source_id: string | null;
      event_count: number;
      last_observed: number | null;
    })[];
    const cursors = this.cursors();
    const gaps = this.allGaps();
    const sourceEpochs = this.db
      .prepare(
        "SELECT source_id, COUNT(DISTINCT epoch) AS epoch_count FROM history_events WHERE source_id IS NOT NULL AND epoch IS NOT NULL GROUP BY source_id",
      )
      .all() as (Row & { source_id: string; epoch_count: number })[];
    const epochs = new Map(
      sourceEpochs.map((row) => [row.source_id, row.epoch_count]),
    );
    const truncatedSources = this.db
      .prepare(
        "SELECT source_id, MAX(gap_history_truncated) AS truncated FROM source_cursors GROUP BY source_id",
      )
      .all() as (Row & { source_id: string; truncated: number })[];
    const truncated = new Map(
      truncatedSources.map((row) => [row.source_id, row.truncated === 1]),
    );
    const unavailableSources = this.db
      .prepare("SELECT source_id, availability_json FROM history_events")
      .all() as (Row & {
      source_id: string | null;
      availability_json: string;
    })[];
    const unavailable = new Set(
      unavailableSources
        .filter((row) =>
          hasUnavailableValue(JSON.parse(row.availability_json) as unknown),
        )
        .map((row) => row.source_id),
    );
    const statusRows = this.db
      .prepare("SELECT * FROM source_status")
      .all() as (Row & {
      source_id: string;
      state: ProjectHistoryAvailability;
      observed_at_ms: number | null;
      read_at_ms: number;
      reason: string | null;
    })[];
    const storedStatusBySource = new Map(
      statusRows.map((item) => [item.source_id, item]),
    );
    const sourceMap = new Map(eventRows.map((row) => [row.source_id, row]));
    for (const row of statusRows) {
      if (!sourceMap.has(row.source_id))
        sourceMap.set(row.source_id, {
          source_id: row.source_id,
          event_count: 0,
          last_observed: row.observed_at_ms,
        });
    }
    return [...sourceMap.values()].map((row) => {
      const cursor =
        row.source_id === null
          ? null
          : (cursors.find((item) => item.sourceId === row.source_id) ?? null);
      const sourceGaps = gaps.filter((item) => item.sourceId === row.source_id);
      const changedEpoch =
        row.source_id !== null && (epochs.get(row.source_id) ?? 0) > 1;
      const gapsTruncated =
        row.source_id !== null && (truncated.get(row.source_id) ?? false);
      const sourceUnavailable = unavailable.has(row.source_id);
      const noCursor =
        row.source_id === null || cursor === null || cursor.eventId === null;
      const eventState =
        sourceGaps.length ||
        changedEpoch ||
        gapsTruncated ||
        sourceUnavailable ||
        noCursor
          ? "partial"
          : "available";
      const storedStatus =
        row.source_id === null
          ? undefined
          : storedStatusBySource.get(row.source_id);
      const state: ProjectHistoryAvailability =
        storedStatus?.state === "unavailable"
          ? "unavailable"
          : storedStatus?.state === "no-data"
            ? "no-data"
            : storedStatus?.state === "partial" || eventState === "partial"
              ? "partial"
              : row.event_count === 0
                ? "no-data"
                : "available";
      let reason: string | null =
        row.source_id === null
          ? null
          : (storedStatusBySource.get(row.source_id)?.reason ?? null);
      if (reason === null && sourceGaps.length)
        reason = "Source sequence gaps are retained.";
      else if (reason === null && changedEpoch)
        reason = "Source epoch changed; continuity is unverified.";
      else if (reason === null && gapsTruncated)
        reason =
          "Older source gaps were truncated from the bounded gap window.";
      else if (reason === null && sourceUnavailable)
        reason = "One or more source values are unknown or unavailable.";
      else if (reason === null && row.source_id === null)
        reason = "The source did not report a stable source ID.";
      else if (reason === null && !cursor)
        reason = "The source did not report a replayable sequence cursor.";
      return {
        sourceId: row.source_id,
        state,
        observedAtMs: row.last_observed,
        cursor,
        gaps: sourceGaps,
        gapsTruncated,
        reason,
      };
    });
  }

  private page<T>(
    request: ProjectHistoryPageRequest,
    sql: string,
    totalSql: string,
    map: (row: Row) => T,
  ): ProjectHistoryPage<T> {
    return this.readConsistent(() => {
      const page = validatePageRequest(request);
      const rows = this.db
        .prepare(sql)
        .all(page.after, page.after, page.limit) as Row[];
      const totalRow = this.db.prepare(totalSql).get() as Row;
      const total = totalRow["count"];
      if (typeof total !== "number")
        throw errorWithCode("HISTORY_DB_CORRUPT", "Invalid history row count");
      const mapped = rows.map(map);
      const revision = this.meta();
      const last = mapped.at(-1) as { rowId?: number } | undefined;
      return {
        revision: { epoch: revision.epoch, revision: revision.revision },
        capturedAtMs: this.now(),
        rows: mapped,
        total,
        nextAfter:
          rows.length === page.limit && last?.rowId !== undefined
            ? last.rowId
            : null,
        availability: this.projectAvailability(),
        gaps: this.allGaps(),
      };
    });
  }

  ingest(
    events: readonly ProjectHistoryEvent<TSourceEvent>[],
  ): ProjectHistoryIngestResult {
    return this.ingestBatch({ events });
  }

  ingestBatch(
    batch: ProjectHistoryIngestBatch<TSourceEvent>,
  ): ProjectHistoryIngestResult {
    const prepared = batch.events.map((event) =>
      projectTelemetryEvent(event, this.projectId),
    );
    const sourceIds = new Set(
      prepared
        .map((item) => item.metadata.sourceId)
        .filter((value): value is string => value !== null),
    );
    const epochs = new Set(
      prepared
        .map((item) => item.metadata.epoch)
        .filter((value): value is string => value !== null),
    );
    const batchSourceId =
      batch.sourceId ??
      batch.cursor?.sourceId ??
      batch.gaps?.[0]?.sourceId ??
      prepared[0]?.metadata.sourceId ??
      null;
    const batchEpoch =
      batch.epoch ??
      batch.cursor?.epoch ??
      batch.gaps?.[0]?.epoch ??
      prepared[0]?.metadata.epoch ??
      null;
    if (sourceIds.size > 1 || epochs.size > 1)
      throw errorWithCode(
        "HISTORY_BATCH_SOURCE_MISMATCH",
        "One replay batch may contain only one source and epoch",
      );
    if (
      batch.cursor &&
      (batch.cursor.sourceId !== batchSourceId ||
        batch.cursor.epoch !== batchEpoch)
    )
      throw errorWithCode(
        "HISTORY_BATCH_SOURCE_MISMATCH",
        "Replay cursor does not match its source batch",
      );
    if (
      prepared.some(
        (item) =>
          (item.metadata.sourceId !== null &&
            item.metadata.sourceId !== batchSourceId) ||
          (item.metadata.epoch !== null && item.metadata.epoch !== batchEpoch),
      )
    )
      throw errorWithCode(
        "HISTORY_BATCH_SOURCE_MISMATCH",
        "Replay events do not match their source batch",
      );
    if (batch.availability !== undefined && batchSourceId === null)
      throw errorWithCode(
        "HISTORY_BATCH_SOURCE_MISMATCH",
        "Source availability requires a stable source ID",
      );
    if (
      (batch.gaps ?? []).some(
        (gap) => gap.sourceId !== batchSourceId || gap.epoch !== batchEpoch,
      )
    )
      throw errorWithCode(
        "HISTORY_BATCH_SOURCE_MISMATCH",
        "Replay gaps do not match their source batch",
      );
    const inferredReadAt =
      batch.readAtMs ??
      prepared.reduce<number | null>(
        (latest, item) => Math.max(latest ?? 0, item.metadata.readAtMs),
        null,
      ) ??
      (batch.gaps?.length
        ? Math.max(...batch.gaps.map((gap) => gap.detectedAtMs))
        : null);
    if (
      ((batch.cursor !== undefined && batch.cursor !== null) ||
        batch.gaps !== undefined ||
        batch.availability !== undefined) &&
      inferredReadAt === null
    )
      throw errorWithCode(
        "HISTORY_EVENT_INVALID",
        "Replay cursor or source availability requires a source-reported readAtMs",
      );
    const batchHasMetadata =
      (batch.cursor !== undefined && batch.cursor !== null) ||
      batch.gaps !== undefined ||
      batch.availability !== undefined;
    return this.transact(() => {
      if (prepared.length || batchHasMetadata) {
        const lifecycle = this.db
          .prepare(
            "SELECT monitoring, archived_at_ms FROM project_lifecycle WHERE singleton = 1",
          )
          .get() as
          | (Row & { monitoring: number; archived_at_ms: number | null })
          | undefined;
        if (!lifecycle)
          throw errorWithCode(
            "HISTORY_DB_CORRUPT",
            "Project lifecycle metadata is missing",
          );
        if (lifecycle.monitoring !== 1 || lifecycle.archived_at_ms !== null)
          throw errorWithCode(
            "HISTORY_MONITORING_DISABLED",
            "Project history monitoring is disabled or the project is archived",
          );
      }
      const maxRow = this.db
        .prepare("SELECT MAX(row_id) AS row_id FROM history_events")
        .get() as Row | undefined;
      const baselineRowId =
        typeof maxRow?.["row_id"] === "number" ? maxRow["row_id"] : 0;
      const duplicateById = this.db.prepare(
        "SELECT row_id, event_json FROM history_events WHERE event_id = ? AND source_id IS ?",
      );
      const insertEvent = this.db.prepare(
        `INSERT INTO history_events(
          event_id, source_id, epoch, sequence, source_revision, observed_at_ms,
          read_at_ms, project_id, event_type, identity_json, availability_json,
          data_json, event_json, inserted_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const inserted: (PreparedEvent<TSourceEvent> & { rowId: number })[] = [];
      let duplicates = 0;
      const revision =
        prepared.length || batchHasMetadata
          ? this.nextRevision()
          : this.meta().revision;
      for (const item of prepared) {
        const { event, eventJson, metadata } = item;
        const existing =
          metadata.eventId === null
            ? undefined
            : (duplicateById.get(metadata.eventId, metadata.sourceId) as
                (Row & { row_id: number; event_json: string }) | undefined);
        const duplicate = existing;
        if (duplicate) {
          if (
            replayFingerprint(duplicate.event_json) !==
            replayFingerprint(eventJson)
          )
            throw errorWithCode(
              metadata.eventId === null
                ? "HISTORY_CURSOR_CONFLICT"
                : "HISTORY_EVENT_ID_CONFLICT",
              "A source event identity or cursor was reused for different event content",
            );
          duplicates++;
          continue;
        }
        const result = insertEvent.run(
          metadata.eventId,
          metadata.sourceId,
          metadata.epoch,
          metadata.sequence,
          metadata.revision,
          metadata.observedAtMs,
          metadata.readAtMs,
          this.projectId,
          metadata.eventType,
          stableJson(metadata.identity),
          stableJson(metadata.availability),
          stableJson(metadata.data),
          eventJson,
          revision,
        );
        const rowId = Number(result.lastInsertRowid);
        if (!Number.isSafeInteger(rowId))
          throw errorWithCode(
            "HISTORY_DB_VERSION",
            "Local history row ID is exhausted",
          );
        inserted.push({ ...item, rowId });
        this.projectEvent(rowId, event, metadata, eventJson);
      }
      if (inserted.length) {
        this.updateCursorsAndGaps(inserted, baselineRowId);
      }
      let metadataChanged = false;
      if (batch.cursor) {
        metadataChanged =
          this.updateReplayCursor(batch.cursor, inferredReadAt!) ||
          metadataChanged;
      }
      if (batch.gaps?.length)
        metadataChanged = this.storeReplayGaps(batch.gaps) || metadataChanged;
      const hasProgress =
        (batch.cursor !== undefined && batch.cursor !== null) ||
        batch.gaps !== undefined ||
        batch.availability !== undefined;
      if (hasProgress && batchSourceId !== null) {
        const replayAvailability =
          batch.availability ??
          ((batch.gaps?.length ?? 0) > 0 ? "partial" : "available");
        if (
          replayAvailability === "partial" ||
          replayAvailability === "unavailable"
        ) {
          if ((batch.gaps?.length ?? 0) === 0) {
            metadataChanged =
              this.addGapWithinTransaction({
                sourceId: batchSourceId,
                epoch: batchEpoch ?? "",
                fromPosition: null,
                toPosition: null,
                positionKind: batch.cursor?.positionKind ?? "sequence",
                detectedAtMs: inferredReadAt!,
                reason: "source-replay-incomplete",
              }) || metadataChanged;
          }
        }
        if (
          replayAvailability === "available" &&
          (batch.gaps?.length ?? 0) === 0
        ) {
          const cleared = this.db
            .prepare(
              `DELETE FROM source_gaps WHERE source_id = ? AND epoch IS ?
               AND from_position IS NULL AND to_position IS NULL
               AND reason = 'source-replay-incomplete'`,
            )
            .run(batchSourceId, batchEpoch ?? null);
          metadataChanged = cleared.changes > 0 || metadataChanged;
        }
        metadataChanged =
          this.updateSourceStatus({
            sourceId: batchSourceId,
            epoch: batchEpoch,
            state: replayAvailability,
            observedAtMs:
              batch.observedAtMs ??
              prepared.reduce<number | null>(
                (latest, item) =>
                  item.metadata.observedAtMs === null
                    ? latest
                    : Math.max(
                        latest ?? item.metadata.observedAtMs,
                        item.metadata.observedAtMs,
                      ),
                null,
              ),
            readAtMs: inferredReadAt!,
            reason:
              batch.reason ??
              ((batch.gaps?.length ?? 0) > 0
                ? "Source replay reported a retained gap."
                : replayAvailability === "partial" ||
                    replayAvailability === "unavailable"
                  ? "Source replay is incomplete or unavailable."
                  : null),
          }) || metadataChanged;
      }
      const changed = inserted.length > 0 || metadataChanged;
      if (changed)
        this.commitRevision(
          revision,
          inserted.length
            ? Math.max(...inserted.map((item) => item.metadata.readAtMs))
            : (inferredReadAt ?? this.meta().updated_at_ms),
        );
      return {
        revision: { epoch: this.epoch, revision: this.meta().revision },
        inserted: inserted.length,
        duplicates,
        cursors: this.cursors(),
        gaps: this.allGaps(),
        availability: this.projectAvailability(),
      };
    });
  }

  private projectEvent(
    rowId: number,
    event: ProjectHistoryEvent<TSourceEvent>,
    metadata: SourceEventMetadata,
    eventJson: string,
  ): void {
    const root = jsonRecord(event);
    const identity = metadata.identity;
    const data = metadata.data;
    const actor = jsonRecord(root?.["actor"]);
    const worker = jsonRecord(root?.["worker"]);
    const jobId = stringValue(identity, "jobId");
    const sessionId = stringValue(identity, "sessionId");
    const clientId = stringValue(identity, "clientId");
    const agentId = stringValue(actor, "agent");
    const state = stringValue(data, "state");
    const phase = stringValue(data, "phase");
    const workerAlive = data["workerAlive"];
    const presence =
      workerAlive === true
        ? "observed"
        : workerAlive === false
          ? "offline"
          : null;
    const observedAtMs = metadata.observedAtMs;
    const isObservation = metadata.eventType === "observation.event";
    const isPresence = metadata.eventType.includes("presence");

    if (isObservation) {
      this.db
        .prepare(
          "INSERT INTO observations(row_id, source_id, observed_at_ms, event_json) VALUES (?, ?, ?, ?)",
        )
        .run(rowId, metadata.sourceId, observedAtMs, eventJson);
    }
    if (jobId !== null && metadata.eventType.startsWith("queue.")) {
      this.db
        .prepare(
          `INSERT INTO jobs(job_id, row_id, state, phase, observed_at_ms, event_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id) DO UPDATE SET row_id = excluded.row_id, state = excluded.state,
             phase = excluded.phase, observed_at_ms = excluded.observed_at_ms, event_json = excluded.event_json
           WHERE CASE
             WHEN json_extract(excluded.event_json, '$.metadata.sourceId.value') IS json_extract(jobs.event_json, '$.metadata.sourceId.value')
               AND json_extract(excluded.event_json, '$.metadata.epoch.value') IS json_extract(jobs.event_json, '$.metadata.epoch.value')
               AND COALESCE(
                 json_extract(excluded.event_json, '$.metadata.sequence.value'),
                 json_extract(excluded.event_json, '$.metadata.revision.value')
               ) IS NOT NULL
             THEN COALESCE(
               json_extract(excluded.event_json, '$.metadata.sequence.value'),
               json_extract(excluded.event_json, '$.metadata.revision.value')
             ) > COALESCE(
               json_extract(jobs.event_json, '$.metadata.sequence.value'),
               json_extract(jobs.event_json, '$.metadata.revision.value')
             )
             ELSE excluded.row_id > jobs.row_id
           END`,
        )
        .run(jobId, rowId, state, phase, observedAtMs, eventJson);
    }
    if (sessionId !== null) {
      this.db
        .prepare(
          `INSERT INTO agent_sessions(session_id, row_id, client_id, agent_id, presence, observed_at_ms, event_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET row_id = excluded.row_id,
             client_id = excluded.client_id, agent_id = excluded.agent_id,
             presence = excluded.presence, observed_at_ms = excluded.observed_at_ms,
             event_json = excluded.event_json
           WHERE excluded.row_id > agent_sessions.row_id`,
        )
        .run(
          sessionId,
          rowId,
          clientId,
          agentId,
          presence,
          observedAtMs,
          eventJson,
        );
    }
    if (isPresence) {
      this.db
        .prepare(
          `INSERT INTO presence_history(row_id, source_id, session_id, client_id, pid, presence, observed_at_ms, event_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rowId,
          metadata.sourceId,
          sessionId,
          clientId,
          numberValue(worker, "pid"),
          presence,
          observedAtMs,
          eventJson,
        );
    }
    const files = data?.["files"] ?? data?.["fileReferences"];
    if (Array.isArray(files)) {
      const insert = this.db.prepare(
        `INSERT INTO file_references(
          reference_id, row_id, job_id, kind, path, file_id, artifact_id,
          sha256, provenance, observed_at_ms, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      files.forEach((file, index) => {
        const reference = jsonRecord(file);
        if (!reference) return;
        const kind = stringValue(reference, "kind");
        if (kind === null) return;
        const id =
          stringValue(reference, "id") ?? stringValue(reference, "fileId");
        const referenceId =
          stringValue(reference, "referenceId") ??
          `${metadata.eventId ?? `local-${rowId}`}:${index}`;
        insert.run(
          referenceId,
          rowId,
          jobId,
          kind,
          stringValue(reference, "path"),
          id,
          stringValue(reference, "artifactId"),
          stringValue(reference, "sha256"),
          stringValue(reference, "provenance"),
          observedAtMs,
          eventJson,
        );
      });
    }
  }

  private updateCursorsAndGaps(
    inserted: readonly (PreparedEvent<TSourceEvent> & { rowId: number })[],
    baselineRowId: number,
  ): void {
    type Position = {
      rowId: number;
      metadata: SourceEventMetadata;
      kind: "sequence" | "revision";
      value: number;
    };
    const positions: Position[] = [];
    for (const item of inserted) {
      if (item.metadata.sourceId === null || item.metadata.epoch === null)
        continue;
      if (item.metadata.sequence !== null)
        positions.push({
          rowId: item.rowId,
          metadata: item.metadata,
          kind: "sequence",
          value: item.metadata.sequence,
        });
      else if (item.metadata.revision !== null)
        positions.push({
          rowId: item.rowId,
          metadata: item.metadata,
          kind: "revision",
          value: item.metadata.revision,
        });
    }
    positions.sort(
      (a, b) =>
        a.metadata.sourceId!.localeCompare(b.metadata.sourceId!) ||
        a.metadata.epoch!.localeCompare(b.metadata.epoch!) ||
        a.kind.localeCompare(b.kind) ||
        a.value - b.value,
    );

    const cursor = this.db.prepare(
      `SELECT * FROM source_cursors
       WHERE source_id = ? AND epoch = ? AND position_kind = ?`,
    );
    const insertCursor = this.db.prepare(
      `INSERT INTO source_cursors(source_id, epoch, position, position_kind, updated_at_ms, event_id)
       VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, epoch, position_kind) DO UPDATE SET
          position = excluded.position, updated_at_ms = excluded.updated_at_ms,
          event_id = excluded.event_id
        WHERE excluded.position > source_cursors.position
          OR (excluded.position = source_cursors.position
            AND excluded.event_id IS NOT NULL
            AND source_cursors.event_id IS NOT excluded.event_id)`,
    );
    const insertGap = this.db.prepare(
      `INSERT INTO source_gaps(source_id, epoch, from_position, to_position,
        position_kind, detected_at_ms, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectGap = this.db.prepare(
      `SELECT gap_id, from_position, to_position FROM source_gaps
       WHERE source_id = ? AND epoch = ? AND position_kind = ?
         AND from_position <= ? AND to_position >= ?`,
    );
    const deleteGap = this.db.prepare(
      "DELETE FROM source_gaps WHERE gap_id = ?",
    );
    const countGaps = this.db.prepare(
      "SELECT COUNT(*) AS count FROM source_gaps WHERE source_id = ?",
    );
    const markGapHistoryTruncated = this.db.prepare(
      `UPDATE source_cursors SET gap_history_truncated = 1
       WHERE source_id = ? AND epoch = ? AND position_kind = ?`,
    );
    const sourceMaximum = (
      sourceId: string,
      epoch: string,
      kind: Position["kind"],
    ) => {
      const column = kind === "sequence" ? "sequence" : "source_revision";
      const row = this.db
        .prepare(
          `SELECT MAX(${column}) AS position FROM history_events
           WHERE source_id = ? AND epoch = ? AND row_id <= ?`,
        )
        .get(sourceId, epoch, baselineRowId) as Row | undefined;
      const value = row?.["position"];
      return typeof value === "number" ? value : null;
    };
    const markTruncated = (
      sourceId: string,
      epoch: string,
      kind: Position["kind"],
    ): void => {
      markGapHistoryTruncated.run(sourceId, epoch, kind);
    };
    const addGap = (
      sourceId: string,
      epoch: string,
      kind: Position["kind"],
      from: number | null,
      to: number | null,
      detectedAtMs: number,
      reason: ProjectHistoryGap["reason"],
    ): void => {
      const count = (countGaps.get(sourceId) as Row | undefined)?.["count"];
      if (typeof count !== "number")
        throw errorWithCode("HISTORY_DB_CORRUPT", "Invalid source gap count");
      if (count >= MAX_GAPS_PER_SOURCE) {
        markTruncated(sourceId, epoch, kind);
        return;
      }
      insertGap.run(sourceId, epoch, from, to, kind, detectedAtMs, reason);
    };

    const initialized = new Set<string>();
    for (const item of positions) {
      const sourceId = item.metadata.sourceId!;
      const epoch = item.metadata.epoch!;
      const key = `${sourceId}\0${epoch}\0${item.kind}`;
      const current = cursor.get(sourceId, epoch, item.kind) as
        CursorRow | undefined;
      if (!current && !initialized.has(key)) {
        const oldMaximum = sourceMaximum(sourceId, epoch, item.kind);
        if (oldMaximum !== null) {
          addGap(
            sourceId,
            epoch,
            item.kind,
            null,
            null,
            item.metadata.readAtMs,
            "cursor-lost",
          );
          insertCursor.run(
            sourceId,
            epoch,
            oldMaximum,
            item.kind,
            item.metadata.readAtMs,
            null,
          );
        } else if (item.kind === "sequence" && item.value > 1) {
          addGap(
            sourceId,
            epoch,
            item.kind,
            null,
            null,
            item.metadata.readAtMs,
            "initial-cursor-unanchored",
          );
        }
        initialized.add(key);
      }
      const highWater = cursor.get(sourceId, epoch, item.kind) as
        CursorRow | undefined;
      if (!highWater) {
        insertCursor.run(
          sourceId,
          epoch,
          item.value,
          item.kind,
          item.metadata.readAtMs,
          item.metadata.eventId,
        );
        continue;
      }
      if (item.value > highWater.position + 1) {
        addGap(
          sourceId,
          epoch,
          item.kind,
          highWater.position + 1,
          item.value - 1,
          item.metadata.readAtMs,
          item.kind === "sequence" ? "sequence-gap" : "revision-gap",
        );
      }
      if (item.value > highWater.position) {
        insertCursor.run(
          sourceId,
          epoch,
          item.value,
          item.kind,
          item.metadata.readAtMs,
          item.metadata.eventId,
        );
        continue;
      }
      if (
        item.value === highWater.position &&
        item.metadata.eventId !== highWater.event_id
      ) {
        insertCursor.run(
          sourceId,
          epoch,
          item.value,
          item.kind,
          item.metadata.readAtMs,
          item.metadata.eventId,
        );
      }
      const gaps = selectGap.all(
        sourceId,
        epoch,
        item.kind,
        item.value,
        item.value,
      ) as (Row & {
        gap_id: number;
        from_position: number;
        to_position: number;
      })[];
      for (const gap of gaps) {
        const parts =
          Number(gap.from_position < item.value) +
          Number(item.value < gap.to_position);
        const gapCount = (countGaps.get(sourceId) as Row | undefined)?.[
          "count"
        ];
        if (typeof gapCount !== "number")
          throw errorWithCode("HISTORY_DB_CORRUPT", "Invalid source gap count");
        if (gapCount - 1 + parts > MAX_GAPS_PER_SOURCE) {
          markTruncated(sourceId, epoch, item.kind);
          continue;
        }
        deleteGap.run(gap.gap_id);
        if (gap.from_position < item.value)
          insertGap.run(
            sourceId,
            epoch,
            gap.from_position,
            item.value - 1,
            item.kind,
            item.metadata.readAtMs,
            item.kind === "sequence" ? "sequence-gap" : "revision-gap",
          );
        if (item.value < gap.to_position)
          insertGap.run(
            sourceId,
            epoch,
            item.value + 1,
            gap.to_position,
            item.kind,
            item.metadata.readAtMs,
            item.kind === "sequence" ? "sequence-gap" : "revision-gap",
          );
      }
    }
  }

  private updateReplayCursor(
    cursor: ReplayPosition,
    readAtMs: number,
  ): boolean {
    const current = this.db
      .prepare(
        `SELECT * FROM source_cursors
         WHERE source_id = ? AND epoch = ? AND position_kind = ?`,
      )
      .get(cursor.sourceId, cursor.epoch, cursor.positionKind) as
      CursorRow | undefined;
    if (current && cursor.position < current.position) return false;
    if (current && cursor.position === current.position) {
      if (current.event_id !== cursor.eventId) {
        const changed = this.db
          .prepare(
            `UPDATE source_cursors SET event_id = ?, updated_at_ms = ?
             WHERE source_id = ? AND epoch = ? AND position_kind = ? AND position = ?`,
          )
          .run(
            cursor.eventId,
            readAtMs,
            cursor.sourceId,
            cursor.epoch,
            cursor.positionKind,
            cursor.position,
          );
        return changed.changes > 0;
      }
      return false;
    }
    if (!current && cursor.positionKind === "sequence" && cursor.position > 1) {
      this.addGapWithinTransaction({
        sourceId: cursor.sourceId,
        epoch: cursor.epoch,
        fromPosition: null,
        toPosition: null,
        positionKind: cursor.positionKind,
        detectedAtMs: readAtMs,
        reason: "initial-cursor-unanchored",
      });
    } else if (current && cursor.position > current.position + 1) {
      this.addGapWithinTransaction({
        sourceId: cursor.sourceId,
        epoch: cursor.epoch,
        fromPosition: current.position + 1,
        toPosition: cursor.position - 1,
        positionKind: cursor.positionKind,
        detectedAtMs: readAtMs,
        reason:
          cursor.positionKind === "sequence" ? "sequence-gap" : "revision-gap",
      });
    }
    this.db
      .prepare(
        `INSERT INTO source_cursors(source_id, epoch, position, position_kind, updated_at_ms, event_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, epoch, position_kind) DO UPDATE SET
           position = excluded.position, updated_at_ms = excluded.updated_at_ms,
           event_id = excluded.event_id
         WHERE excluded.position > source_cursors.position`,
      )
      .run(
        cursor.sourceId,
        cursor.epoch,
        cursor.position,
        cursor.positionKind,
        readAtMs,
        cursor.eventId,
      );
    return true;
  }

  private addGapWithinTransaction(gap: ProjectHistoryGap): boolean {
    const existing = this.db
      .prepare(
        `SELECT gap_id FROM source_gaps WHERE source_id = ? AND epoch = ?
         AND from_position IS ? AND to_position IS ? AND position_kind = ? AND reason = ? LIMIT 1`,
      )
      .get(
        gap.sourceId,
        gap.epoch,
        gap.fromPosition,
        gap.toPosition,
        gap.positionKind,
        gap.reason,
      );
    if (existing) return false;
    const total = this.db
      .prepare("SELECT COUNT(*) AS count FROM source_gaps WHERE source_id = ?")
      .get(gap.sourceId) as Row;
    if (typeof total["count"] !== "number")
      throw errorWithCode("HISTORY_DB_CORRUPT", "Invalid source gap count");
    if (total["count"] >= MAX_GAPS_PER_SOURCE) {
      this.db
        .prepare(
          `UPDATE source_cursors SET gap_history_truncated = 1
           WHERE source_id = ? AND epoch = ? AND position_kind = ?`,
        )
        .run(gap.sourceId, gap.epoch, gap.positionKind);
      return false;
    }
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO source_gaps(
          source_id, epoch, from_position, to_position, position_kind, detected_at_ms, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        gap.sourceId,
        gap.epoch,
        gap.fromPosition,
        gap.toPosition,
        gap.positionKind,
        gap.detectedAtMs,
        gap.reason,
      );
    return result.changes > 0;
  }

  private storeReplayGaps(gaps: readonly ProjectHistoryGap[]): boolean {
    if (gaps.length > MAX_GAPS_PER_SOURCE)
      throw errorWithCode(
        "HISTORY_EVENT_INVALID",
        "Replay batch exceeds the bounded gap window",
      );
    let changed = false;
    for (const gap of gaps) {
      const added = this.addGapWithinTransaction(gap);
      changed = added || changed;
    }
    return changed;
  }

  private updateSourceStatus(input: {
    sourceId: string;
    epoch: string | null;
    state: ProjectHistoryAvailability;
    observedAtMs: number | null;
    readAtMs: number;
    reason: string | null;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO source_status(source_id, epoch, state, observed_at_ms, read_at_ms, reason)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           epoch = excluded.epoch, state = excluded.state,
           observed_at_ms = excluded.observed_at_ms,
           read_at_ms = excluded.read_at_ms, reason = excluded.reason
         WHERE source_status.epoch IS NOT excluded.epoch
            OR source_status.state IS NOT excluded.state
            OR source_status.observed_at_ms IS NOT excluded.observed_at_ms
            OR source_status.read_at_ms IS NOT excluded.read_at_ms
            OR source_status.reason IS NOT excluded.reason`,
      )
      .run(
        input.sourceId,
        input.epoch,
        input.state,
        input.observedAtMs,
        input.readAtMs,
        input.reason,
      );
    return result.changes > 0;
  }

  snapshot(capturedAtMs = this.now()): ProjectHistorySnapshot {
    if (!Number.isFinite(capturedAtMs) || capturedAtMs < 0)
      throw new Error("Snapshot timestamp must be non-negative and finite");
    return this.readConsistent(() => {
      const meta = this.meta();
      const lifecycleRow = this.db
        .prepare("SELECT * FROM project_lifecycle WHERE singleton = 1")
        .get() as
        | (Row & {
            monitoring: number;
            archived_at_ms: number | null;
            updated_at_ms: number;
          })
        | undefined;
      if (!lifecycleRow)
        throw errorWithCode(
          "HISTORY_DB_CORRUPT",
          "Project lifecycle metadata is missing",
        );
      const aliases = (
        this.db
          .prepare("SELECT alias FROM aliases ORDER BY alias_key")
          .all() as (Row & { alias: string })[]
      ).map((row) => row.alias);
      return {
        projectId: this.projectId,
        databaseId: this.databaseId,
        version: 1,
        revision: { epoch: this.epoch, revision: meta.revision },
        capturedAtMs,
        availability: this.projectAvailability(),
        lifecycle: {
          monitoring: lifecycleRow.monitoring === 1,
          archivedAtMs: lifecycleRow.archived_at_ms,
          updatedAtMs: lifecycleRow.updated_at_ms,
        },
        aliases,
        agentAliases: this.schemaVersion >= 7 ? this.agentAliasRows() : [],
        sources: this.snapshotSources(),
        eventCount: count(this.db, "history_events"),
        jobCount: count(this.db, "jobs"),
        sessionCount: count(this.db, "agent_sessions"),
        fileReferenceCount: count(this.db, "file_references"),
      };
    });
  }

  readSnapshot(
    maxBytes = MAX_READ_SNAPSHOT_BYTES,
  ): ProjectHistoryReadSnapshot<TSourceEvent> {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_READ_SNAPSHOT_BYTES
    )
      throw new Error(
        `History snapshot limit must be between 1 and ${MAX_READ_SNAPSHOT_BYTES}`,
      );
    return this.readConsistent(() => {
      const summary = this.snapshot(this.now());
      let bytes = Buffer.byteLength(JSON.stringify(summary), "utf8");
      const appendRows = <T>(sql: string, map: (row: Row) => T): T[] => {
        const rows: T[] = [];
        for (const row of this.db.prepare(sql).iterate() as Iterable<Row>) {
          const value = map(row);
          bytes += Buffer.byteLength(JSON.stringify(value), "utf8");
          if (bytes > maxBytes)
            throw errorWithCode(
              "HISTORY_SNAPSHOT_TOO_LARGE",
              "Project history exceeds the immutable query snapshot byte limit",
            );
          rows.push(value);
        }
        return rows;
      };
      const events = appendRows(
        "SELECT row_id, event_json, inserted_revision FROM history_events ORDER BY row_id DESC",
        (row): ProjectHistoryEventRecord<TSourceEvent> => ({
          rowId: row["row_id"] as number,
          event: JSON.parse(
            row["event_json"] as string,
          ) as ProjectHistoryEvent<TSourceEvent>,
          insertedRevision: row["inserted_revision"] as number,
        }),
      );
      const jobs = appendRows(
        "SELECT row_id, job_id, state, phase, observed_at_ms, event_json FROM jobs ORDER BY row_id DESC",
        (row): ProjectHistoryJobRecord<TSourceEvent> => ({
          rowId: row["row_id"] as number,
          jobId: row["job_id"] as string,
          state: row["state"] as string | null,
          phase: row["phase"] as string | null,
          observedAtMs: row["observed_at_ms"] as number | null,
          event: JSON.parse(
            row["event_json"] as string,
          ) as ProjectHistoryEvent<TSourceEvent>,
        }),
      );
      const sessions = appendRows(
        "SELECT row_id, session_id, client_id, agent_id, presence, observed_at_ms, event_json FROM agent_sessions ORDER BY row_id DESC",
        (row): ProjectHistorySessionRecord<TSourceEvent> => ({
          rowId: row["row_id"] as number,
          sessionId: row["session_id"] as string,
          clientId: row["client_id"] as string | null,
          agentId: row["agent_id"] as string | null,
          presence: row["presence"] as string | null,
          observedAtMs: row["observed_at_ms"] as number | null,
          event: JSON.parse(
            row["event_json"] as string,
          ) as ProjectHistoryEvent<TSourceEvent>,
        }),
      );
      const fileReferences = appendRows(
        `SELECT row_id, reference_id, job_id, kind, path, file_id, artifact_id,
          sha256, provenance, observed_at_ms, event_json FROM file_references ORDER BY row_id DESC`,
        (row): ProjectHistoryFileReference<TSourceEvent> => ({
          rowId: row["row_id"] as number,
          id: row["reference_id"] as string,
          jobId: row["job_id"] as string | null,
          kind: row["kind"] as string,
          path: row["path"] as string | null,
          fileId: row["file_id"] as string | null,
          artifactId: row["artifact_id"] as string | null,
          sha256: row["sha256"] as string | null,
          provenance: row["provenance"] as string | null,
          observedAtMs: row["observed_at_ms"] as number | null,
          event: JSON.parse(
            row["event_json"] as string,
          ) as ProjectHistoryEvent<TSourceEvent>,
        }),
      );
      return { ...summary, events, jobs, sessions, fileReferences };
    });
  }

  listEvents(
    request: ProjectHistoryPageRequest,
  ): ProjectHistoryPage<ProjectHistoryEventRecord<TSourceEvent>> {
    return this.page(
      request,
      `SELECT row_id, event_json, inserted_revision FROM history_events
       WHERE (? IS NULL OR row_id < ?) ORDER BY row_id DESC LIMIT ?`,
      "SELECT COUNT(*) AS count FROM history_events",
      (row) => ({
        rowId: row["row_id"] as number,
        event: JSON.parse(
          row["event_json"] as string,
        ) as ProjectHistoryEvent<TSourceEvent>,
        insertedRevision: row["inserted_revision"] as number,
      }),
    );
  }

  listJobs(
    request: ProjectHistoryPageRequest,
  ): ProjectHistoryPage<ProjectHistoryJobRecord<TSourceEvent>> {
    return this.page(
      request,
      `SELECT row_id, job_id, state, phase, observed_at_ms, event_json FROM jobs
       WHERE (? IS NULL OR row_id < ?) ORDER BY row_id DESC LIMIT ?`,
      "SELECT COUNT(*) AS count FROM jobs",
      (row) => ({
        rowId: row["row_id"] as number,
        jobId: row["job_id"] as string,
        state: row["state"] as string | null,
        phase: row["phase"] as string | null,
        observedAtMs: row["observed_at_ms"] as number | null,
        event: JSON.parse(
          row["event_json"] as string,
        ) as ProjectHistoryEvent<TSourceEvent>,
      }),
    );
  }

  listSessions(
    request: ProjectHistoryPageRequest,
  ): ProjectHistoryPage<ProjectHistorySessionRecord<TSourceEvent>> {
    return this.page(
      request,
      `SELECT row_id, session_id, client_id, agent_id, presence, observed_at_ms, event_json
       FROM agent_sessions WHERE (? IS NULL OR row_id < ?) ORDER BY row_id DESC LIMIT ?`,
      "SELECT COUNT(*) AS count FROM agent_sessions",
      (row) => ({
        rowId: row["row_id"] as number,
        sessionId: row["session_id"] as string,
        clientId: row["client_id"] as string | null,
        agentId: row["agent_id"] as string | null,
        presence: row["presence"] as string | null,
        observedAtMs: row["observed_at_ms"] as number | null,
        event: JSON.parse(
          row["event_json"] as string,
        ) as ProjectHistoryEvent<TSourceEvent>,
      }),
    );
  }

  listFileReferences(
    request: ProjectHistoryPageRequest,
  ): ProjectHistoryPage<ProjectHistoryFileReference<TSourceEvent>> {
    return this.page(
      request,
      `SELECT row_id, reference_id, job_id, kind, path, file_id, artifact_id,
        sha256, provenance, observed_at_ms, event_json FROM file_references
       WHERE (? IS NULL OR row_id < ?) ORDER BY row_id DESC LIMIT ?`,
      "SELECT COUNT(*) AS count FROM file_references",
      (row) => ({
        rowId: row["row_id"] as number,
        id: row["reference_id"] as string,
        jobId: row["job_id"] as string | null,
        kind: row["kind"] as string,
        path: row["path"] as string | null,
        fileId: row["file_id"] as string | null,
        artifactId: row["artifact_id"] as string | null,
        sha256: row["sha256"] as string | null,
        provenance: row["provenance"] as string | null,
        observedAtMs: row["observed_at_ms"] as number | null,
        event: JSON.parse(
          row["event_json"] as string,
        ) as ProjectHistoryEvent<TSourceEvent>,
      }),
    );
  }

  setAlias(alias: string, nowMs: number): ProjectHistorySnapshot {
    const label = validateAlias(alias);
    const key = label.normalize("NFKC").toLowerCase();
    if (!Number.isFinite(nowMs) || nowMs < 0)
      throw new Error("Alias timestamp must be non-negative and finite");
    return this.transact(() => {
      const existing = this.db
        .prepare("SELECT alias FROM aliases WHERE alias_key = ?")
        .get(key) as (Row & { alias: string }) | undefined;
      if (existing?.alias === label) return this.snapshot(nowMs);
      const revision = this.nextRevision();
      this.db
        .prepare(
          `INSERT INTO aliases(alias_key, alias, updated_at_ms) VALUES (?, ?, ?)
           ON CONFLICT(alias_key) DO UPDATE SET alias = excluded.alias,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(key, label, nowMs);
      this.commitRevision(revision, nowMs);
      return this.snapshot(nowMs);
    });
  }

  setProjectAlias(
    alias: string | null,
    expectedRevision: ProjectHistoryRevision,
    nowMs: number,
  ): ProjectHistorySnapshot {
    const label = alias === null ? null : validateAlias(alias);
    if (!Number.isFinite(nowMs) || nowMs < 0)
      throw new Error("Alias timestamp must be a non-negative finite number");
    return this.transact(() => {
      this.assertExpectedRevision(expectedRevision);
      this.assertProjectMonitoringEnabled();
      const current = (
        this.db
          .prepare("SELECT alias FROM aliases ORDER BY alias_key")
          .all() as (Row & { alias: string })[]
      ).map((row) => row.alias);
      const unchanged =
        label === null
          ? current.length === 0
          : current.length === 1 && current[0] === label;
      if (unchanged) return this.snapshot(nowMs);
      const revision = this.nextRevision();
      this.db.prepare("DELETE FROM aliases").run();
      if (label !== null)
        this.db
          .prepare(
            "INSERT INTO aliases(alias_key, alias, updated_at_ms) VALUES (?, ?, ?)",
          )
          .run(label.normalize("NFKC").toLowerCase(), label, nowMs);
      this.commitRevision(revision, nowMs);
      return this.snapshot(nowMs);
    });
  }

  setAgentAlias(
    identity: ProjectHistoryAgentAliasIdentity,
    alias: string | null,
    expectedRevision: ProjectHistoryRevision,
    nowMs: number,
  ): ProjectHistorySnapshot {
    if (
      !identity ||
      !["agent", "client", "session"].includes(identity.kind) ||
      typeof identity.id !== "string" ||
      !identity.id.trim() ||
      identity.id.length > 256 ||
      /[\x00-\x1f\x7f]/u.test(identity.id)
    )
      throw new Error("Agent alias identity is invalid");
    const label = alias === null ? null : validateAlias(alias);
    if (!Number.isFinite(nowMs) || nowMs < 0)
      throw new Error("Alias timestamp must be a non-negative finite number");
    return this.transact(() => {
      this.assertExpectedRevision(expectedRevision);
      this.assertProjectMonitoringEnabled();
      const previous = this.db
        .prepare(
          "SELECT alias FROM agent_aliases WHERE identity_kind = ? AND identity_id = ?",
        )
        .get(identity.kind, identity.id) as
        (Row & { alias: string }) | undefined;
      if (previous?.alias === label || (!previous && label === null))
        return this.snapshot(nowMs);
      const revision = this.nextRevision();
      if (label === null) {
        this.db
          .prepare(
            "DELETE FROM agent_aliases WHERE identity_kind = ? AND identity_id = ?",
          )
          .run(identity.kind, identity.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO agent_aliases(identity_kind, identity_id, alias, updated_at_ms)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(identity_kind, identity_id) DO UPDATE SET
               alias = excluded.alias, updated_at_ms = excluded.updated_at_ms`,
          )
          .run(identity.kind, identity.id, label, nowMs);
      }
      this.commitRevision(revision, nowMs);
      return this.snapshot(nowMs);
    });
  }

  private updateLifecycle(
    lifecycle: ProjectHistoryProjectLifecycle,
  ): ProjectHistorySnapshot {
    const current = this.db
      .prepare("SELECT * FROM project_lifecycle WHERE singleton = 1")
      .get() as
      (Row & { monitoring: number; archived_at_ms: number | null }) | undefined;
    if (!current)
      throw errorWithCode(
        "HISTORY_DB_CORRUPT",
        "Project lifecycle metadata is missing",
      );
    const monitoring = lifecycle.monitoring ? 1 : 0;
    if (
      current.monitoring === monitoring &&
      current.archived_at_ms === lifecycle.archivedAtMs
    )
      return this.snapshot(lifecycle.updatedAtMs);
    const revision = this.nextRevision();
    this.db
      .prepare(
        "UPDATE project_lifecycle SET monitoring = ?, archived_at_ms = ?, updated_at_ms = ? WHERE singleton = 1",
      )
      .run(monitoring, lifecycle.archivedAtMs, lifecycle.updatedAtMs);
    this.commitRevision(revision, lifecycle.updatedAtMs);
    return this.snapshot(lifecycle.updatedAtMs);
  }

  removeAlias(alias: string, nowMs: number): ProjectHistorySnapshot {
    const key = alias.trim().normalize("NFKC").toLowerCase();
    if (!key || !Number.isFinite(nowMs) || nowMs < 0)
      throw new Error("Alias and timestamp are invalid");
    return this.transact(() => {
      const result = this.db
        .prepare("DELETE FROM aliases WHERE alias_key = ?")
        .run(key);
      if (result.changes) this.commitRevision(this.nextRevision(), nowMs);
      return this.snapshot(nowMs);
    });
  }

  setLifecycle(
    lifecycle: ProjectHistoryProjectLifecycle,
  ): ProjectHistorySnapshot {
    validateLifecycle(lifecycle);
    return this.transact(() => this.updateLifecycle(lifecycle));
  }

  setLifecycleIfRevision(
    lifecycle: ProjectHistoryProjectLifecycle,
    expectedRevision: ProjectHistoryRevision,
  ): ProjectHistorySnapshot {
    validateLifecycle(lifecycle);
    return this.transact(() => {
      this.assertExpectedRevision(expectedRevision);
      return this.updateLifecycle(lifecycle);
    });
  }

  withActivityFence<T>(
    operation: (
      fence: ProjectHistoryActivityFence,
    ) => ProjectHistorySynchronousResult<T>,
  ): T {
    if (typeof operation !== "function")
      throw new TypeError("Project activity fence operation is required");
    return this.transact(() => {
      const result = operation({
        projectId: this.projectId,
        databaseId: this.databaseId,
        snapshot: (capturedAtMs) => this.snapshot(capturedAtMs),
        setLifecycleIfRevision: (lifecycle, expectedRevision) => {
          validateLifecycle(lifecycle);
          this.assertExpectedRevision(expectedRevision);
          return this.updateLifecycle(lifecycle);
        },
      });
      if (isPromiseLike(result))
        throw errorWithCode(
          "HISTORY_ACTIVITY_FENCE_ASYNC",
          "Project activity fence operations must remain synchronous",
        );
      return result as T;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** One synchronous SQLite connection per project; SQLite serializes cross-process writers. */
export function openProjectHistoryStore<
  TSourceEvent extends ProjectHistoryEvent = ProjectHistoryEvent,
>(options: OpenProjectHistoryOptions): ProjectHistoryStore<TSourceEvent> {
  if (!options.projectId.trim() || options.projectId.length > 256)
    throw errorWithCode("PROJECT_ID_INVALID", "Project ID is invalid");
  const readOnly = options.readOnly ?? false;
  const initializeIfMissing = options.initializeIfMissing ?? false;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > MAX_BUSY_TIMEOUT_MS
  ) {
    throw new Error(
      `SQLite busy timeout must be between 0 and ${MAX_BUSY_TIMEOUT_MS} ms`,
    );
  }
  if (
    options.maxDatabasePages !== undefined &&
    (!Number.isSafeInteger(options.maxDatabasePages) ||
      options.maxDatabasePages < 1)
  ) {
    throw new Error("SQLite page cap must be a positive safe integer");
  }
  const projectRoot = assertSafeProjectRoot(options.projectRoot);
  if (options.journalMode === "wal") assertWalFilesystem(projectRoot);
  const allowCreate = initializeIfMissing && !readOnly;
  const cadDirectory = ensureChildDirectory(projectRoot, ".cad", allowCreate);
  const historyDirectory = ensureChildDirectory(
    cadDirectory,
    "control-center",
    allowCreate,
  );
  const databasePath = join(historyDirectory, DATABASE_NAME);
  const isNewFile = ensureDatabaseFile(databasePath, allowCreate);
  const walRequested = options.journalMode === "wal";
  if (walRequested || (!isNewFile && usesWalJournal(databasePath)))
    assertWalFilesystem(projectRoot);
  let db: DatabaseSync | undefined;
  let maxPages: number | undefined;
  try {
    const DatabaseSync = loadDatabaseSync();
    db = new DatabaseSync(databasePath, { readOnly });
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec("PRAGMA foreign_keys = ON");
    if (!readOnly) {
      const pageSize = (db.prepare("PRAGMA page_size").get() as Row)[
        "page_size"
      ];
      if (
        typeof pageSize !== "number" ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1
      )
        throw errorWithCode(
          "HISTORY_DB_CORRUPT",
          "Project history page size is invalid",
        );
      maxPages =
        options.maxDatabasePages ??
        Math.max(1, Math.floor(DEFAULT_DATABASE_MAX_BYTES / pageSize));
      const pageCount = (db.prepare("PRAGMA page_count").get() as Row)[
        "page_count"
      ];
      if (
        typeof pageCount !== "number" ||
        !Number.isSafeInteger(pageCount) ||
        pageCount < 0
      )
        throw errorWithCode(
          "HISTORY_DB_CORRUPT",
          "Project history page count is invalid",
        );
      // A database already over the limit must be allowed to finish migration;
      // applying the limit afterward prevents any further growth without truncation.
      if (pageCount <= maxPages) db.exec(`PRAGMA max_page_count = ${maxPages}`);
      db.exec("PRAGMA journal_size_limit = 0");
    }
    if (!readOnly && options.journalMode) {
      const mode = db
        .prepare(`PRAGMA journal_mode = ${options.journalMode.toUpperCase()}`)
        .get() as Row;
      if (String(mode["journal_mode"]).toLowerCase() !== options.journalMode)
        throw errorWithCode(
          "HISTORY_JOURNAL_MODE_UNAVAILABLE",
          `SQLite did not enable requested ${options.journalMode} journal mode`,
        );
      if (options.journalMode === "wal")
        db.exec(
          `PRAGMA wal_autocheckpoint = ${DEFAULT_WAL_AUTOCHECKPOINT_PAGES}`,
        );
    } else {
      const mode = db.prepare("PRAGMA journal_mode").get() as Row;
      if (String(mode["journal_mode"]).toLowerCase() === "wal") {
        assertWalFilesystem(projectRoot);
        if (!readOnly)
          db.exec(
            `PRAGMA wal_autocheckpoint = ${DEFAULT_WAL_AUTOCHECKPOINT_PAGES}`,
          );
      }
    }
    if (!readOnly) db.exec("PRAGMA synchronous = FULL");
    if (!isNewFile && statSync(databasePath).size === 0)
      throw errorWithCode(
        "HISTORY_DB_CORRUPT",
        "Project history database is empty; it was not silently reinitialized",
      );
    migrate(
      db,
      readOnly,
      isNewFile,
      initializeIfMissing,
      options.initialMonitoring ?? false,
    );
    let meta = db
      .prepare("SELECT * FROM project_meta WHERE singleton = 1")
      .get() as MetaRow | undefined;
    if (!meta) {
      if (
        readOnly ||
        (!isNewFile && !initializeIfMissing) ||
        count(db, "history_events") > 0 ||
        count(db, "aliases") > 0
      )
        throw errorWithCode(
          "HISTORY_DB_CORRUPT",
          "Project history metadata is missing",
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        meta = db
          .prepare("SELECT * FROM project_meta WHERE singleton = 1")
          .get() as MetaRow | undefined;
        if (!meta) {
          const now = options.now?.() ?? Date.now();
          db.prepare(
            `INSERT INTO project_meta(
              singleton, project_id, database_id, epoch, revision, created_at_ms, updated_at_ms
            ) VALUES (1, ?, ?, ?, 0, ?, ?)`,
          ).run(options.projectId, randomUUID(), randomUUID(), now, now);
          meta = db
            .prepare("SELECT * FROM project_meta WHERE singleton = 1")
            .get() as MetaRow;
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original initialization failure.
        }
        throw mapSqliteError(error);
      }
    }
    if (meta.project_id !== options.projectId)
      throw errorWithCode(
        "PROJECT_ID_MISMATCH",
        "Project history belongs to a different project ID; copied-project resolution is explicit",
      );
    if (
      options.expectedDatabaseId !== undefined &&
      meta.database_id !== options.expectedDatabaseId
    )
      throw errorWithCode(
        "HISTORY_DB_ID_MISMATCH",
        "Project history database identity changed; reset or copy resolution must be explicit",
      );
    if (
      typeof meta.database_id !== "string" ||
      typeof meta.epoch !== "string" ||
      !Number.isSafeInteger(meta.revision) ||
      meta.revision < 0
    ) {
      throw errorWithCode(
        "HISTORY_DB_CORRUPT",
        "Project history metadata is invalid",
      );
    }
    if (maxPages !== undefined) db.exec(`PRAGMA max_page_count = ${maxPages}`);
    return new SQLiteProjectHistoryStore<TSourceEvent>(
      db,
      options.projectId,
      meta.database_id,
      meta.epoch,
      readPragmaInteger(db, "user_version"),
      readOnly,
      options.now ?? Date.now,
      databasePath,
      statSync(databasePath).dev,
      statSync(databasePath).ino,
    );
  } catch (error) {
    if (db?.isOpen) {
      try {
        db.close();
      } catch {
        // Preserve the original open/migration failure.
      }
    }
    throw mapSqliteError(error);
  }
}

/** Open only an already registered project; known deleted DBs are never recreated. */
export function openRegisteredProjectHistoryStore<
  TSourceEvent extends ProjectHistoryEvent = ProjectHistoryEvent,
>(
  registry: ProjectRegistryStore,
  options: Omit<
    OpenProjectHistoryOptions,
    "initializeIfMissing" | "expectedDatabaseId"
  >,
): ProjectHistoryStore<TSourceEvent> {
  const entry = registry.lookup(options.projectId);
  if (!entry)
    throw errorWithCode(
      "PROJECT_NOT_REGISTERED",
      "Project is not in the explicit project registry",
    );
  const projectRoot = assertSafeProjectRoot(options.projectRoot);
  if (projectRoot !== entry.path)
    throw errorWithCode(
      "PROJECT_PATH_MISMATCH",
      "Project path changed; rename or copied-project resolution must be explicit",
    );
  return openProjectHistoryStore<TSourceEvent>({
    ...options,
    projectRoot: entry.path,
    expectedDatabaseId: entry.databaseId,
    initializeIfMissing: false,
  });
}

/** Explicit first registration. It never changes queue state or project results. */
export function registerProjectHistoryStore<
  TSourceEvent extends ProjectHistoryEvent = ProjectHistoryEvent,
>(
  registry: ProjectRegistryStore,
  options: Omit<OpenProjectHistoryOptions, "expectedDatabaseId">,
): ProjectHistoryStore<TSourceEvent> {
  if (options.readOnly)
    throw errorWithCode(
      "HISTORY_DB_READ_ONLY",
      "A new project history registration requires a writable database",
    );
  const projectRoot = assertSafeProjectRoot(options.projectRoot);
  const store = openProjectHistoryStore<TSourceEvent>({
    ...options,
    projectRoot,
    initializeIfMissing: true,
    initialMonitoring: true,
  });
  try {
    const snapshot = store.snapshot(options.now?.() ?? Date.now());
    registry.register({
      projectId: snapshot.projectId,
      projectPath: projectRoot,
      databaseId: snapshot.databaseId,
      monitoring: snapshot.lifecycle.monitoring,
      archivedAtMs: snapshot.lifecycle.archivedAtMs,
      nowMs: options.now?.() ?? Date.now(),
    });
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}

export function projectHistoryDatabasePath(projectRoot: string): string {
  return join(resolve(projectRoot), ".cad", "control-center", DATABASE_NAME);
}

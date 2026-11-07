/// <reference lib="dom" />

import {
  API_VERSION,
  ConsoleApiError,
  ConsoleQueryClient,
  type ArtifactKind,
  type ArtifactResult,
  type ConsoleOverviewRecord,
  type QueryPage,
  type QueryRequest,
  type QueryScope,
  type Revision,
  type SourceStatus,
} from "./api.js";
import {
  applyTable,
  toggleSort,
  type SortEntry,
  type TableFilter,
} from "./table-model.js";
import { createSelectControls } from "./select-controls.js";
import { correlate, nonemptyId, type ConsoleRow } from "./read-model.js";
import { localeText } from "./locale-runtime.js";
import {
  mountLocaleSelector,
  type LocaleSelectorHandle,
} from "./locale-selector.js";
import type { MessageKey } from "./locale-catalogs.js";

type Collection = QueryRequest["collection"];
type TableName = "tasks" | "agents" | "logs";
type TableRequestOptions = Partial<
  Pick<
    QueryRequest,
    "search" | "filters" | "sort" | "offset" | "limit" | "facetFields"
  >
>;
type Row = Record<string, unknown>;
type View = "overview" | "tasks" | "agents" | "logs";
type AuxiliaryModal = "filter" | "search" | "settings" | "help" | "export";
type LoadState = {
  scope: QueryScope;
  snapshotToken: string | null;
  revision: Revision | null;
  capturedAt: number | null;
  sources: Readonly<Record<string, SourceStatus>> | null;
  chartPage: QueryPage<Row> | null;
  recentLogCount: number | null;
  recentLogsError: string | null;
  pages: Partial<Record<Collection, QueryPage<Row>>>;
  errors: Partial<Record<Collection, string>>;
  stale: boolean;
};
type ModalState =
  | {
      type: "task";
      task: Row;
      projectId: string;
      snapshotToken: string | null;
      revision: Revision | null;
      sources: Readonly<Record<string, SourceStatus>>;
      tab: "details" | "events" | "code" | "response";
      events: readonly Row[] | null;
      eventStatus: string | null;
      artifact: ArtifactResult | null;
      artifactMissingReason: string | null;
      artifactKind: ArtifactKind | null;
      loading: boolean;
      returnLog?: Extract<ModalState, { type: "log" }>;
    }
  | {
      type: "log";
      log: Row;
      projectId: string;
      revision: Revision | null;
      returnTask?: Extract<ModalState, { type: "task" }>;
      returnLog?: Extract<ModalState, { type: "log" }>;
    }
  | {
      type: "agent";
      agent: Row;
      projectId: string;
      revision: Revision | null;
      returnTask?: Extract<ModalState, { type: "task" }>;
    };
type AgentReturn = Extract<ModalState, { type: "agent" }>;

const ICON_PATHS: Readonly<Record<string, string>> = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  pulse: "M2 12h5l3-8 4 16 3-8h5",
  layers: "m12 3 10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5",
  tasks: "M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M15 3a4 4 0 0 1 0 8 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  terminal: "m4 6 5 6-5 6 M13 18h7",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  chevron: "m9 5 7 7-7 7",
  arrow: "M4 12h16 m-6-6 6 6-6 6",
  down: "m6 9 6 6 6-6",
  clock: "M12 8v5l3 2 M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0",
  check: "m5 12 4 4L19 6",
  alert: "m12 3 10 18H2z M12 9v5 M12 17h.01",
  download: "M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5",
  refresh: "M20 7a9 9 0 1 0 1 9 M20 2v5h-5",
  close: "m6 6 12 12 M6 18 18 6",
  pause: "M8 4v16 M16 4v16",
  play: "m7 4 14 8-14 8z",
  folder: "M3 7V4h6l3 3h9v13H3z",
  code: "m8 5-7 7 7 7 M16 5l7 7-7 7 M14 2l-4 20",
  settings:
    "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M9 2h6l1 4 4 1 2 5-3 3v4l-5 3-3-2-4 1-4-4 1-4-2-3 3-5h4z",
  file: "M14 2H4v20h16V8z M14 2v6h6 M8 13h8 M8 17h6",
  menu: "M3 6h18 M3 12h18 M3 18h18",
  copy: "M8 8h13v13H8z M16 8V3H3v13h5",
  filter: "M3 4h18l-7 8v7l-4 2v-9z",
  sort: "M8 4v16 m-4-4 4 4 4-4 M16 20V4 m-4 4 4-4 4 4",
  globe:
    "M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0 M2 12h20 M12 2a18 18 0 0 1 0 20 18 18 0 0 1 0-20",
  server: "M3 3h18v7H3z M3 14h18v7H3z M7 6.5h.01 M7 17.5h.01",
  help: "M9 9a3 3 0 1 1 5 2.2c-2 1-2 2-2 3 M12 17h.01 M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0",
};

const $ = <T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T | null => root.querySelector<T>(selector);
const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const record = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const text = (row: Row, key: string): string | null =>
  typeof row[key] === "string" && row[key] !== "" ? (row[key] as string) : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const telemetryNumber = (row: Row, key: string): number | null => {
  const direct = number(row[key]);
  if (direct !== null) return direct;
  const observation = record(row[key]);
  const availability = text(observation, "availability");
  return availability === "available" || availability === "stale"
    ? number(observation["value"])
    : null;
};
const display = (value: unknown): string =>
  value == null || value === ""
    ? localeText.t("common.notReported")
    : String(value);
const icon = (name: string, cls = ""): string =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON_PATHS[name] ?? ICON_PATHS["file"]}"/></svg>`;
const safeClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const scopeKey = (scope: QueryScope): string =>
  scope.kind === "global" ? "global" : `project:${scope.projectId}`;
const scopeParam = (value: string): QueryScope =>
  value === "global"
    ? { kind: "global" }
    : { kind: "project", projectId: value };
const STATE_MESSAGES: Readonly<Record<string, MessageKey>> = {
  success: "state.success",
  succeeded: "state.success",
  completed: "state.completed",
  unsuccessful: "state.unsuccessful",
  failed: "state.failed",
  running: "state.running",
  processing: "state.processing",
  preparing: "state.preparing",
  sending: "state.sending",
  queued: "state.queued",
  unresolved: "state.unresolved",
  needs_reconciliation: "state.unresolved",
  observed: "state.observed",
  stale: "state.stale",
  unknown: "ui.queue.status.unknown",
  missing: "state.missing",
  "no-data": "common.noData",
  cancelled: "state.cancelled",
  expired: "state.expired",
  paused: "state.paused",
  active: "state.active",
  idle: "state.idle",
  pending: "state.pending",
};
const stateLabel = (state: unknown): string => {
  const raw = String(state ?? "unknown");
  const normalized = raw.toLowerCase();
  const key = STATE_MESSAGES[normalized];
  return key ? localeText.t(key) : raw;
};
const stateTone = (state: unknown): string => {
  const normalized = String(state ?? "unknown").toLowerCase();
  if (["success", "succeeded", "completed"].includes(normalized))
    return "green";
  if (["failed", "unsuccessful"].includes(normalized)) return "red";
  if (["running", "processing", "sending"].includes(normalized)) return "blue";
  if (
    normalized === "observed" ||
    normalized === "active" ||
    normalized === "idle"
  )
    return "green";
  if (
    normalized === "stale" ||
    normalized === "unknown" ||
    normalized === "missing"
  )
    return "amber";
  if (normalized === "preparing") return "purple";
  if (["queued", "pending"].includes(normalized)) return "purple";
  if (["unresolved", "unknown"].includes(normalized)) return "amber";
  return "neutral";
};
const statusBadge = (state: unknown): string =>
  `<span class="badge ${stateTone(state)}"><span class="dot"></span>${esc(stateLabel(state))}</span>`;
const time = (value: unknown): string => {
  if (value == null) return "—";
  const date =
    typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime())
    ? "—"
    : localeText.formatDate(date, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
};
const dateTime = (value: unknown): string => {
  if (value == null) return localeText.t("common.notReported");
  const date =
    typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime())
    ? localeText.t("common.notReported")
    : localeText.formatDate(date);
};
const utcDateTime = (value: unknown): string => {
  const timestamp = number(value);
  if (timestamp === null) return localeText.t("common.notReported");
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? localeText.t("common.notReported")
    : localeText.formatDate(date, {
        timeZone: "UTC",
        dateStyle: "medium",
        timeStyle: "medium",
      });
};
const duration = (value: unknown): string => {
  const ms = number(value);
  if (ms === null) return "—";
  return localeText.formatDuration(ms);
};
const knownTotal = (page: QueryPage<Row> | null | undefined): number | null =>
  !page ||
  page.source.state === "unavailable" ||
  page.source.state === "no-data"
    ? null
    : page.total;
const projectName = (project: Row): string =>
  text(project, "name") ??
  text(project, "displayName") ??
  localeText.t("ui.project.unnamed");
const projectId = (project: Row): string | null =>
  text(project, "id") ?? text(project, "projectId");
const projectColor = (project: Row): string => {
  const color = text(project, "color");
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : "#b4a1ff";
};
const rowTaskId = (row: Row): string | null =>
  text(row, "id") ?? text(row, "taskId");
const artifactSlot = (kind: ArtifactKind): string =>
  ({
    "original-source": "originalSource",
    "sent-source": "sentSource",
    "current-file": "currentFile",
    response: "response",
    stdout: "stdout",
    stderr: "stderr",
    rpc: "rpc",
    event: "events",
  })[kind];
const outputChannels = [
  ["stdout", "stdout.txt"],
  ["stderr", "stderr.txt"],
  ["rpc", "rpc-result.json"],
] as const satisfies readonly (readonly [ArtifactKind, string])[];
const outputProvenance = new Set([
  "retained-owned-result",
  "retained-project-file",
  "retained-artifact-store",
]);
const isOutputKind = (
  kind: ArtifactKind | null,
): kind is "stdout" | "stderr" | "rpc" =>
  kind === "stdout" || kind === "stderr" || kind === "rpc";
const validOutputChannel = (value: Row): boolean =>
  value["state"] === "available" &&
  nonemptyId(value["artifactId"]) &&
  typeof value["sourceHash"] === "string" &&
  /^[a-f0-9]{64}$/u.test(value["sourceHash"]) &&
  typeof value["provenance"] === "string" &&
  outputProvenance.has(value["provenance"]);
const statusSourceText = (source: {
  readonly state?: string;
  readonly reason?: string;
  readonly source?: string;
}): string => {
  const state = source.state ?? "unavailable";
  const reason = source.reason;
  const name = source.source;
  if (state === "available")
    return name
      ? localeText.t("ui.source.availableWithName", { source: name })
      : localeText.t("ui.source.available");
  const key =
    state === "partial"
      ? "ui.source.partial"
      : state === "stale"
        ? "ui.source.stale"
        : state === "no-data"
          ? "ui.source.noData"
          : "ui.source.unavailable";
  const detail = reason ?? name;
  return `${localeText.t(key)}${detail ? ` · ${detail}` : ""}`;
};

export interface ControlCenterOptions {
  readonly origin?: string;
  readonly client?: ConsoleQueryClient;
  readonly refreshIntervalMs?: number;
}

export class ControlCenterApp {
  readonly #api: ConsoleQueryClient;
  readonly #root: HTMLElement;
  readonly #selects = createSelectControls();
  readonly #listeners = new AbortController();
  #localeSelector: LocaleSelectorHandle | null = null;
  #unsubscribeLocale: (() => void) | null = null;
  #started = false;
  #localeRenderQueued = false;
  #scope: QueryScope = { kind: "global" };
  #view: View = "overview";
  #visible: LoadState | null = null;
  #latest: LoadState | null = null;
  #projects: readonly Row[] = [];
  #projectTotal: number | null = null;
  #modal: ModalState | null = null;
  #modalReturnFocus: HTMLElement | null = null;
  #source: EventSource | null = null;
  #refreshTimer: number | null = null;
  #loadGeneration = 0;
  #refreshInterval: number;
  #frozen = false;
  #follow = true;
  #mobile = false;
  #taskRange: "all" | "open" | "history" = "all";
  #agentRange: "all" | "confirmed" | "history" = "all";
  #logLevel = "all";
  #search = "";
  #page = 1;
  #sorts: Record<TableName, SortEntry[]> = { tasks: [], agents: [], logs: [] };
  #filters: Record<TableName, Record<string, TableFilter>> = {
    tasks: {},
    agents: {},
    logs: {},
  };
  #notice = "";
  #logSource = "all";
  #showHeartbeat = false;
  #artifactLoadSerial = 0;
  #searchTimer: number | null = null;
  #globalSearchSerial = 0;
  #querySerial: Partial<Record<Collection, number>> = {};
  #filterColumn: string | null = null;
  #filterTable: TableName = "tasks";
  #filterOptions: readonly {
    value: string | null;
    count: number;
    label: string;
  }[] = [];
  #filterChosen = new Set<string | null>();
  #filterSearch = "";
  #auxiliaryModal: AuxiliaryModal | null = null;
  #exportCollection: Collection | null = null;
  #returnAgent: AgentReturn | null = null;

  constructor(root: HTMLElement, options: ControlCenterOptions = {}) {
    this.#root = root;
    const origin = options.origin ?? window.location.origin;
    this.#api = options.client ?? new ConsoleQueryClient(origin);
    this.#refreshInterval =
      options.refreshIntervalMs ?? this.#readRefreshInterval();
    const signal = this.#listeners.signal;
    document.addEventListener("click", (event) => this.#onClick(event), {
      signal,
    });
    document.addEventListener("input", (event) => this.#onInput(event), {
      signal,
    });
    document.addEventListener("change", (event) => this.#onChange(event), {
      signal,
    });
    document.addEventListener("keydown", (event) => this.#onKeyDown(event), {
      signal,
    });
    this.#unsubscribeLocale = localeText.subscribe(() => {
      this.#syncDocumentLocale();
      if (!this.#started || this.#localeRenderQueued) return;
      this.#localeRenderQueued = true;
      queueMicrotask(() => {
        this.#localeRenderQueued = false;
        if (this.#listeners.signal.aborted) return;
        this.#render();
        this.#renderLocaleOverlay();
      });
    });
    void this.start();
  }

  async start(): Promise<void> {
    this.#started = true;
    this.#syncDocumentLocale();
    this.#render();
    await this.#load(this.#scope, false);
    this.#watch();
  }

  dispose(): void {
    this.#listeners.abort();
    this.#loadGeneration += 1;
    this.#unsubscribeLocale?.();
    this.#unsubscribeLocale = null;
    this.#localeSelector?.dispose();
    this.#localeSelector = null;
    this.#selects.dispose();
    this.#source?.close();
    this.#source = null;
    if (this.#refreshTimer !== null) window.clearTimeout(this.#refreshTimer);
    if (this.#searchTimer !== null) window.clearTimeout(this.#searchTimer);
    this.#root.inert = false;
    this.#root.innerHTML = "";
    document.getElementById("overlay-root")?.replaceChildren();
  }

  #syncDocumentLocale(): void {
    document.documentElement.lang = localeText.locale;
    document.title = `fmcad — ${localeText.t("app.title")}`;
    const description = $("meta[name=description]") as HTMLMetaElement | null;
    if (description) description.content = localeText.t("ui.meta.description");
    const skipLink = $(".skip-link");
    if (skipLink) skipLink.textContent = localeText.t("ui.skipLink");
  }

  async #load(scope: QueryScope, background: boolean): Promise<void> {
    const generation = ++this.#loadGeneration;
    const next: LoadState = {
      scope,
      snapshotToken: null,
      revision: null,
      capturedAt: null,
      sources: null,
      chartPage: null,
      recentLogCount: null,
      recentLogsError: null,
      pages: {},
      errors: {},
      stale: false,
    };
    try {
      const snapshot = await this.#api.snapshot(scope);
      next.snapshotToken = snapshot.snapshotToken;
      next.revision = snapshot.revision;
      next.capturedAt = snapshot.capturedAt;
      next.sources = snapshot.sources;
    } catch (error) {
      next.errors["overview"] = this.#error(error);
      next.stale =
        this.#visible !== null &&
        scopeKey(this.#visible.scope) === scopeKey(scope);
      if (
        next.stale &&
        this.#visible &&
        scopeKey(this.#visible.scope) === scopeKey(scope)
      ) {
        next.snapshotToken = this.#visible.snapshotToken;
        next.revision = this.#visible.revision;
        next.capturedAt = this.#visible.capturedAt;
        next.sources = this.#visible.sources;
        next.chartPage = this.#visible.chartPage;
        next.recentLogCount = this.#visible.recentLogCount;
        next.recentLogsError = this.#visible.recentLogsError;
        next.pages = { ...this.#visible.pages };
        next.errors = { ...this.#visible.errors, ...next.errors };
      }
    }

    const token = next.snapshotToken;
    if (scope.kind === "global" && token) {
      await this.#query(next, "projects", { limit: 200 });
      if (next.pages.projects) {
        this.#projects = next.pages.projects.rows;
        this.#projectTotal = knownTotal(next.pages.projects);
      }
    } else if (this.#projects.length === 0) {
      await this.#loadProjects();
    }

    if (token) {
      await Promise.all([
        this.#query(next, "overview", { limit: 1 }),
        this.#query(next, "tasks", this.#tableOptions("tasks")),
        this.#query(next, "logs", this.#tableOptions("logs")),
        this.#query(next, "agents", this.#tableOptions("agents")),
        this.#query(next, "system", { limit: 1 }),
        this.#loadChartRows(next, next.capturedAt ?? Date.now()),
      ]);
      await this.#loadRecentLogs(next, next.capturedAt ?? Date.now());
    }

    if (generation !== this.#loadGeneration) return;

    this.#latest = next;
    const scopeChanged =
      this.#visible && scopeKey(this.#visible.scope) !== scopeKey(scope);
    if (!this.#frozen || (!background && scopeChanged)) this.#visible = next;
    if (this.#frozen) this.#notice = localeText.t("ui.freeze.banner");
    this.#render();
    this.#renderModal();
  }

  async #loadProjects(): Promise<void> {
    try {
      const globalSnapshot = await this.#api.snapshot({ kind: "global" });
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope: { kind: "global" },
        collection: "projects",
        snapshotToken: globalSnapshot.snapshotToken,
        limit: 200,
      });
      this.#projects = page.rows;
      this.#projectTotal = knownTotal(page);
    } catch {
      // Project navigation is explicitly unavailable until the global query succeeds.
    }
  }

  async #query(
    target: LoadState,
    collection: Collection,
    options: Partial<
      Pick<
        QueryRequest,
        "search" | "filters" | "sort" | "offset" | "limit" | "facetFields"
      >
    > = {},
  ): Promise<void> {
    if (!target.snapshotToken) return;
    const request: QueryRequest = {
      version: API_VERSION,
      scope: target.scope,
      collection,
      snapshotToken: target.snapshotToken,
      ...options,
    };
    const serial = (this.#querySerial[collection] ?? 0) + 1;
    this.#querySerial[collection] = serial;
    try {
      const page = await this.#api.query<Row>(request);
      if (this.#querySerial[collection] !== serial) return;
      target.pages[collection] = page;
      delete target.errors[collection];
    } catch (error) {
      if (this.#querySerial[collection] !== serial) return;
      target.errors[collection] = this.#error(error);
    }
  }

  async #loadChartRows(target: LoadState, capturedAt: number): Promise<void> {
    if (!target.snapshotToken) return;
    try {
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope: target.scope,
        collection: "tasks",
        snapshotToken: target.snapshotToken,
        filters: {
          state: {
            any: [
              "success",
              "succeeded",
              "completed",
              "failed",
              "unsuccessful",
              "cancelled",
              "expired",
            ],
          },
          finishedAt: { min: capturedAt - 60 * 60 * 1000, max: capturedAt },
        },
        facetFields: ["state"],
        aggregateFields: ["waitMs", "executionMs"],
        sort: [{ field: "finishedAt", direction: "desc" }],
        offset: 0,
        limit: 18,
      });
      target.chartPage = page;
    } catch (error) {
      target.errors["overview"] = this.#error(error);
    }
  }

  async #loadRecentLogs(target: LoadState, capturedAt: number): Promise<void> {
    if (!target.snapshotToken) return;
    const logsPage = target.pages.logs;
    if (!logsPage) {
      target.recentLogCount = null;
      target.recentLogsError =
        target.errors.logs ?? localeText.t("ui.logs.empty.unavailable");
      return;
    }
    if (logsPage.source.state === "no-data") {
      target.recentLogCount = null;
      target.recentLogsError = statusSourceText(logsPage.source);
      return;
    }
    const timeSample = logsPage?.rows.find((row) => row["timestamp"] != null)?.[
      "timestamp"
    ];
    if (typeof timeSample !== "number" || !Number.isFinite(timeSample)) {
      target.recentLogCount = null;
      target.recentLogsError =
        "Brak numerycznego timestampMs do pomiaru okna 60 s.";
      return;
    }
    try {
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope: target.scope,
        collection: "logs",
        snapshotToken: target.snapshotToken,
        filters: { timestamp: { min: capturedAt - 60_000, max: capturedAt } },
        limit: 1,
      });
      target.recentLogCount =
        page.source.state === "available" ? page.total : null;
      if (page.source.state !== "available")
        target.recentLogsError = statusSourceText(page.source);
    } catch (error) {
      target.recentLogsError = this.#error(error);
    }
  }

  #watch(): void {
    const revision = this.#latest?.revision ?? null;
    this.#source?.close();
    try {
      this.#source = this.#api.watch(
        this.#scope,
        revision,
        (event) => {
          const relevant =
            event.scope.kind === "global" ||
            (this.#scope.kind === "project" &&
              event.scope.kind === "project" &&
              event.scope.projectId === this.#scope.projectId);
          if (!relevant && !event.resyncRequired) return;
          const sameScope =
            event.scope.kind === this.#scope.kind &&
            (event.scope.kind === "global" ||
              (this.#scope.kind === "project" &&
                event.scope.projectId === this.#scope.projectId));
          if (
            sameScope &&
            this.#latest?.revision &&
            (event.revision.epoch !== this.#latest.revision.epoch ||
              event.revision.revision > this.#latest.revision.revision + 1)
          ) {
            event = { ...event, resyncRequired: true };
          }
          this.#scheduleRefresh();
        },
        () => {
          if (this.#visible) {
            this.#visible = { ...this.#visible, stale: true };
            this.#render();
          }
          this.#scheduleRefresh();
        },
      );
    } catch {
      this.#source = null;
      if (this.#visible) {
        this.#visible = { ...this.#visible, stale: true };
        this.#render();
      }
    }
  }

  #scheduleRefresh(): void {
    if (this.#refreshTimer !== null) return;
    this.#refreshTimer = window.setTimeout(() => {
      this.#refreshTimer = null;
      void this.#load(this.#scope, true).then(() => this.#watch());
    }, this.#refreshInterval);
  }

  #error(error: unknown): string {
    if (error instanceof ConsoleApiError) return error.message;
    return localeText.t("ui.error.localApiRead");
  }

  #state(): LoadState | null {
    return this.#frozen ? this.#visible : (this.#latest ?? this.#visible);
  }

  #isStale(state: LoadState | null): boolean {
    return Boolean(
      state?.stale ||
      Object.values(state?.sources ?? {}).some(
        (source) => source.state === "stale",
      ) ||
      Object.values(state?.pages ?? {}).some(
        (page) => page.source.state === "stale",
      ),
    );
  }

  #queryForTable(): void {
    const state = this.#latest;
    if (!state?.snapshotToken || this.#frozen) return;
    const collection: TableName =
      this.#view === "logs"
        ? "logs"
        : this.#view === "agents"
          ? "agents"
          : "tasks";
    const options = this.#tableOptions(collection);
    void this.#query(state, collection, options).then(() => {
      if (this.#latest !== state) return;
      if (!this.#frozen) this.#visible = state;
      this.#latest = state;
      this.#render();
    });
  }

  #tableOptions(collection: TableName): TableRequestOptions {
    const limit =
      collection === "tasks" ? 12 : collection === "agents" ? 8 : 150;
    const filters: NonNullable<QueryRequest["filters"]> = {};
    for (const [key, value] of Object.entries(this.#filters[collection])) {
      if (value.type === "text") {
        if (value.query.trim()) filters[key] = { contains: value.query.trim() };
      } else if (value.type === "number") {
        const filter: { min?: number; max?: number; includeMissing?: boolean } =
          {};
        if (value.min !== "" && value.min != null) filter.min = value.min;
        if (value.max !== "" && value.max != null) filter.max = value.max;
        if (value.includeUnknown) filter.includeMissing = true;
        filters[key] = filter;
      } else {
        const selected = value.values
          .filter((item): item is string | number => item != null)
          .map(String);
        filters[key] = {
          any: selected,
          includeMissing: value.values.includes(null),
        };
      }
    }
    if (collection === "tasks" && this.#taskRange !== "all") {
      const rangeStates =
        this.#taskRange === "open"
          ? [
              "queued",
              "preparing",
              "sending",
              "processing",
              "running",
              "unresolved",
            ]
          : [
              "success",
              "succeeded",
              "completed",
              "failed",
              "unsuccessful",
              "cancelled",
              "expired",
            ];
      const current = filters["state"];
      const selected =
        current &&
        typeof current === "object" &&
        "any" in current &&
        Array.isArray(current.any)
          ? rangeStates.filter((state) => current.any?.includes(state))
          : rangeStates;
      filters["state"] = { any: selected };
    }
    if (collection === "agents" && this.#agentRange !== "all") {
      filters["presence"] = {
        any:
          this.#agentRange === "confirmed"
            ? ["observed", "active", "idle"]
            : ["stale", "unknown", "missing", "history"],
      };
    }
    if (collection === "logs" && this.#logLevel !== "all")
      filters["level"] = this.#logLevel;
    if (collection === "logs" && this.#logSource !== "all")
      filters["source"] = this.#logSource;
    const serverSort = this.#sorts[collection].map((item) => ({
      field: item.key,
      direction: item.dir,
    }));
    const query: Partial<
      Pick<
        QueryRequest,
        "search" | "filters" | "sort" | "offset" | "limit" | "facetFields"
      >
    > = {
      offset:
        collection === "tasks" || collection === "agents"
          ? (this.#page - 1) * limit
          : 0,
      limit,
      facetFields:
        collection === "tasks"
          ? ["state", "clientId", "projectId"]
          : collection === "agents"
            ? ["presence", "kind"]
            : ["level", "source"],
    };
    if (this.#search) query.search = this.#search;
    if (Object.keys(filters).length) query.filters = filters;
    if (serverSort.length) query.sort = serverSort;
    else if (collection === "tasks")
      query.sort = [{ field: "submittedAt", direction: "desc" }];
    else if (collection === "agents")
      query.sort = [{ field: "lastSeen", direction: "desc" }];
    else if (collection === "logs")
      query.sort = [{ field: "timestamp", direction: "desc" }];
    return query;
  }

  #readRefreshInterval(): number {
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem("fmcad-prefs") ?? "null",
      );
      const interval = record(saved)["refreshIntervalMs"];
      return [2000, 4000, 8000].includes(Number(interval))
        ? Number(interval)
        : 4000;
    } catch {
      return 4000;
    }
  }

  #render(): void {
    if (this.#listeners.signal.aborted) return;
    this.#selects.close(false);
    const state = this.#state();
    const active = document.activeElement as HTMLElement | null;
    const restoreLocaleFocus = Boolean(active?.closest(".locale-selector"));
    const focusId = active?.id;
    const selectionStart =
      active instanceof HTMLInputElement ? active.selectionStart : null;
    const selectionEnd =
      active instanceof HTMLInputElement ? active.selectionEnd : null;
    const activeAction = active?.dataset["action"];
    const activeDataId = active?.dataset["id"];
    const activeDataProject = active?.dataset["project"];
    const scroll = window.scrollY;
    const logScroll = $("#log-stream")?.scrollTop ?? 0;
    const selectedProjectId =
      this.#scope.kind === "project" ? this.#scope.projectId : null;
    const project = selectedProjectId
      ? this.#projects.find((item) => projectId(item) === selectedProjectId)
      : null;
    const sources = [
      ...Object.values(state?.sources ?? {}),
      ...Object.values(state?.pages ?? {}).map((page) => page.source),
      ...(state?.chartPage ? [state.chartPage.source] : []),
    ];
    const stale = this.#isStale(state);
    const messages = [
      ...Object.entries(state?.errors ?? {}).map(
        ([collection, message]) => `${collection}: ${message}`,
      ),
      ...sources
        .filter((source) => source.state !== "available")
        .map(statusSourceText),
    ];
    const issue =
      stale || messages.length
        ? `<div class="notice info" role="status">${icon(stale ? "alert" : "info")}<div><strong>${localeText.t(stale ? "ui.notice.stale.title" : "ui.notice.source.title")}</strong><p>${esc(stale ? localeText.t("ui.notice.lastRead", { details: messages.join(" · ") || localeText.t("ui.notice.connectionUnavailable") }) : messages.join(" · "))}</p></div></div>`
        : "";
    this.#localeSelector?.dispose();
    this.#localeSelector = null;
    this.#root.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar ${this.#mobile ? "open" : ""}">
          <a class="brand" href="#main" data-action="view" data-view="overview" aria-label="${localeText.t("ui.brand.aria")}">
            <div class="brand-mark"><span class="brand-symbol" aria-hidden="true"><span class="brand-face brand-top"></span><span class="brand-face brand-left"></span><span class="brand-face brand-right"></span></span></div>
            <div class="brand-name">fmcad<span>CONTROL CENTER</span></div>
          </a>
          <div class="workspace"><span class="workspace-icon">${icon("server")}</span><div><strong>${localeText.t("ui.workspace.local")}</strong><small>${selectedProjectId === null ? localeText.t("scope.global") : esc(project ? projectName(project) : selectedProjectId)}</small></div><span class="dot ${state?.snapshotToken && !this.#isStale(state) ? "good" : "warn"}" style="margin-left:auto"></span></div>
          <div class="section-label">${localeText.t("ui.workspace.section.projects").toLocaleUpperCase(localeText.locale)}</div>
          <nav aria-label="${localeText.t("nav.projects")}">
            <button class="project-nav ${this.#scope.kind === "global" ? "active" : ""}" data-action="scope" data-id="global">${icon("globe", "small")}<span class="project-name">${localeText.t("scope.global")}</span>${this.#projectTotal === null ? "" : `<span class="mini-count">${localeText.formatNumber(this.#projectTotal)}</span>`}</button>
            ${
              this.#projects
                .map((item) => {
                  const id = projectId(item);
                  if (!id) return "";
                  const pending = number(item["pending"]);
                  return `<button class="project-nav ${this.#scope.kind === "project" && this.#scope.projectId === id ? "active" : ""}" data-action="scope" data-id="${esc(id)}"><span class="project-dot" style="--project-color:${projectColor(item)}"></span><span class="project-name">${esc(projectName(item))}</span>${pending !== null && pending > 0 ? `<span class="mini-count">${localeText.formatNumber(pending)}</span>` : ""}</button>`;
                })
                .join("") ||
              `<p class="project-list-description" role="status">${esc(state?.errors.projects ?? (state?.pages.projects ? statusSourceText(state.pages.projects.source) : localeText.t("ui.workspace.error.projectsUnavailable")))}</p>`
            }
          </nav>
          <div class="sidebar-bottom"><div class="source-card"><div class="row"><span class="dot ${state?.snapshotToken && !stale ? "good" : "warn"}"></span><strong>${stale ? localeText.t("ui.workspace.status.stale") : state?.snapshotToken ? localeText.t("ui.workspace.status.ready") : localeText.t("ui.workspace.status.waiting")}</strong></div><p>${state?.revision ? `Snapshot ${esc(state.revision.epoch)}:${localeText.formatNumber(state.revision.revision)}` : localeText.t("ui.workspace.read.notReady")} ${localeText.t("ui.workspace.notSimulated")}</p></div>
          <button class="nav-button" data-action="settings">${icon("settings")}${localeText.t("common.settings")}</button><button class="nav-button" data-action="help">${icon("help")}${localeText.t("common.help")}<span class="count">?</span></button>
           <div class="account"><div class="avatar">FC</div><div><strong>${localeText.t("app.title")}</strong><small>fmcad console · web edition</small></div></div></div>
        </aside>
          <button class="mobile-scrim" data-action="mobile" aria-label="${localeText.t("common.close")}"></button>
        <div class="main-shell">
          <header class="topbar"><div class="row"><button class="icon-button mobile-menu" data-action="mobile" aria-label="${localeText.t("common.openMenu")}">${icon("menu")}</button><div class="breadcrumb"><span class="breadcrumb-root">${localeText.t("scope.project")}</span><span class="breadcrumb-root">/</span>${this.#scope.kind === "global" ? localeText.t("scope.global") : esc(project ? projectName(project) : this.#scope.projectId)}</div><label class="scope-picker">${icon("globe", "small")}<select aria-label="${localeText.t("ui.scope.project.aria")}" data-action="scope-select"><option value="global" ${this.#scope.kind === "global" ? "selected" : ""}>${localeText.t("scope.global")}</option>${this.#projects
            .map((item) => {
              const id = projectId(item);
              return id
                ? `<option value="${esc(id)}" ${this.#scope.kind === "project" && this.#scope.projectId === id ? "selected" : ""}>${esc(projectName(item))}</option>`
                : "";
            })
            .join(
              "",
            )}</select></label></div><div class="top-actions"><span class="simulation-label"><span class="dot ${this.#isStale(state) ? "warn" : "good"}"></span>${this.#isStale(state) ? localeText.t("state.stale").toLocaleUpperCase(localeText.locale) : state?.snapshotToken ? localeText.t("ui.workspace.status.connected") : localeText.t("ui.workspace.status.waitingUpper")}</span><span class="top-divider"></span><button class="icon-button" data-action="global-search" aria-label="${localeText.t("ui.search.global.aria")}" title="${localeText.t("ui.search.global.title")}">${icon("search")}</button><button class="icon-button" data-action="settings" aria-label="${localeText.t("common.settings")}">${icon("settings")}</button><button class="icon-button" data-action="help" aria-label="${localeText.t("common.help")}">${icon("help")}</button><div id="locale-selector"></div></div></header>
          <main id="main" class="content">
            <div class="page-heading"><div><div class="eyebrow">${this.#scope.kind === "global" ? localeText.t("ui.page.eyebrow.global") : localeText.t("ui.page.eyebrow.project")}</div><h1>${this.#view === "overview" ? (this.#scope.kind === "global" ? localeText.t("ui.page.overview.global.title") : esc(project ? projectName(project) : localeText.t("ui.page.overview.project.title"))) : this.#view === "tasks" ? localeText.t("ui.page.tasks.title") : this.#view === "agents" ? localeText.t("ui.page.agents.title") : localeText.t("ui.page.logs.title")}</h1><p class="page-description">${this.#view === "overview" ? (this.#scope.kind === "global" ? localeText.t("ui.page.overview.global.description") : localeText.t("ui.page.overview.project.description")) : this.#view === "tasks" ? localeText.t("ui.page.tasks.description") : this.#view === "agents" ? localeText.t("ui.page.agents.description") : localeText.t("ui.page.logs.description")}</p></div><div class="heading-actions"><button class="btn" data-action="export" data-collection="${this.#activeCollection()}" aria-label="${localeText.t("ui.action.exportData")}">${icon("download", "small")}<span>${localeText.t("common.export")}</span></button>${this.#returnAgent ? `<button class="btn" data-action="back-agent">${localeText.t("ui.action.backAgent")}</button>` : ""}<button class="btn ${this.#frozen ? "primary" : ""}" data-action="freeze" aria-label="${localeText.t(this.#frozen ? "common.resume" : "common.freeze")}">${icon(this.#frozen ? "play" : "pause", "small")}<span>${localeText.t(this.#frozen ? "common.resume" : "common.freeze")}</span></button><button class="btn primary" data-action="refresh" aria-label="${localeText.t("ui.action.refreshView")}">${icon("refresh", "small")}<span>${localeText.t("common.refresh")}</span></button></div></div>
            <div class="tabs" role="tablist" aria-label="${localeText.t("ui.tabs.aria")}">${this.#tab("overview", "grid", localeText.t("nav.overview"))}${this.#tab("tasks", "layers", localeText.t("nav.tasks"), knownTotal(state?.pages.tasks))}${this.#tab("agents", "users", localeText.t("nav.agents"), knownTotal(state?.pages.agents))}${this.#tab("logs", "terminal", localeText.t("nav.logs"), knownTotal(state?.pages.logs))}<span class="tab-end">${icon("clock", "small")}<span>${state?.revision ? localeText.t("ui.tabs.refreshRate", { seconds: this.#refreshInterval / 1000, revision: state.revision.revision }) : localeText.t("ui.tabs.waitingRefreshRate", { seconds: this.#refreshInterval / 1000 })}</span></span></div>
            ${issue}${this.#frozen ? `<div class="freeze-banner">${icon("pause", "small")}${localeText.t("ui.freeze.banner")}<span>${esc(this.#notice)}</span><button data-action="freeze">${localeText.t("common.resume")} ${icon("play", "small")}</button></div>` : ""}
            <div class="tab-content">${this.#view === "overview" ? this.#overview(state) : this.#view === "tasks" ? this.#tasksView(state) : this.#view === "logs" ? this.#logsView(state) : this.#agentsView(state)}</div>
            <footer class="page-footer"><span>${icon("server", "small")} ${localeText.t("ui.footer.source")}</span><span><kbd>1–4</kbd> ${localeText.t("nav.overview")} <kbd>/</kbd> ${localeText.t("common.search")} <kbd>␠</kbd> ${localeText.t("common.freeze")}</span></footer>
          </main>
        </div>
      </div>`;
    this.#selects.upgrade(this.#root);
    const localeHost = $("#locale-selector", this.#root);
    if (localeHost) {
      this.#localeSelector = mountLocaleSelector(localeHost, localeText);
      if (restoreLocaleFocus) this.#localeSelector.focus();
    }
    if (focusId) {
      const next = $<HTMLInputElement>(`#${CSS.escape(focusId)}`, this.#root);
      if (next) {
        next.focus({ preventScroll: true });
        if (selectionStart !== null && selectionStart !== undefined) {
          try {
            next.setSelectionRange(
              selectionStart,
              selectionEnd ?? selectionStart,
            );
          } catch {
            /* not a text input */
          }
        }
      }
    } else if (activeAction) {
      const next = [
        ...this.#root.querySelectorAll<HTMLElement>("[data-action]"),
      ].find(
        (element) =>
          element.dataset["action"] === activeAction &&
          element.dataset["id"] === activeDataId &&
          element.dataset["project"] === activeDataProject,
      );
      next?.focus({ preventScroll: true });
    }
    const nextLogStream = $("#log-stream");
    if (nextLogStream) nextLogStream.scrollTop = this.#follow ? 0 : logScroll;
    window.scrollTo(0, scroll);
  }

  #tab(
    view: View,
    image: string,
    label: string,
    count?: number | null,
  ): string {
    return `<button class="tab ${this.#view === view ? "active" : ""}" role="tab" aria-selected="${this.#view === view}" data-action="view" data-view="${view}">${icon(image, "small")}${label}${count != null ? `<span class="tab-count">${count}</span>` : ""}</button>`;
  }

  #activeCollection(): TableName {
    return this.#view === "logs"
      ? "logs"
      : this.#view === "agents"
        ? "agents"
        : "tasks";
  }

  #overview(state: LoadState | null): string {
    const page = state?.pages.overview;
    const overview = page?.rows[0] as ConsoleOverviewRecord | undefined;
    const chartPage = state?.chartPage;
    const samples = chartPage?.rows ?? [];
    const plotted = [...samples].reverse();
    const values = plotted
      .map((row) => number(row["executionMs"]))
      .filter((value): value is number => value !== null);
    const max = Math.max(5000, Math.ceil(Math.max(...values, 0) / 5000) * 5000);
    const chartWidth = 590;
    const plotWidth = 545;
    const chartHeight = 99;
    const barWidth = (plotWidth - 15) / Math.max(plotted.length, 1);
    const ticks = [0, 0.5, 1];
    const chart = plotted.length
      ? `<svg class="duration-chart" viewBox="0 0 ${chartWidth} 137" role="img" aria-label="${localeText.t("ui.chart.recentExecutions", { count: plotted.length })}">${ticks
          .map((fraction) => {
            const y = 12 + chartHeight * (1 - fraction);
            return `<line class="grid" x1="37" y1="${y}" x2="583" y2="${y}"/><text x="0" y="${y + 3}">${localeText.formatNumber((max * fraction) / 1000, { maximumFractionDigits: 0 })} s</text>`;
          })
          .join("")}${plotted
          .map((row, index) => {
            const value = number(row["executionMs"]);
            if (value === null) return "";
            const height = Math.max(3, (chartHeight * value) / max);
            const failed = [
              "failed",
              "unsuccessful",
              "cancelled",
              "expired",
            ].includes(String(row["state"]));
            return `<rect class="bar ${failed ? "failed" : ""}" x="${43 + index * barWidth}" y="${12 + chartHeight - height}" width="${Math.max(6, barWidth - 11)}" height="${height}" rx="3"><title>${esc(text(row, "label") ?? localeText.t("ui.chart.executionTimes"))} · ${esc(duration(value))}</title></rect>`;
          })
          .join(
            "",
          )}<text x="39" y="132">${localeText.t("ui.chart.older")}</text><text x="532" y="132">${localeText.t("ui.chart.newest")}</text></svg>`
      : `<div class="empty-state">${icon("pulse")}<strong>${localeText.t("ui.chart.noCompletedExecutions")}</strong><span>${localeText.t("ui.chart.willAppear")}</span></div>`;
    const queue = overview?.pendingProject ?? null;
    const running = overview?.running ?? null;
    const failed = overview?.failedExecutions ?? null;
    const medianWait = overview?.waitMedianMs ?? null;
    const p95Wait = overview?.waitP95Ms ?? null;
    const sessions = overview?.liveReportingSessions ?? null;
    const samplesCount = knownTotal(chartPage);
    const waitValue =
      medianWait === null
        ? null
        : medianWait < 1000
          ? medianWait
          : medianWait / 1000;
    const waitUnit = medianWait === null ? "" : medianWait < 1000 ? "ms" : "s";
    const metric = (
      label: string,
      value: number | null,
      unit: string,
      detail: string,
      image: string,
      tone = "",
    ) =>
      `<article class="metric"><div class="metric-top"><span>${label}</span>${icon(image)}</div><div class="metric-value ${tone}">${value === null ? "—" : localeText.formatNumber(value, { maximumFractionDigits: 1 })}<small>${unit}</small></div><div class="metric-bottom">${detail}</div></article>`;
    const sessionDetail =
      sessions === null
        ? localeText.t("ui.metric.telemetryUnavailable")
        : localeText.t("ui.metric.confirmedPresence");
    return `<section class="metrics" aria-label="${localeText.t("ui.metric.aria")}">${metric(localeText.t("ui.metric.queue"), queue, "", running === null ? localeText.t("ui.metric.noRunningData") : localeText.t("ui.queue.processing", { count: running }), "layers", "purple")}${metric(localeText.t("ui.metric.executionsHour"), samplesCount, "", failed === null ? localeText.t("ui.metric.noFailureCounter") : localeText.t("ui.metric.failedExecutions", { count: failed }), "check", failed ? "warn" : "")}${metric(localeText.t("ui.metric.medianWait"), waitValue, waitUnit, localeText.t("ui.metric.p95", { duration: duration(p95Wait) }), "clock")}${metric(localeText.t("ui.metric.confirmedSessions"), sessions, "", sessionDetail, "users")}</section>
       <div class="analytics-grid"><section class="panel"><div class="panel-head"><div><h2>${localeText.t("ui.chart.executionTimes")}</h2><p class="panel-subtitle">${localeText.t("ui.chart.lastCalls", { count: plotted.length })}</p></div><div class="legend"><span><span class="dot purple"></span>${localeText.t("ui.chart.success")}</span><span><span class="dot warn"></span>${localeText.t("ui.chart.unsuccessful")}</span></div></div><div class="chart-body">${chart}</div><div class="chart-foot"><span>${localeText.t("ui.chart.median")} <strong>${duration(chartPage?.aggregates["executionMs"]?.median ?? null)}</strong></span><span>${localeText.t("ui.chart.fullCallDuration")} ${icon("help", "small")}</span></div></section>${this.#queuePanel(overview)}</div>
      ${this.#taskTable(state, true)}
      ${this.#systemStrip(state)}
      ${this.#recentLogs(state)}`;
  }

  #systemStrip(state: LoadState | null): string {
    const page = state?.pages.system;
    const row = record(page?.rows[0]);
    const telemetry = record(row["data"]);
    const host = record(
      row["host"] ??
        row["hostMetrics"] ??
        telemetry["host"] ??
        telemetry ??
        row,
    );
    if (!Object.keys(host).length) return "";
    const cpu = telemetryNumber(host, "cpuPercent");
    const memoryUsed =
      telemetryNumber(host, "memoryUsedGiB") ??
      (() => {
        const bytes = telemetryNumber(host, "ramUsedBytes");
        return bytes === null ? null : bytes / 1024 ** 3;
      })();
    const memoryTotal =
      telemetryNumber(host, "memoryTotalGiB") ??
      (() => {
        const bytes = telemetryNumber(host, "ramTotalBytes");
        return bytes === null ? null : bytes / 1024 ** 3;
      })();
    const uptime =
      telemetryNumber(host, "uptimeHours") ??
      (() => {
        const seconds = telemetryNumber(host, "uptimeSeconds");
        return seconds === null ? null : seconds / 3600;
      })();
    return `<section class="system-strip"><div class="system-strip-title">${icon("server", "small")}Host lokalny</div><div class="strip-metric">CPU <b>${cpu === null ? "—" : `${cpu.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`}</b><div class="mini-track"><span style="width:${cpu === null ? 0 : Math.max(0, Math.min(100, cpu))}%"></span></div></div><div class="strip-metric">RAM <b>${memoryUsed === null || memoryTotal === null ? "—" : `${memoryUsed.toLocaleString("pl-PL", { maximumFractionDigits: 1 })} / ${memoryTotal.toLocaleString("pl-PL", { maximumFractionDigits: 1 })} GiB`}</b></div><div class="strip-metric">Uptime <b>${uptime === null ? "—" : `${uptime.toLocaleString("pl-PL", { maximumFractionDigits: 1 })} h`}</b></div></section>`;
  }

  #queuePanel(overview: ConsoleOverviewRecord | undefined): string {
    const pending = overview?.pendingProject ?? null;
    const processing = overview?.running ?? null;
    const unresolved = overview?.unresolved ?? null;
    const known =
      pending !== null || processing !== null || unresolved !== null;
    const busy = (pending ?? 0) + (processing ?? 0) > 0;
    return `<section class="panel"><div class="panel-head"><div><h2>${localeText.t("ui.queue.panelTitle")}</h2><p class="panel-subtitle">${localeText.t(this.#scope.kind === "global" ? "ui.queue.scope.global" : "ui.queue.scope.project")}</p></div><span class="badge ${known ? (busy ? "blue" : "green") : "amber"}"><span class="dot"></span>${known ? (busy ? localeText.t("ui.queue.status.running") : localeText.t("ui.queue.status.read")) : localeText.t("ui.queue.status.unknown")}</span></div><div class="queue-body"><div class="queue-orbit ${busy ? "busy" : ""}">${icon(known ? (busy ? "layers" : "check") : "help")}</div><div><h3>${known ? (busy ? localeText.t("ui.queue.heading.running") : localeText.t("ui.queue.heading.read")) : localeText.t("ui.queue.heading.waiting")}</h3><p>${known ? `${pending === null ? "—" : localeText.t("ui.queue.pending", { count: pending })} · ${processing === null ? "—" : localeText.t("ui.queue.processing", { count: processing })}.` : localeText.t("ui.queue.noData")}</p></div></div><div class="queue-meta"><div><span>${localeText.t("ui.queue.processingLabel")}</span><strong>${processing === null ? "—" : localeText.formatNumber(processing)}</strong></div><div><span>${localeText.t("ui.queue.unresolved")}</span><strong class="${unresolved === null || unresolved === 0 ? "" : "warn"}">${unresolved === null ? "—" : localeText.formatNumber(unresolved)}</strong></div></div><button class="queue-link" data-action="open-queue">${localeText.t("ui.queue.open")} ${icon("arrow", "small")}</button></section>`;
  }

  #taskTable(state: LoadState | null, preview: boolean): string {
    const page = state?.pages.tasks;
    const rows = page?.rows ?? [];
    const total = knownTotal(page);
    const columns = {
      label: {
        type: "text" as const,
        value: (row: Row) => row["label"] ?? row["kind"],
        sortValue: (row: Row) => row["label"] ?? row["kind"],
      },
      projectId: {
        type: "text" as const,
        value: (row: Row) => row["projectId"],
      },
      clientId: { type: "text" as const, value: (row: Row) => row["clientId"] },
      state: { type: "text" as const, value: (row: Row) => row["state"] },
      waitMs: { type: "number" as const, value: (row: Row) => row["waitMs"] },
      executionMs: {
        type: "number" as const,
        value: (row: Row) => row["executionMs"],
      },
    };
    const shownRows = applyTable(
      rows,
      { sort: this.#sorts.tasks, filters: this.#filters.tasks },
      columns,
    );
    const shown = preview ? shownRows.slice(0, 6) : shownRows;
    const headers = [
      ["label", localeText.t("ui.tasks.column.taskDocument")],
      ...(this.#scope.kind === "global"
        ? [["projectId", localeText.t("ui.tasks.column.project")] as const]
        : []),
      ["clientId", localeText.t("ui.tasks.column.client")],
      ["state", localeText.t("ui.tasks.column.state")],
      ["waitMs", localeText.t("ui.tasks.column.wait")],
      ["executionMs", localeText.t("ui.tasks.column.execution")],
    ] as const;
    const columnCount = headers.length + 1;
    const widths =
      this.#scope.kind === "global"
        ? [23, 12, 14, 18, 15, 14, 4]
        : [26, 18, 20, 17, 15, 4];
    return `<section class="panel table-panel"><div class="panel-head"><div class="row"><h2>${localeText.t(preview ? "ui.tasks.preview.title" : "ui.tasks.list.title")}<span class="count-label">${total === null ? "—" : localeText.formatNumber(total)}</span></h2></div>${preview ? `<button class="text-link" data-action="view" data-view="tasks">${localeText.t("ui.tasks.all.link")} ${icon("chevron", "small")}</button>` : `<span class="inline-source">${statusSourceText(record(page?.source))}</span>`}</div>
      <div class="table-toolbar"><label class="search-box">${icon("search", "small")}<input id="task-search" type="search" placeholder="${localeText.t("ui.tasks.search.placeholder")}" value="${esc(this.#search)}" aria-label="${localeText.t("ui.tasks.search.aria")}"></label>${this.#tableControls("tasks")}</div>
      ${
        !preview
          ? `<div class="queue-list-header"><div class="segmented">${this.#taskSegments(
              page,
            )
              .map(
                ([key, label, count]) =>
                  `<button class="segment ${this.#taskRange === key ? "active" : ""}" data-action="range" data-range="${key}">${label}<span>${count ?? "—"}</span></button>`,
              )
              .join(
                "",
              )}</div><span class="inline-source">${localeText.t("ui.tasks.clickRow")}</span></div>`
          : ""
      }
      <div class="table-wrap"><table class="task-grid-table ${this.#scope.kind === "project" ? "scoped-table" : ""}" aria-label="${localeText.t("ui.tasks.table.aria")}"><colgroup>${widths.map((width) => `<col style="width:${width}%">`).join("")}</colgroup><thead><tr>${headers.map(([key, label]) => this.#header(key, label)).join("")}<th scope="col"><span class="sr-only">${localeText.t("ui.tasks.column.details")}</span></th></tr></thead><tbody>${
        shown.length
          ? shown
              .map((task) => {
                const id = rowTaskId(task);
                const command =
                  text(task, "label") ??
                  text(task, "kind") ??
                  localeText.t("ui.tasks.operation.unknown");
                return `<tr class="${id ? "click-row" : ""}" ${id ? `tabindex="0" data-action="task" data-id="${esc(id)}" data-project="${esc(text(task, "projectId") ?? "")}"` : ""} aria-label="${id ? esc(localeText.t("ui.tasks.row.details", { command })) : localeText.t("ui.tasks.row.unstableDetails")}"><td><div class="task-cell"><span class="task-icon">${icon("code", "small")}</span><div><span class="task-name">${esc(command)}</span><div class="task-doc">${esc(text(task, "document") ?? text(task, "purpose") ?? localeText.t("ui.tasks.document.notReported"))}</div></div></div></td>${this.#scope.kind === "global" ? `<td><span class="client-id" title="${esc(text(task, "projectId") ?? localeText.t("ui.tasks.project.notReported"))}">${esc(text(task, "projectName") ?? text(task, "projectId") ?? localeText.t("ui.tasks.project.notReported"))}</span></td>` : ""}<td><span class="client-id" title="${esc(text(task, "clientId") ?? localeText.t("ui.tasks.client.notReported"))}">${esc(text(task, "clientName") ?? text(task, "clientId") ?? localeText.t("ui.tasks.client.notReported"))}</span></td><td>${statusBadge(task["state"])}</td><td class="duration">${duration(task["waitMs"])}</td><td class="duration">${duration(task["executionMs"])}</td><td class="row-arrow">${icon("chevron", "small")}</td></tr>`;
              })
              .join("")
          : `<tr><td class="table-empty" colspan="${columnCount}">${this.#empty(!page ? localeText.t("ui.tasks.empty.unavailable") : page.source.state === "no-data" ? localeText.t("ui.tasks.empty.retained") : localeText.t("ui.tasks.empty.noMatches"), !page ? (state?.errors.tasks ?? localeText.t("ui.tasks.empty.sourceUnavailable")) : page.source.state === "no-data" ? statusSourceText(page.source) : localeText.t("ui.tasks.empty.filters"), "layers")}</td></tr>`
      }</tbody></table></div>
      <div class="table-footer"><span>${page ? `${localeText.formatNumber(page.offset + (page.rows.length ? 1 : 0))}–${localeText.formatNumber(Math.min(page.offset + page.rows.length, total ?? page.offset + page.rows.length))} ${total === null ? localeText.t("ui.table.ofUnknownCount") : localeText.t("ui.pagination.of", { pages: localeText.formatNumber(total) })}` : localeText.t("ui.table.noPage")}</span>${preview ? "" : this.#pagination(page?.total ?? null, page?.limit ?? 12, (page?.rows.length ?? 0) >= (page?.limit ?? 12))}</div></section>`;
  }

  #taskSegments(
    page: QueryPage<Row> | undefined,
  ): readonly (readonly ["all" | "open" | "history", string, number | null])[] {
    const states = page?.facets["state"] ?? {};
    const sum = (values: readonly string[]) => {
      const selected = Object.entries(states)
        .filter(([state]) => values.includes(state.toLowerCase()))
        .map(([, count]) => count);
      return selected.length
        ? selected.reduce((total, count) => total + count, 0)
        : null;
    };
    return [
      ["all", localeText.t("ui.tasks.range.all"), knownTotal(page)],
      [
        "open",
        localeText.t("ui.tasks.range.open"),
        sum([
          "queued",
          "preparing",
          "sending",
          "processing",
          "running",
          "unresolved",
        ]),
      ],
      [
        "history",
        localeText.t("ui.tasks.range.history"),
        sum([
          "success",
          "succeeded",
          "completed",
          "failed",
          "unsuccessful",
          "cancelled",
          "expired",
        ]),
      ],
    ];
  }

  #header(key: string, label: string): string {
    const table: TableName =
      this.#view === "logs"
        ? "logs"
        : this.#view === "agents"
          ? "agents"
          : "tasks";
    const index = this.#sorts[table].findIndex((item) => item.key === key);
    const sort = this.#sorts[table][index];
    return `<th scope="col" ${index === 0 ? `aria-sort="${sort?.dir === "asc" ? "ascending" : "descending"}"` : ""}><div class="column-header"><button class="column-sort ${sort ? "is-sorted" : ""}" data-action="sort" data-column="${key}" aria-label="${esc(localeText.t("ui.table.sort.aria", { label }))}"><span>${label}</span><span class="column-order">${sort ? `${sort.dir === "asc" ? "↑" : "↓"}${this.#sorts[table].length > 1 ? `<span class="column-priority">${index + 1}</span>` : ""}` : icon("sort", "small")}</span></button><button class="column-filter ${this.#filters[table][key] ? "is-filtered" : ""}" data-action="filter" data-column="${key}" aria-label="${esc(localeText.t("ui.table.filter.aria", { label }))}" aria-haspopup="dialog">${icon("filter", "small")}</button></div></th>`;
  }

  #tableControls(table: TableName): string {
    const count =
      Object.keys(this.#filters[table]).length + this.#sorts[table].length;
    return `<div class="table-controls"><span class="table-sort-hint"><kbd>Ctrl</kbd> + ${localeText.t("ui.common.click")} · ${localeText.t("ui.table.sort.multiHint")}</span>${count ? `<span class="table-filter-count">${localeText.t("ui.table.filterCount", { count })}</span><button class="btn small" data-action="reset-table" data-table="${table}">${icon("refresh", "small")}${localeText.t("ui.table.reset")}</button>` : ""}</div>`;
  }

  #pagination(total: number | null, limit: number, hasNext: boolean): string {
    const pages = total === null ? null : Math.max(1, Math.ceil(total / limit));
    return `<div class="pagination"><button class="btn small" data-action="page" data-page="${this.#page - 1}" ${this.#page <= 1 ? "disabled" : ""}>${localeText.t("common.previous")}</button><span>${localeText.t("ui.pagination.page", { page: this.#page })}${pages === null ? "" : localeText.t("ui.pagination.of", { pages })}</span><button class="btn small" data-action="page" data-page="${this.#page + 1}" ${pages !== null ? (this.#page >= pages ? "disabled" : "") : !hasNext ? "disabled" : ""}>${localeText.t("common.next")}</button></div>`;
  }

  #tasksView(state: LoadState | null): string {
    const page = state?.pages.tasks;
    const states = page?.facets["state"] ?? {};
    const count = (...names: string[]) => {
      const values = Object.entries(states)
        .filter(([key]) => names.includes(key.toLowerCase()))
        .map(([, value]) => value);
      return values.length
        ? values.reduce((sum, value) => sum + value, 0)
        : null;
    };
    return `<div class="status-overview">${this.#stat(localeText.t("ui.tasks.preparing"), count("preparing"), localeText.t("ui.phase.real"), "clock")}${this.#stat(localeText.t("ui.tasks.processing"), count("processing"), localeText.t("ui.phase.real"), "pulse")}${this.#stat(localeText.t("ui.tasks.unresolved"), count("unresolved"), localeText.t("ui.tasks.needsReview"), "alert")}</div>${this.#taskTable(state, false)}`;
  }

  #stat(label: string, value: unknown, detail: string, image: string): string {
    const displayed =
      typeof value === "number" ? localeText.formatNumber(value) : value;
    return `<div class="metric"><div class="metric-top"><span>${label}</span>${icon(image)}</div><div class="metric-value">${displayed == null ? "—" : esc(displayed)}</div><div class="metric-bottom">${detail}</div></div>`;
  }

  #logsView(state: LoadState | null): string {
    const page = state?.pages.logs;
    const rows = page?.rows ?? [];
    const sources = Object.keys(page?.facets["source"] ?? {});
    const shown = rows.filter(
      (row) =>
        (this.#showHeartbeat ||
          !["HEARTBEAT", "heartbeat"].includes(
            String(row["event"] ?? row["kind"]),
          )) &&
        (this.#logLevel === "all" ||
          text(row, "level")?.toUpperCase() === this.#logLevel) &&
        (this.#logSource === "all" || text(row, "source") === this.#logSource),
    );
    const levels = Object.entries(page?.facets["level"] ?? {});
    const lastMinute = state?.recentLogCount;
    const recentSummary =
      lastMinute === null || lastMinute === undefined
        ? "—"
        : localeText.formatNumber(lastMinute);
    const resultRows = shown.length
      ? this.#logItems(shown.slice(0, 150))
      : this.#empty(
          page
            ? localeText.t("ui.logs.empty.entries")
            : localeText.t("ui.logs.empty.unavailable"),
          page
            ? localeText.t("ui.tasks.empty.filters")
            : (state?.errors.logs ??
                localeText.t("ui.logs.empty.sourceUnavailable")),
          "terminal",
        );
    const levelRows = levels.length
      ? levels
          .map(
            ([level, count]) =>
              `<button class="level-stat ${this.#logLevel === level ? "selected" : ""}" data-action="log-level-select" data-level="${esc(level)}"><span>${esc(level)}</span><b>${localeText.formatNumber(count)}</b></button>`,
          )
          .join("")
      : this.#empty(
          localeText.t("ui.logs.levels.empty"),
          localeText.t("ui.logs.levels.incomplete"),
          "filter",
        );
    const countNote =
      page?.total == null
        ? ""
        : ` ${localeText.t("ui.pagination.of", {
            pages: localeText.formatNumber(page.total),
          })}`;

    return `<div class="log-layout"><section class="panel log-main"><div class="panel-head"><div class="row"><h2>${localeText.t("ui.logs.title")}<span class="count-label">${page?.total == null ? "—" : localeText.formatNumber(page.total)}</span></h2><span class="live-pip ${this.#follow ? "" : "off"}"></span></div><button class="btn small ${this.#follow ? "follow-active" : ""}" data-action="follow">${icon(this.#follow ? "eye" : "pause", "small")}${localeText.t(this.#follow ? "ui.logs.follow.enabled" : "ui.logs.follow.paused")}</button></div><div class="log-toolbar"><label class="search-box">${icon("search", "small")}<input id="log-search" type="search" placeholder="${localeText.t("ui.logs.search.placeholder")}" value="${esc(this.#search)}" aria-label="${localeText.t("ui.logs.search.aria")}"></label><div class="filter-group"><select id="log-level" aria-label="${localeText.t("ui.logs.level.aria")}" ><option value="all">${localeText.t("ui.logs.level.all")}</option>${["INFO", "WARN", "ERROR", "DEBUG", "TRACE", "OTHER"].map((level) => `<option value="${level}" ${this.#logLevel === level ? "selected" : ""}>${level}</option>`).join("")}</select><select id="log-source" aria-label="${localeText.t("ui.logs.source.aria")}"><option value="all" ${this.#logSource === "all" ? "selected" : ""}>${localeText.t("ui.logs.source.all")}</option>${sources.map((source) => `<option value="${esc(source)}" ${this.#logSource === source ? "selected" : ""}>${esc(source)}</option>`).join("")}</select></div><label class="toggle-label"><input id="heartbeat" type="checkbox" ${this.#showHeartbeat ? "checked" : ""}>${localeText.t("ui.logs.heartbeat.show")}</label>${this.#tableControls("logs")}</div><div class="logs scroll-logs" id="log-stream">${resultRows}</div><div class="table-footer"><span>${localeText.t("ui.logs.footer.entries")}: ${localeText.formatNumber(Math.min(shown.length, 150))}${countNote} · ${localeText.t(this.#follow ? "ui.logs.follow.enabled" : "ui.logs.follow.paused")}</span><button class="text-link" data-action="export" data-collection="logs">${icon("download", "small")}${localeText.t("common.export")}</button></div></section><aside class="log-side"><section class="panel system-panel"><h2>${icon("filter", "small")}${localeText.t("ui.logs.levels.title")}</h2>${levelRows}<div class="key-values"><div><dt>${localeText.t("ui.logs.recent.seconds")}</dt><dd>${recentSummary}</dd></div></div></section><section class="panel system-panel"><h2>${localeText.t("system.lock.source")}</h2>${statusSourceText(page?.source ?? { state: "unavailable", source: "logs" })}</section></aside></div>`;
  }

  #logItems(rows: readonly Row[]): string {
    return rows
      .map((row) => {
        const id = text(row, "id");
        return `<div class="log-row" ${id ? `tabindex="0" data-action="log" data-id="${esc(id)}"` : 'aria-disabled="true"'}><span class="log-time">${esc(time(row["timestamp"]))}</span><span class="log-level ${esc(text(row, "level")?.toLowerCase() ?? "other")}">${esc(text(row, "level") ?? "OTHER")}</span><div><div class="log-text">${esc(text(row, "message") ?? localeText.t("ui.logs.message.empty"))}</div><div class="log-meta">${esc(text(row, "source") ?? localeText.t("ui.logs.source.notReported"))}${nonemptyId(row["taskId"]) ? ` · ${localeText.t("ui.logs.task.label")} ${esc(row["taskId"])}` : ""}</div></div>${icon("chevron", "small")}</div>`;
      })
      .join("");
  }

  #recentLogs(state: LoadState | null): string {
    const rows = (state?.pages.logs?.rows ?? []).slice(0, 3);
    return `<section class="panel"><div class="panel-head"><div class="row"><h2>${localeText.t("ui.logs.recent.title")}</h2><span class="live-pip"></span></div><button class="text-link" data-action="view" data-view="logs">${localeText.t("ui.logs.open")} ${icon("chevron", "small")}</button></div>${rows.length ? `<div class="logs">${this.#logItems(rows)}</div>` : this.#empty(localeText.t("ui.logs.events.empty"), localeText.t("ui.logs.events.emptyDescription"), "terminal")}</section>`;
  }

  #agentsView(state: LoadState | null): string {
    const page = state?.pages.agents;
    const rows = page?.rows ?? [];
    const presence = page?.facets["presence"] ?? {};
    const count = (values: readonly string[]) => {
      const matches = Object.entries(presence)
        .filter(([value]) => values.includes(value.toLowerCase()))
        .map(([, total]) => total);
      return matches.length
        ? matches.reduce((sum, value) => sum + value, 0)
        : null;
    };
    const ranges = [
      ["all", "Wszystkie", page?.total ?? null],
      ["confirmed", "Potwierdzone", count(["observed", "active", "idle"])],
      [
        "history",
        "Historia i nieznane",
        count(["stale", "unknown", "missing", "history"]),
      ],
    ] as const;
    return `<div class="agent-toolbar"><div class="segmented agent-filter" aria-label="${localeText.t("ui.agents.filter.aria")}">${ranges.map(([key, label, total]) => `<button class="segment ${this.#agentRange === key ? "active" : ""}" data-action="agent-range" data-range="${key}">${label}<span>${total === null ? "—" : localeText.formatNumber(total)}</span></button>`).join("")}</div></div><section class="panel table-panel"><div class="panel-head"><div><h2>${localeText.t("ui.agents.title")}<span class="count-label">${knownTotal(page) === null ? "—" : localeText.formatNumber(knownTotal(page)!)}</span></h2><p class="panel-subtitle">${localeText.t("ui.agents.description")}</p></div><span class="inline-source">${statusSourceText(page?.source ?? { state: "unavailable", source: "agents" })}</span></div><div class="table-toolbar"><label class="search-box">${icon("search", "small")}<input id="agent-search" type="search" placeholder="${localeText.t("ui.agents.search.placeholder")}" value="${esc(this.#search)}" aria-label="${localeText.t("ui.agents.search.aria")}"></label>${this.#tableControls("agents")}</div><div class="agent-list">${rows.length ? rows.map((agent) => `<div class="agent-list-row" ${nonemptyId(agent["id"]) ? `tabindex="0" data-action="agent" data-id="${esc(agent["id"])}" data-project="${esc(text(agent, "projectId") ?? "")}"` : ""}><span class="agent-identity"><span class="agent-monogram">${esc((text(agent, "name") ?? "?").slice(0, 2).toUpperCase())}</span><span class="agent-identity-text"><span class="agent-name-line"><strong>${esc(text(agent, "name") ?? text(agent, "clientId") ?? localeText.t("ui.agents.identity.unknown"))}</strong>${statusBadge(agent["presence"])}</span><span class="agent-role">${esc(display(agent["kind"]))}</span><span class="agent-tool">${esc(text(agent, "id") ?? localeText.t("ui.agents.identity.notReported"))}</span></span></span><span class="agent-work">${esc(text(agent, "work") ?? localeText.t("ui.agents.work.none"))}</span>${icon("chevron", "small")}</div>`).join("") : this.#empty(!page ? localeText.t("ui.agents.empty.unavailable") : page.source.state === "no-data" ? localeText.t("ui.agents.empty.noPresence") : localeText.t("ui.agents.empty.noIdentity"), !page ? (state?.errors.agents ?? localeText.t("ui.agents.source.noData")) : statusSourceText(page.source), "users")}</div><div class="table-footer"><span>${page ? `${localeText.formatNumber(page.offset + (rows.length ? 1 : 0))}–${localeText.formatNumber(page.offset + rows.length)} ${knownTotal(page) === null ? localeText.t("ui.table.ofUnknownCount") : localeText.t("ui.pagination.of", { pages: localeText.formatNumber(knownTotal(page)!) })}` : localeText.t("ui.agents.page.unavailable")}</span>${this.#pagination(knownTotal(page), page?.limit ?? 8, rows.length >= (page?.limit ?? 8))}</div></section>`;
  }

  #empty(title: string, description: string, image: string): string {
    return `<div class="empty-state">${icon(image)}<strong>${esc(title)}</strong><span>${esc(description)}</span></div>`;
  }

  async #openTask(id: string): Promise<void> {
    const state = this.#state();
    const task = (state?.pages.tasks?.rows ?? []).find(
      (row) => rowTaskId(row) === id,
    );
    if (!task) {
      this.#toast(localeText.t("ui.project.task.unavailable"));
      return;
    }
    const owner =
      this.#scope.kind === "project"
        ? this.#scope.projectId
        : text(task, "projectId");
    if (!nonemptyId(owner)) {
      this.#toast(localeText.t("ui.project.task.sourceMissing"));
      return;
    }
    try {
      const scope = { kind: "project" as const, projectId: owner };
      let token =
        state?.scope.kind === "project" && state.scope.projectId === owner
          ? state.snapshotToken
          : null;
      let revision =
        state?.scope.kind === "project" && state.scope.projectId === owner
          ? state.revision
          : null;
      let sources =
        state?.scope.kind === "project" && state.scope.projectId === owner
          ? (state.sources ?? {})
          : {};
      if (!token) {
        const snapshot = await this.#api.snapshot(scope);
        token = snapshot.snapshotToken;
        revision = snapshot.revision;
        sources = snapshot.sources;
      }
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope,
        collection: "tasks",
        snapshotToken: token,
        filters: { id },
        limit: 1,
      });
      const selected = page.rows.find((row) => rowTaskId(row) === id) ?? task;
      this.#showTask(
        selected,
        owner,
        page.snapshotToken ?? token,
        page.revision ?? revision,
        undefined,
        sources,
      );
    } catch (error) {
      this.#toast(this.#error(error));
    }
  }

  #showTask(
    task: Row,
    owner: string,
    token: string | null,
    revision: Revision | null,
    returnLog?: Extract<ModalState, { type: "log" }>,
    sources: Readonly<Record<string, SourceStatus>> = {},
  ): void {
    this.#rememberModalFocus();
    this.#modal = {
      type: "task",
      task: safeClone(task),
      projectId: owner,
      snapshotToken: token,
      revision,
      sources,
      tab: "details",
      events: null,
      eventStatus: null,
      artifact: null,
      artifactMissingReason: null,
      artifactKind: null,
      loading: false,
      ...(returnLog ? { returnLog } : {}),
    };
    this.#renderModal(true);
  }

  async #loadTaskEvents(): Promise<void> {
    const modal = this.#modal;
    if (modal?.type !== "task" || modal.events !== null) return;
    const id = rowTaskId(modal.task);
    const requestId = text(modal.task, "requestId");
    if (!modal.snapshotToken) {
      modal.events = [];
      modal.eventStatus =
        "Brak tokenu snapshotu do korelowanego odczytu zdarzeń.";
      this.#renderModal();
      return;
    }
    if (!nonemptyId(id) && !nonemptyId(requestId)) {
      modal.events = [];
      modal.eventStatus =
        "Brak niepustego task ID lub request ID do powiązania zdarzeń.";
      this.#renderModal();
      return;
    }
    modal.loading = true;
    this.#renderModal();
    try {
      const requests = [
        ...(nonemptyId(id)
          ? [
              this.#api.query<Row>({
                version: API_VERSION,
                scope: { kind: "project", projectId: modal.projectId },
                collection: "logs",
                snapshotToken: modal.snapshotToken,
                filters: { taskId: id },
                limit: 200,
              }),
            ]
          : []),
        ...(nonemptyId(requestId)
          ? [
              this.#api.query<Row>({
                version: API_VERSION,
                scope: { kind: "project", projectId: modal.projectId },
                collection: "logs",
                snapshotToken: modal.snapshotToken,
                filters: { requestId },
                limit: 200,
              }),
            ]
          : []),
      ];
      const pages = await Promise.all(requests);
      const rows = [
        ...new Map(
          pages
            .flatMap((page) => page.rows)
            .filter((row) => nonemptyId(row["id"]))
            .map((row) => [String(row["id"]), row]),
        ).values(),
      ];
      const taskRow: ConsoleRow = {
        ...modal.task,
        ...(nonemptyId(id) ? { id } : {}),
      };
      const snapshot = { logs: rows as readonly ConsoleRow[] };
      modal.events = correlate(taskRow, snapshot, "task").events as
        readonly Row[] | null;
      modal.eventStatus = null;
      modal.eventStatus =
        pages
          .filter((page) => page.source.state !== "available")
          .map((page) => statusSourceText(page.source))
          .join(" · ") || null;
    } catch (error) {
      modal.events = [];
      modal.eventStatus = this.#error(error);
    } finally {
      modal.loading = false;
      this.#renderModal();
    }
  }

  async #loadArtifact(kind: ArtifactKind): Promise<void> {
    const modal = this.#modal;
    if (modal?.type !== "task") return;
    const serial = ++this.#artifactLoadSerial;
    const id = rowTaskId(modal.task);
    const artifacts = record(modal.task["artifacts"]);
    const link = artifacts[artifactSlot(kind)];
    const reference = record(Array.isArray(link) ? link[0] : link);
    if (isOutputKind(kind) && !validOutputChannel(reference)) {
      modal.artifactKind = kind;
      modal.artifact = null;
      modal.loading = false;
      modal.artifactMissingReason =
        text(reference, "reason") ??
        (reference["state"] === "missing"
          ? `${kind} was not retained for this task.`
          : reference["state"] === "unavailable"
            ? `${kind} is unavailable in the retained source.`
            : `No retained ${kind} channel with verified provenance was supplied.`);
      this.#renderModal();
      return;
    }
    const artifactId =
      typeof link === "string" ? link : text(reference, "artifactId");
    if (!id || !artifactId || !modal.snapshotToken) {
      modal.artifactKind = kind;
      modal.artifact = null;
      modal.loading = false;
      modal.artifactMissingReason = !modal.snapshotToken
        ? "Brak tokenu snapshotu do odczytu artefaktu."
        : "Źródło nie udostępniło identyfikatora artefaktu.";
      this.#renderModal();
      return;
    }
    modal.loading = true;
    modal.artifactKind = kind;
    modal.artifactMissingReason = null;
    this.#renderModal();
    try {
      const artifact = await this.#api.detail({
        version: API_VERSION,
        scope: { kind: "project", projectId: modal.projectId },
        taskId: id,
        artifactId,
        kind,
        snapshotToken: modal.snapshotToken,
        offset: 0,
        length: 256 * 1024,
      });
      if (this.#modal !== modal || this.#artifactLoadSerial !== serial) return;
      modal.artifact = artifact;
    } catch (error) {
      if (this.#modal !== modal || this.#artifactLoadSerial !== serial) return;
      modal.artifact = null;
      modal.artifactMissingReason = this.#error(error);
    } finally {
      if (this.#modal === modal && this.#artifactLoadSerial === serial) {
        modal.loading = false;
        this.#renderModal();
      }
    }
  }

  #renderModal(focus = false): void {
    if (this.#listeners.signal.aborted) return;
    const host = document.getElementById("overlay-root");
    if (!host) return;
    if (!this.#modal) {
      if (this.#auxiliaryModal) return;
      this.#closeModalSurface();
      return;
    }
    this.#rememberModalFocus();
    this.#auxiliaryModal = null;
    this.#root.inert = true;
    const active = document.activeElement as HTMLElement | null;
    const activeAction = active?.dataset["action"];
    const activeId = active?.dataset["id"];
    const activeTab = active?.dataset["tab"];
    const content =
      this.#modal.type === "task"
        ? this.#taskModal(this.#modal)
        : this.#modal.type === "log"
          ? this.#logModal(this.#modal)
          : this.#agentModal(this.#modal);
    const footer =
      this.#modal.type === "task"
        ? `${this.#modal.returnLog ? `<button class="btn small" data-action="back-log">← Zdarzenie</button>` : ""}<span class="modal-footer-note">Stan z chwili otwarcia · rewizja ${this.#modal.revision?.revision ?? "—"}</span><button class="btn small" data-action="task-refresh">${icon("refresh", "small")}Odśwież szczegóły</button><button class="btn" data-action="close">Zamknij</button>`
        : this.#modal.type === "log"
          ? `${this.#modal.returnTask ? `<button class="btn small" data-action="back-task">← Zadanie</button>` : ""}${nonemptyId(this.#modal.log["taskId"]) ? `<button class="btn primary" data-action="log-task">${icon("layers", "small")}Powiązane zadanie</button>` : ""}<button class="btn" data-action="copy-log">${icon("copy", "small")}Kopiuj wpis</button><button class="btn" data-action="close">Zamknij</button>`
          : `${this.#modal.returnTask ? `<button class="btn small" data-action="back-task">← Zadanie</button>` : ""}<button class="btn small" data-action="agent-logs">${icon("terminal", "small")}Logi</button><button class="btn" data-action="close">Zamknij</button>`;
    const title =
      this.#modal.type === "task"
        ? "Szczegóły zadania"
        : this.#modal.type === "log"
          ? "Szczegóły zdarzenia"
          : "Agent / sesja";
    host.innerHTML = `<div class="overlay" data-action="backdrop"><section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><header class="modal-header"><h2 id="modal-title">${title}</h2><button class="icon-button" data-action="close" aria-label="Zamknij okno">${icon("close")}</button></header><div class="modal-body">${content}</div><footer class="modal-footer">${footer}</footer></section></div>`;
    this.#selects.upgrade(host);
    if (focus) $(".modal", host)?.focus();
    else if (activeAction) {
      const next = [
        ...host.querySelectorAll<HTMLElement>("[data-action]"),
      ].find(
        (element) =>
          element.dataset["action"] === activeAction &&
          element.dataset["id"] === activeId &&
          element.dataset["tab"] === activeTab,
      );
      next?.focus({ preventScroll: true });
    }
  }

  #renderLocaleOverlay(): void {
    if (this.#modal) {
      this.#renderModal();
      return;
    }
    switch (this.#auxiliaryModal) {
      case "filter":
        if (this.#filterColumn) this.#openFilter(this.#filterColumn, true);
        break;
      case "search": {
        const query =
          ($("#global-search-input") as HTMLInputElement | null)?.value ?? "";
        const results = $("#global-results")?.innerHTML ?? "";
        const activeSearch =
          document.activeElement?.id === "global-search-input";
        this.#searchDialog(query, results);
        if (activeSearch) $("#global-search-input")?.focus();
        break;
      }
      case "settings":
        this.#showSettings();
        break;
      case "help":
        this.#showHelp();
        break;
      case "export":
        if (this.#exportCollection) this.#showExport(this.#exportCollection);
        break;
      default:
        break;
    }
  }

  #rememberModalFocus(): void {
    if (this.#modalReturnFocus) return;
    const active = document.activeElement;
    this.#modalReturnFocus = active instanceof HTMLElement ? active : null;
  }

  #mountOverlay(
    kind: AuxiliaryModal,
    markup: string,
    focusSelector: string,
  ): void {
    this.#selects.close(false);
    this.#rememberModalFocus();
    this.#modal = null;
    this.#auxiliaryModal = kind;
    this.#root.inert = true;
    const host = document.getElementById("overlay-root");
    if (!host) return;
    host.innerHTML = markup;
    this.#selects.upgrade(host);
    $(focusSelector, host)?.focus();
  }

  #closeModalSurface(): void {
    this.#selects.close(false);
    const host = document.getElementById("overlay-root");
    if (host) host.innerHTML = "";
    this.#root.inert = false;
    this.#exportCollection = null;
    this.#modal = null;
    this.#auxiliaryModal = null;
    this.#globalSearchSerial += 1;
    const returnFocus = this.#modalReturnFocus;
    this.#modalReturnFocus = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  #taskModal(modal: Extract<ModalState, { type: "task" }>): string {
    const task = modal.task;
    const id = rowTaskId(task) ?? "";
    const tabs = (
      [
        ["details", "file", "Szczegóły"],
        [
          "events",
          "terminal",
          `Zdarzenia${modal.events ? ` (${modal.events.length})` : ""}`,
        ],
        ["code", "code", "Kod"],
        ["response", "terminal", "Odpowiedź"],
      ] as const
    )
      .map(
        ([key, image, label]) =>
          `<button class="modal-tab ${modal.tab === key ? "active" : ""}" role="tab" aria-selected="${modal.tab === key}" data-action="task-tab" data-tab="${key}">${icon(image, "small")}${label}</button>`,
      )
      .join("");
    const agentId = nonemptyId(task["agentId"])
      ? task["agentId"]
      : nonemptyId(task["clientId"])
        ? task["clientId"]
        : null;
    let body = "";
    if (modal.tab === "details") {
      body = `<div class="details-header">${statusBadge(task["state"])}</div><div class="detail-command">${esc(text(task, "label") ?? text(task, "kind") ?? "Nieznana operacja")}</div><div class="detail-columns"><section><h3 class="detail-section-title">Cel i operacja</h3>${this.#keyValues(
        [
          ["Cel", text(task, "purpose")],
          ["Rodzaj", text(task, "kind")],
          ["Dokument", text(task, "document")],
          ["Źródło pola", text(task, "source")],
        ],
      )}</section><section><h3 class="detail-section-title">Wynik i czasy</h3>${this.#keyValues(
        [
          ["Stan źródłowy", task["state"]],
          ["Wysłano", dateTime(task["submittedAt"])],
          ["Rozpoczęto", dateTime(task["startedAt"])],
          ["Zakończono", dateTime(task["finishedAt"])],
          ["Oczekiwanie", duration(task["waitMs"])],
          ["Wykonanie", duration(task["executionMs"])],
          ["Limit wykonania", duration(task["timeoutMs"])],
          ["Kod wyjścia", task["exitCode"]],
          ["Rezultat", task["outcome"]],
          ["Możliwa modyfikacja", task["mayHaveMutated"]],
        ],
      )}</section></div><h3 class="detail-section-title">Tożsamość i korelacja</h3>${this.#keyValues(
        [
          ["Task ID", id],
          ["Job ID", task["jobId"]],
          ["Execution ID", task["executionId"]],
          ["Request ID", task["requestId"]],
          ["Client ID", task["clientId"]],
          ["Agent ID", task["agentId"]],
          ["Session ID", task["sessionId"]],
          ["Dokument ID", task["documentId"]],
          ["Operacja", task["operationKind"]],
          ["Zdarzenie terminalne", task["event"]],
          ["Źródło", task["source"]],
          ["Ordinal źródła", task["sourceOrdinal"]],
          [
            "Rewizja",
            modal.revision
              ? `${modal.revision.epoch}:${modal.revision.revision}`
              : null,
          ],
        ],
      )}${agentId ? `<button class="text-link" data-action="task-agent" data-id="${esc(agentId)}">${icon("users", "small")}Otwórz agenta / sesję</button>` : ""}`;
    } else if (modal.tab === "events") {
      body = modal.loading
        ? this.#empty(
            "Wczytywanie zdarzeń",
            "Odczyt ze snapshotu bieżącego zadania.",
            "terminal",
          )
        : modal.events?.length
          ? `<div class="modal-event-list">${this.#logItems(modal.events)}</div>`
          : this.#empty(
              "Brak dostępnych zdarzeń",
              modal.eventStatus ??
                "Nie znaleziono zdarzeń z niepustym powiązaniem zadania lub requestu.",
              "terminal",
            );
    } else if (modal.tab === "code") {
      const artifact =
        modal.artifactKind === "original-source" ? modal.artifact : null;
      const sent = modal.artifactKind === "sent-source" ? modal.artifact : null;
      const current =
        modal.artifactKind === "current-file" ? modal.artifact : null;
      const selected = artifact ?? sent ?? current;
      const artifacts = record(task["artifacts"]);
      const rawRef =
        artifacts[artifactSlot(modal.artifactKind ?? "original-source")];
      const ref = record(Array.isArray(rawRef) ? rawRef[0] : rawRef);
      const sourceHash = text(ref, "sourceHash") ?? text(task, "sourceHash");
      body = `<div class="response-tabs"><div class="segmented">${(["original-source", "sent-source", "current-file"] as const).map((kind) => `<button class="segment ${modal.artifactKind === kind ? "active" : ""}" data-action="artifact" data-kind="${kind}">${kind === "original-source" ? "Oryginalne" : kind === "sent-source" ? "Wysłane" : "Aktualny plik"}</button>`).join("")}</div>${selected?.content ? `<button class="btn small" data-action="copy-artifact">${icon("copy", "small")}Kopiuj</button>` : ""}</div>${this.#keyValues(
        [["SHA-256", sourceHash]],
      )}${sourceHash ? `<button class="text-link" data-action="copy-hash">${icon("copy", "small")}Kopiuj hash</button>` : ""}${modal.loading ? this.#empty("Wczytywanie źródła", "Odczyt ograniczonego artefaktu ze snapshotu.", "file") : selected ? this.#artifactBlock(selected, modal.artifactKind ?? "original-source") : modal.artifactMissingReason ? this.#empty("Źródło niedostępne", modal.artifactMissingReason, "alert") : this.#empty("Wybierz źródło", "Oryginalny kod, wysłany payload i aktualny plik są odrębnymi artefaktami.", "code")}`;
    } else {
      const taskArtifacts = record(task["artifacts"]);
      const outputButtons = outputChannels
        .map(([kind, filename]) => {
          const channel = record(taskArtifacts[artifactSlot(kind)]);
          const available = validOutputChannel(channel);
          const label = kind === "rpc" ? "rpc-result.json" : kind;
          return `<button class="segment ${modal.artifactKind === kind ? "active" : ""}" data-action="artifact" data-kind="${kind}" aria-label="${esc(label)}${available ? "" : " · niedostępny"}" title="${esc(text(channel, "reason") ?? filename)}">${esc(label)}${available ? "" : " · niedostępny"}</button>`;
        })
        .join("");
      const selectedOutput = isOutputKind(modal.artifactKind)
        ? record(taskArtifacts[artifactSlot(modal.artifactKind)])
        : null;
      const provenanceNote = validOutputChannel(selectedOutput ?? {})
        ? `<p class="details-note">Źródło zachowane: ${esc(text(selectedOutput!, "provenance"))} · SHA-256 ${esc(text(selectedOutput!, "sourceHash"))}</p>`
        : "";
      const taskSource = modal.sources["tasks"];
      const freshnessNote =
        taskSource && taskSource.state !== "available"
          ? `<p class="details-note">${esc(statusSourceText(taskSource))}</p>`
          : "";
      const selectedKind =
        modal.artifactKind === "response" || isOutputKind(modal.artifactKind)
          ? modal.artifactKind
          : null;
      const selectedArtifact = selectedKind ? modal.artifact : null;
      const selectedLabel =
        selectedKind === "rpc"
          ? "rpc-result.json"
          : (selectedKind ?? "artefaktu");
      body = `<div class="response-tabs"><span class="details-note">Zachowane wyjście wykonania; odczyt tylko z przypiętego snapshotu, bez ponownego uruchomienia.</span><div class="segmented">${outputButtons}<button class="segment ${selectedKind === "response" ? "active" : ""}" data-action="artifact" data-kind="response" aria-label="Wczytaj odpowiedź zgodności">Odpowiedź</button></div>${selectedArtifact?.content ? `<button class="btn small" data-action="copy-artifact">${icon("copy", "small")}Kopiuj</button>` : ""}</div>${freshnessNote}${provenanceNote}${modal.loading ? this.#empty(`Wczytywanie ${esc(selectedLabel)}`, "Odczyt ograniczonego zakresu ze snapshotu.", "terminal") : selectedArtifact && selectedKind ? this.#artifactBlock(selectedArtifact, selectedKind) : modal.artifactMissingReason ? this.#empty(`${esc(selectedLabel)} niedostępny`, modal.artifactMissingReason, "alert") : this.#empty("Wybierz zachowany kanał", "Dostępność stdout, stderr, RPC i zgodności odpowiedzi zależy wyłącznie od retained artifact links.", "terminal")}`;
    }
    return `<div class="details-header"><span class="project-chip">${esc(this.#projectLabel(modal.projectId))}</span>${statusBadge(task["state"])}</div><div class="modal-tabs" role="tablist" aria-label="Szczegóły zadania">${tabs}</div><section role="tabpanel" class="agent-modal-panel">${body}</section>`;
  }

  #artifactBlock(artifact: ArtifactResult, kind: ArtifactKind): string {
    if (!["available", "empty", "truncated"].includes(artifact.state))
      return `<div class="notice info">${icon("alert")}<div><strong>${esc(artifact.state)}</strong><p>${esc(artifact.reason ?? "Treść artefaktu nie jest dostępna.")}</p></div></div>`;
    if (artifact.content === null || artifact.state === "empty")
      return this.#empty(
        "Brak treści artefaktu",
        artifact.reason ?? "Źródło nie zgłosiło treści.",
        "file",
      );
    if (kind === "response" || isOutputKind(kind)) {
      const label =
        kind === "stdout"
          ? "stdout.txt · UTF-8"
          : kind === "stderr"
            ? "stderr.txt · UTF-8"
            : kind === "rpc"
              ? "rpc-result.json · zachowany wynik, nie pełny wire payload"
              : "Odpowiedź · tekst zachowany";
      return `<div class="source-editor-head"><span class="source-language">${label}</span><span>${artifact.content.split("\n").length} linii</span></div><pre class="code-block"><code>${esc(artifact.content)}</code></pre>${artifact.state === "truncated" ? `<p class="details-note">Treść ograniczona przez API · odczyt bajtów ${artifact.offset}–${artifact.offset + artifact.length} z ${artifact.totalLength ?? "nieznanej długości"}.</p>` : ""}`;
    }
    const highlighter = (
      window as Window & {
        hljs?: {
          highlight(
            code: string,
            options: { language: string },
          ): { value: string };
        };
      }
    ).hljs;
    let highlighted: string;
    try {
      highlighted =
        highlighter?.highlight(artifact.content, { language: "python" })
          .value ?? esc(artifact.content);
    } catch {
      highlighted = esc(artifact.content);
    }
    const lines = highlighted.split("\n");
    return `<div class="source-editor-head"><span class="source-language">Tekst zachowany · tylko odczyt</span><span>${lines.length} linii</span></div><pre class="code-block code-view syntax-view"><code class="language-python">${lines.map((line, index) => `<span><i class="code-gutter">${index + 1}</i><span class="highlight-source">${line || " "}</span></span>`).join("\n")}</code></pre>${artifact.state === "truncated" ? `<p class="details-note">Treść ograniczona przez API · odczyt bajtów ${artifact.offset}–${artifact.offset + artifact.length} z ${artifact.totalLength ?? "nieznanej długości"}.</p>` : ""}`;
  }

  #logModal(modal: Extract<ModalState, { type: "log" }>): string {
    const log = modal.log;
    const timestamp = log["timestamp"];
    const raw =
      text(log, "rawMessage") ??
      text(log, "message") ??
      "Treść nie została zachowana.";
    return `<div class="details-header"><span class="badge ${stateTone(log["level"])}">${esc(text(log, "level") ?? "OTHER")}</span></div>${this.#keyValues(
      [
        ["Czas lokalny", dateTime(timestamp)],
        ["Czas UTC", utcDateTime(timestamp)],
        ["Źródło", log["source"]],
        ["Zdarzenie", log["event"]],
        ["Task ID", log["taskId"]],
        ["Request ID", log["requestId"]],
        ["Client ID", log["clientId"]],
        [
          "Rewizja",
          modal.revision
            ? `${modal.revision.epoch}:${modal.revision.revision}`
            : null,
        ],
      ],
    )}<h3 class="detail-section-title">Wiadomość</h3><pre class="code-block">${esc(raw)}</pre>`;
  }

  #agentModal(modal: Extract<ModalState, { type: "agent" }>): string {
    const agent = modal.agent;
    return `<div class="agent-modal-identity"><span class="agent-monogram large">${esc((text(agent, "name") ?? "?").slice(0, 2).toUpperCase())}</span><div><h3>${esc(text(agent, "name") ?? text(agent, "clientId") ?? "Nieznana tożsamość")}</h3><p>${esc(text(agent, "kind") ?? "Rodzaj niezgłoszony")}</p><span class="project-chip">${esc(this.#projectLabel(modal.projectId))}</span></div>${statusBadge(agent["presence"])}</div>${this.#keyValues(
      [
        ["Client ID", agent["id"]],
        ["Session ID", agent["sessionId"]],
        ["Źródło obecności", agent["source"]],
        ["Ostatni sygnał", dateTime(agent["lastSeen"])],
        ["Aktywne zadanie", agent["work"]],
      ],
    )}<p class="details-note">Tożsamość i obecność pochodzą z jawnego źródła. Historia zadań nie jest używana jako heartbeat.</p>`;
  }

  #keyValues(entries: readonly (readonly [string, unknown])[]): string {
    return `<dl class="key-values">${entries.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(display(value))}</dd></div>`).join("")}</dl>`;
  }

  #projectLabel(id: string): string {
    const project = this.#projects.find((item) => projectId(item) === id);
    return project ? projectName(project) : id;
  }

  #toast(message: string): void {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("visible");
    window.setTimeout(() => toast.classList.remove("visible"), 3500);
  }

  async #copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.#toast("Skopiowano do schowka.");
    } catch {
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      this.#toast(
        copied ? "Skopiowano do schowka." : "Nie udało się skopiować treści.",
      );
    }
  }

  async #export(collection: Collection, format: "csv" | "json"): Promise<void> {
    const state = this.#latest;
    if (!state?.snapshotToken)
      return this.#toast("Brak snapshotu do eksportu.");
    const options = this.#tableOptions(
      collection === "logs"
        ? "logs"
        : collection === "agents"
          ? "agents"
          : "tasks",
    );
    const selection = Object.fromEntries(
      Object.entries(options).filter(
        ([key]) => key !== "offset" && key !== "limit",
      ),
    ) as Partial<
      Pick<
        QueryRequest,
        "search" | "filters" | "sort" | "facetFields" | "aggregateFields"
      >
    >;
    const request: QueryRequest = {
      version: API_VERSION,
      scope: state.scope,
      collection,
      snapshotToken: state.snapshotToken,
      ...selection,
    };
    try {
      const result = await this.#api.export({ ...request, format });
      const mime =
        format === "csv"
          ? "text/csv;charset=utf-8"
          : "application/json;charset=utf-8";
      const url = URL.createObjectURL(
        new Blob([result.content], { type: mime }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `fmcad-${collection}-${new Date().toISOString().slice(0, 10)}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
      this.#closeModalSurface();
      this.#toast(`Wyeksportowano ${result.rowCount} rekordów.`);
    } catch (error) {
      this.#toast(this.#error(error));
    }
  }

  #onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>("[data-action]");
    if (!button) return;
    const action = button.dataset["action"];
    if (action === "backdrop" && target !== button) return;
    switch (action) {
      case "backdrop":
        this.#closeModalSurface();
        break;
      case "view": {
        const view = button.dataset["view"];
        if (["overview", "tasks", "agents", "logs"].includes(String(view))) {
          this.#view = view as View;
          this.#search = "";
          this.#page = 1;
          this.#mobile = false;
          this.#queryForTable();
          this.#render();
        }
        break;
      }
      case "scope":
        this.#changeScope(scopeParam(button.dataset["id"] ?? "global"));
        break;
      case "mobile":
        this.#mobile = !this.#mobile;
        this.#render();
        break;
      case "freeze":
        this.#frozen = !this.#frozen;
        if (!this.#frozen && this.#latest) this.#visible = this.#latest;
        this.#render();
        break;
      case "refresh":
        void this.#load(this.#scope, false).then(() => this.#watch());
        break;
      case "sort": {
        const column = button.dataset["column"];
        const table: TableName =
          this.#view === "logs"
            ? "logs"
            : this.#view === "agents"
              ? "agents"
              : "tasks";
        if (column)
          this.#sorts[table] = toggleSort(
            this.#sorts[table],
            column,
            event.ctrlKey || event.metaKey,
          );
        this.#page = 1;
        this.#queryForTable();
        this.#render();
        break;
      }
      case "filter":
        this.#openFilter(button.dataset["column"] ?? "");
        break;
      case "filter-search":
        this.#filterSearch =
          $<HTMLInputElement>("#filter-value-search")?.value ??
          this.#filterSearch;
        this.#renderFilterChoices();
        break;
      case "filter-select-all":
        this.#filterChosen = new Set(
          this.#filterOptions.map((option) => option.value),
        );
        this.#renderFilterChoices();
        break;
      case "filter-select-none":
        this.#filterChosen.clear();
        this.#renderFilterChoices();
        break;
      case "filter-select-visible": {
        const visible = this.#visibleFilterOptions();
        this.#filterChosen = new Set(visible.map((option) => option.value));
        this.#renderFilterChoices();
        break;
      }
      case "filter-toggle": {
        const value =
          button.dataset["value"] === "__missing__"
            ? null
            : (button.dataset["value"] ?? null);
        if (this.#filterChosen.has(value)) this.#filterChosen.delete(value);
        else this.#filterChosen.add(value);
        this.#renderFilterChoices();
        break;
      }
      case "filter-clear": {
        const column = button.dataset["column"];
        if (column) delete this.#filters[this.#filterTable][column];
        this.#closeModalSurface();
        this.#page = 1;
        this.#queryForTable();
        this.#render();
        break;
      }
      case "filter-apply": {
        const column = button.dataset["column"];
        if (!column) break;
        const numeric = column === "waitMs" || column === "executionMs";
        if (numeric) {
          const minText = $<HTMLInputElement>("#filter-min")?.value ?? "";
          const maxText = $<HTMLInputElement>("#filter-max")?.value ?? "";
          const min = minText === "" ? "" : Number(minText);
          const max = maxText === "" ? "" : Number(maxText);
          if (
            (min !== "" && (!Number.isFinite(min) || min < 0)) ||
            (max !== "" && (!Number.isFinite(max) || max < 0)) ||
            (min !== "" && max !== "" && min > max)
          ) {
            const error = $("#filter-error");
            if (error) {
              error.hidden = false;
              error.textContent =
                "Podaj poprawny zakres: minimum nie może być większe od maksimum.";
            }
            break;
          }
          const includeUnknown =
            $<HTMLInputElement>("#filter-missing")?.checked ?? false;
          const scale = 1000;
          if (min !== "" || max !== "" || !includeUnknown)
            this.#filters[this.#filterTable][column] = {
              type: "number",
              min: min === "" ? "" : min * scale,
              max: max === "" ? "" : max * scale,
              includeUnknown,
            };
          else delete this.#filters[this.#filterTable][column];
        } else if (this.#filterOptions.length) {
          const all =
            this.#filterOptions.length === this.#filterChosen.size &&
            !this.#filterChosen.has(null);
          if (all) delete this.#filters[this.#filterTable][column];
          else
            this.#filters[this.#filterTable][column] = {
              type: "values",
              values: [...this.#filterChosen],
            };
        } else {
          const query = $<HTMLInputElement>("#filter-text")?.value.trim() ?? "";
          if (query)
            this.#filters[this.#filterTable][column] = { type: "text", query };
          else delete this.#filters[this.#filterTable][column];
        }
        this.#closeModalSurface();
        this.#page = 1;
        this.#queryForTable();
        this.#render();
        break;
      }
      case "reset-table":
        {
          const table: TableName =
            button.dataset["table"] === "logs"
              ? "logs"
              : button.dataset["table"] === "agents"
                ? "agents"
                : "tasks";
          this.#filters[table] = {};
          this.#sorts[table] = [];
          if (table === "tasks") this.#taskRange = "all";
          if (table === "agents") this.#agentRange = "all";
          if (table === "logs") {
            this.#logLevel = "all";
            this.#logSource = "all";
          }
        }
        this.#page = 1;
        this.#queryForTable();
        this.#render();
        break;
      case "page":
        this.#page = Math.max(1, Number(button.dataset["page"]) || 1);
        this.#queryForTable();
        this.#render();
        break;
      case "range":
        if (
          ["all", "open", "history"].includes(String(button.dataset["range"]))
        ) {
          this.#taskRange = button.dataset["range"] as
            "all" | "open" | "history";
          this.#page = 1;
          this.#queryForTable();
          this.#render();
        }
        break;
      case "open-queue":
        this.#view = "tasks";
        this.#taskRange = "open";
        this.#page = 1;
        this.#search = "";
        this.#queryForTable();
        this.#render();
        break;
      case "agent-range":
        if (
          ["all", "confirmed", "history"].includes(
            String(button.dataset["range"]),
          )
        ) {
          this.#agentRange = button.dataset["range"] as
            "all" | "confirmed" | "history";
          this.#page = 1;
          this.#queryForTable();
          this.#render();
        }
        break;
      case "follow":
        this.#follow = !this.#follow;
        this.#render();
        break;
      case "log-level-select":
        this.#logLevel = button.dataset["level"] ?? "all";
        this.#queryForTable();
        this.#render();
        break;
      case "task":
        if (button.dataset["id"]) void this.#openTask(button.dataset["id"]);
        break;
      case "agent":
        if (button.dataset["id"])
          void this.#openAgent(
            button.dataset["id"],
            button.dataset["project"] ??
              (this.#scope.kind === "project" ? this.#scope.projectId : ""),
          );
        break;
      case "task-agent":
        if (button.dataset["id"] && this.#modal?.type === "task")
          void this.#openAgent(
            button.dataset["id"],
            this.#modal.projectId,
            this.#modal,
          );
        break;
      case "log": {
        const logId = button.dataset["id"];
        const currentTask = this.#modal?.type === "task" ? this.#modal : null;
        const log = [
          ...(this.#state()?.pages.logs?.rows ?? []),
          ...(currentTask?.events ?? []),
        ].find((row) => nonemptyId(row["id"]) && row["id"] === logId);
        if (log) {
          const owner =
            currentTask?.projectId ??
            (this.#scope.kind === "project"
              ? this.#scope.projectId
              : text(log, "projectId"));
          if (!nonemptyId(owner)) break;
          this.#rememberModalFocus();
          this.#modal = {
            type: "log",
            log: safeClone(log),
            projectId: owner,
            revision: currentTask?.revision ?? this.#state()?.revision ?? null,
            ...(currentTask ? { returnTask: safeClone(currentTask) } : {}),
          };
          this.#renderModal(true);
        }
        break;
      }
      case "log-task": {
        if (
          this.#modal?.type === "log" &&
          nonemptyId(this.#modal.log["taskId"])
        )
          void this.#openTaskFromLog(this.#modal);
        break;
      }
      case "search-result":
        void this.#openSearchResult(
          button.dataset["kind"] ?? "",
          button.dataset["id"] ?? "",
          button.dataset["project"] ?? "",
        );
        break;
      case "back-task":
        if (this.#modal?.type === "log" && this.#modal.returnTask) {
          this.#modal = this.#modal.returnTask;
          this.#renderModal(true);
        } else if (this.#modal?.type === "agent" && this.#modal.returnTask) {
          this.#modal = this.#modal.returnTask;
          this.#renderModal(true);
        }
        break;
      case "back-log":
        if (this.#modal?.type === "task" && this.#modal.returnLog) {
          this.#modal = this.#modal.returnLog;
          this.#renderModal(true);
        }
        break;
      case "back-agent":
        if (this.#returnAgent) {
          this.#modal = this.#returnAgent;
          this.#returnAgent = null;
          this.#view = "agents";
          this.#renderModal(true);
        }
        break;
      case "agent-logs":
        if (this.#modal?.type === "agent")
          void this.#openAgentLogs(this.#modal);
        break;
      case "task-tab": {
        if (this.#modal?.type !== "task") break;
        const tab = button.dataset["tab"];
        if (["details", "events", "code", "response"].includes(String(tab))) {
          this.#modal.tab = tab as Extract<ModalState, { type: "task" }>["tab"];
          this.#modal.artifact = null;
          this.#modal.artifactMissingReason = null;
          this.#modal.artifactKind = null;
          this.#renderModal();
          if (tab === "events") void this.#loadTaskEvents();
        }
        break;
      }
      case "artifact": {
        const kind = button.dataset["kind"];
        if (
          [
            "original-source",
            "sent-source",
            "current-file",
            "response",
            "stdout",
            "stderr",
            "rpc",
            "event",
          ].includes(String(kind))
        )
          void this.#loadArtifact(kind as ArtifactKind);
        break;
      }
      case "task-refresh":
        if (this.#modal?.type === "task") {
          const id = rowTaskId(this.#modal.task);
          if (id) void this.#refreshTask(id);
        }
        break;
      case "copy-artifact":
        if (
          this.#modal?.type === "task" &&
          this.#modal.artifact?.content !== null &&
          this.#modal.artifact?.content !== undefined
        )
          void this.#copy(this.#modal.artifact.content);
        break;
      case "copy-hash":
        if (this.#modal?.type === "task") {
          const artifacts = record(this.#modal.task["artifacts"]);
          const rawRef =
            artifacts[
              artifactSlot(this.#modal.artifactKind ?? "original-source")
            ];
          const ref = record(Array.isArray(rawRef) ? rawRef[0] : rawRef);
          const hash =
            text(ref, "sourceHash") ?? text(this.#modal.task, "sourceHash");
          if (hash) void this.#copy(hash);
        }
        break;
      case "copy-log":
        if (this.#modal?.type === "log")
          void this.#copy(JSON.stringify(this.#modal.log, null, 2));
        break;
      case "export":
        this.#showExport(
          (button.dataset["collection"] as Collection | undefined) ??
            (this.#view === "logs" ? "logs" : "tasks"),
        );
        break;
      case "export-format":
        void this.#export(
          (button.dataset["collection"] as Collection | undefined) ??
            (this.#view === "logs" ? "logs" : "tasks"),
          button.dataset["format"] === "json" ? "json" : "csv",
        );
        break;
      case "global-search":
        this.#searchDialog();
        break;
      case "settings":
        this.#showSettings();
        break;
      case "help":
        this.#showHelp();
        break;
      case "close":
        this.#closeModalSurface();
        break;
      default:
        break;
    }
  }

  async #changeScope(scope: QueryScope): Promise<void> {
    this.#scope = scope;
    this.#mobile = false;
    this.#page = 1;
    this.#filters = { tasks: {}, agents: {}, logs: {} };
    this.#sorts = { tasks: [], agents: [], logs: [] };
    this.#search = "";
    this.#modal = null;
    this.#source?.close();
    await this.#load(scope, false);
    this.#watch();
  }

  async #refreshTask(id: string): Promise<void> {
    const state = this.#modal;
    if (state?.type !== "task") return;
    const modal = { ...state, loading: true };
    this.#modal = modal;
    this.#renderModal();
    try {
      const snapshot = await this.#api.snapshot({
        kind: "project",
        projectId: modal.projectId,
      });
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope: { kind: "project", projectId: modal.projectId },
        collection: "tasks",
        snapshotToken: snapshot.snapshotToken,
        limit: 1,
        filters: { id },
      });
      const fresh = page.rows.find((row) => rowTaskId(row) === id);
      if (fresh) {
        this.#modal = {
          ...modal,
          task: safeClone(fresh),
          snapshotToken: page.snapshotToken,
          revision: page.revision,
          sources: snapshot.sources,
          events: null,
          eventStatus: null,
          artifact: null,
          artifactMissingReason: null,
          loading: false,
        };
      } else {
        this.#modal = { ...modal, loading: false };
        this.#toast(
          "Zadania nie ma w świeżym snapshotcie; zachowano otwarty zapis.",
        );
      }
    } catch (error) {
      this.#modal = { ...modal, loading: false };
      this.#toast(this.#error(error));
    }
    this.#renderModal();
  }

  async #openAgent(
    id: string,
    owner: string,
    returnTask?: Extract<ModalState, { type: "task" }>,
  ): Promise<void> {
    if (!nonemptyId(id) || !nonemptyId(owner)) {
      this.#toast(localeText.t("ui.agent.identity.unavailable"));
      return;
    }
    try {
      const scope = { kind: "project" as const, projectId: owner };
      const snapshot = await this.#api.snapshot(scope);
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope,
        collection: "agents",
        snapshotToken: snapshot.snapshotToken,
        filters: { id },
        limit: 8,
      });
      const agent = page.rows.find((row) =>
        [row["id"], row["clientId"], row["sessionId"]].some(
          (candidate) => nonemptyId(candidate) && candidate === id,
        ),
      );
      if (!agent) {
        this.#toast(localeText.t("ui.agent.identity.unavailable"));
        return;
      }
      if (!returnTask) this.#rememberModalFocus();
      this.#modal = {
        type: "agent",
        agent: safeClone(agent),
        projectId: owner,
        revision: page.revision,
        ...(returnTask ? { returnTask: safeClone(returnTask) } : {}),
      };
      this.#renderModal(true);
    } catch (error) {
      this.#toast(this.#error(error));
    }
  }

  async #openTaskFromLog(
    logModal: Extract<ModalState, { type: "log" }>,
  ): Promise<void> {
    const taskId = logModal.log["taskId"];
    const requestId = logModal.log["requestId"];
    if (!nonemptyId(taskId) && !nonemptyId(requestId)) {
      this.#toast("Zdarzenie nie ma niepustego task ID ani request ID.");
      return;
    }
    try {
      const scope = { kind: "project" as const, projectId: logModal.projectId };
      const snapshot = await this.#api.snapshot(scope);
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope,
        collection: "tasks",
        snapshotToken: snapshot.snapshotToken,
        filters: nonemptyId(taskId)
          ? { id: taskId }
          : { requestId: requestId as string },
        limit: 1,
      });
      const task = page.rows.find((row) =>
        nonemptyId(taskId)
          ? rowTaskId(row) === taskId
          : nonemptyId(row["requestId"]) && row["requestId"] === requestId,
      );
      if (!task) {
        this.#toast("Powiązanego zadania nie ma w zachowanym zakresie.");
        return;
      }
      this.#showTask(
        task,
        logModal.projectId,
        page.snapshotToken,
        page.revision,
        logModal,
        snapshot.sources,
      );
    } catch (error) {
      this.#toast(this.#error(error));
    }
  }

  async #openSearchResult(
    kind: string,
    id: string,
    owner: string,
  ): Promise<void> {
    if (!nonemptyId(id)) return;
    if (kind === "project") {
      this.#closeModalSurface();
      await this.#changeScope({ kind: "project", projectId: id });
      return;
    }
    if (!nonemptyId(owner)) {
      this.#toast(
        "Wynik nie zgłosił project ID; szczegółów nie można otworzyć.",
      );
      return;
    }
    this.#auxiliaryModal = null;
    if (kind === "agent") {
      await this.#openAgent(id, owner);
      return;
    }
    if (kind !== "task") return;
    try {
      const scope = { kind: "project" as const, projectId: owner };
      const snapshot = await this.#api.snapshot(scope);
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope,
        collection: "tasks",
        snapshotToken: snapshot.snapshotToken,
        filters: { id },
        limit: 1,
      });
      const task = page.rows.find((row) => rowTaskId(row) === id);
      if (task)
        this.#showTask(
          task,
          owner,
          page.snapshotToken,
          page.revision,
          undefined,
          snapshot.sources,
        );
      else this.#toast(localeText.t("ui.project.task.unavailable"));
    } catch (error) {
      this.#toast(this.#error(error));
    }
  }

  async #openAgentLogs(agent: AgentReturn): Promise<void> {
    const identity = nonemptyId(agent.agent["clientId"])
      ? agent.agent["clientId"]
      : nonemptyId(agent.agent["id"])
        ? agent.agent["id"]
        : null;
    if (!identity) {
      this.#toast("Agent nie ma niepustej tożsamości do powiązania logów.");
      return;
    }
    this.#returnAgent = safeClone(agent);
    this.#scope = { kind: "project", projectId: agent.projectId };
    this.#view = "logs";
    this.#filters = {
      ...this.#filters,
      logs: { clientId: { type: "values", values: [identity] } },
    };
    this.#sorts.logs = [];
    this.#search = "";
    this.#page = 1;
    this.#modal = null;
    this.#closeModalSurface();
    await this.#load(this.#scope, false);
    this.#watch();
  }

  #onInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (["task-search", "agent-search", "log-search"].includes(target.id)) {
      this.#search = target.value;
      this.#page = 1;
      if (this.#searchTimer !== null) window.clearTimeout(this.#searchTimer);
      this.#searchTimer = window.setTimeout(() => {
        this.#searchTimer = null;
        this.#queryForTable();
      }, 180);
    }
    if (target.id === "filter-value-search") {
      this.#filterSearch = target.value;
      this.#renderFilterChoices();
    }
    if (target.id === "global-search-input") {
      this.#globalSearchSerial += 1;
      if (this.#searchTimer !== null) window.clearTimeout(this.#searchTimer);
      this.#searchTimer = window.setTimeout(() => {
        this.#searchTimer = null;
        void this.#globalSearch(target.value);
      }, 180);
    }
  }

  #onChange(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.id === "heartbeat") {
      this.#showHeartbeat = target.checked;
      this.#render();
      return;
    }
    if (!(target instanceof HTMLSelectElement)) return;
    if (target.dataset["action"] === "scope-select") {
      void this.#changeScope(scopeParam(target.value));
    } else if (target.id === "log-level") {
      this.#logLevel = target.value;
      this.#queryForTable();
    } else if (target.id === "log-source") {
      this.#logSource = target.value;
      this.#queryForTable();
    } else if (target.id === "refresh-interval") {
      const value = Number(target.value);
      if (![2000, 4000, 8000].includes(value)) return;
      this.#refreshInterval = value;
      try {
        const saved: unknown = JSON.parse(
          localStorage.getItem("fmcad-prefs") ?? "{}",
        );
        localStorage.setItem(
          "fmcad-prefs",
          JSON.stringify({ ...record(saved), refreshIntervalMs: value }),
        );
      } catch {
        // The selected interval remains active for this page if storage is blocked.
      }
      this.#closeModalSurface();
      this.#render();
      this.#toast("Częstotliwość odświeżania została zaktualizowana.");
    }
  }

  #onKeyDown(event: KeyboardEvent): void {
    const target = event.target;
    const editing =
      target instanceof HTMLElement &&
      target.matches("input,textarea,select,[contenteditable=true]");
    if (event.key === "Escape" && (this.#modal || this.#auxiliaryModal)) {
      this.#closeModalSurface();
      return;
    }
    if (event.key === "Escape" && this.#mobile) {
      this.#mobile = false;
      this.#render();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      this.#searchDialog();
      return;
    }
    if (event.key === "Tab" && (this.#modal || this.#auxiliaryModal)) {
      const dialog = $(".modal, .column-filter-popup");
      const items = dialog
        ? [
            ...dialog.querySelectorAll<HTMLElement>(
              'button:not([disabled]),a[href],input,select,textarea,[tabindex="0"]',
            ),
          ].filter(
            (element) =>
              !element.matches("[data-select-native]") &&
              !element.hidden &&
              element.getAttribute("aria-hidden") !== "true",
          )
        : [];
      if (!items.length) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === dialog)
      ) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (this.#modal?.type === "task" && !editing) {
      const key = event.key.toLowerCase();
      const tabs: Partial<
        Record<string, Extract<ModalState, { type: "task" }>["tab"]>
      > = {
        p: "code",
        y: "response",
        g: "events",
      };
      if (tabs[key]) {
        event.preventDefault();
        this.#modal.tab = tabs[key]!;
        this.#modal.artifact = null;
        this.#modal.artifactMissingReason = null;
        this.#modal.artifactKind = null;
        this.#renderModal();
        if (tabs[key] === "events") void this.#loadTaskEvents();
      } else if (key === "a") {
        const identity = nonemptyId(this.#modal.task["agentId"])
          ? this.#modal.task["agentId"]
          : this.#modal.task["clientId"];
        if (nonemptyId(identity)) {
          event.preventDefault();
          void this.#openAgent(identity, this.#modal.projectId, this.#modal);
        }
      }
      return;
    }
    if (this.#modal || this.#auxiliaryModal) return;
    if (editing || event.ctrlKey || event.metaKey || event.altKey) return;
    const views: Record<string, View> = {
      "1": "overview",
      "2": "tasks",
      "3": "agents",
      "4": "logs",
    };
    if (views[event.key]) {
      event.preventDefault();
      this.#view = views[event.key]!;
      this.#render();
    } else if (event.key === "/") {
      event.preventDefault();
      $("#task-search, #agent-search, #log-search")?.focus();
    } else if (event.key.toLowerCase() === "f") {
      this.#openFilter(
        this.#view === "logs"
          ? "level"
          : this.#view === "agents"
            ? "presence"
            : "state",
      );
    } else if (event.key.toLowerCase() === "o") {
      $(".column-sort")?.focus({ preventScroll: true });
    } else if (event.key.toLowerCase() === "l") {
      if (this.#view === "logs") this.#follow = !this.#follow;
      else this.#view = "logs";
      this.#page = 1;
      this.#queryForTable();
      this.#render();
    } else if (event.key.toLowerCase() === "c") {
      this.#selects.focus("scope-select");
    } else if (event.key === "?") {
      this.#showHelp();
    } else if (event.key === ",") {
      this.#showSettings();
    } else if (event.key === " ") {
      if (
        target instanceof HTMLElement &&
        target.matches("button,[role=button]")
      )
        return;
      event.preventDefault();
      this.#frozen = !this.#frozen;
      if (!this.#frozen && this.#latest) this.#visible = this.#latest;
      this.#render();
    } else if (event.key.toLowerCase() === "r") {
      void this.#load(this.#scope, false);
    } else if (event.key.toLowerCase() === "e") {
      this.#showExport(
        this.#view === "logs"
          ? "logs"
          : this.#view === "agents"
            ? "agents"
            : "tasks",
      );
    } else if (
      event.key === "Enter" &&
      target instanceof HTMLElement &&
      target.matches(
        '[data-action="task"],[data-action="agent"],[data-action="log"]',
      )
    ) {
      event.preventDefault();
      target.click();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const rows = [
        ...document.querySelectorAll<HTMLElement>(
          '#main [data-action="task"],#main [data-action="agent"],#main [data-action="log"]',
        ),
      ];
      if (!rows.length) return;
      event.preventDefault();
      const index = rows.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "ArrowDown"
          ? Math.min(rows.length - 1, index + 1)
          : Math.max(0, index < 0 ? 0 : index - 1);
      rows[next]?.focus({ preventScroll: true });
    }
  }

  #openFilter(column: string, preserveState = false): void {
    if (!column) return;
    const preservedSearch = preserveState ? this.#filterSearch : "";
    const preservedChosen = preserveState ? this.#filterChosen : null;
    this.#filterTable =
      this.#view === "logs"
        ? "logs"
        : this.#view === "agents"
          ? "agents"
          : "tasks";
    const filter = this.#filters[this.#filterTable][column];
    const isNumber = column === "waitMs" || column === "executionMs";
    const state = this.#latest;
    const collection = this.#filterTable;
    const page = state?.pages[collection];
    const categorical =
      collection === "tasks"
        ? ["state", "clientId", "projectId"].includes(column)
        : collection === "agents"
          ? ["presence", "kind"].includes(column)
          : ["level", "source"].includes(column);
    const facets = categorical ? (page?.facets[column] ?? {}) : {};
    this.#filterOptions = Object.entries(facets)
      .filter(([value]) => value !== "\u0000missing")
      .map(([value, count]) => ({
        value,
        count,
        label: column === "state" ? stateLabel(value) : value,
      }));
    const knownCount = this.#filterOptions.reduce(
      (sum, option) => sum + option.count,
      0,
    );
    if (
      categorical &&
      page?.total !== null &&
      page?.total !== undefined &&
      page.total > knownCount
    )
      this.#filterOptions = [
        ...this.#filterOptions,
        { value: null, count: page.total - knownCount, label: "Brak danych" },
      ];
    this.#filterColumn = column;
    this.#filterSearch = preservedSearch;
    this.#filterChosen =
      preservedChosen ??
      (filter?.type === "values"
        ? new Set(
            filter.values.map((value) =>
              value === null ? null : String(value),
            ),
          )
        : new Set(this.#filterOptions.map((option) => option.value)));
    const body = isNumber
      ? `<p class="column-filter-description">Zakres wartości · sekundy</p><div class="column-number-range"><label for="filter-min">Od<input id="filter-min" type="number" min="0" step="any" value="${filter?.type === "number" && filter.min !== "" ? esc(typeof filter.min === "number" ? filter.min / 1000 : "") : ""}"></label><span>—</span><label for="filter-max">Do<input id="filter-max" type="number" min="0" step="any" value="${filter?.type === "number" && filter.max !== "" ? esc(typeof filter.max === "number" ? filter.max / 1000 : "") : ""}"></label></div><label class="column-unknown"><input id="filter-missing" type="checkbox" ${filter?.type !== "number" || filter.includeUnknown ? "checked" : ""}>Uwzględnij brak danych</label>`
      : this.#filterOptions.length
        ? `<div class="column-value-search">${icon("search", "small")}<input id="filter-value-search" type="search" autocomplete="off" value="${esc(this.#filterSearch)}" placeholder="Szukaj wartości…" aria-label="Szukaj wartości kolumny"></div><div class="column-choice-actions"><button type="button" data-action="filter-select-visible">Tylko widoczne</button><button type="button" data-action="filter-select-all">Wszystkie</button><button type="button" data-action="filter-select-none">Żadne</button></div><div class="column-values" id="filter-values"></div><div class="column-selection-note" id="filter-selection-note" aria-live="polite"></div>`
        : `<label class="column-text-label" for="filter-text">Zawiera tekst</label><input id="filter-text" type="search" value="${filter?.type === "text" ? esc(filter.query) : ""}"><p class="column-filter-description">Wyszukiwanie bez rozróżniania wielkości liter.</p>`;
    this.#mountOverlay(
      "filter",
      `<div class="overlay" data-action="backdrop"><section class="column-filter-popup" role="dialog" aria-modal="true" aria-labelledby="column-filter-title" tabindex="-1"><header><div><span>FILTR KOLUMNY</span><h3 id="column-filter-title">${esc(column)}</h3></div><button class="icon-button" data-action="close" aria-label="Zamknij filtr">${icon("close", "small")}</button></header><div class="column-filter-body">${body}<p id="filter-error" class="field-error" role="alert" hidden></p></div><footer><button class="btn small" data-action="filter-clear" data-column="${esc(column)}">Wyczyść</button><button class="btn primary small" data-action="filter-apply" data-column="${esc(column)}">Zastosuj</button></footer></section></div>`,
      isNumber
        ? "#filter-min"
        : this.#filterOptions.length
          ? "#filter-value-search"
          : "#filter-text",
    );
    if (!isNumber && this.#filterOptions.length)
      $("#filter-value-search")?.focus();
    this.#renderFilterChoices();
  }

  #visibleFilterOptions(): readonly {
    value: string | null;
    count: number;
    label: string;
  }[] {
    const query = this.#filterSearch
      .trim()
      .toLocaleLowerCase(localeText.locale);
    return this.#filterOptions.filter((option) =>
      option.label.toLocaleLowerCase(localeText.locale).includes(query),
    );
  }

  #renderFilterChoices(): void {
    const host = document.getElementById("filter-values");
    if (!host) return;
    const rows = this.#visibleFilterOptions();
    host.innerHTML = rows.length
      ? rows
          .map(
            (option) =>
              `<button type="button" class="column-choice" data-action="filter-toggle" data-value="${option.value === null ? "__missing__" : esc(option.value)}" aria-pressed="${this.#filterChosen.has(option.value)}"><span class="column-choice-check">${this.#filterChosen.has(option.value) ? icon("check", "small") : ""}</span><span><strong>${esc(option.label)}</strong></span><span class="column-value-count">${localeText.formatNumber(option.count)}</span></button>`,
          )
          .join("")
      : `<p class="column-no-values">${localeText.t("common.noResults")}</p>`;
    const note = document.getElementById("filter-selection-note");
    if (note)
      note.textContent = `${localeText.formatNumber(this.#filterChosen.size)} / ${localeText.formatNumber(this.#filterOptions.length)}`;
  }

  #searchDialog(query = "", results = ""): void {
    this.#mountOverlay(
      "search",
      `<div class="overlay" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><header class="modal-header"><h2 id="modal-title">Szukaj w przestrzeni roboczej</h2><button class="icon-button" data-action="close" aria-label="Zamknij">${icon("close")}</button></header><div class="modal-body"><label class="search-box global-modal-search">${icon("search")}<input id="global-search-input" type="search" placeholder="Projekt, zadanie, agent, ID…" aria-label="Szukaj globalnie" autocomplete="off" value="${esc(query)}"></label><div id="global-results" class="global-search-results">${results}</div></div></section></div>`,
      "#global-search-input",
    );
  }

  async #globalSearch(query: string): Promise<void> {
    const holder = document.getElementById("global-results");
    if (!holder) return;
    const serial = ++this.#globalSearchSerial;
    const needle = query.trim();
    if (!needle) {
      holder.innerHTML = this.#empty(
        "Wpisz wyszukiwaną frazę",
        "Wyszukiwanie korzysta wyłącznie z danych dostępnych przez API.",
        "search",
      );
      return;
    }
    holder.innerHTML = this.#empty(
      "Wyszukiwanie…",
      "Odczyt z globalnego zakresu.",
      "search",
    );
    try {
      const snapshot = await this.#api.snapshot({ kind: "global" });
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope: { kind: "global" },
        collection: "search",
        snapshotToken: snapshot.snapshotToken,
        search: needle,
        limit: 20,
      });
      if (
        serial !== this.#globalSearchSerial ||
        !document.getElementById("global-results")
      )
        return;
      holder.innerHTML =
        page.rows
          .map((result) => {
            const row = record(result["record"]);
            const type = text(result, "resultType");
            if (!type || !["project", "agent", "task"].includes(type))
              return "";
            const id = projectId(row) ?? text(row, "id");
            if (!id) return "";
            return `<button class="search-result" data-action="search-result" data-kind="${type}" data-id="${esc(id)}" data-project="${esc(text(row, "projectId") ?? "")}">${icon(type === "project" ? "folder" : type === "agent" ? "users" : "code")}<div><strong>${esc(text(row, "name") ?? text(row, "label") ?? text(row, "kind") ?? id)}</strong><small>${esc(type)} · ${esc(text(row, "state") ?? text(row, "projectName") ?? "")}</small></div>${icon("chevron", "small")}</button>`;
          })
          .join("") ||
        this.#empty(
          "Brak wyników",
          "Spróbuj innej nazwy lub fragmentu.",
          "search",
        );
    } catch (error) {
      if (serial !== this.#globalSearchSerial) return;
      holder.innerHTML = this.#empty(
        "Wyszukiwanie niedostępne",
        this.#error(error),
        "alert",
      );
    }
  }

  #showHelp(): void {
    this.#mountOverlay(
      "help",
      `<div class="overlay" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><header class="modal-header"><h2 id="modal-title">Pomoc i skróty</h2><button class="icon-button" data-action="close">${icon("close")}</button></header><div class="modal-body"><p>Widoki używają wyłącznie odczytów z lokalnego Console Query API.</p>${[
        ["Przegląd / Zadania / Agenci / Logi", "1–4"],
        ["Wyszukiwanie w widoku", "/"],
        ["Wyszukiwanie globalne", "Ctrl K"],
        ["Filtry / sortowanie", "f / o"],
        ["Sortowanie wielu kolumn", "Ctrl + klik"],
        ["Zamroź / wznów podgląd", "Spacja"],
        ["Śledzenie logów", "l"],
        ["Zakres projektu", "c"],
        ["Odśwież", "r"],
        ["Eksportuj", "e"],
        ["Ustawienia podglądu", ","],
        ["W zadaniu: kod / odpowiedź", "p / y"],
        ["W zadaniu: zdarzenia / agent", "g / a"],
        ["Zamknij okno", "Esc"],
      ]
        .map(
          ([label, key]) =>
            `<div class="shortcut-row"><span>${label}</span><kbd>${key}</kbd></div>`,
        )
        .join(
          "",
        )}<p class="details-note">Zamrożenie dotyczy widoku przeglądarki, a nie pracy brokera. Automatyczne odczyty są wyzwalane przez powiadomienia zmian źródła.</p></div></section></div>`,
      ".modal",
    );
  }

  #showSettings(): void {
    this.#mountOverlay(
      "settings",
      `<div class="overlay" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><header class="modal-header"><h2 id="modal-title">Ustawienia podglądu</h2><button class="icon-button" data-action="close" aria-label="Zamknij">${icon("close")}</button></header><div class="modal-body"><div class="field"><label class="modal-label" for="refresh-interval">Odstęp między aktualizacjami widoku</label><select id="refresh-interval"><option value="2000" ${this.#refreshInterval === 2000 ? "selected" : ""}>Co 2 sekundy · szybka</option><option value="4000" ${this.#refreshInterval === 4000 ? "selected" : ""}>Co 4 sekundy · standardowa</option><option value="8000" ${this.#refreshInterval === 8000 ? "selected" : ""}>Co 8 sekund · spokojna</option></select><small>Widok pobiera nowy snapshot po powiadomieniu SSE. Interwał scala serię zmian; nie działa tu własny polling ani generator danych.</small></div></div></section></div>`,
      ".modal",
    );
  }

  #showExport(collection: Collection): void {
    this.#exportCollection = collection;
    this.#mountOverlay(
      "export",
      `<div class="overlay" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><header class="modal-header"><h2 id="modal-title">Eksport danych</h2><button class="icon-button" data-action="close" aria-label="Zamknij">${icon("close")}</button></header><div class="modal-body"><p>Eksport obejmuje cały retained scope i aktualne filtry, niezależnie od bieżącej strony.</p><button class="source-option" data-action="export-format" data-collection="${esc(collection)}" data-format="csv"><span class="source-option-icon">${icon("file")}</span><div><strong>CSV · pełny wynik</strong><p>Separator i formuły obsługuje serwer eksportu.</p></div>${icon("download", "small")}</button><button class="source-option" data-action="export-format" data-collection="${esc(collection)}" data-format="json"><span class="source-option-icon">${icon("code")}</span><div><strong>JSON · pełny wynik</strong><p>Wersjonowany eksport wybranego zakresu.</p></div>${icon("download", "small")}</button></div></section></div>`,
      ".modal",
    );
  }
}

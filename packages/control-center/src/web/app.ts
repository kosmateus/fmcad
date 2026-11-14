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
  createAgentsProjectsFeature,
  renderAgentDetail,
  renderAgentList,
  renderProjectActionDialog,
  renderProjectActionStatus,
  renderProjectList,
  renderTechnicalSessionDetail,
  renderTechnicalSessions,
  type AgentFilter,
  type AgentAliasIdentity,
  type AgentsProjectsLocaleText,
  type ProjectActionResponse,
  type ProjectListFilter,
  type TechnicalSessionFilter,
} from "./agents-projects.js";
import {
  mountLocaleSelector,
  type LocaleSelectorHandle,
} from "./locale-selector.js";
import type { MessageKey } from "./locale-catalogs.js";
import {
  createSystemControlCommand,
  renderSystemControlConfirmation,
  renderSystemControlReceipt,
  renderSystemControls,
  SystemControlsClient,
  SystemControlsClientError,
} from "./system-controls.js";
import type {
  SystemControlAction,
  SystemControlCommand,
  SystemControlReceipt,
  SystemControlStatus,
} from "../contracts/system-controls.js";
import type { ConsoleProjectRecord } from "../contracts/query.js";

type Collection = QueryRequest["collection"];
type TableName = "tasks" | "agents" | "logs";
type TableRequestOptions = Partial<
  Pick<
    QueryRequest,
    "search" | "filters" | "sort" | "offset" | "limit" | "facetFields"
  >
>;
type Row = Record<string, unknown>;
type View = "overview" | "tasks" | "agents" | "logs" | "system" | "projects";
type AuxiliaryModal =
  | "filter"
  | "search"
  | "settings"
  | "help"
  | "export"
  | "project-action"
  | "system-control-confirm";
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
      snapshotToken: string;
      tasks: readonly Row[] | null;
      files: readonly Row[] | null;
      taskOffset: number;
      taskTotal: number | null;
      projectArchived: boolean;
      loading: boolean;
      returnTask?: Extract<ModalState, { type: "task" }>;
    }
  | {
      type: "session";
      session: Row;
      projectId: string;
      snapshotToken: string;
      revision: Revision | null;
      tasks: readonly Row[] | null;
      events: readonly Row[] | null;
      taskOffset: number;
      taskTotal: number | null;
      loading: boolean;
    };
type AgentReturn = Extract<ModalState, { type: "agent" }>;
type ProjectActionDialog = {
  project: Row;
  action: "archive" | "restore";
  revision: Revision;
  status: ProjectActionResponse | null;
};
type AgentsProjectsFeaturePage = {
  snapshot: { snapshotToken: string; revision: Revision };
  page: QueryPage<Row>;
  rows: readonly Row[];
};
type AgentsProjectsFeatureApi = {
  projectRevision(projectId: string): Promise<Revision>;
  favoriteProject(projectId: string, favorite?: boolean): boolean;
  isFavorite(projectId: string): boolean;
  listTechnicalSessions(
    scope: QueryScope,
    input: {
      filter?: TechnicalSessionFilter;
      search?: string;
      offset?: number;
      limit?: number;
    },
  ): Promise<AgentsProjectsFeaturePage>;
  listAgents(
    scope: QueryScope,
    input: {
      filter?: AgentFilter;
      search?: string;
      offset?: number;
      limit?: number;
    },
  ): Promise<AgentsProjectsFeaturePage>;
  listAgentTasks(
    projectId: string,
    agent: Row,
    input: { offset?: number; limit?: number },
  ): Promise<AgentsProjectsFeaturePage>;
  taskDetailsForFile(
    projectId: string,
    file: Row,
    snapshotToken: string,
  ): Promise<{
    task: Row;
    artifact: ArtifactResult | null;
    artifactUnavailable: boolean;
    unavailableMessage: string | null;
  }>;
  setProjectAlias(
    projectId: string,
    alias: string,
    revision: Revision,
  ): Promise<ProjectActionResponse>;
  resetProjectAlias(
    projectId: string,
    revision: Revision,
  ): Promise<ProjectActionResponse>;
  setAgentAlias(
    projectId: string,
    identity: AgentAliasIdentity,
    alias: string,
    revision: Revision,
  ): Promise<ProjectActionResponse>;
  resetAgentAlias(
    projectId: string,
    identity: AgentAliasIdentity,
    revision: Revision,
  ): Promise<ProjectActionResponse>;
  archiveProject(
    projectId: string,
    revision: Revision,
  ): Promise<ProjectActionResponse>;
  restoreProject(
    projectId: string,
    revision: Revision,
  ): Promise<ProjectActionResponse>;
};

const agentsProjectsLocale: AgentsProjectsLocaleText = {
  t: (key, params) => localeText.t(key as MessageKey, params),
  formatNumber: (value) => localeText.formatNumber(value),
  formatDate: (value) => localeText.formatDate(value),
  formatDuration: (milliseconds) => localeText.formatDuration(milliseconds),
  subscribe: (listener) => localeText.subscribe(() => listener()),
};

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
  readonly #agentsProjects: AgentsProjectsFeatureApi;
  readonly #systemControls: SystemControlsClient;
  readonly #root: HTMLElement;
  readonly #selects = createSelectControls();
  readonly #listeners = new AbortController();
  #localeSelector: LocaleSelectorHandle | null = null;
  #unsubscribeLocale: (() => void) | null = null;
  #started = false;
  #startPromise: Promise<void> | null = null;
  #modalGeneration = 0;
  #toastTimer: number | null = null;
  #localeRenderQueued = false;
  #systemControlsInitialized = false;
  #systemControlsMount = 0;
  #systemControlsReadSerial = 0;
  #systemControlStatus: SystemControlStatus | null = null;
  #systemControlReceipt: SystemControlReceipt | null = null;
  #systemControlAction: SystemControlAction | null = null;
  #scope: QueryScope = { kind: "global" };
  #view: View = "overview";
  #visible: LoadState | null = null;
  #latest: LoadState | null = null;
  #projects: readonly Row[] = [];
  #projectTotal: number | null = null;
  #projectFilter: ProjectListFilter = "all";
  #projectsSearch = "";
  #projectRevisions = new Map<string, Revision>();
  #projectRevisionKey = "";
  #projectRevisionLoad = 0;
  #projectActionDialog: ProjectActionDialog | null = null;
  #projectActionBusy = false;
  #technicalSessions: readonly Row[] | null = null;
  #technicalSessionsSource = "";
  #technicalSessionFilter: TechnicalSessionFilter = "all";
  #workingAgents: readonly Row[] | null = null;
  #workingAgentsLoading = false;
  #workingAgentsUnavailable = false;
  #workingAgentLoad = 0;
  #agentViewLoad = 0;
  #projectRevisionStatus = "";
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
  #agentRange: AgentFilter = "all";
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
    this.#agentsProjects = createAgentsProjectsFeature({
      query: this.#api,
      actions: { execute: (request) => this.#api.projectAction(request) },
      localeText: agentsProjectsLocale,
    }) as unknown as AgentsProjectsFeatureApi;
    this.#systemControls = new SystemControlsClient(origin);
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
    document.addEventListener("submit", (event) => this.#onSubmit(event), {
      signal,
    });
    document.addEventListener("keydown", (event) => this.#onKeyDown(event), {
      signal,
    });
    document.addEventListener(
      "click",
      (event) => this.#onSystemControlsClick(event),
      { signal },
    );
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

  start(): Promise<void> {
    if (this.#listeners.signal.aborted) return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    const initialProject = new URL(window.location.href).searchParams.get(
      "project",
    );
    if (initialProject)
      this.#scope = { kind: "project", projectId: initialProject };
    this.#started = true;
    this.#syncDocumentLocale();
    this.#render();
    this.#startPromise = this.#load(this.#scope, false).then(() =>
      this.#watch(),
    );
    return this.#startPromise;
  }

  dispose(): void {
    if (this.#listeners.signal.aborted) return;
    this.#listeners.abort();
    this.#modalGeneration += 1;
    this.#globalSearchSerial += 1;
    this.#artifactLoadSerial += 1;
    this.#modal = null;
    this.#latest = null;
    this.#visible = null;
    if (this.#toastTimer !== null) window.clearTimeout(this.#toastTimer);
    document.getElementById("toast")?.classList.remove("visible");
    this.#loadGeneration += 1;
    this.#systemControlsReadSerial += 1;
    this.#systemControlsMount += 1;
    this.#agentViewLoad += 1;
    this.#workingAgentLoad += 1;
    this.#projectRevisionLoad += 1;
    this.#unsubscribeLocale?.();
    this.#unsubscribeLocale = null;
    this.#localeSelector?.dispose();
    this.#localeSelector = null;
    this.#selects.dispose();
    this.#source?.close();
    this.#source = null;
    if (this.#refreshTimer !== null) window.clearTimeout(this.#refreshTimer);
    if (this.#searchTimer !== null) window.clearTimeout(this.#searchTimer);
    this.#modal = null;
    this.#auxiliaryModal = null;
    this.#projectActionDialog = null;
    this.#modalReturnFocus = null;
    this.#returnAgent = null;
    this.#visible = null;
    this.#latest = null;
    this.#projects = [];
    this.#projectRevisions.clear();
    this.#technicalSessions = null;
    this.#workingAgents = null;
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

  #mountSystemControls(): void {
    const mount = ++this.#systemControlsMount;
    this.#systemControlsInitialized = true;
    void (async () => {
      await this.#refreshSystemControls(false);
      if (this.#listeners.signal.aborted || mount !== this.#systemControlsMount)
        return;
      let receipt: SystemControlReceipt | null = null;
      try {
        receipt = await this.#systemControls.reconcilePending();
      } catch {
        receipt = null;
      }
      if (this.#view !== "system" || mount !== this.#systemControlsMount)
        return;
      this.#systemControlReceipt =
        receipt && ["accepted", "pending", "unknown"].includes(receipt.state)
          ? receipt
          : null;
      await this.#refreshSystemControls(false);
      if (this.#view === "system" && mount === this.#systemControlsMount)
        this.#render();
    })();
  }

  #setView(view: View): void {
    const changed = this.#view !== view;
    this.#view = view;
    if (changed && view === "system") this.#mountSystemControls();
  }

  async #refreshSystemControls(
    render = true,
  ): Promise<SystemControlStatus | null> {
    if (this.#listeners.signal.aborted) return null;
    const serial = ++this.#systemControlsReadSerial;
    let status: SystemControlStatus | null = null;
    try {
      status = await this.#systemControls.status(this.#scope);
    } catch {
      status = null;
    }
    if (
      serial !== this.#systemControlsReadSerial ||
      this.#listeners.signal.aborted
    )
      return null;
    this.#systemControlStatus = status;
    if (render) this.#render();
    return status;
  }

  #systemControlPhaseKey(status: SystemControlStatus): MessageKey {
    const snapshot = status.snapshot;
    if (status.state !== "available" || !snapshot)
      return "system.controls.phase.offline";
    if (snapshot.unresolved || snapshot.phase === "RECOVERY_BLOCKED")
      return "system.controls.phase.recoveryBlocked";
    if (snapshot.activeOperations > 0 && snapshot.phase === "DRAINING")
      return "system.controls.phase.draining";
    switch (snapshot.phase) {
      case "RUNNING":
        return "system.controls.phase.running";
      case "PAUSED":
        return "system.controls.phase.paused";
      case "PAUSING":
      case "DRAINING":
        return "system.controls.phase.pausing";
      case "STOPPED":
        return "system.controls.phase.stopped";
      default:
        return "system.controls.phase.unknown";
    }
  }

  #systemControlErrorMessage(
    error: unknown,
    action?: SystemControlAction,
  ): string {
    const code =
      error instanceof SystemControlsClientError ? error.code : "UNKNOWN";
    if (code === "UNAUTHORIZED" || code === "FORBIDDEN")
      return localeText.t("system.controls.error.unauthorized");
    if (code === "PENDING_STORAGE_UNAVAILABLE")
      return localeText.t("system.controls.error.storageUnavailable");
    if (code === "STATE_CONFLICT")
      return localeText.t("system.controls.error.generationConflict");
    if (code === "INSTANCE_CHANGED")
      return localeText.t("system.controls.error.instanceChanged");
    if (code === "RECONCILIATION_REQUIRED")
      return localeText.t("system.controls.error.reconciliationRequired");
    if (code === "OFFLINE" || code === "BROKER_OFFLINE")
      return localeText.t("system.controls.error.offline");
    if (action)
      return localeText.t("system.controls.error.unsupported", {
        action: localeText.t(`system.controls.action.${action}` as MessageKey),
      });
    return localeText.t("system.controls.phase.unknown");
  }

  #systemControlsPanel(): string {
    const status = this.#systemControlStatus;
    if (!status) {
      const storageUnavailable =
        !this.#systemControls.canMutate() && !this.#systemControlReceipt;
      const receiptMarkup = this.#systemControlReceipt
        ? renderSystemControlReceipt(
            this.#systemControlReceipt,
            (key, params) => localeText.t(key as MessageKey, params),
          )
        : "";
      const reconcileButton = this.#systemControlReceipt
        ? `<button class="btn small" type="button" data-system-control-reconcile>${localeText.t("system.controls.action.reconcile")}</button>`
        : "";
      return `<section class="panel system-panel" role="status" aria-live="polite"><h2>${localeText.t("system.controls.title")}</h2><p class="system-note">${localeText.t(storageUnavailable ? "system.controls.error.storageUnavailable" : "ui.systemControls.unavailable")}</p><button class="btn small" type="button" data-system-control-refresh>${localeText.t("system.controls.action.refresh")}</button>${receiptMarkup}${reconcileButton}</section>`;
    }
    const selectedProjectId =
      this.#scope.kind === "project" ? this.#scope.projectId : null;
    const selectedProject = selectedProjectId
      ? this.#projects.find((entry) => projectId(entry) === selectedProjectId)
      : null;
    const receipt = this.#systemControlReceipt;
    const pendingMarkup =
      receipt && ["accepted", "pending", "unknown"].includes(receipt.state)
        ? `<button class="btn small" type="button" data-system-control-reconcile>${localeText.t("system.controls.action.reconcile")}</button>`
        : "";
    return `${renderSystemControls(
      status,
      this.#scope,
      (key, params) => localeText.t(key as MessageKey, params),
      selectedProject ? projectName(selectedProject) : undefined,
      localeText.formatNumber,
      receipt,
      this.#systemControls.canMutate(),
    )}${pendingMarkup}`;
  }

  async #openSystemControlConfirmation(
    action: SystemControlAction,
  ): Promise<void> {
    if (this.#systemControlReceipt) {
      this.#toast(localeText.t("system.controls.safety.noReplay"));
      await this.#refreshSystemControls();
      return;
    }
    if (!this.#systemControls.canMutate()) {
      this.#toast(localeText.t("system.controls.error.storageUnavailable"));
      await this.#refreshSystemControls();
      return;
    }
    this.#systemControlAction = action;
    const requestedProjectId =
      this.#scope.kind === "project" ? this.#scope.projectId : null;
    const project = requestedProjectId
      ? this.#projects.find((entry) => projectId(entry) === requestedProjectId)
      : null;
    const projectLabel = project ? projectName(project) : null;
    const markup = renderSystemControlConfirmation(
      action,
      projectLabel,
      (key, params) => localeText.t(key as MessageKey, params),
    ).replace(
      'class="modal-overlay"',
      'class="overlay" data-action="backdrop"',
    );
    this.#mountOverlay(
      "system-control-confirm",
      markup,
      "[data-system-control-cancel]",
    );
  }

  async #executeSystemControlCommand(): Promise<void> {
    const action = this.#systemControlAction;
    if (!action) return;
    this.#systemControlAction = null;
    this.#closeModalSurface();
    const scope = this.#scope;
    const status = await this.#refreshSystemControls(false);
    if (
      this.#listeners.signal.aborted ||
      scopeKey(scope) !== scopeKey(this.#scope)
    )
      return;
    if (!status) {
      this.#toast(localeText.t("ui.systemControls.unavailable"));
      return;
    }
    let command: SystemControlCommand;
    try {
      command = createSystemControlCommand(status, this.#scope, action);
    } catch {
      this.#toast(localeText.t("system.controls.error.generationConflict"));
      return;
    }
    try {
      const receipt = await this.#systemControls.execute(command);
      this.#systemControlReceipt = ["accepted", "pending", "unknown"].includes(
        receipt.state,
      )
        ? receipt
        : null;
      if (receipt.state === "confirmed") {
        const refreshed = await this.#refreshSystemControls(false);
        this.#toast(
          localeText.t("system.controls.action.confirmed", {
            phase: localeText.t(
              refreshed
                ? this.#systemControlPhaseKey(refreshed)
                : "system.controls.phase.unknown",
            ),
          }),
        );
      } else if (receipt.state === "unknown") {
        this.#toast(localeText.t("system.controls.action.unknown"));
      } else if (receipt.state === "accepted" || receipt.state === "pending") {
        this.#toast(localeText.t("system.controls.action.receiptPending"));
      } else if (receipt.state === "conflict") {
        this.#toast(this.#systemControlErrorMessage(receipt, command.action));
      }
    } catch (error) {
      this.#systemControlReceipt = null;
      this.#toast(this.#systemControlErrorMessage(error, command.action));
    }
    await this.#refreshSystemControls();
  }

  #onSystemControlsClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>(
      "[data-system-control-refresh], [data-system-control-action], [data-system-control-cancel], [data-system-control-confirm-action], [data-system-control-reconcile]",
    );
    if (!button) return;
    if (button.hasAttribute("data-system-control-refresh")) {
      event.preventDefault();
      void this.#refreshSystemControls();
      return;
    }
    if (button.hasAttribute("data-system-control-cancel")) {
      event.preventDefault();
      this.#systemControlAction = null;
      this.#closeModalSurface();
      return;
    }
    if (button.hasAttribute("data-system-control-confirm-action")) {
      event.preventDefault();
      void this.#executeSystemControlCommand();
      return;
    }
    if (button.hasAttribute("data-system-control-reconcile")) {
      event.preventDefault();
      void this.#reconcileSystemControlReceipt();
      return;
    }
    const action = button.dataset["systemControlAction"];
    if (
      action === "pause" ||
      action === "drain" ||
      action === "resume" ||
      action === "start"
    ) {
      event.preventDefault();
      void this.#openSystemControlConfirmation(action);
    }
  }

  async #reconcileSystemControlReceipt(): Promise<void> {
    try {
      const receipt = await this.#systemControls.reconcilePending();
      this.#systemControlReceipt =
        receipt && ["accepted", "pending", "unknown"].includes(receipt.state)
          ? receipt
          : null;
      if (receipt?.state === "confirmed")
        this.#toast(
          localeText.t("system.controls.action.confirmed", {
            phase: localeText.t(
              this.#systemControlPhaseKey({
                version: 1,
                requestedScope: receipt.requestedScope,
                effectiveScope: { kind: "global" },
                state: receipt.snapshot ? "available" : "unavailable",
                observedAt: null,
                snapshot: receipt.snapshot,
                capabilities: {
                  pause: false,
                  drain: false,
                  resume: false,
                  start: false,
                },
              }),
            ),
          }),
        );
    } catch (error) {
      this.#systemControlReceipt = null;
      this.#toast(this.#systemControlErrorMessage(error));
    }
    await this.#refreshSystemControls();
  }

  async #load(scope: QueryScope, background: boolean): Promise<void> {
    if (this.#listeners.signal.aborted) return;
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

    if (generation !== this.#loadGeneration) return;
    const token = next.snapshotToken;
    if (scope.kind === "global" && token) {
      await this.#query(next, "projects", { limit: 200 });
      if (generation !== this.#loadGeneration) return;
      if (next.pages.projects) {
        this.#projects = next.pages.projects.rows;
        this.#projectTotal = knownTotal(next.pages.projects);
      }
    } else if (this.#projects.length === 0) {
      await this.#loadProjects(generation);
    }

    if (generation !== this.#loadGeneration) return;
    if (token) {
      await Promise.all([
        this.#query(next, "overview", { limit: 1 }),
        this.#query(next, "tasks", this.#tableOptions("tasks")),
        this.#query(next, "logs", this.#tableOptions("logs")),
        this.#query(next, "agents", this.#tableOptions("agents")),
        this.#query(next, "system", { limit: 1 }),
        this.#loadChartRows(next, next.capturedAt ?? Date.now()),
      ]);
      if (generation !== this.#loadGeneration) return;
      await this.#loadRecentLogs(next, next.capturedAt ?? Date.now());
    }

    if (generation !== this.#loadGeneration) return;

    this.#latest = next;
    const scopeChanged =
      this.#visible && scopeKey(this.#visible.scope) !== scopeKey(scope);
    if (!this.#frozen || (!background && scopeChanged)) this.#visible = next;
    if (this.#frozen) this.#notice = localeText.t("ui.freeze.banner");
    if (this.#systemControlsInitialized)
      await this.#refreshSystemControls(false);
    if (generation !== this.#loadGeneration || this.#listeners.signal.aborted)
      return;
    this.#render();
    if (this.#view === "agents") this.#loadAgentsView();
    this.#renderModal();
  }

  async #loadProjects(generation: number): Promise<void> {
    if (this.#listeners.signal.aborted) return;
    try {
      const globalSnapshot = await this.#api.snapshot({ kind: "global" });
      if (generation !== this.#loadGeneration) return;
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope: { kind: "global" },
        collection: "projects",
        snapshotToken: globalSnapshot.snapshotToken,
        limit: 200,
      });
      if (generation !== this.#loadGeneration) return;
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
  ): Promise<"complete" | "expired" | "superseded"> {
    if (this.#listeners.signal.aborted || !target.snapshotToken)
      return "superseded";
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
      if (this.#querySerial[collection] !== serial) return "superseded";
      target.pages[collection] = page;
      delete target.errors[collection];
    } catch (error) {
      if (this.#querySerial[collection] !== serial) return "superseded";
      target.errors[collection] = this.#error(error);
      if (error instanceof ConsoleApiError && error.code === "SNAPSHOT_EXPIRED")
        return "expired";
    }
    return "complete";
  }

  async #loadChartRows(target: LoadState, capturedAt: number): Promise<void> {
    if (this.#listeners.signal.aborted || !target.snapshotToken) return;
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
    if (this.#listeners.signal.aborted || !target.snapshotToken) return;
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
      target.recentLogsError = localeText.t("ui.logs.empty.unavailable");
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
    if (this.#listeners.signal.aborted) return;
    const revision = this.#latest?.revision ?? null;
    this.#source?.close();
    try {
      this.#source = this.#api.watch(
        this.#scope,
        revision,
        (event) => {
          if (this.#listeners.signal.aborted) return;
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
          if (this.#listeners.signal.aborted) return;
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
    if (this.#listeners.signal.aborted || this.#refreshTimer !== null) return;
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
    if (this.#view === "system" || this.#view === "projects") return;
    const state = this.#latest;
    if (!state?.snapshotToken || this.#frozen) return;
    const collection: TableName =
      this.#view === "logs"
        ? "logs"
        : this.#view === "agents"
          ? "agents"
          : "tasks";
    const options = this.#tableOptions(collection);
    void this.#query(state, collection, options).then((outcome) => {
      if (
        this.#latest !== state ||
        this.#listeners.signal.aborted ||
        outcome === "superseded"
      )
        return;
      if (outcome === "expired") {
        // A retained table token may expire while the user inspects details.
        // Acquire one fresh snapshot and apply the current filters. The full
        // load reports any further error; it does not recursively retry.
        void this.#load(this.#scope, true).then(() => {
          if (!this.#listeners.signal.aborted) this.#watch();
        });
        return;
      }
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
    if (
      collection === "agents" &&
      (this.#agentRange === "active" || this.#agentRange === "history")
    ) {
      filters["presence"] = {
        any:
          this.#agentRange === "active"
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
    const previousLocaleHost = $("#locale-selector", this.#root);
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
    const pageTitle =
      this.#view === "overview"
        ? this.#scope.kind === "global"
          ? localeText.t("ui.page.overview.global.title")
          : esc(
              project
                ? projectName(project)
                : localeText.t("ui.page.overview.project.title"),
            )
        : this.#view === "tasks"
          ? localeText.t("ui.page.tasks.title")
          : this.#view === "agents"
            ? localeText.t("ui.page.agents.title")
            : this.#view === "logs"
              ? localeText.t("ui.page.logs.title")
              : localeText.t(
                  this.#view === "system" ? "nav.system" : "nav.projects",
                );
    const pageDescription =
      this.#view === "overview"
        ? this.#scope.kind === "global"
          ? localeText.t("ui.page.overview.global.description")
          : localeText.t("ui.page.overview.project.description")
        : this.#view === "tasks"
          ? localeText.t("ui.page.tasks.description")
          : this.#view === "agents"
            ? localeText.t("ui.page.agents.description")
            : this.#view === "logs"
              ? localeText.t("ui.page.logs.description")
              : this.#view === "system"
                ? localeText.t("ui.page.system.description")
                : localeText.t("ui.page.projects.description");
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
          <button class="nav-button ${this.#view === "projects" ? "active" : ""}" data-action="view" data-view="projects">${icon("folder")}${localeText.t("nav.projects")}</button><button class="nav-button" data-action="settings">${icon("settings")}${localeText.t("common.settings")}</button><button class="nav-button" data-action="help">${icon("help")}${localeText.t("common.help")}<span class="count">?</span></button>
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
            )}</select></label></div><div class="top-actions"><span class="simulation-label"><span class="dot ${this.#isStale(state) ? "warn" : "good"}"></span>${this.#isStale(state) ? localeText.t("ui.workspace.status.stale").toLocaleUpperCase(localeText.locale) : state?.snapshotToken ? localeText.t("ui.workspace.status.connected") : localeText.t("ui.workspace.status.waitingUpper")}</span><span class="top-divider"></span><button class="icon-button" data-action="global-search" aria-label="${localeText.t("ui.search.global.aria")}" title="${localeText.t("ui.search.global.title")}">${icon("search")}</button><button class="icon-button" data-action="settings" aria-label="${localeText.t("common.settings")}">${icon("settings")}</button><button class="icon-button" data-action="help" aria-label="${localeText.t("common.help")}">${icon("help")}</button><div id="locale-selector"></div></div></header>
          <main id="main" class="content">
            <div class="page-heading"><div><div class="eyebrow">${this.#scope.kind === "global" ? localeText.t("ui.page.eyebrow.global") : localeText.t("ui.page.eyebrow.project")}</div><h1>${pageTitle}</h1><p class="page-description">${pageDescription}</p></div><div class="heading-actions"><button class="btn" data-action="export" data-collection="${this.#activeCollection()}" aria-label="${localeText.t("ui.action.exportData")}">${icon("download", "small")}<span>${localeText.t("common.export")}</span></button>${this.#returnAgent ? `<button class="btn" data-action="back-agent">${localeText.t("ui.action.backAgent")}</button>` : ""}<button class="btn ${this.#frozen ? "primary" : ""}" data-action="freeze" aria-label="${localeText.t(this.#frozen ? "common.resume" : "common.freeze")}">${icon(this.#frozen ? "play" : "pause", "small")}<span>${localeText.t(this.#frozen ? "common.resume" : "common.freeze")}</span></button><button class="btn primary" data-action="refresh" aria-label="${localeText.t("common.refresh")}">${icon("refresh", "small")}<span>${localeText.t("common.refresh")}</span></button></div></div>
            <div class="tabs" role="tablist" aria-label="${localeText.t("ui.tabs.aria")}">${this.#tab("overview", "grid", localeText.t("nav.overview"))}${this.#tab("tasks", "layers", localeText.t("nav.tasks"), knownTotal(state?.pages.tasks))}${this.#tab("agents", "users", localeText.t("nav.agents"), knownTotal(state?.pages.agents))}${this.#tab("logs", "terminal", localeText.t("nav.logs"), knownTotal(state?.pages.logs))}${this.#tab("system", "server", localeText.t("nav.system"))}<span class="tab-end">${icon("clock", "small")}<span>${state?.revision ? localeText.t("ui.tabs.refreshRate", { seconds: this.#refreshInterval / 1000, revision: state.revision.revision }) : localeText.t("ui.tabs.waitingRefreshRate", { seconds: this.#refreshInterval / 1000 })}</span></span></div>
            ${issue}${this.#frozen ? `<div class="freeze-banner">${icon("pause", "small")}${localeText.t("ui.freeze.banner")}<span>${esc(this.#notice)}</span><button data-action="freeze">${localeText.t("common.resume")} ${icon("play", "small")}</button></div>` : ""}
            <div class="tab-content">${this.#view === "overview" ? this.#overview(state) : this.#view === "tasks" ? this.#tasksView(state) : this.#view === "logs" ? this.#logsView(state) : this.#view === "system" ? this.#systemView(state) : this.#view === "projects" ? this.#projectsView(state) : this.#agentsView(state)}</div>
            <footer class="page-footer"><span>${icon("server", "small")} ${localeText.t("ui.footer.source")}</span><span><kbd>1–5</kbd> ${localeText.t("nav.overview")} <kbd>/</kbd> ${localeText.t("common.search")} <kbd>␠</kbd> ${localeText.t("common.freeze")}</span></footer>
          </main>
        </div>
      </div>`;
    this.#selects.upgrade(this.#root);
    const localeHost = $("#locale-selector", this.#root);
    if (localeHost) {
      if (previousLocaleHost && this.#localeSelector) {
        // Background data refresh must preserve the open menu, its keyboard
        // selection and subscription. Disposal belongs to the app lifecycle.
        localeHost.replaceWith(previousLocaleHost);
        if (restoreLocaleFocus) active?.focus({ preventScroll: true });
      } else {
        this.#localeSelector?.dispose();
        this.#localeSelector = mountLocaleSelector(localeHost, localeText);
      }
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

  #activeCollection(): Collection {
    return this.#view === "logs"
      ? "logs"
      : this.#view === "agents"
        ? "agents"
        : this.#view === "system"
          ? "system"
          : this.#view === "projects"
            ? "projects"
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
    const nestedHost = record(
      row["host"] ?? row["hostMetrics"] ?? telemetry["host"],
    );
    const host =
      Object.keys(nestedHost).length > 0
        ? nestedHost
        : Object.keys(telemetry).length > 0
          ? telemetry
          : row;
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
    return `<section class="system-strip"><div class="system-strip-title">${icon("server", "small")}${localeText.t("ui.systemStrip.host")}</div><div class="strip-metric">${localeText.t("system.metric.cpu")} <b>${cpu === null ? "—" : `${localeText.formatNumber(cpu, { maximumFractionDigits: 1 })}%`}</b><div class="mini-track"><span style="width:${cpu === null ? 0 : Math.max(0, Math.min(100, cpu))}%"></span></div></div><div class="strip-metric">${localeText.t("ui.systemStrip.ram")} <b>${memoryUsed === null || memoryTotal === null ? "—" : `${localeText.formatNumber(memoryUsed, { maximumFractionDigits: 1 })} / ${localeText.formatNumber(memoryTotal, { maximumFractionDigits: 1 })} GiB`}</b></div><div class="strip-metric">${localeText.t("ui.systemStrip.uptime")} <b>${uptime === null ? "—" : localeText.formatDuration(uptime * 3_600_000)}</b></div></section>`;
  }

  #systemView(state: LoadState | null): string {
    const page = state?.pages.system;
    const controls = this.#systemControlsPanel();
    if (!page)
      return `${this.#empty(
        localeText.t("system.empty.unavailable"),
        state?.errors.system ??
          localeText.t("system.empty.observationsUnavailable"),
        "server",
      )}<div class="system-grid">${controls}</div>`;
    const row = page.rows[0];
    if (!row)
      return `${this.#empty(
        page.source.state === "no-data"
          ? localeText.t("system.empty.noRetainedObservations")
          : localeText.t("system.empty.observationsUnavailable"),
        statusSourceText(page.source),
        "server",
      )}<div class="system-grid">${controls}</div>`;

    const source = record(row["data"]);
    const nestedHost = record(
      row["host"] ?? row["hostMetrics"] ?? source["host"],
    );
    const host =
      Object.keys(nestedHost).length > 0
        ? nestedHost
        : Object.keys(source).length > 0
          ? source
          : row;
    const formatNumber = (value: unknown, maximumFractionDigits = 1) => {
      const result = telemetryNumber({ value }, "value");
      return result === null
        ? null
        : localeText.formatNumber(result, { maximumFractionDigits });
    };
    const formatGib = (value: unknown) => {
      const bytes = telemetryNumber({ value }, "value");
      return bytes === null
        ? null
        : `${localeText.formatNumber(bytes / 1024 ** 3, { maximumFractionDigits: 1 })} GiB`;
    };
    const hostValues: readonly (readonly [string, unknown])[] = [
      [localeText.t("system.metric.hostname"), text(host, "hostname")],
      [
        localeText.t("system.metric.cpu"),
        formatNumber(host["cpuPercent"]) === null
          ? null
          : `${formatNumber(host["cpuPercent"])}%`,
      ],
      [
        localeText.t("system.metric.ramUsedTotal"),
        formatGib(host["ramUsedBytes"]) === null ||
        formatGib(host["ramTotalBytes"]) === null
          ? null
          : `${formatGib(host["ramUsedBytes"])} / ${formatGib(host["ramTotalBytes"])}`,
      ],
      [
        localeText.t("system.metric.swapUsedTotal"),
        formatGib(host["swapUsedBytes"]) === null ||
        formatGib(host["swapTotalBytes"]) === null
          ? null
          : `${formatGib(host["swapUsedBytes"])} / ${formatGib(host["swapTotalBytes"])}`,
      ],
      [
        localeText.t("system.metric.diskUsedTotal"),
        formatGib(host["diskUsedBytes"]) === null ||
        formatGib(host["diskTotalBytes"]) === null
          ? null
          : `${formatGib(host["diskUsedBytes"])} / ${formatGib(host["diskTotalBytes"])}`,
      ],
      [
        localeText.t("system.metric.loadAverage"),
        Array.isArray(host["load"]) &&
        host["load"].every(
          (value) => typeof value === "number" && Number.isFinite(value),
        )
          ? host["load"].map((value) => formatNumber(value, 2)).join(" / ")
          : null,
      ],
      [
        localeText.t("system.metric.networkInterface"),
        host["networkInterface"],
      ],
      [
        localeText.t("system.metric.receiveRate"),
        formatNumber(host["rxBytesPerSecond"]) === null
          ? null
          : `${formatNumber(host["rxBytesPerSecond"])} B/s`,
      ],
      [
        localeText.t("system.metric.sendRate"),
        formatNumber(host["txBytesPerSecond"]) === null
          ? null
          : `${formatNumber(host["txBytesPerSecond"])} B/s`,
      ],
      [
        localeText.t("system.metric.uptime"),
        formatNumber(host["uptimeSeconds"]) === null
          ? null
          : localeText.formatDuration(
              telemetryNumber({ value: host["uptimeSeconds"] }, "value")! *
                1000,
            ),
      ],
      [
        localeText.t("system.metric.processCount"),
        formatNumber(host["processCount"], 0),
      ],
    ];
    const processRow = (label: string, value: unknown): string => {
      const processObservation = record(value);
      const identity = record(processObservation["identity"]);
      const alive = identity["alive"];
      const status =
        alive === true
          ? localeText.t("system.process.status.confirmed")
          : alive === false
            ? localeText.t("system.process.status.terminated")
            : localeText.t("system.process.status.unknown");
      return `<div class="process"><div><strong>${label}</strong><span class="mono">${esc(localeText.t("system.process.identity", { pid: display(identity["pid"]), birth: display(identity["birth"]) }))}</span></div><span class="status-line">${esc(status)}</span><span class="mono">${localeText.t("system.metric.cpu")} ${formatNumber(processObservation["cpuPercent"]) === null ? "—" : `${formatNumber(processObservation["cpuPercent"])}%`} · RSS ${formatGib(processObservation["rssBytes"]) ?? "—"}</span></div>`;
    };
    const workers = row["workers"];
    const workerList = Array.isArray(workers)
      ? workers.length
        ? workers
            .map((worker, index) =>
              processRow(
                localeText.t("system.process.worker", { index: index + 1 }),
                worker,
              ),
            )
            .join("")
        : page.source.state === "available"
          ? `<p class="system-note">${localeText.t("system.note.noReportedWorkers")}</p>`
          : `<p class="system-note">${esc(statusSourceText(page.source))}</p>`
      : `<p class="system-note">${esc(statusSourceText(page.source))}</p>`;
    const locks = record(row["locks"]);
    const processes = `${processRow(localeText.t("system.process.panel", { index: 1 }), row["panelProcess"])}${processRow(localeText.t("system.process.broker", { index: 1 }), row["brokerProcess"])}${workerList}`;
    return `<div class="notice info" role="status" data-system-source="${esc(page.source.state)}">${icon(page.source.state === "available" ? "server" : "alert")}<div><strong>${esc(statusSourceText(page.source))}</strong><p>${localeText.t("system.note.unknownRemainsUnknown")}</p></div></div><div class="system-grid"><section class="panel system-panel"><h2>${icon("server", "small")}${localeText.t("system.hostLocal")}</h2>${this.#keyValues(hostValues)}</section><section class="panel system-panel"><h2>${icon("pulse", "small")}${localeText.t("system.processes")}</h2>${processes}</section><section class="panel system-panel"><h2>${icon("check", "small")}${localeText.t("system.lockObservations")}</h2>${this.#keyValues(
      [
        [localeText.t("system.lock.status"), locks["status"]],
        [localeText.t("system.lock.evidenceCount"), locks["evidenceCount"]],
        [localeText.t("system.lock.source"), locks["source"]],
        [localeText.t("system.lock.reason"), locks["reason"]],
      ],
    )}</section>${controls}</div>`;
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
    const rows =
      this.#agentRange === "working"
        ? (this.#workingAgents ?? [])
        : (page?.rows ?? []);
    const unavailable =
      this.#agentRange === "working"
        ? this.#workingAgentsLoading ||
          this.#workingAgents === null ||
          this.#workingAgentsUnavailable
        : !page || (page.source.state !== "available" && rows.length === 0);
    const agents = renderAgentList({
      rows,
      filter: this.#agentRange,
      localeText: agentsProjectsLocale,
      sourceState:
        this.#agentRange === "working" && this.#workingAgentsLoading
          ? localeText.t("common.loading")
          : statusSourceText(
              page?.source ?? { state: "unavailable", source: "agents" },
            ),
      unavailable,
    }).replace(
      'data-action="agent-search"',
      `data-action="agent-search" value="${esc(this.#search)}"`,
    );
    const sessions =
      this.#technicalSessions === null
        ? `<section class="panel table-panel"><div class="panel-head"><h2>${localeText.t("agents.title")}</h2><span class="inline-source">${esc(this.#technicalSessionsSource || localeText.t("common.loading"))}</span></div><p class="project-list-description" role="status">${localeText.t("agents.list.unavailable")}</p></section>`
        : renderTechnicalSessions({
            rows: this.#technicalSessions,
            filter: this.#technicalSessionFilter,
            localeText: agentsProjectsLocale,
            sourceState: this.#technicalSessionsSource,
          });
    return `${agents}<div class="section-spaced">${sessions}</div>`;
  }

  #projectsView(state: LoadState | null): string {
    const rows = this.#projects
      .map((row) => {
        const id = projectId(row);
        return id
          ? ({ ...row, id, name: projectName(row) } as ConsoleProjectRecord)
          : null;
      })
      .filter((row): row is ConsoleProjectRecord => row !== null);
    this.#ensureProjectRevisions(rows);
    const source = state?.pages.projects?.source;
    const unavailable =
      rows.length === 0 &&
      (!source || source.state === "unavailable" || source.state === "no-data");
    const favorites = new Set(
      rows
        .filter((row) => this.#agentsProjects.isFavorite(row.id))
        .map((row) => row.id),
    );
    let list = renderProjectList({
      rows: unavailable ? null : rows,
      filter: this.#projectFilter,
      search: this.#projectsSearch,
      favorites,
      revisions: this.#projectRevisions,
      localeText: agentsProjectsLocale,
      ...(unavailable
        ? {
            unavailableReason:
              state?.errors.projects ??
              statusSourceText(
                source ?? { state: "unavailable", source: "projects" },
              ),
          }
        : {}),
    });
    for (const project of rows) {
      const formStart = list.indexOf(
        `data-action="project-alias-form" data-project="${esc(project.id)}"`,
      );
      if (formStart < 0) continue;
      const formEnd = list.indexOf("</form>", formStart);
      if (formEnd < 0) continue;
      const form = list
        .slice(formStart, formEnd)
        .replace(
          '<input type="text" name="alias"',
          `<input id="project-alias-${esc(project.id)}" type="text" name="alias"`,
        );
      list = `${list.slice(0, formStart)}${form}${list.slice(formEnd)}`;
    }
    return `${list}${this.#projectRevisionStatus ? `<p class="project-list-description" role="status">${esc(this.#projectRevisionStatus)}</p>` : ""}`;
  }

  #ensureProjectRevisions(rows: readonly ConsoleProjectRecord[]): void {
    const key = rows.map((row) => row.id).join("\u0000");
    if (key === this.#projectRevisionKey) return;
    this.#projectRevisionKey = key;
    this.#projectRevisions = new Map();
    this.#projectRevisionStatus = "";
    const load = ++this.#projectRevisionLoad;
    if (!rows.length) return;
    void (async () => {
      const revisions = new Map<string, Revision>();
      let failures = 0;
      for (let offset = 0; offset < rows.length; offset += 8) {
        await Promise.all(
          rows.slice(offset, offset + 8).map(async (project) => {
            try {
              revisions.set(
                project.id,
                await this.#agentsProjects.projectRevision(project.id),
              );
            } catch {
              failures += 1;
            }
          }),
        );
        if (
          load !== this.#projectRevisionLoad ||
          this.#listeners.signal.aborted
        )
          return;
      }
      this.#projectRevisions = revisions;
      this.#projectRevisionStatus = failures
        ? localeText.t("projects.archive.blocked.missing")
        : "";
      if (this.#view === "projects") this.#render();
    })();
  }

  #loadAgentsView(): void {
    if (this.#listeners.signal.aborted) return;
    const serial = ++this.#agentViewLoad;
    this.#technicalSessions = null;
    this.#technicalSessionsSource = localeText.t("common.loading");
    void this.#agentsProjects
      .listTechnicalSessions(this.#scope, {
        filter: this.#technicalSessionFilter,
        search: this.#search,
        limit: 200,
      })
      .then((result) => {
        if (serial !== this.#agentViewLoad || this.#listeners.signal.aborted)
          return;
        this.#technicalSessions =
          result.page.source.state === "available" ||
          (result.page.source.state === "partial" && result.rows.length > 0)
            ? result.rows
            : null;
        this.#technicalSessionsSource = statusSourceText(result.page.source);
        if (this.#view === "agents") this.#render();
      })
      .catch((error: unknown) => {
        if (serial !== this.#agentViewLoad || this.#listeners.signal.aborted)
          return;
        this.#technicalSessions = null;
        this.#technicalSessionsSource = this.#error(error);
        if (this.#view === "agents") this.#render();
      });
    if (this.#agentRange !== "working") {
      this.#workingAgents = null;
      this.#workingAgentsLoading = false;
      this.#workingAgentsUnavailable = false;
      return;
    }
    const workingLoad = ++this.#workingAgentLoad;
    this.#workingAgentsLoading = true;
    this.#workingAgents = null;
    this.#workingAgentsUnavailable = false;
    void this.#agentsProjects
      .listAgents(this.#scope, {
        filter: "working",
        search: this.#search,
        offset: (this.#page - 1) * 8,
        limit: 8,
      })
      .then((result) => {
        if (
          workingLoad !== this.#workingAgentLoad ||
          this.#listeners.signal.aborted
        )
          return;
        this.#workingAgents = result.rows;
        this.#workingAgentsLoading = false;
        this.#workingAgentsUnavailable =
          result.page.source.state !== "available" && result.rows.length === 0;
        if (this.#view === "agents") this.#render();
      })
      .catch(() => {
        if (workingLoad !== this.#workingAgentLoad) return;
        this.#workingAgents = null;
        this.#workingAgentsLoading = false;
        this.#workingAgentsUnavailable = true;
        if (this.#view === "agents") this.#render();
      });
  }

  #empty(title: string, description: string, image: string): string {
    return `<div class="empty-state">${icon(image)}<strong>${esc(title)}</strong><span>${esc(description)}</span></div>`;
  }

  #currentModal(generation: number): boolean {
    return (
      !this.#listeners.signal.aborted && generation === this.#modalGeneration
    );
  }

  async #openTask(id: string, ownerHint?: string): Promise<void> {
    const state = this.#state();
    const retainedTask = (state?.pages.tasks?.rows ?? []).find(
      (row) => rowTaskId(row) === id,
    );
    const owner =
      ownerHint ??
      (this.#scope.kind === "project"
        ? this.#scope.projectId
        : text(retainedTask ?? {}, "projectId"));
    if (!nonemptyId(owner)) {
      this.#toast(
        retainedTask
          ? localeText.t("ui.project.task.sourceMissing")
          : localeText.t("ui.project.task.unavailable"),
      );
      return;
    }
    const generation = ++this.#modalGeneration;
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
      if (!this.#currentModal(generation)) return;
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope,
        collection: "tasks",
        snapshotToken: token,
        filters: { id },
        limit: 1,
      });
      if (!this.#currentModal(generation)) return;
      const selected =
        page.rows.find((row) => rowTaskId(row) === id) ?? retainedTask;
      if (!selected) {
        this.#toast(localeText.t("ui.project.task.unavailable"));
        return;
      }
      this.#showTask(
        selected,
        owner,
        page.snapshotToken ?? token,
        page.revision ?? revision,
        undefined,
        sources,
      );
    } catch (error) {
      if (!this.#currentModal(generation)) return;
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
    retainedArtifact?: {
      readonly kind: ArtifactKind;
      readonly artifact: ArtifactResult;
    },
  ): void {
    this.#rememberModalFocus();
    this.#modal = {
      type: "task",
      task: safeClone(task),
      projectId: owner,
      snapshotToken: token,
      revision,
      sources,
      tab: retainedArtifact
        ? isOutputKind(retainedArtifact.kind)
          ? "response"
          : "code"
        : "details",
      events: null,
      eventStatus: null,
      artifact: retainedArtifact?.artifact ?? null,
      artifactMissingReason: null,
      artifactKind: retainedArtifact?.kind ?? null,
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
      modal.eventStatus = localeText.t("ui.modal.task.noEventsSnapshot");
      this.#renderModal();
      return;
    }
    if (!nonemptyId(id) && !nonemptyId(requestId)) {
      modal.events = [];
      modal.eventStatus = localeText.t("ui.modal.task.noEventIdentity");
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
          ? `${kind} · ${localeText.t("state.missing")}`
          : reference["state"] === "unavailable"
            ? `${kind} · ${localeText.t("ui.source.unavailable")}`
            : `${kind} · ${localeText.t("ui.modal.task.outputChooseDescription")}`);
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
        ? localeText.t("ui.modal.task.noArtifactSnapshot")
        : localeText.t("ui.source.unavailable");
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
      if (
        this.#auxiliaryModal === "project-action" &&
        this.#projectActionDialog
      ) {
        this.#renderProjectActionModal(focus);
        return;
      }
      if (
        this.#auxiliaryModal === "system-control-confirm" &&
        this.#systemControlAction
      ) {
        const action = this.#systemControlAction;
        const controlProjectId =
          this.#scope.kind === "project" ? this.#scope.projectId : null;
        const project = controlProjectId
          ? this.#projects.find(
              (entry) => projectId(entry) === controlProjectId,
            )
          : null;
        const markup = renderSystemControlConfirmation(
          action,
          project ? projectName(project) : null,
          (key, params) => localeText.t(key as MessageKey, params),
        ).replace(
          'class="modal-overlay"',
          'class="overlay" data-action="backdrop"',
        );
        this.#mountOverlay(
          "system-control-confirm",
          markup,
          "[data-system-control-cancel]",
        );
        return;
      }
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
    const focusedId = active?.id;
    const selectionStart =
      active instanceof HTMLInputElement ? active.selectionStart : null;
    const selectionEnd =
      active instanceof HTMLInputElement ? active.selectionEnd : null;
    const content =
      this.#modal.type === "task"
        ? this.#taskModal(this.#modal)
        : this.#modal.type === "log"
          ? this.#logModal(this.#modal)
          : this.#modal.type === "agent"
            ? this.#agentModal(this.#modal)
            : this.#sessionModal(this.#modal);
    const footer =
      this.#modal.type === "task"
        ? `${this.#modal.returnLog ? `<button class="btn small" data-action="back-log">${localeText.t("ui.modal.backToEvent")}</button>` : ""}<span class="modal-footer-note">${localeText.t("ui.modal.task.snapshotRevision", { revision: this.#modal.revision?.revision ?? "—" })}</span><button class="btn small" data-action="task-refresh">${icon("refresh", "small")}${localeText.t("ui.modal.task.refresh")}</button><button class="btn" data-action="close">${localeText.t("common.close")}</button>`
        : this.#modal.type === "log"
          ? `${this.#modal.returnTask ? `<button class="btn small" data-action="back-task">${localeText.t("ui.modal.backToTask")}</button>` : ""}${nonemptyId(this.#modal.log["taskId"]) ? `<button class="btn primary" data-action="log-task">${icon("layers", "small")}${localeText.t("ui.modal.relatedTask")}</button>` : ""}<button class="btn" data-action="copy-log">${icon("copy", "small")}${localeText.t("ui.modal.copyEntry")}</button><button class="btn" data-action="close">${localeText.t("common.close")}</button>`
          : this.#modal.type === "agent"
            ? `${this.#modal.returnTask ? `<button class="btn small" data-action="back-task">${localeText.t("ui.modal.backToTask")}</button>` : ""}<button class="btn" data-action="close">${localeText.t("common.close")}</button>`
            : `<button class="btn" data-action="close">${localeText.t("common.close")}</button>`;
    const title =
      this.#modal.type === "task"
        ? localeText.t("ui.modal.task.title")
        : this.#modal.type === "log"
          ? localeText.t("ui.modal.log.title")
          : localeText.t("ui.modal.agent.title");
    host.innerHTML = `<div class="overlay" data-action="backdrop"><section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><header class="modal-header"><h2 id="modal-title">${title}</h2><button class="icon-button" data-action="close" aria-label="${localeText.t("ui.modal.close")}">${icon("close")}</button></header><div class="modal-body">${content}</div><footer class="modal-footer">${footer}</footer></section></div>`;
    this.#selects.upgrade(host);
    if (focus) $(".modal", host)?.focus();
    else if (focusedId) {
      const next = $<HTMLInputElement>(`#${CSS.escape(focusedId)}`, host);
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

  #renderProjectActionModal(focus = false): void {
    const host = document.getElementById("overlay-root");
    const dialog = this.#projectActionDialog;
    if (!host || !dialog) return;
    const markup = renderProjectActionDialog(
      dialog.project as ConsoleProjectRecord,
      dialog.action,
      dialog.revision,
      agentsProjectsLocale,
      dialog.status,
    ).replace(
      'data-action="project-action-confirm"',
      `data-action="project-action-confirm"${this.#projectActionBusy || dialog.status?.state === "ok" ? " disabled" : ""}`,
    );
    const activeAction = (document.activeElement as HTMLElement | null)
      ?.dataset["action"];
    this.#root.inert = true;
    host.innerHTML = `<div class="overlay" data-action="backdrop">${markup}</div>`;
    if (focus) {
      $("[data-action=project-action-cancel]", host)?.focus();
    } else if (activeAction) {
      $(`[data-action="${CSS.escape(activeAction)}"]`, host)?.focus({
        preventScroll: true,
      });
    }
  }

  #renderLocaleOverlay(): void {
    if (
      this.#modal ||
      this.#auxiliaryModal === "system-control-confirm" ||
      this.#auxiliaryModal === "project-action"
    ) {
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
    this.#modalGeneration += 1;
    this.#selects.close(false);
    const host = document.getElementById("overlay-root");
    if (host) host.innerHTML = "";
    this.#root.inert = false;
    if (this.#auxiliaryModal === "system-control-confirm")
      this.#systemControlAction = null;
    this.#projectActionDialog = null;
    this.#projectActionBusy = false;
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
        ["details", "file", localeText.t("ui.tasks.column.details")],
        [
          "events",
          "terminal",
          modal.events === null
            ? localeText.t("ui.logs.title")
            : localeText.t("ui.modal.task.tab.events", {
                count: modal.events.length,
              }),
        ],
        ["code", "code", localeText.t("ui.modal.task.tab.code")],
        ["response", "terminal", localeText.t("ui.modal.task.tab.response")],
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
      body = `<div class="details-header">${statusBadge(task["state"])}</div><div class="detail-command">${esc(text(task, "label") ?? text(task, "kind") ?? localeText.t("ui.tasks.operation.unknown"))}</div><div class="detail-columns"><section><h3 class="detail-section-title">${localeText.t("ui.modal.task.section.purposeOperation")}</h3>${this.#keyValues(
        [
          [localeText.t("ui.modal.task.field.purpose"), text(task, "purpose")],
          [localeText.t("ui.modal.task.field.kind"), text(task, "kind")],
          [
            localeText.t("ui.modal.task.field.document"),
            text(task, "document"),
          ],
          [localeText.t("ui.modal.task.field.source"), text(task, "source")],
        ],
      )}</section><section><h3 class="detail-section-title">${localeText.t("ui.modal.task.section.resultTimes")}</h3>${this.#keyValues(
        [
          [localeText.t("ui.modal.task.field.sourceState"), task["state"]],
          [
            localeText.t("ui.modal.task.field.submitted"),
            dateTime(task["submittedAt"]),
          ],
          [
            localeText.t("ui.modal.task.field.started"),
            dateTime(task["startedAt"]),
          ],
          [
            localeText.t("ui.modal.task.field.finished"),
            dateTime(task["finishedAt"]),
          ],
          [localeText.t("ui.tasks.column.wait"), duration(task["waitMs"])],
          [
            localeText.t("ui.tasks.column.execution"),
            duration(task["executionMs"]),
          ],
          [
            localeText.t("ui.modal.task.field.timeout"),
            duration(task["timeoutMs"]),
          ],
          [localeText.t("ui.modal.task.field.exitCode"), task["exitCode"]],
          [localeText.t("ui.modal.task.field.outcome"), task["outcome"]],
          [
            localeText.t("ui.modal.task.field.mayHaveMutated"),
            task["mayHaveMutated"],
          ],
        ],
      )}</section></div><h3 class="detail-section-title">${localeText.t("ui.modal.task.section.identity")}</h3>${this.#keyValues(
        [
          ["Task ID", id],
          ["Job ID", task["jobId"]],
          ["Execution ID", task["executionId"]],
          ["Request ID", task["requestId"]],
          ["Client ID", task["clientId"]],
          ["Agent ID", task["agentId"]],
          ["Session ID", task["sessionId"]],
          ["Document ID", task["documentId"]],
          [
            localeText.t("ui.modal.task.field.operation"),
            task["operationKind"],
          ],
          [localeText.t("ui.modal.log.event"), task["event"]],
          [localeText.t("ui.modal.log.source"), task["source"]],
          [
            localeText.t("ui.modal.task.field.sourceOrdinal"),
            task["sourceOrdinal"],
          ],
          [
            localeText.t("ui.modal.task.field.revision"),
            modal.revision
              ? `${modal.revision.epoch}:${modal.revision.revision}`
              : null,
          ],
        ],
      )}${agentId ? `<button class="text-link" data-action="task-agent" data-id="${esc(agentId)}">${icon("users", "small")}${localeText.t("ui.modal.task.openAgent")}</button>` : ""}`;
    } else if (modal.tab === "events") {
      body = modal.loading
        ? this.#empty(
            localeText.t("common.loading"),
            localeText.t("ui.modal.task.events.loadingDescription"),
            "terminal",
          )
        : modal.events?.length
          ? `<div class="modal-event-list">${this.#logItems(modal.events)}</div>`
          : this.#empty(
              localeText.t("ui.logs.events.empty"),
              modal.eventStatus ??
                localeText.t("ui.modal.task.events.emptyDescription"),
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
      body = `<div class="response-tabs"><div class="segmented">${(["original-source", "sent-source", "current-file"] as const).map((kind) => `<button class="segment ${modal.artifactKind === kind ? "active" : ""}" data-action="artifact" data-kind="${kind}">${localeText.t(kind === "original-source" ? "ui.modal.task.source.original" : kind === "sent-source" ? "ui.modal.task.source.sent" : "ui.modal.task.source.current")}</button>`).join("")}</div>${selected?.content ? `<button class="btn small" data-action="copy-artifact">${icon("copy", "small")}${localeText.t("common.copy")}</button>` : ""}</div>${this.#keyValues(
        [["SHA-256", sourceHash]],
      )}${sourceHash ? `<button class="text-link" data-action="copy-hash">${icon("copy", "small")}${localeText.t("ui.modal.task.copyHash")}</button>` : ""}${modal.loading ? this.#empty(localeText.t("common.loading"), localeText.t("ui.modal.task.sourceLoadingDescription"), "file") : selected ? this.#artifactBlock(selected, modal.artifactKind ?? "original-source") : modal.artifactMissingReason ? this.#empty(localeText.t("ui.modal.task.sourceUnavailable"), modal.artifactMissingReason, "alert") : this.#empty(localeText.t("ui.modal.task.sourceChoose"), localeText.t("ui.modal.task.sourceChooseDescription"), "code")}`;
    } else {
      const taskArtifacts = record(task["artifacts"]);
      const outputButtons = outputChannels
        .map(([kind, filename]) => {
          const channel = record(taskArtifacts[artifactSlot(kind)]);
          const available = validOutputChannel(channel);
          const label = kind === "rpc" ? "rpc-result.json" : kind;
          return `<button class="segment ${modal.artifactKind === kind ? "active" : ""}" data-action="artifact" data-kind="${kind}" aria-label="${esc(label)}${available ? "" : ` · ${localeText.t("ui.modal.task.outputUnavailable")}`}" title="${esc(text(channel, "reason") ?? filename)}">${esc(label)}${available ? "" : ` · ${localeText.t("ui.modal.task.outputUnavailable")}`}</button>`;
        })
        .join("");
      const selectedOutput = isOutputKind(modal.artifactKind)
        ? record(taskArtifacts[artifactSlot(modal.artifactKind)])
        : null;
      const provenanceNote = validOutputChannel(selectedOutput ?? {})
        ? `<p class="details-note">${localeText.t("ui.modal.task.provenance", { provenance: text(selectedOutput!, "provenance") ?? "", hash: text(selectedOutput!, "sourceHash") ?? "" })}</p>`
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
          : (selectedKind ?? "artifact");
      body = `<div class="response-tabs"><span class="details-note">${localeText.t("ui.modal.task.outputNote")}</span><div class="segmented">${outputButtons}<button class="segment ${selectedKind === "response" ? "active" : ""}" data-action="artifact" data-kind="response" aria-label="${localeText.t("ui.modal.task.compatibleResponse")}">${localeText.t("ui.modal.task.tab.response")}</button></div>${selectedArtifact?.content ? `<button class="btn small" data-action="copy-artifact">${icon("copy", "small")}${localeText.t("common.copy")}</button>` : ""}</div>${freshnessNote}${provenanceNote}${modal.loading ? this.#empty(localeText.t("ui.modal.task.outputLoading", { channel: selectedLabel }), localeText.t("ui.modal.task.outputLoadingDescription"), "terminal") : selectedArtifact && selectedKind ? this.#artifactBlock(selectedArtifact, selectedKind) : modal.artifactMissingReason ? this.#empty(`${esc(selectedLabel)} ${localeText.t("ui.modal.task.outputUnavailable")}`, modal.artifactMissingReason, "alert") : this.#empty(localeText.t("ui.modal.task.outputChoose"), localeText.t("ui.modal.task.outputChooseDescription"), "terminal")}`;
    }
    return `<div class="details-header"><span class="project-chip">${esc(this.#projectLabel(modal.projectId))}</span>${statusBadge(task["state"])}</div><div class="modal-tabs" role="tablist" aria-label="${localeText.t("ui.modal.task.tabs.aria")}">${tabs}</div><section role="tabpanel" class="agent-modal-panel">${body}</section>`;
  }

  #artifactBlock(artifact: ArtifactResult, kind: ArtifactKind): string {
    if (!["available", "empty", "truncated"].includes(artifact.state))
      return `<div class="notice info">${icon("alert")}<div><strong>${esc(artifact.state)}</strong><p>${esc(artifact.reason ?? localeText.t("ui.modal.task.artifactUnavailable"))}</p></div></div>`;
    if (artifact.content === null || artifact.state === "empty")
      return this.#empty(
        localeText.t("common.noData"),
        artifact.reason ??
          localeText.t("ui.modal.task.artifactEmptyDescription"),
        "file",
      );
    if (kind === "response" || isOutputKind(kind)) {
      const label =
        kind === "stdout"
          ? "stdout.txt · UTF-8"
          : kind === "stderr"
            ? "stderr.txt · UTF-8"
            : kind === "rpc"
              ? localeText.t("ui.modal.task.artifactRpcRetained")
              : localeText.t("ui.modal.task.artifactResponseRetained");
      const lineCount = artifact.content.split("\n").length;
      return `<div class="source-editor-head"><span class="source-language">${label}</span><span>${localeText.plural("ui.modal.task.artifactLines", lineCount)}</span></div><pre class="code-block"><code>${esc(artifact.content)}</code></pre>${artifact.state === "truncated" ? `<p class="details-note">${localeText.t("ui.modal.task.artifactTruncated", { offset: artifact.offset, end: artifact.offset + artifact.length, totalLength: artifact.totalLength ?? localeText.t("common.unknown") })}</p>` : ""}`;
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
    return `<div class="source-editor-head"><span class="source-language">${localeText.t("ui.modal.task.artifactSourceReadOnly")}</span><span>${localeText.plural("ui.modal.task.artifactLines", lines.length)}</span></div><pre class="code-block code-view syntax-view"><code class="language-python">${lines.map((line, index) => `<span><i class="code-gutter">${index + 1}</i><span class="highlight-source">${line || " "}</span></span>`).join("\n")}</code></pre>${artifact.state === "truncated" ? `<p class="details-note">${localeText.t("ui.modal.task.artifactTruncated", { offset: artifact.offset, end: artifact.offset + artifact.length, totalLength: artifact.totalLength ?? localeText.t("common.unknown") })}</p>` : ""}`;
  }

  #logModal(modal: Extract<ModalState, { type: "log" }>): string {
    const log = modal.log;
    const timestamp = log["timestamp"];
    const raw =
      text(log, "rawMessage") ??
      text(log, "message") ??
      localeText.t("ui.modal.log.unretainedMessage");
    return `<div class="details-header"><span class="badge ${stateTone(log["level"])}">${esc(text(log, "level") ?? "OTHER")}</span></div>${this.#keyValues(
      [
        [localeText.t("ui.modal.log.localTime"), dateTime(timestamp)],
        [localeText.t("ui.modal.log.utcTime"), utcDateTime(timestamp)],
        [localeText.t("ui.modal.log.source"), log["source"]],
        [localeText.t("ui.modal.log.event"), log["event"]],
        ["Task ID", log["taskId"]],
        ["Request ID", log["requestId"]],
        ["Client ID", log["clientId"]],
        [
          localeText.t("ui.modal.task.field.revision"),
          modal.revision
            ? `${modal.revision.epoch}:${modal.revision.revision}`
            : null,
        ],
      ],
    )}<h3 class="detail-section-title">${localeText.t("ui.modal.log.message")}</h3><pre class="code-block">${esc(raw)}</pre>`;
  }

  #agentModal(modal: Extract<ModalState, { type: "agent" }>): string {
    if (modal.loading)
      return `<p role="status">${localeText.t("common.loading")}</p>`;
    return renderAgentDetail({
      agent: modal.agent,
      tasks: modal.tasks,
      files: modal.files,
      projectName: this.#projectLabel(modal.projectId),
      projectArchived: modal.projectArchived,
      snapshotToken: modal.snapshotToken,
      revision: modal.revision,
      taskOffset: modal.taskOffset,
      taskTotal: modal.taskTotal,
      localeText: agentsProjectsLocale,
    })
      .replace(
        '<input type="text" name="alias"',
        '<input id="agent-alias-input" type="text" name="alias"',
      )
      .replace('data-action="agent-logs-open"', 'data-action="agent-logs"');
  }

  #sessionModal(modal: Extract<ModalState, { type: "session" }>): string {
    if (modal.loading)
      return `<p role="status">${localeText.t("common.loading")}</p>`;
    return renderTechnicalSessionDetail({
      session: modal.session,
      tasks: modal.tasks,
      events: modal.events,
      offset: modal.taskOffset,
      total: modal.taskTotal,
      localeText: agentsProjectsLocale,
    });
  }

  #keyValues(entries: readonly (readonly [string, unknown])[]): string {
    return `<dl class="key-values">${entries.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(display(value))}</dd></div>`).join("")}</dl>`;
  }

  #projectLabel(id: string): string {
    const project = this.#projects.find((item) => projectId(item) === id);
    return project ? projectName(project) : id;
  }

  #toast(message: string): void {
    if (this.#listeners.signal.aborted) return;
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("visible");
    if (this.#toastTimer !== null) window.clearTimeout(this.#toastTimer);
    this.#toastTimer = window.setTimeout(() => {
      this.#toastTimer = null;
      toast.classList.remove("visible");
    }, 3500);
  }

  async #copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.#toast(localeText.t("common.copied"));
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
        copied
          ? localeText.t("common.copied")
          : localeText.t("ui.toast.copyFailed"),
      );
    }
  }

  async #export(collection: Collection, format: "csv" | "json"): Promise<void> {
    const state = this.#latest;
    if (!state?.snapshotToken)
      return this.#toast(localeText.t("ui.toast.exportNoSnapshot"));
    try {
      let scope = state.scope;
      let snapshotToken = state.snapshotToken;
      let selection: Partial<
        Pick<
          QueryRequest,
          "search" | "filters" | "sort" | "facetFields" | "aggregateFields"
        >
      >;
      if (collection === "projects") {
        scope = { kind: "global" };
        snapshotToken = (await this.#api.snapshot(scope)).snapshotToken;
        selection = {
          ...(this.#projectsSearch ? { search: this.#projectsSearch } : {}),
          ...(this.#projectFilter === "monitored"
            ? { filters: { monitoring: { eq: true } } }
            : this.#projectFilter === "archived"
              ? {
                  filters: {
                    monitoring: { eq: false },
                    archivedAtMs: { min: 0 },
                  },
                }
              : {}),
        };
      } else {
        const options = this.#tableOptions(
          collection === "logs"
            ? "logs"
            : collection === "agents"
              ? "agents"
              : "tasks",
        );
        selection = Object.fromEntries(
          Object.entries(options).filter(
            ([key]) => key !== "offset" && key !== "limit",
          ),
        ) as Partial<
          Pick<
            QueryRequest,
            "search" | "filters" | "sort" | "facetFields" | "aggregateFields"
          >
        >;
      }
      const request: QueryRequest = {
        version: API_VERSION,
        scope,
        collection,
        snapshotToken,
        ...selection,
      };
      const result = await this.#api.export({ ...request, format });
      if (this.#listeners.signal.aborted) return;
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
      this.#toast(
        localeText.t("ui.toast.exported", { count: result.rowCount }),
      );
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
        if (
          [
            "overview",
            "tasks",
            "agents",
            "logs",
            "system",
            "projects",
          ].includes(String(view))
        ) {
          this.#setView(view as View);
          this.#search = "";
          this.#page = 1;
          this.#mobile = false;
          this.#queryForTable();
          this.#render();
          if (this.#view === "agents") this.#loadAgentsView();
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
              error.textContent = localeText.t("ui.filter.invalidRange");
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
      case "agent-filter":
        if (
          ["all", "active", "working", "history"].includes(
            String(button.dataset["filter"]),
          )
        ) {
          this.#agentRange = button.dataset["filter"] as AgentFilter;
          this.#page = 1;
          this.#loadAgentsView();
          this.#queryForTable();
          this.#render();
        }
        break;
      case "session-filter":
        if (
          ["all", "confirmed", "history", "unknown"].includes(
            String(button.dataset["filter"]),
          )
        ) {
          this.#technicalSessionFilter = button.dataset[
            "filter"
          ] as TechnicalSessionFilter;
          this.#loadAgentsView();
        }
        break;
      case "project-filter":
        if (
          ["all", "monitored", "archived"].includes(
            String(button.dataset["filter"]),
          )
        ) {
          this.#projectFilter = button.dataset["filter"] as ProjectListFilter;
          this.#render();
        }
        break;
      case "project-favorite": {
        const id = button.dataset["project"];
        if (id) {
          this.#agentsProjects.favoriteProject(
            id,
            button.getAttribute("aria-pressed") !== "true",
          );
          this.#render();
        }
        break;
      }
      case "project-open":
        if (button.dataset["project"])
          void this.#openProject(button.dataset["project"]!);
        break;
      case "project-archive-open":
        if (button.dataset["project"])
          void this.#openProjectAction(button.dataset["project"]!, "archive");
        break;
      case "project-restore-open":
        if (button.dataset["project"])
          void this.#openProjectAction(button.dataset["project"]!, "restore");
        break;
      case "project-action-cancel":
        this.#closeModalSurface();
        break;
      case "project-action-confirm":
        void this.#confirmProjectAction();
        break;
      case "project-alias-reset":
        void this.#resetProjectAlias(button);
        break;
      case "agent-alias-reset":
        void this.#resetAgentAlias(button);
        break;
      case "agent-open":
        if (button.dataset["id"])
          void this.#openAgent(
            button.dataset["id"]!,
            button.dataset["project"] ??
              (this.#scope.kind === "project" ? this.#scope.projectId : ""),
          );
        break;
      case "session-open":
        if (button.dataset["id"])
          void this.#openTechnicalSession(
            button.dataset["id"]!,
            button.dataset["project"] ??
              (this.#scope.kind === "project" ? this.#scope.projectId : ""),
          );
        break;
      case "session-page":
        if (this.#modal?.type === "session")
          void this.#loadTechnicalSessionDetails(
            this.#modal,
            Math.max(0, Number(button.dataset["offset"]) || 0),
          );
        break;
      case "agent-task-page":
        if (this.#modal?.type === "agent")
          void this.#loadAgentDetails(
            this.#modal,
            Math.max(0, Number(button.dataset["offset"]) || 0),
          );
        break;
      case "agent-file-task":
        void this.#openAgentFileTask(button);
        break;
      case "agent-logs-open":
        if (button.dataset["project"] && button.dataset["sessionId"])
          void this.#openAgentSessionLogs(
            button.dataset["project"]!,
            button.dataset["sessionId"]!,
          );
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
      case "task-open":
        if (button.dataset["id"])
          void this.#openTask(button.dataset["id"]!, button.dataset["project"]);
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
          ...(this.#modal?.type === "session"
            ? (this.#modal.events ?? [])
            : []),
        ].find((row) => nonemptyId(row["id"]) && row["id"] === logId);
        if (log) {
          const owner =
            currentTask?.projectId ??
            (this.#modal?.type === "session" ? this.#modal.projectId : null) ??
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
      case "log-open":
        if (button.dataset["id"] && button.dataset["project"])
          void this.#openLogById(
            button.dataset["id"]!,
            button.dataset["project"]!,
          );
        break;
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

  #onSubmit(event: SubmitEvent): void {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const action = form.dataset["action"];
    if (action !== "project-alias-form" && action !== "agent-alias-form")
      return;
    event.preventDefault();
    const alias = new FormData(form).get("alias");
    if (typeof alias !== "string") return;
    if (action === "project-alias-form")
      void this.#saveProjectAlias(form, alias);
    else void this.#saveAgentAlias(form, alias);
  }

  #expectedRevision(element: HTMLElement): Revision | null {
    const epoch = element.dataset["revisionEpoch"];
    const revision = Number(element.dataset["revision"]);
    return epoch && Number.isSafeInteger(revision) && revision >= 0
      ? { epoch, revision }
      : null;
  }

  async #openProject(id: string): Promise<void> {
    this.#view = "overview";
    await this.#changeScope({ kind: "project", projectId: id });
  }

  async #openProjectAction(
    id: string,
    action: "archive" | "restore",
  ): Promise<void> {
    const modalGeneration = ++this.#modalGeneration;
    const project = this.#projects.find((entry) => projectId(entry) === id);
    if (!project) {
      this.#toast(localeText.t("projects.archive.blocked.missing"));
      return;
    }
    try {
      const snapshot = await this.#api.snapshot({
        kind: "project",
        projectId: id,
      });
      if (!this.#currentModal(modalGeneration)) return;
      this.#projectRevisions.set(id, snapshot.revision);
      this.#rememberModalFocus();
      this.#modal = null;
      this.#projectActionDialog = {
        project: { ...project, id, name: projectName(project) },
        action,
        revision: snapshot.revision,
        status: null,
      };
      this.#auxiliaryModal = "project-action";
      this.#renderModal(true);
    } catch (error) {
      if (!this.#currentModal(modalGeneration)) return;
      this.#toast(this.#error(error));
    }
  }

  async #confirmProjectAction(): Promise<void> {
    const dialog = this.#projectActionDialog;
    if (!dialog || this.#projectActionBusy) return;
    const id = projectId(dialog.project);
    if (!id) return;
    this.#projectActionBusy = true;
    this.#renderModal();
    try {
      const result =
        dialog.action === "archive"
          ? await this.#agentsProjects.archiveProject(id, dialog.revision)
          : await this.#agentsProjects.restoreProject(id, dialog.revision);
      if (
        this.#projectActionDialog === dialog &&
        !this.#listeners.signal.aborted
      )
        this.#projectActionDialog = { ...dialog, status: result };
      this.#toast(
        renderProjectActionStatus(
          result,
          agentsProjectsLocale,
          projectName(dialog.project),
        ),
      );
      if (result.state === "ok") await this.#refreshProjects();
    } catch (error) {
      this.#toast(this.#error(error));
    } finally {
      this.#projectActionBusy = false;
      this.#renderModal();
    }
  }

  async #saveProjectAlias(form: HTMLFormElement, alias: string): Promise<void> {
    if (this.#projectActionBusy) return;
    const id = form.dataset["project"];
    const revision = this.#expectedRevision(form);
    if (!id || !revision) {
      this.#toast(localeText.t("projects.archive.blocked.stale"));
      return;
    }
    this.#projectActionBusy = true;
    const submit = form.querySelector<HTMLButtonElement>("[type=submit]");
    if (submit) submit.disabled = true;
    try {
      const result = await this.#agentsProjects.setProjectAlias(
        id,
        alias,
        revision,
      );
      const project = this.#projects.find((entry) => projectId(entry) === id);
      this.#toast(
        renderProjectActionStatus(
          result,
          agentsProjectsLocale,
          project ? projectName(project) : id,
        ),
      );
      if (result.state === "ok") await this.#refreshProjects();
    } catch (error) {
      this.#toast(this.#error(error));
    } finally {
      this.#projectActionBusy = false;
      if (submit?.isConnected) submit.disabled = false;
    }
  }

  async #resetProjectAlias(button: HTMLElement): Promise<void> {
    if (this.#projectActionBusy) return;
    const form = button.closest<HTMLFormElement>(
      "form[data-action=project-alias-form]",
    );
    const id = form?.dataset["project"];
    const revision = form ? this.#expectedRevision(form) : null;
    if (!id || !revision) {
      this.#toast(localeText.t("projects.archive.blocked.stale"));
      return;
    }
    this.#projectActionBusy = true;
    try {
      const result = await this.#agentsProjects.resetProjectAlias(id, revision);
      const project = this.#projects.find((entry) => projectId(entry) === id);
      this.#toast(
        renderProjectActionStatus(
          result,
          agentsProjectsLocale,
          project ? projectName(project) : id,
        ),
      );
      if (result.state === "ok") await this.#refreshProjects();
    } catch (error) {
      this.#toast(this.#error(error));
    } finally {
      this.#projectActionBusy = false;
    }
  }

  async #saveAgentAlias(form: HTMLFormElement, alias: string): Promise<void> {
    if (this.#projectActionBusy || this.#modal?.type !== "agent") return;
    const modal = this.#modal;
    const identity = this.#agentAliasIdentity(form);
    const revision = this.#expectedRevision(form);
    if (!identity || !revision) {
      this.#toast(localeText.t("agents.alias.identityUnavailable"));
      return;
    }
    this.#projectActionBusy = true;
    try {
      const result = await this.#agentsProjects.setAgentAlias(
        modal.projectId,
        identity,
        alias,
        revision,
      );
      this.#toast(
        renderProjectActionStatus(
          result,
          agentsProjectsLocale,
          text(modal.agent, "alias") ??
            text(modal.agent, "name") ??
            identity.id,
        ),
      );
      if (result.state === "ok" && this.#modal === modal) {
        const agent = { ...modal.agent };
        if (result.alias === null) delete agent["alias"];
        else agent["alias"] = result.alias;
        this.#modal = {
          ...modal,
          agent,
          revision: result.revision ?? modal.revision,
        };
      }
    } catch (error) {
      this.#toast(this.#error(error));
    } finally {
      this.#projectActionBusy = false;
      this.#renderModal();
    }
  }

  async #resetAgentAlias(button: HTMLElement): Promise<void> {
    if (this.#projectActionBusy || this.#modal?.type !== "agent") return;
    const form = button.closest<HTMLFormElement>(
      "form[data-action=agent-alias-form]",
    );
    if (!form) return;
    const modal = this.#modal;
    const identity = this.#agentAliasIdentity(form);
    const revision = this.#expectedRevision(form);
    if (!identity || !revision) {
      this.#toast(localeText.t("agents.alias.identityUnavailable"));
      return;
    }
    this.#projectActionBusy = true;
    try {
      const result = await this.#agentsProjects.resetAgentAlias(
        modal.projectId,
        identity,
        revision,
      );
      this.#toast(
        renderProjectActionStatus(
          result,
          agentsProjectsLocale,
          text(modal.agent, "name") ?? identity.id,
        ),
      );
      if (result.state === "ok" && this.#modal === modal) {
        const agent = { ...modal.agent };
        delete agent["alias"];
        this.#modal = {
          ...modal,
          agent,
          revision: result.revision ?? modal.revision,
        };
      }
    } catch (error) {
      this.#toast(this.#error(error));
    } finally {
      this.#projectActionBusy = false;
      this.#renderModal();
    }
  }

  #agentAliasIdentity(form: HTMLFormElement): AgentAliasIdentity | null {
    const kind = form.dataset["identityKind"];
    const id = form.dataset["identityId"];
    return (kind === "agent" || kind === "client" || kind === "session") &&
      nonemptyId(id)
      ? { kind, id }
      : null;
  }

  async #refreshProjects(): Promise<void> {
    if (this.#listeners.signal.aborted) return;
    this.#projectRevisionKey = "";
    this.#projectRevisions.clear();
    await this.#loadProjects(this.#loadGeneration);
    this.#render();
  }

  async #changeScope(scope: QueryScope): Promise<void> {
    this.#closeModalSurface();
    this.#agentViewLoad += 1;
    this.#workingAgentLoad += 1;
    this.#technicalSessions = null;
    this.#workingAgents = null;
    this.#scope = scope;
    this.#mobile = false;
    this.#page = 1;
    this.#filters = { tasks: {}, agents: {}, logs: {} };
    this.#sorts = { tasks: [], agents: [], logs: [] };
    this.#search = "";
    this.#returnAgent = null;
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
    const generation = ++this.#modalGeneration;
    try {
      const snapshot = await this.#api.snapshot({
        kind: "project",
        projectId: modal.projectId,
      });
      if (!this.#currentModal(generation)) return;
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope: { kind: "project", projectId: modal.projectId },
        collection: "tasks",
        snapshotToken: snapshot.snapshotToken,
        limit: 1,
        filters: { id },
      });
      if (!this.#currentModal(generation)) return;
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
        this.#toast(localeText.t("ui.modal.task.notInFreshSnapshot"));
      }
    } catch (error) {
      if (!this.#currentModal(generation)) return;
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
    const generation = ++this.#modalGeneration;
    try {
      const scope = { kind: "project" as const, projectId: owner };
      const snapshot = await this.#api.snapshot(scope);
      if (!this.#currentModal(generation)) return;
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope,
        collection: "agents",
        snapshotToken: snapshot.snapshotToken,
        filters: { id },
        limit: 8,
      });
      if (!this.#currentModal(generation)) return;
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
      const modal: Extract<ModalState, { type: "agent" }> = {
        type: "agent",
        agent: safeClone(agent),
        projectId: owner,
        revision: page.revision,
        snapshotToken: page.snapshotToken,
        tasks: null,
        files: null,
        taskOffset: 0,
        taskTotal: null,
        projectArchived: this.#isProjectArchived(owner),
        loading: true,
        ...(returnTask ? { returnTask: safeClone(returnTask) } : {}),
      };
      this.#modal = modal;
      this.#renderModal(true);
      await this.#loadAgentDetails(modal, 0);
    } catch (error) {
      this.#toast(this.#error(error));
    }
  }

  async #loadAgentDetails(
    modal: Extract<ModalState, { type: "agent" }>,
    offset: number,
  ): Promise<void> {
    const loading = { ...modal, loading: true, taskOffset: offset };
    this.#modal = loading;
    this.#renderModal();
    try {
      const taskPage = await this.#agentsProjects.listAgentTasks(
        modal.projectId,
        modal.agent,
        { offset, limit: 8 },
      );
      if (this.#modal !== loading || this.#listeners.signal.aborted) return;
      const taskIds = taskPage.rows
        .map((task) => task["id"])
        .filter((id): id is string => nonemptyId(id));
      let files: readonly Row[] | null = [];
      if (taskIds.length) {
        const filePage = await this.#api.query<Row>({
          version: API_VERSION,
          scope: { kind: "project", projectId: modal.projectId },
          collection: "files",
          snapshotToken: taskPage.snapshot.snapshotToken,
          filters: { taskId: { any: taskIds } },
          offset: 0,
          limit: 200,
        });
        files =
          filePage.source.state === "unavailable"
            ? null
            : filePage.rows.filter(
                (file) =>
                  file["projectId"] === modal.projectId &&
                  nonemptyId(file["taskId"]) &&
                  taskIds.includes(String(file["taskId"])) &&
                  nonemptyId(file["artifactId"]),
              );
      }
      if (this.#modal !== loading) return;
      this.#modal = {
        ...loading,
        snapshotToken: taskPage.snapshot.snapshotToken,
        revision: taskPage.snapshot.revision,
        tasks:
          taskPage.page.source.state === "unavailable" ? null : taskPage.rows,
        files,
        taskTotal: taskPage.page.total,
        loading: false,
      };
    } catch {
      if (this.#modal !== loading) return;
      this.#modal = { ...loading, tasks: null, files: null, loading: false };
    }
    this.#renderModal();
  }

  #isProjectArchived(id: string): boolean {
    const project = this.#projects.find((entry) => projectId(entry) === id);
    return (
      project?.["monitoring"] === false || project?.["archivedAtMs"] != null
    );
  }

  async #openTechnicalSession(id: string, owner: string): Promise<void> {
    if (!nonemptyId(id) || !nonemptyId(owner)) return;
    try {
      const result = await this.#agentsProjects.listTechnicalSessions(
        { kind: "project", projectId: owner },
        { filter: "all", limit: 200 },
      );
      const session = result.rows.find(
        (row) => row["id"] === id || row["sessionId"] === id,
      );
      if (!session) {
        this.#toast(localeText.t("agents.sessions.empty"));
        return;
      }
      this.#rememberModalFocus();
      const modal: Extract<ModalState, { type: "session" }> = {
        type: "session",
        session: safeClone(session),
        projectId: owner,
        snapshotToken: result.snapshot.snapshotToken,
        revision: result.snapshot.revision,
        tasks: null,
        events: null,
        taskOffset: 0,
        taskTotal: null,
        loading: true,
      };
      this.#modal = modal;
      this.#renderModal(true);
      await this.#loadTechnicalSessionDetails(modal, 0);
    } catch (error) {
      this.#toast(this.#error(error));
    }
  }

  async #loadTechnicalSessionDetails(
    modal: Extract<ModalState, { type: "session" }>,
    offset: number,
  ): Promise<void> {
    const sessionId =
      text(modal.session, "sessionId") ?? text(modal.session, "id");
    if (!sessionId) return;
    const loading = { ...modal, loading: true, taskOffset: offset };
    this.#modal = loading;
    this.#renderModal();
    try {
      const scope = { kind: "project" as const, projectId: modal.projectId };
      const [tasks, events] = await Promise.all([
        this.#api.query<Row>({
          version: API_VERSION,
          scope,
          collection: "tasks",
          snapshotToken: modal.snapshotToken,
          filters: { sessionId: { eq: sessionId } },
          offset,
          limit: 8,
        }),
        this.#api.query<Row>({
          version: API_VERSION,
          scope,
          collection: "logs",
          snapshotToken: modal.snapshotToken,
          filters: { sessionId: { eq: sessionId } },
          offset: 0,
          limit: 200,
        }),
      ]);
      if (this.#modal !== loading) return;
      this.#modal = {
        ...loading,
        tasks:
          tasks.source.state === "unavailable"
            ? null
            : tasks.rows.filter(
                (row) =>
                  row["projectId"] === modal.projectId &&
                  row["sessionId"] === sessionId,
              ),
        events:
          events.source.state === "unavailable"
            ? null
            : events.rows.filter(
                (row) =>
                  row["projectId"] === modal.projectId &&
                  row["sessionId"] === sessionId,
              ),
        taskTotal: tasks.total,
        loading: false,
      };
    } catch {
      if (this.#modal !== loading) return;
      this.#modal = { ...loading, tasks: null, events: null, loading: false };
    }
    this.#renderModal();
  }

  async #openAgentFileTask(button: HTMLElement): Promise<void> {
    const generation = ++this.#modalGeneration;
    const projectId = button.dataset["project"];
    const taskId = button.dataset["taskId"];
    const artifactId = button.dataset["artifactId"];
    const snapshotToken = button.dataset["snapshot"];
    if (!projectId || !taskId || !artifactId || !snapshotToken) return;
    try {
      const detail = await this.#agentsProjects.taskDetailsForFile(
        projectId,
        { projectId, taskId, artifactId },
        snapshotToken,
      );
      if (!this.#currentModal(generation)) return;
      if (detail.artifactUnavailable) {
        this.#toast(
          detail.unavailableMessage ??
            localeText.t("agents.file.detailUnavailable"),
        );
        return;
      }
      const revision =
        this.#modal?.type === "agent" && this.#modal.projectId === projectId
          ? this.#modal.revision
          : null;
      if (!detail.artifact) return;
      this.#showTask(
        detail.task,
        projectId,
        snapshotToken,
        revision,
        undefined,
        {},
        {
          kind: detail.artifact.kind,
          artifact: detail.artifact,
        },
      );
    } catch (error) {
      this.#toast(this.#error(error));
    }
  }

  async #openAgentSessionLogs(
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    if (this.#modal?.type === "agent")
      this.#returnAgent = safeClone(this.#modal);
    this.#closeModalSurface();
    this.#scope = { kind: "project", projectId };
    this.#view = "logs";
    this.#search = sessionId;
    this.#page = 1;
    await this.#load(this.#scope, false);
    this.#watch();
  }

  async #openLogById(id: string, owner: string): Promise<void> {
    const generation = ++this.#modalGeneration;
    try {
      const scope = { kind: "project" as const, projectId: owner };
      const snapshot = await this.#api.snapshot(scope);
      if (!this.#currentModal(generation)) return;
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope,
        collection: "logs",
        snapshotToken: snapshot.snapshotToken,
        filters: { id },
        limit: 1,
      });
      if (!this.#currentModal(generation)) return;
      const log = page.rows.find((row) => row["id"] === id);
      if (!log) return;
      this.#rememberModalFocus();
      this.#modal = {
        type: "log",
        log,
        projectId: owner,
        revision: page.revision,
      };
      this.#renderModal(true);
    } catch (error) {
      if (!this.#currentModal(generation)) return;
      this.#toast(this.#error(error));
    }
  }

  async #openTaskFromLog(
    logModal: Extract<ModalState, { type: "log" }>,
  ): Promise<void> {
    const taskId = logModal.log["taskId"];
    const requestId = logModal.log["requestId"];
    if (!nonemptyId(taskId) && !nonemptyId(requestId)) {
      this.#toast(localeText.t("ui.toast.eventIdentityMissing"));
      return;
    }
    const generation = ++this.#modalGeneration;
    try {
      const scope = { kind: "project" as const, projectId: logModal.projectId };
      const snapshot = await this.#api.snapshot(scope);
      if (!this.#currentModal(generation)) return;
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
      if (!this.#currentModal(generation)) return;
      const task = page.rows.find((row) =>
        nonemptyId(taskId)
          ? rowTaskId(row) === taskId
          : nonemptyId(row["requestId"]) && row["requestId"] === requestId,
      );
      if (!task) {
        this.#toast(localeText.t("ui.project.task.unavailable"));
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
      if (!this.#currentModal(generation)) return;
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
      this.#toast(localeText.t("ui.toast.searchResultProjectMissing"));
      return;
    }
    this.#auxiliaryModal = null;
    if (kind === "agent") {
      await this.#openAgent(id, owner);
      return;
    }
    if (kind !== "task") return;
    const generation = ++this.#modalGeneration;
    try {
      const scope = { kind: "project" as const, projectId: owner };
      const snapshot = await this.#api.snapshot(scope);
      if (!this.#currentModal(generation)) return;
      const page = await this.#api.query<Row>({
        version: API_VERSION,
        scope,
        collection: "tasks",
        snapshotToken: snapshot.snapshotToken,
        filters: { id },
        limit: 1,
      });
      if (!this.#currentModal(generation)) return;
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
      if (!this.#currentModal(generation)) return;
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
      this.#toast(localeText.t("ui.toast.agentLogIdentityMissing"));
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
    const action = target.dataset["action"];
    if (action === "project-search") {
      this.#projectsSearch = target.value;
      this.#render();
      return;
    }
    if (
      ["task-search", "log-search"].includes(target.id) ||
      action === "agent-search"
    ) {
      this.#search = target.value;
      this.#page = 1;
      if (this.#searchTimer !== null) window.clearTimeout(this.#searchTimer);
      this.#searchTimer = window.setTimeout(() => {
        this.#searchTimer = null;
        this.#queryForTable();
        if (this.#view === "agents") this.#loadAgentsView();
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
      this.#toast(localeText.t("ui.toast.refreshIntervalUpdated"));
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
      "5": "system",
      "6": "projects",
    };
    if (views[event.key]) {
      event.preventDefault();
      this.#setView(views[event.key]!);
      this.#render();
      if (this.#view === "agents") this.#loadAgentsView();
    } else if (event.key === "/") {
      event.preventDefault();
      $("#task-search, [data-action=agent-search], #log-search")?.focus();
    } else if (
      event.key.toLowerCase() === "f" &&
      this.#view !== "system" &&
      this.#view !== "projects"
    ) {
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
        '[data-action="task"],[data-action="task-open"],[data-action="agent"],[data-action="agent-open"],[data-action="session-open"],[data-action="log"],[data-action="log-open"]',
      )
    ) {
      event.preventDefault();
      target.click();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const rows = [
        ...document.querySelectorAll<HTMLElement>(
          '#main [data-action="task"],#main [data-action="task-open"],#main [data-action="agent"],#main [data-action="agent-open"],#main [data-action="session-open"],#main [data-action="log"],#main [data-action="log-open"]',
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
        {
          value: null,
          count: page.total - knownCount,
          label: localeText.t("common.noData"),
        },
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
      ? `<p class="column-filter-description">${localeText.t("ui.filter.numeric.description")}</p><div class="column-number-range"><label for="filter-min">${localeText.t("ui.filter.numeric.min")}<input id="filter-min" type="number" min="0" step="any" value="${filter?.type === "number" && filter.min !== "" ? esc(typeof filter.min === "number" ? filter.min / 1000 : "") : ""}"></label><span>—</span><label for="filter-max">${localeText.t("ui.filter.numeric.max")}<input id="filter-max" type="number" min="0" step="any" value="${filter?.type === "number" && filter.max !== "" ? esc(typeof filter.max === "number" ? filter.max / 1000 : "") : ""}"></label></div><label class="column-unknown"><input id="filter-missing" type="checkbox" ${filter?.type !== "number" || filter.includeUnknown ? "checked" : ""}>${localeText.t("ui.filter.includeMissing")}</label>`
      : this.#filterOptions.length
        ? `<div class="column-value-search">${icon("search", "small")}<input id="filter-value-search" type="search" autocomplete="off" value="${esc(this.#filterSearch)}" placeholder="${localeText.t("ui.filter.searchValues.placeholder")}" aria-label="${localeText.t("ui.filter.searchValues.aria")}"></div><div class="column-choice-actions"><button type="button" data-action="filter-select-visible">${localeText.t("ui.filter.selectVisible")}</button><button type="button" data-action="filter-select-all">${localeText.t("ui.filter.selectAll")}</button><button type="button" data-action="filter-select-none">${localeText.t("ui.filter.selectNone")}</button></div><div class="column-values" id="filter-values"></div><div class="column-selection-note" id="filter-selection-note" aria-live="polite"></div>`
        : `<label class="column-text-label" for="filter-text">${localeText.t("ui.filter.contains")}</label><input id="filter-text" type="search" value="${filter?.type === "text" ? esc(filter.query) : ""}"><p class="column-filter-description">${localeText.t("ui.filter.caseInsensitive")}</p>`;
    this.#mountOverlay(
      "filter",
      `<div class="overlay" data-action="backdrop"><section class="column-filter-popup" role="dialog" aria-modal="true" aria-labelledby="column-filter-title" tabindex="-1"><header><div><span>${localeText.t("ui.filter.title")}</span><h3 id="column-filter-title">${esc(column)}</h3></div><button class="icon-button" data-action="close" aria-label="${localeText.t("ui.filter.close")}">${icon("close", "small")}</button></header><div class="column-filter-body">${body}<p id="filter-error" class="field-error" role="alert" hidden></p></div><footer><button class="btn small" data-action="filter-clear" data-column="${esc(column)}">${localeText.t("ui.filter.clear")}</button><button class="btn primary small" data-action="filter-apply" data-column="${esc(column)}">${localeText.t("ui.filter.apply")}</button></footer></section></div>`,
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
      `<div class="overlay" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><header class="modal-header"><h2 id="modal-title">${localeText.t("ui.search.title")}</h2><button class="icon-button" data-action="close" aria-label="${localeText.t("ui.modal.close")}">${icon("close")}</button></header><div class="modal-body"><label class="search-box global-modal-search">${icon("search")}<input id="global-search-input" type="search" placeholder="${localeText.t("ui.search.placeholder")}" aria-label="${localeText.t("ui.search.global.aria")}" autocomplete="off" value="${esc(query)}"></label><div id="global-results" class="global-search-results">${results}</div></div></section></div>`,
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
        localeText.t("ui.search.prompt"),
        localeText.t("ui.search.apiOnly"),
        "search",
      );
      return;
    }
    holder.innerHTML = this.#empty(
      localeText.t("common.loading"),
      localeText.t("ui.search.globalScope"),
      "search",
    );
    try {
      const snapshot = await this.#api.snapshot({ kind: "global" });
      if (this.#listeners.signal.aborted || serial !== this.#globalSearchSerial)
        return;
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
            const label =
              type === "project"
                ? localeText.t("nav.projects")
                : type === "agent"
                  ? localeText.t("nav.agents")
                  : localeText.t("nav.tasks");
            return `<button class="search-result" data-action="search-result" data-kind="${type}" data-id="${esc(id)}" data-project="${esc(text(row, "projectId") ?? "")}">${icon(type === "project" ? "folder" : type === "agent" ? "users" : "code")}<div><strong>${esc(text(row, "name") ?? text(row, "label") ?? text(row, "kind") ?? id)}</strong><small>${label} · ${esc(text(row, "state") ?? text(row, "projectName") ?? "")}</small></div>${icon("chevron", "small")}</button>`;
          })
          .join("") ||
        this.#empty(
          localeText.t("common.noResults"),
          localeText.t("ui.search.emptyDescription"),
          "search",
        );
    } catch (error) {
      if (serial !== this.#globalSearchSerial) return;
      holder.innerHTML = this.#empty(
        localeText.t("ui.search.unavailable"),
        this.#error(error),
        "alert",
      );
    }
  }

  #showHelp(): void {
    const views = (
      [
        "nav.overview",
        "nav.tasks",
        "nav.agents",
        "nav.logs",
        "nav.system",
      ] as const
    )
      .map((key) => localeText.t(key))
      .join(" / ");
    this.#mountOverlay(
      "help",
      `<div class="overlay" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><header class="modal-header"><h2 id="modal-title">${localeText.t("common.help")}</h2><button class="icon-button" data-action="close" aria-label="${localeText.t("common.close")}">${icon("close")}</button></header><div class="modal-body"><p>${localeText.t("ui.help.readOnly")}</p>${[
        [views, "1–5"],
        [localeText.t("ui.help.shortcuts.viewSearch"), "/"],
        [localeText.t("ui.help.shortcuts.globalSearch"), "Ctrl K"],
        [localeText.t("ui.help.shortcuts.filtersSort"), "f / o"],
        [localeText.t("ui.help.shortcuts.multiSort"), "Ctrl + click"],
        [localeText.t("ui.help.shortcuts.freeze"), "Space"],
        [localeText.t("ui.help.shortcuts.follow"), "l"],
        [localeText.t("ui.help.shortcuts.system"), "5"],
        [localeText.t("ui.help.shortcuts.scope"), "c"],
        [localeText.t("ui.help.shortcuts.refresh"), "r"],
        [localeText.t("ui.help.shortcuts.export"), "e"],
        [localeText.t("ui.help.shortcuts.settings"), ","],
        [localeText.t("ui.help.shortcuts.taskCodeResponse"), "p / y"],
        [localeText.t("ui.help.shortcuts.taskEventsAgent"), "g / a"],
        [localeText.t("ui.help.shortcuts.close"), "Esc"],
      ]
        .map(
          ([label, key]) =>
            `<div class="shortcut-row"><span>${label}</span><kbd>${key}</kbd></div>`,
        )
        .join(
          "",
        )}<p class="details-note">${localeText.t("ui.help.freezeNote")}</p></div></section></div>`,
      ".modal",
    );
  }

  #showSettings(): void {
    this.#mountOverlay(
      "settings",
      `<div class="overlay" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><header class="modal-header"><h2 id="modal-title">${localeText.t("common.settings")}</h2><button class="icon-button" data-action="close" aria-label="${localeText.t("common.close")}">${icon("close")}</button></header><div class="modal-body"><div class="field"><label class="modal-label" for="refresh-interval">${localeText.t("ui.settings.refreshInterval")}</label><select id="refresh-interval"><option value="2000" ${this.#refreshInterval === 2000 ? "selected" : ""}>${localeText.t("ui.settings.interval.fast")}</option><option value="4000" ${this.#refreshInterval === 4000 ? "selected" : ""}>${localeText.t("ui.settings.interval.standard")}</option><option value="8000" ${this.#refreshInterval === 8000 ? "selected" : ""}>${localeText.t("ui.settings.interval.slow")}</option></select><small>${localeText.t("ui.settings.refreshNote")}</small></div></div></section></div>`,
      ".modal",
    );
  }

  #showExport(collection: Collection): void {
    this.#exportCollection = collection;
    this.#mountOverlay(
      "export",
      `<div class="overlay" data-action="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><header class="modal-header"><h2 id="modal-title">${localeText.t("common.export")}</h2><button class="icon-button" data-action="close" aria-label="${localeText.t("common.close")}">${icon("close")}</button></header><div class="modal-body"><p>${localeText.t("ui.export.description")}</p><button class="source-option" data-action="export-format" data-collection="${esc(collection)}" data-format="csv"><span class="source-option-icon">${icon("file")}</span><div><strong>${localeText.t("ui.export.csv.title")}</strong><p>${localeText.t("ui.export.csv.description")}</p></div>${icon("download", "small")}</button><button class="source-option" data-action="export-format" data-collection="${esc(collection)}" data-format="json"><span class="source-option-icon">${icon("code")}</span><div><strong>${localeText.t("ui.export.json.title")}</strong><p>${localeText.t("ui.export.json.description")}</p></div>${icon("download", "small")}</button></div></section></div>`,
      ".modal",
    );
  }
}

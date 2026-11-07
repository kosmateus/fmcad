/// <reference lib="dom" />

import type {
  ConsoleArtifactKind,
  ConsoleArtifactRequest,
  ConsoleArtifactResult,
  ConsoleProjectRecord,
  ConsoleQueryCollection,
  ConsoleQueryPage,
  ConsoleQueryRecord,
  ConsoleQueryRequest,
  ConsoleQueryScope,
  ConsoleQuerySnapshot,
  ConsoleRevision,
} from "../contracts/query.js";

export const AGENTS_PROJECTS_MESSAGES = {
  "agents.title": "Agents and sessions",
  "agents.list.all": "All agents",
  "agents.list.active": "Active agents",
  "agents.list.working": "Working agents",
  "agents.list.history": "History and unknown",
  "agents.list.technical": "Technical sessions",
  "agents.list.unavailable":
    "Agent presence is unavailable; no empty result is assumed.",
  "agents.search.label": "Search agents, sessions, or projects",
  "agents.identity.unknown": "Unknown identity",
  "agents.identity.notReported": "Identity not reported",
  "agents.presence.unknown": "Presence unknown",
  "agents.work.none": "No active work reported",
  "agents.detail.title": "Agent: {agentName}",
  "agents.detail.tasks": "Tasks",
  "agents.detail.files": "Files",
  "agents.detail.session": "Session: {sessionId}",
  "agents.detail.model": "Model: {model}",
  "agents.detail.role": "Role: {role}",
  "agents.detail.pid": "Process ID: {pid}",
  "agents.detail.heartbeat": "Last heartbeat: {lastSeen}",
  "agents.detail.freshness": "Presence source: {source}; observed {observedAt}",
  "agents.detail.openLogs.aria": "Open logs for agent {agentName}",
  "agents.detail.noIdentity":
    "The source did not report a stable agent identity.",
  "agents.detail.noTasks": "No tasks are linked to this reported identity.",
  "agents.detail.tasksUnavailable":
    "Task history is unavailable; no empty result is assumed.",
  "agents.detail.noFiles":
    "No retained file references are available for these tasks.",
  "agents.detail.filesUnavailable":
    "File history is unavailable; no empty result is assumed.",
  "agents.sessions.empty": "No technical sessions were reported.",
  "agents.session.open.aria": "Open technical session {sessionId}",
  "agents.session.title": "Technical session: {sessionId}",
  "agents.session.events": "Session events",
  "agents.session.noEvents": "No retained events are linked to this session.",
  "agents.session.eventsUnavailable":
    "Session event history is unavailable; no empty result is assumed.",
  "agents.alias.label": "Agent label",
  "agents.alias.input.aria": "Set label for {agentName}",
  "agents.alias.save": "Save agent label",
  "agents.alias.reset": "Reset agent label",
  "agents.alias.saved": "Agent label saved.",
  "agents.alias.reset.done": "Agent label reset to its source-reported name.",
  "agents.alias.validation.required": "Enter an agent label.",
  "agents.alias.validation.tooLong":
    "Agent labels can contain at most {maxLength} characters.",
  "agents.alias.validation.unavailable":
    "The agent label could not be saved because project history is unavailable.",
  "agents.alias.archivedReadOnly":
    "Restore this project before changing agent labels.",
  "agents.alias.identityUnavailable":
    "No stable source-reported identity is available for a label.",
  "agents.file.openTask.aria": "Open task {taskId} for file {fileName}",
  "agents.file.detailUnavailable":
    "The file reference is not linked to an exact retained task artifact.",
  "agents.file.kind.unknown": "File",
  "agents.task.returnToAgent.aria": "Return to agent {agentName}",
  "projects.title": "Projects",
  "projects.list.monitored": "Monitored",
  "projects.list.archived": "Archived",
  "projects.list.unknown": "Lifecycle unknown",
  "projects.list.empty": "No matching projects are available.",
  "projects.search.label": "Search projects",
  "projects.name.unknown": "Unnamed project",
  "projects.favorite.add": "Add to favorites",
  "projects.favorite.remove": "Remove from favorites",
  "projects.favorite.add.aria": "Add {projectName} to favorites",
  "projects.favorite.remove.aria": "Remove {projectName} from favorites",
  "projects.archive.open.aria": "Archive {projectName}",
  "projects.restore.open.aria": "Restore {projectName}",
  "projects.archive.confirm.title": "Archive project?",
  "projects.archive.confirm.body":
    "Stop monitoring {projectName}? Its history and results will be kept.",
  "projects.archive.confirm.liveCheck":
    "The server will recheck the complete current task queue and agent presence. Stale or unknown state, or any open work, will block archiving.",
  "projects.archive.confirm.action": "Stop monitoring",
  "projects.archive.success":
    "{projectName} was removed from monitoring. History and results were kept.",
  "projects.archive.banner":
    "This project is archived. Its retained history is read-only until restored.",
  "projects.archive.blocked.stale":
    "Current project data is stale. Refresh before archiving.",
  "projects.archive.blocked.unknown":
    "The full current task and presence state could not be confirmed. The project was not archived.",
  "projects.archive.blocked.activity":
    "The project still has queued, active, preparing, processing, or unresolved work.",
  "projects.archive.blocked.presence":
    "A current agent or technical session is still present or its status is unknown.",
  "projects.archive.blocked.alreadyArchived":
    "This project is already archived.",
  "projects.archive.blocked.revision":
    "Project state changed. Review the current state before archiving.",
  "projects.archive.blocked.missing":
    "The registered project or its history database is unavailable. No data was recreated.",
  "projects.archive.blocked.lifecycleMismatch":
    "Project monitoring metadata is inconsistent. No lifecycle change was made.",
  "projects.archive.confirm.aria": "Confirm archiving {projectName}",
  "projects.restore.confirm.title": "Restore project?",
  "projects.restore.confirm.body":
    "Restore {projectName} to monitoring? This will not start or resubmit any tasks.",
  "projects.restore.confirm.action": "Restore monitoring",
  "projects.restore.success":
    "{projectName} was restored. No task was started or resubmitted.",
  "projects.restore.blocked.notArchived": "This project is not archived.",
  "projects.restore.confirm.aria": "Confirm restoring {projectName}",
  "projects.alias.label": "Project name",
  "projects.alias.input.aria": "Set project name for {projectName}",
  "projects.alias.save": "Save project name",
  "projects.alias.reset": "Reset project name",
  "projects.alias.saved": "Project name saved.",
  "projects.alias.reset.done":
    "Project name reset to the registered project name.",
  "projects.alias.validation.required": "Enter a project name.",
  "projects.alias.validation.tooLong":
    "Project names can contain at most {maxLength} characters.",
  "projects.alias.validation.unavailable":
    "The project name could not be saved because the project history is unavailable.",
  "projects.alias.archivedReadOnly":
    "Restore this project before changing its name.",
  "projects.action.accessDenied":
    "You do not have permission to change this project.",
  "projects.action.failed":
    "The project action could not be completed. Retained data was not deleted.",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.notReported": "Not reported",
  "common.previous": "Previous",
  "common.next": "Next",
} as const;

export type AgentsProjectsMessageKey = keyof typeof AGENTS_PROJECTS_MESSAGES;
export type LocaleParams = Readonly<Record<string, string | number>>;

export interface AgentsProjectsLocaleText {
  t(key: AgentsProjectsMessageKey, params?: LocaleParams): string;
  formatNumber(value: number): string;
  formatDate(value: number | Date): string;
  formatDuration(milliseconds: number): string;
  subscribe(listener: () => void): () => void;
}

export type ProjectActionKind =
  | "set-alias"
  | "reset-alias"
  | "set-agent-alias"
  | "reset-agent-alias"
  | "archive"
  | "restore";

export interface AgentAliasIdentity {
  readonly kind: "agent" | "client" | "session";
  readonly id: string;
}

interface ProjectActionBase {
  readonly version: 1;
  readonly projectId: string;
  readonly expectedRevision: ConsoleRevision;
}

export type ProjectActionRequest =
  | (ProjectActionBase & {
      readonly action: "set-alias";
      readonly alias: string;
    })
  | (ProjectActionBase & { readonly action: "reset-alias" })
  | (ProjectActionBase & {
      readonly action: "set-agent-alias";
      readonly identity: AgentAliasIdentity;
      readonly alias: string;
    })
  | (ProjectActionBase & {
      readonly action: "reset-agent-alias";
      readonly identity: AgentAliasIdentity;
    })
  | (ProjectActionBase & { readonly action: "archive" })
  | (ProjectActionBase & { readonly action: "restore" });

export interface ProjectActionReason {
  readonly key: AgentsProjectsMessageKey;
  readonly params?: LocaleParams;
}

export interface ProjectActionResponse {
  readonly version: 1;
  readonly state:
    "ok" | "blocked" | "stale" | "unavailable" | "forbidden" | "error";
  readonly code: string;
  readonly projectId: string;
  readonly revision: ConsoleRevision | null;
  readonly monitoring: boolean | null;
  readonly archivedAtMs: number | null;
  readonly alias: string | null;
  readonly identity?: AgentAliasIdentity;
  readonly reasons: readonly ProjectActionReason[];
}

export interface AgentsProjectsActionPort {
  execute(request: ProjectActionRequest): Promise<ProjectActionResponse>;
}

export interface AgentsProjectsQueryPort {
  snapshot(scope: ConsoleQueryScope): Promise<ConsoleQuerySnapshot>;
  query<Row extends ConsoleQueryRecord = ConsoleQueryRecord>(
    request: ConsoleQueryRequest,
  ): Promise<ConsoleQueryPage<Row>>;
  detail(request: ConsoleArtifactRequest): Promise<ConsoleArtifactResult>;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PROJECT_FAVORITES_STORAGE_KEY =
  "fmcad-control-center-favorites-v1";
export { PROJECT_ACTIONS_ROUTE } from "../contracts/project-actions.js";
const PAGE_SIZE = 200;
const MAX_FAVORITES_BYTES = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 256
  );
}

function favoriteList(storage: KeyValueStorage | null): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(PROJECT_FAVORITES_STORAGE_KEY);
    if (!raw || raw.length > MAX_FAVORITES_BYTES) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (
      !record(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype ||
      parsed["version"] !== 1 ||
      !Array.isArray(parsed["projectIds"])
    )
      return new Set();
    return new Set(
      parsed["projectIds"].filter((id): id is string => validId(id)),
    );
  } catch {
    return new Set();
  }
}

function persistFavorites(
  storage: KeyValueStorage | null,
  favorites: ReadonlySet<string>,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      PROJECT_FAVORITES_STORAGE_KEY,
      JSON.stringify({ version: 1, projectIds: [...favorites].sort() }),
    );
  } catch {
    // A blocked browser store affects persistence only, not the current view.
  }
}

function projectLifecycle(
  row: ConsoleProjectRecord,
): "monitored" | "archived" | "unknown" {
  if (typeof row["archivedAtMs"] === "number" && row["monitoring"] === false)
    return "archived";
  if (row["monitoring"] === true && row["archivedAtMs"] === null)
    return "monitored";
  if (row["monitoring"] === false && row["archivedAtMs"] === null)
    return "unknown";
  return "unknown";
}

function projectMatchesSearch(
  row: ConsoleProjectRecord,
  query: string,
): boolean {
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase();
  if (!needle) return true;
  return [row.name, row.id].some(
    (value) =>
      typeof value === "string" &&
      value.normalize("NFKC").toLocaleLowerCase().includes(needle),
  );
}

function hasAnyIdentity(row: ConsoleQueryRecord): boolean {
  return [row["agentId"], row["clientId"], row["sessionId"]].some(validId);
}

function taskMatchesAgent(
  task: ConsoleQueryRecord,
  agent: ConsoleQueryRecord,
): boolean {
  if (!validId(agent.projectId) || task.projectId !== agent.projectId)
    return false;
  return (
    (validId(agent.agentId) && task.agentId === agent.agentId) ||
    (validId(agent.clientId) && task.clientId === agent.clientId) ||
    (validId(agent.sessionId) && task.sessionId === agent.sessionId)
  );
}

function taskFilterForAgent(
  identity: ConsoleQueryRecord,
): Readonly<Record<string, { eq: string }>> | null {
  if (validId(identity["agentId"]))
    return { agentId: { eq: identity["agentId"] } };
  if (validId(identity["clientId"]))
    return { clientId: { eq: identity["clientId"] } };
  if (validId(identity["sessionId"]))
    return { sessionId: { eq: identity["sessionId"] } };
  return null;
}

export function agentAliasIdentity(
  row: ConsoleQueryRecord,
): AgentAliasIdentity | null {
  const agentId = row["agentId"];
  if (validId(agentId)) return { kind: "agent", id: agentId };
  const clientId = row["clientId"];
  if (validId(clientId)) return { kind: "client", id: clientId };
  const sessionId = row["sessionId"];
  if (validId(sessionId)) return { kind: "session", id: sessionId };
  return null;
}

function html(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function message(
  locale: AgentsProjectsLocaleText,
  key: AgentsProjectsMessageKey,
  params?: LocaleParams,
): string {
  return html(locale.t(key, params));
}

function nonemptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function safeFileLabel(row: ConsoleQueryRecord): string {
  const path = nonemptyText(row["path"]);
  if (!path) return nonemptyText(row["name"]) ?? nonemptyText(row["id"]) ?? "";
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized))
    return normalized.slice(normalized.lastIndexOf("/") + 1);
  return normalized;
}

function agentDisplayName(
  row: ConsoleQueryRecord,
  locale: AgentsProjectsLocaleText,
): string {
  return (
    nonemptyText(row["alias"]) ??
    nonemptyText(row["name"]) ??
    nonemptyText(row["clientId"]) ??
    nonemptyText(row["sessionId"]) ??
    message(locale, "agents.identity.unknown")
  );
}

export interface AgentListRenderInput {
  readonly rows: readonly ConsoleQueryRecord[];
  readonly filter: AgentFilter;
  readonly localeText: AgentsProjectsLocaleText;
  readonly sourceState: string;
  readonly unavailable?: boolean;
}

export interface TechnicalSessionRenderInput {
  readonly rows: readonly ConsoleQueryRecord[];
  readonly filter: TechnicalSessionFilter;
  readonly localeText: AgentsProjectsLocaleText;
  readonly sourceState: string;
}

export interface TechnicalSessionDetailRenderInput {
  readonly session: ConsoleQueryRecord;
  readonly events: readonly ConsoleQueryRecord[] | null;
  readonly taskOffset?: number;
  readonly taskTotal?: number | null;
  readonly localeText: AgentsProjectsLocaleText;
}

/** Existing compact agent-list pattern; identities are never inferred from names. */
export function renderAgentList(input: AgentListRenderInput): string {
  const { localeText: locale } = input;
  const filters: readonly [AgentFilter, AgentsProjectsMessageKey][] = [
    ["all", "agents.list.all"],
    ["active", "agents.list.active"],
    ["working", "agents.list.working"],
    ["history", "agents.list.history"],
  ];
  const rows = input.rows
    .filter((row) => validId(row["id"]) && validId(row["projectId"]))
    .map((row) => {
      const id = row["id"] as string;
      const projectId = row["projectId"] as string;
      const name = agentDisplayName(row, locale);
      const presence = nonemptyText(row["presence"]);
      const role = nonemptyText(row["role"]);
      const model = nonemptyText(row["model"]);
      const work = nonemptyText(row["work"]);
      return `<button class="agent-list-row" type="button" data-action="agent-open" data-id="${html(id)}" data-project="${html(projectId)}" aria-label="${message(locale, "agents.detail.title", { agentName: name })}"><span class="agent-identity"><span class="agent-monogram" aria-hidden="true">${html(Array.from(name).slice(0, 2).join("").toLocaleUpperCase())}</span><span class="agent-identity-text"><span class="agent-name-line"><strong>${html(name)}</strong><span class="badge">${html(presence ?? locale.t("agents.presence.unknown"))}</span></span><span class="agent-role">${html(role ?? locale.t("common.notReported"))}${model ? ` · ${html(model)}` : ""}</span><span class="agent-tool">${html(id)}</span></span></span><span class="agent-work">${html(work ?? locale.t("agents.work.none"))}</span><span class="icon" aria-hidden="true">›</span></button>`;
    })
    .join("");
  const content =
    rows ||
    `<p class="project-list-description" role="status">${
      input.unavailable
        ? message(locale, "agents.list.unavailable")
        : message(locale, "agents.detail.noIdentity")
    }</p>`;
  return `<section class="panel table-panel"><div class="panel-head"><div><h2>${message(locale, "agents.title")}</h2></div><span class="inline-source">${html(input.sourceState)}</span></div><div class="agent-toolbar"><div class="segmented agent-filter" role="group" aria-label="${message(locale, "agents.title")}">${filters
    .map(
      ([filter, key]) =>
        `<button class="segment${input.filter === filter ? " active" : ""}" type="button" data-action="agent-filter" data-filter="${filter}" aria-pressed="${input.filter === filter}">${message(locale, key)}</button>`,
    )
    .join(
      "",
    )}</div><label class="search-box"><span class="sr-only">${message(locale, "agents.search.label")}</span><input type="search" data-action="agent-search" aria-label="${message(locale, "agents.search.label")}"></label></div><div class="agent-list">${content}</div></section>`;
}

export function renderTechnicalSessions(
  input: TechnicalSessionRenderInput,
): string {
  const { localeText: locale } = input;
  const filters: readonly [TechnicalSessionFilter, AgentsProjectsMessageKey][] =
    [
      ["all", "agents.list.technical"],
      ["confirmed", "agents.list.active"],
      ["history", "agents.list.history"],
      ["unknown", "agents.presence.unknown"],
    ];
  const rows = input.rows
    .filter((row) => validId(row["id"]) && validId(row["projectId"]))
    .map((row) => {
      const id = row["id"] as string;
      const projectId = row["projectId"] as string;
      const presence = nonemptyText(row["presence"]);
      const sessionId = nonemptyText(row["sessionId"]);
      const clientId = nonemptyText(row["clientId"]);
      const label = nonemptyText(row["alias"]) ?? sessionId;
      const observedAt =
        typeof row["timestamp"] === "number"
          ? locale.formatDate(row["timestamp"])
          : null;
      return `<button class="agent-list-row" type="button" data-action="session-open" data-id="${html(id)}" data-project="${html(projectId)}" aria-label="${message(locale, "agents.session.open.aria", { sessionId: label ?? id })}"><span class="agent-identity"><span class="agent-monogram" aria-hidden="true">⌁</span><span class="agent-identity-text"><strong>${html(label ?? locale.t("agents.identity.unknown"))}</strong><span class="agent-role">${html(clientId ?? locale.t("agents.identity.notReported"))}</span><span class="agent-tool">${html(id)}</span></span></span><span class="agent-work">${html(presence ?? locale.t("agents.presence.unknown"))}${observedAt ? ` · ${html(observedAt)}` : ""}</span><span class="icon" aria-hidden="true">›</span></button>`;
    })
    .join("");
  return `<section class="panel table-panel"><div class="panel-head"><div><h2>${message(locale, "agents.list.technical")}</h2></div><span class="inline-source">${html(input.sourceState)}</span></div><div class="segmented agent-filter" role="group" aria-label="${message(locale, "agents.list.technical")}">${filters
    .map(
      ([filter, key]) =>
        `<button class="segment${input.filter === filter ? " active" : ""}" type="button" data-action="session-filter" data-filter="${filter}" aria-pressed="${input.filter === filter}">${message(locale, key)}</button>`,
    )
    .join(
      "",
    )}</div><div class="agent-list">${rows || `<p class="project-list-description" role="status">${message(locale, "agents.sessions.empty")}</p>`}</div></section>`;
}

export interface TechnicalSessionDetailRenderInput {
  readonly session: ConsoleQueryRecord;
  readonly tasks: readonly ConsoleQueryRecord[] | null;
  readonly events: readonly ConsoleQueryRecord[] | null;
  readonly offset?: number;
  readonly total?: number | null;
  readonly localeText: AgentsProjectsLocaleText;
}

export function renderTechnicalSessionDetail(
  input: TechnicalSessionDetailRenderInput,
): string {
  const { session, localeText: locale } = input;
  const projectId = validId(session["projectId"]) ? session["projectId"] : null;
  const sessionId =
    nonemptyText(session["sessionId"]) ?? nonemptyText(session["id"]);
  const taskRows =
    input.tasks === null
      ? `<p role="status">${message(locale, "agents.detail.tasksUnavailable")}</p>`
      : input.tasks.length
        ? input.tasks
            .filter(
              (task) =>
                validId(task["id"]) &&
                task["projectId"] === projectId &&
                task["sessionId"] === sessionId,
            )
            .map(
              (task) =>
                `<button class="agent-task-entry" type="button" data-action="task-open" data-id="${html(task["id"])}" data-project="${html(projectId)}"><span class="task-icon" aria-hidden="true">◇</span><span class="agent-task-copy"><strong>${html(task["label"] ?? task["id"])}</strong><small>${html(task["state"] ?? locale.t("common.notReported"))}</small></span><span class="badge">${html(task["phase"] ?? locale.t("common.notReported"))}</span></button>`,
            )
            .join("")
        : `<p role="status">${message(locale, "agents.detail.noTasks")}</p>`;
  const eventRows =
    input.events === null
      ? `<p role="status">${message(locale, "agents.session.eventsUnavailable")}</p>`
      : input.events.length
        ? input.events
            .filter(
              (event) =>
                validId(event["id"]) &&
                event["projectId"] === projectId &&
                event["sessionId"] === sessionId,
            )
            .map((event) => {
              const taskId = validId(event["taskId"]) ? event["taskId"] : null;
              return `<button class="agent-file-entry" type="button" data-action="${taskId ? "task-open" : "log-open"}" data-id="${html(taskId ?? event["id"])}" data-project="${html(projectId)}"><span class="task-icon" aria-hidden="true">·</span><span class="agent-task-copy"><strong>${html(event["message"] ?? event["event"] ?? locale.t("common.notReported"))}</strong><small>${html(event["level"] ?? locale.t("common.notReported"))}${event["timestamp"] === null || event["timestamp"] === undefined ? "" : ` · ${html(typeof event["timestamp"] === "number" ? locale.formatDate(event["timestamp"]) : event["timestamp"])}`}</small></span><span class="icon" aria-hidden="true">›</span></button>`;
            })
            .join("")
        : `<p role="status">${message(locale, "agents.session.noEvents")}</p>`;
  return `<section class="agent-modal" data-session-id="${html(sessionId)}"><header class="agent-modal-identity"><span class="agent-monogram large" aria-hidden="true">⌁</span><div><h2>${message(locale, "agents.session.title", { sessionId: sessionId ?? locale.t("agents.identity.unknown") })}</h2><p>${html(session["clientId"] ?? locale.t("agents.identity.notReported"))}</p><span class="badge">${html(session["presence"] ?? locale.t("agents.presence.unknown"))}</span></div></header><section class="agent-section"><header class="agent-section-header"><h3>${message(locale, "agents.detail.tasks")}</h3></header>${taskRows}</section><section class="agent-section"><header class="agent-section-header"><h3>${message(locale, "agents.session.events")}</h3></header>${eventRows}</section><footer class="agent-modal-pagination"><span>${input.total === null || input.total === undefined ? locale.t("common.notReported") : locale.formatNumber(input.total)}</span><button class="btn small" type="button" data-action="session-page" data-offset="${Math.max(0, input.offset ?? 0) - 8}" ${!input.offset ? "disabled" : ""}>${message(locale, "common.previous")}</button><button class="btn small" type="button" data-action="session-page" data-offset="${(input.offset ?? 0) + 8}" ${input.total !== null && input.total !== undefined && (input.offset ?? 0) + 8 >= input.total ? "disabled" : ""}>${message(locale, "common.next")}</button></footer></section>`;
}

export interface AgentDetailRenderInput {
  readonly agent: ConsoleQueryRecord;
  readonly tasks: readonly ConsoleQueryRecord[] | null;
  readonly files: readonly ConsoleQueryRecord[] | null;
  readonly projectName: string;
  readonly projectArchived: boolean;
  readonly snapshotToken: string;
  readonly revision: ConsoleRevision | null;
  readonly taskOffset?: number;
  readonly taskTotal?: number | null;
  readonly localeText: AgentsProjectsLocaleText;
}

/** Read-only agent modal content; file links carry exact project/task/artifact IDs. */
export function renderAgentDetail(input: AgentDetailRenderInput): string {
  const { agent, localeText: locale } = input;
  const projectId = validId(agent["projectId"]) ? agent["projectId"] : null;
  const identity = agentAliasIdentity(agent);
  const name = agentDisplayName(agent, locale);
  const alias = nonemptyText(agent["alias"]) ?? "";
  const attributes = [
    ["sessionId", "agents.detail.session"],
    ["model", "agents.detail.model"],
    ["role", "agents.detail.role"],
    ["pid", "agents.detail.pid"],
  ] as const;
  const reported = attributes
    .flatMap(([field, key]) => {
      const value = nonemptyText(agent[field]);
      return value
        ? [
            `<div><dt>${message(locale, key, { [field]: value })}</dt><dd>${html(value)}</dd></div>`,
          ]
        : [];
    })
    .join("");
  const lastSeen =
    typeof agent["timestamp"] === "number"
      ? locale.formatDate(agent["timestamp"])
      : null;
  const freshness = nonemptyText(agent["presenceSource"]);
  const tasks =
    input.tasks === null
      ? `<p role="status">${message(locale, "agents.detail.tasksUnavailable")}</p>`
      : input.tasks.length
        ? input.tasks
            .filter(
              (task) => validId(task["id"]) && task["projectId"] === projectId,
            )
            .map(
              (task) =>
                `<button class="agent-task-entry" type="button" data-action="task-open" data-id="${html(task["id"])}" data-project="${html(projectId)}"><span class="task-icon" aria-hidden="true">◇</span><span class="agent-task-copy"><strong>${html(task["label"] ?? task["id"])}</strong><small>${html(task["state"] ?? locale.t("common.notReported"))}</small></span><span class="badge">${html(task["phase"] ?? locale.t("common.notReported"))}</span></button>`,
            )
            .join("")
        : `<p role="status">${message(locale, "agents.detail.noTasks")}</p>`;
  const files =
    input.files === null
      ? `<p role="status">${message(locale, "agents.detail.filesUnavailable")}</p>`
      : input.files.length
        ? input.files
            .filter(
              (file) =>
                file["projectId"] === projectId &&
                validId(file["taskId"]) &&
                validId(file["artifactId"]),
            )
            .map((file) => {
              const label = safeFileLabel(file);
              const taskId = file["taskId"] as string;
              return `<button class="agent-file-entry" type="button" data-action="agent-file-task" data-project="${html(projectId)}" data-task-id="${html(taskId)}" data-artifact-id="${html(file["artifactId"])}" data-snapshot="${html(input.snapshotToken)}" aria-label="${message(locale, "agents.file.openTask.aria", { taskId, fileName: label })}"><span class="task-icon" aria-hidden="true">▧</span><span class="agent-task-copy"><strong>${html(label)}</strong><small>${html(taskId)} · ${html(file["kind"] ?? locale.t("agents.file.kind.unknown"))}</small></span><span class="icon" aria-hidden="true">›</span></button>`;
            })
            .join("")
        : `<p role="status">${message(locale, "agents.detail.noFiles")}</p>`;
  const aliasEditor = !identity
    ? `<p role="status">${message(locale, "agents.alias.identityUnavailable")}</p>`
    : input.projectArchived
      ? `<p role="status">${message(locale, "agents.alias.archivedReadOnly")}</p>`
      : `<form class="alias-controls" data-action="agent-alias-form" data-project="${html(projectId)}" data-identity-kind="${identity.kind}" data-identity-id="${html(identity.id)}" data-revision-epoch="${html(input.revision?.epoch ?? "")}" data-revision="${input.revision?.revision ?? ""}"><label>${message(locale, "agents.alias.label")}<input type="text" name="alias" maxlength="128" value="${html(alias)}" aria-label="${message(locale, "agents.alias.input.aria", { agentName: name })}" required></label><button class="btn small" type="submit" data-action="agent-alias-save" ${input.revision ? "" : "disabled"}>${message(locale, "agents.alias.save")}</button>${alias ? `<button class="text-link" type="button" data-action="agent-alias-reset" ${input.revision ? "" : "disabled"}>${message(locale, "agents.alias.reset")}</button>` : ""}</form>`;
  const sessionId = nonemptyText(agent["sessionId"]);
  const logsButton =
    sessionId && projectId
      ? `<button class="text-link" type="button" data-action="agent-logs-open" data-project="${html(projectId)}" data-session-id="${html(sessionId)}" aria-label="${message(locale, "agents.detail.openLogs.aria", { agentName: name })}">${message(locale, "agents.session.events")}</button>`
      : "";
  return `<section class="agent-modal"><header class="agent-modal-identity"><span class="agent-monogram large" aria-hidden="true">${html(Array.from(name).slice(0, 2).join("").toLocaleUpperCase())}</span><div><h2>${html(name)}</h2><p>${html(agent["id"] ?? locale.t("agents.identity.notReported"))}</p><span class="badge">${html(agent["presence"] ?? locale.t("agents.presence.unknown"))}</span></div></header><dl class="agent-activity-stats">${reported}${lastSeen ? `<div><dt>${message(locale, "agents.detail.heartbeat", { lastSeen })}</dt><dd>${html(lastSeen)}</dd></div>` : ""}${freshness ? `<div><dt>${message(locale, "agents.detail.freshness", { source: freshness, observedAt: lastSeen ?? locale.t("common.notReported") })}</dt></div>` : ""}</dl>${aliasEditor}${logsButton}<section class="agent-section"><header class="agent-section-header"><h3>${message(locale, "agents.detail.tasks")}</h3></header>${tasks}</section><section class="agent-section"><header class="agent-section-header"><h3>${message(locale, "agents.detail.files")}</h3></header>${files}</section><footer class="agent-modal-pagination"><span>${input.taskTotal === null || input.taskTotal === undefined ? locale.t("common.notReported") : locale.formatNumber(input.taskTotal)}</span><button class="btn small" type="button" data-action="agent-task-page" data-offset="${Math.max(0, input.taskOffset ?? 0) - 8}" ${!input.taskOffset ? "disabled" : ""}>${message(locale, "common.previous")}</button><button class="btn small" type="button" data-action="agent-task-page" data-offset="${(input.taskOffset ?? 0) + 8}" ${input.taskTotal !== null && input.taskTotal !== undefined && (input.taskOffset ?? 0) + 8 >= input.taskTotal ? "disabled" : ""}>${message(locale, "common.next")}</button></footer></section>`;
}

export function renderAgentReturnButton(
  agent: ConsoleQueryRecord,
  locale: AgentsProjectsLocaleText,
): string {
  const name = agentDisplayName(agent, locale);
  return `<button class="btn" type="button" data-action="back-agent" aria-label="${message(locale, "agents.task.returnToAgent.aria", { agentName: name })}">← ${html(name)}</button>`;
}

export interface ProjectListRenderInput {
  readonly rows: readonly ConsoleProjectRecord[] | null;
  readonly filter: ProjectListFilter;
  readonly search: string;
  readonly favorites: ReadonlySet<string>;
  readonly revisions: ReadonlyMap<string, ConsoleRevision>;
  readonly localeText: AgentsProjectsLocaleText;
  readonly unavailableReason?: string;
}

export interface ProjectGroups {
  readonly favorites: readonly ConsoleProjectRecord[];
  readonly monitored: readonly ConsoleProjectRecord[];
  readonly archived: readonly ConsoleProjectRecord[];
  readonly unknown: readonly ConsoleProjectRecord[];
}

export function groupProjects(
  rows: readonly ConsoleProjectRecord[],
  favorites: ReadonlySet<string>,
): ProjectGroups {
  const groups: {
    favorites: ConsoleProjectRecord[];
    monitored: ConsoleProjectRecord[];
    archived: ConsoleProjectRecord[];
    unknown: ConsoleProjectRecord[];
  } = { favorites: [], monitored: [], archived: [], unknown: [] };
  for (const row of rows) {
    const lifecycle = projectLifecycle(row);
    if (validId(row.id) && favorites.has(row.id)) groups.favorites.push(row);
    groups[lifecycle].push(row);
  }
  return groups;
}

export function renderProjectList(input: ProjectListRenderInput): string {
  const { localeText: locale } = input;
  const rows = input.rows?.filter((row) => {
    const state = projectLifecycle(row);
    return (
      projectMatchesSearch(row, input.search) &&
      (input.filter === "all" || input.filter === state)
    );
  });
  const filters: readonly [ProjectListFilter, AgentsProjectsMessageKey][] = [
    ["all", "projects.title"],
    ["monitored", "projects.list.monitored"],
    ["archived", "projects.list.archived"],
  ];
  const cards = rows
    ?.filter((row) => validId(row.id))
    .map((row) => {
      const projectId = row.id;
      const projectName =
        typeof row.name === "string" && row.name.trim()
          ? row.name
          : locale.t("projects.name.unknown");
      const lifecycle = projectLifecycle(row);
      const archived = lifecycle === "archived";
      const favorite = input.favorites.has(projectId);
      const revision = input.revisions.get(projectId) ?? null;
      const editor = archived
        ? `<p class="project-lifecycle-note">${message(locale, "projects.archive.banner")}</p>`
        : `<form class="alias-controls" data-action="project-alias-form" data-project="${html(projectId)}" data-revision-epoch="${html(revision?.epoch ?? "")}" data-revision="${revision?.revision ?? ""}"><label>${message(locale, "projects.alias.label")}<input type="text" name="alias" maxlength="128" value="${html(projectName)}" aria-label="${message(locale, "projects.alias.input.aria", { projectName })}" required></label><button class="btn small" type="submit" data-action="project-alias-save" ${revision ? "" : "disabled"}>${message(locale, "projects.alias.save")}</button><button class="text-link" type="button" data-action="project-alias-reset" ${revision ? "" : "disabled"}>${message(locale, "projects.alias.reset")}</button></form>`;
      const lifecycleControl = !revision
        ? ""
        : archived
          ? `<button class="btn small" type="button" data-action="project-restore-open" data-project="${html(projectId)}" data-revision-epoch="${html(revision.epoch)}" data-revision="${revision.revision}" aria-label="${message(locale, "projects.restore.open.aria", { projectName })}">${message(locale, "projects.restore.confirm.action")}</button>`
          : lifecycle === "monitored"
            ? `<button class="btn small" type="button" data-action="project-archive-open" data-project="${html(projectId)}" data-revision-epoch="${html(revision.epoch)}" data-revision="${revision.revision}" aria-label="${message(locale, "projects.archive.open.aria", { projectName })}">${message(locale, "projects.archive.confirm.action")}</button>`
            : `<span class="badge">${message(locale, "projects.list.unknown")}</span>`;
      return `<article class="project-card"><header class="project-card-tools"><button class="icon-button" type="button" data-action="project-favorite" data-project="${html(projectId)}" aria-pressed="${favorite}" aria-label="${message(locale, favorite ? "projects.favorite.remove.aria" : "projects.favorite.add.aria", { projectName })}" title="${message(locale, favorite ? "projects.favorite.remove" : "projects.favorite.add")}">${favorite ? "★" : "☆"}</button><span class="badge">${message(locale, archived ? "projects.list.archived" : lifecycle === "monitored" ? "projects.list.monitored" : "projects.list.unknown")}</span></header><button class="project-name" type="button" data-action="project-open" data-project="${html(projectId)}">${html(projectName)}</button>${editor}<footer class="project-card-bottom">${lifecycleControl}</footer></article>`;
    })
    .join("");
  const body =
    input.rows === null
      ? `<p class="project-list-description" role="status">${html(input.unavailableReason ?? locale.t("projects.archive.blocked.missing"))}</p>`
      : cards ||
        `<p class="project-list-description" role="status">${message(locale, "projects.list.empty")}</p>`;
  return `<section class="project-list"><header class="subheading"><div><h2>${message(locale, "projects.title")}</h2></div></header><div class="project-toolbar"><div class="segmented project-filter" role="group" aria-label="${message(locale, "projects.title")}">${filters
    .map(
      ([filter, key]) =>
        `<button class="segment${input.filter === filter ? " active" : ""}" type="button" data-action="project-filter" data-filter="${filter}" aria-pressed="${input.filter === filter}">${message(locale, key)}</button>`,
    )
    .join(
      "",
    )}</div><label class="search-box"><span class="sr-only">${message(locale, "projects.search.label")}</span><input type="search" value="${html(input.search)}" data-action="project-search" aria-label="${message(locale, "projects.search.label")}"></label></div><div class="project-cards">${body}</div></section>`;
}

export function renderProjectActionDialog(
  project: ConsoleProjectRecord,
  action: "archive" | "restore",
  revision: ConsoleRevision,
  locale: AgentsProjectsLocaleText,
  status?: ProjectActionResponse | null,
): string {
  const projectId = validId(project.id) ? project.id : "";
  const projectName =
    typeof project.name === "string" && project.name.trim()
      ? project.name
      : locale.t("projects.name.unknown");
  const archiving = action === "archive";
  const title = archiving
    ? "projects.archive.confirm.title"
    : "projects.restore.confirm.title";
  const body = archiving
    ? "projects.archive.confirm.body"
    : "projects.restore.confirm.body";
  const confirm = archiving
    ? "projects.archive.confirm.action"
    : "projects.restore.confirm.action";
  const responseText = status ? renderProjectActionStatus(status, locale) : "";
  return `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="project-action-title" data-project-action-dialog="${action}"><div class="modal-header"><h2 id="project-action-title">${message(locale, title)}</h2><button type="button" data-action="project-action-cancel" aria-label="${message(locale, "common.close")}">×</button></div><p>${message(locale, body, { projectName })}</p>${archiving ? `<p class="project-lifecycle-note">${message(locale, "projects.archive.confirm.liveCheck")}</p>` : ""}${status ? `<div role="status">${responseText}</div>` : ""}<footer><button class="btn" type="button" data-action="project-action-cancel">${message(locale, "common.cancel")}</button><button class="btn primary" type="button" data-action="project-action-confirm" data-project-action="${action}" data-project="${html(projectId)}" data-revision-epoch="${html(revision.epoch)}" data-revision="${revision.revision}" aria-label="${message(locale, archiving ? "projects.archive.confirm.aria" : "projects.restore.confirm.aria", { projectName })}">${message(locale, confirm)}</button></footer></section>`;
}

export function renderProjectActionStatus(
  result: ProjectActionResponse,
  locale: AgentsProjectsLocaleText,
  projectName = result.projectId,
): string {
  if (result.state === "ok") {
    const key: AgentsProjectsMessageKey =
      result.code === "PROJECT_ARCHIVED"
        ? "projects.archive.success"
        : result.code === "PROJECT_RESTORED"
          ? "projects.restore.success"
          : result.code === "PROJECT_ALIAS_UPDATED"
            ? result.alias === null
              ? "projects.alias.reset.done"
              : "projects.alias.saved"
            : result.code === "AGENT_ALIAS_UPDATED"
              ? result.alias === null
                ? "agents.alias.reset.done"
                : "agents.alias.saved"
              : "projects.action.failed";
    return message(locale, key, { projectName });
  }
  return (
    result.reasons
      .map(({ key, params }) => message(locale, key, params))
      .join(" ") || message(locale, "projects.action.failed")
  );
}

const FILE_ARTIFACTS: readonly [string, ConsoleArtifactKind][] = [
  ["originalSource", "original-source"],
  ["sentSource", "sent-source"],
  ["currentFile", "current-file"],
  ["response", "response"],
  ["stdout", "stdout"],
  ["stderr", "stderr"],
  ["rpc", "rpc"],
];

function artifactKindsForFile(
  task: ConsoleQueryRecord,
  artifactId: string,
): ConsoleArtifactKind[] {
  const artifacts = record(task.artifacts) ? task.artifacts : {};
  const matches: ConsoleArtifactKind[] = [];
  for (const [field, kind] of FILE_ARTIFACTS) {
    const reference = artifacts[field];
    if (record(reference) && reference["artifactId"] === artifactId)
      matches.push(kind);
  }
  const events = artifacts["events"];
  if (Array.isArray(events))
    for (const event of events)
      if (record(event) && event["artifactId"] === artifactId)
        matches.push("event");
  return matches;
}

export type AgentFilter = "all" | "active" | "working" | "history";
export type TechnicalSessionFilter =
  "all" | "confirmed" | "history" | "unknown";
export type ProjectListFilter = "all" | "monitored" | "archived";

export interface AgentsProjectsFeatureOptions {
  readonly query: AgentsProjectsQueryPort;
  readonly actions: AgentsProjectsActionPort;
  readonly localeText: AgentsProjectsLocaleText;
  readonly storage?: KeyValueStorage | null;
}

export interface AgentsProjectsPage<Row extends ConsoleQueryRecord> {
  readonly snapshot: ConsoleQuerySnapshot;
  readonly page: ConsoleQueryPage<Row>;
  readonly rows: readonly Row[];
  readonly completeness?: "complete" | "partial" | "unknown";
}

export interface AgentFileTaskDetail {
  readonly task: ConsoleQueryRecord;
  readonly file: ConsoleQueryRecord;
  readonly artifact: ConsoleArtifactResult | null;
  readonly artifactUnavailable: boolean;
  readonly unavailableMessage: string | null;
}

export function createAgentsProjectsFeature(
  options: AgentsProjectsFeatureOptions,
) {
  let storage = options.storage ?? null;
  if (options.storage === undefined) {
    try {
      storage = globalThis.localStorage ?? null;
    } catch {
      storage = null;
    }
  }
  let favorites = favoriteList(storage);

  async function page<Row extends ConsoleQueryRecord>(
    scope: ConsoleQueryScope,
    collection: ConsoleQueryCollection,
    input: {
      readonly offset?: number;
      readonly limit?: number;
      readonly filters?: ConsoleQueryRequest["filters"];
      readonly search?: string;
      readonly sort?: ConsoleQueryRequest["sort"];
    } = {},
  ): Promise<AgentsProjectsPage<Row>> {
    const snapshot = await options.query.snapshot(scope);
    const result = await options.query.query<Row>({
      version: 1,
      scope,
      collection,
      snapshotToken: snapshot.snapshotToken,
      offset: input.offset ?? 0,
      limit: input.limit ?? PAGE_SIZE,
      ...(input.filters ? { filters: input.filters } : {}),
      ...(input.search ? { search: input.search } : {}),
      ...(input.sort ? { sort: input.sort } : {}),
    });
    return { snapshot, page: result, rows: result.rows };
  }

  return {
    localeText: options.localeText,
    subscribeLocale(listener: () => void): () => void {
      return options.localeText.subscribe(listener);
    },

    async listProjects(
      scope: ConsoleQueryScope,
      input: {
        readonly filter?: ProjectListFilter;
        readonly search?: string;
        readonly offset?: number;
        readonly limit?: number;
      } = {},
    ): Promise<AgentsProjectsPage<ConsoleProjectRecord>> {
      const result = await page<ConsoleProjectRecord>(scope, "projects", input);
      const filter = input.filter ?? "all";
      const rows = result.rows.filter((row) => {
        const lifecycle = projectLifecycle(row);
        return (
          projectMatchesSearch(row, input.search ?? "") &&
          (filter === "all" || lifecycle === filter)
        );
      });
      return { ...result, rows };
    },

    async projectRevision(projectId: string): Promise<ConsoleRevision> {
      if (!validId(projectId)) throw new TypeError("Project ID is invalid");
      const snapshot = await options.query.snapshot({
        kind: "project",
        projectId,
      });
      return snapshot.revision;
    },

    async listAgents(
      scope: ConsoleQueryScope,
      input: {
        readonly filter?: AgentFilter;
        readonly search?: string;
        readonly offset?: number;
        readonly limit?: number;
      } = {},
    ): Promise<AgentsProjectsPage<ConsoleQueryRecord>> {
      const filter = input.filter ?? "all";
      const filters: ConsoleQueryRequest["filters"] =
        filter === "active"
          ? { presence: { any: ["active", "observed", "idle"] } }
          : filter === "history"
            ? { presence: { any: ["stale", "unknown", "offline", "history"] } }
            : undefined;
      const result = await page<ConsoleQueryRecord>(scope, "agents", {
        ...input,
        ...(filters ? { filters } : {}),
      });
      if (filter === "working") {
        const workingStates = [
          "active",
          "running",
          "queued",
          "preparing",
          "processing",
          "sending",
          "unresolved",
        ];
        const working = new Set<ConsoleQueryRecord>();
        let offset = 0;
        let completeness: AgentsProjectsPage<ConsoleQueryRecord>["completeness"] =
          "unknown";
        for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
          const taskPage = await options.query.query<ConsoleQueryRecord>({
            version: 1,
            scope,
            collection: "tasks",
            snapshotToken: result.snapshot.snapshotToken,
            offset,
            limit: PAGE_SIZE,
            filters: { state: { any: workingStates } },
          });
          for (const agent of result.rows)
            if (taskPage.rows.some((task) => taskMatchesAgent(task, agent)))
              working.add(agent);
          if (
            taskPage.source.state === "unavailable" ||
            taskPage.source.state === "no-data"
          ) {
            completeness =
              taskPage.source.state === "no-data" ? "complete" : "unknown";
            break;
          }
          if (taskPage.total === null) {
            completeness = "partial";
            break;
          }
          offset += taskPage.rows.length;
          if (offset >= taskPage.total) {
            completeness =
              taskPage.source.state === "available" ? "complete" : "partial";
            break;
          }
          if (taskPage.rows.length === 0) {
            completeness = "partial";
            break;
          }
          if (pageIndex === 49) completeness = "partial";
        }
        const rows = result.rows.filter(
          (row) =>
            working.has(row) ||
            row["working"] === true ||
            row["presence"] === "working" ||
            (typeof row["work"] === "string" && row["work"].trim().length > 0),
        );
        return { ...result, rows, completeness };
      }
      const rows = result.rows.filter((row) => {
        if (filter === "active")
          return ["active", "observed", "idle"].includes(
            String(row["presence"]),
          );
        if (filter === "history")
          return ["stale", "unknown", "offline", "history"].includes(
            String(row["presence"]),
          );
        return true;
      });
      return { ...result, rows };
    },

    async listTechnicalSessions(
      scope: ConsoleQueryScope,
      input: {
        readonly filter?: TechnicalSessionFilter;
        readonly search?: string;
        readonly offset?: number;
        readonly limit?: number;
      } = {},
    ): Promise<AgentsProjectsPage<ConsoleQueryRecord>> {
      const result = await page<ConsoleQueryRecord>(scope, "sessions", input);
      const filter = input.filter ?? "all";
      const rows = result.rows.filter((row) => {
        const presence = String(row["presence"] ?? "unknown").toLowerCase();
        if (filter === "confirmed")
          return ["active", "idle", "observed"].includes(presence);
        if (filter === "history")
          return ["history", "offline", "disconnected"].includes(presence);
        if (filter === "unknown")
          return ["unknown", "stale", "missing"].includes(presence);
        return true;
      });
      return { ...result, rows };
    },

    listSessionTasks(
      projectId: string,
      session: ConsoleQueryRecord,
      input: { readonly offset?: number; readonly limit?: number } = {},
    ): Promise<AgentsProjectsPage<ConsoleQueryRecord>> {
      const sessionId = validId(session["sessionId"])
        ? session["sessionId"]
        : session["id"];
      if (
        !validId(projectId) ||
        session["projectId"] !== projectId ||
        !validId(sessionId)
      )
        throw new TypeError("Session is not scoped to the selected project");
      return page<ConsoleQueryRecord>({ kind: "project", projectId }, "tasks", {
        ...input,
        filters: { sessionId: { eq: sessionId } },
      }).then((result) => ({
        ...result,
        rows: result.rows.filter(
          (task) =>
            task["projectId"] === projectId && task["sessionId"] === sessionId,
        ),
      }));
    },

    listSessionEvents(
      projectId: string,
      session: ConsoleQueryRecord,
      input: { readonly offset?: number; readonly limit?: number } = {},
    ): Promise<AgentsProjectsPage<ConsoleQueryRecord>> {
      const sessionId = validId(session["sessionId"])
        ? session["sessionId"]
        : session["id"];
      if (
        !validId(projectId) ||
        session["projectId"] !== projectId ||
        !validId(sessionId)
      )
        throw new TypeError("Session is not scoped to the selected project");
      return page<ConsoleQueryRecord>({ kind: "project", projectId }, "logs", {
        ...input,
        filters: { sessionId: { eq: sessionId } },
      }).then((result) => ({
        ...result,
        rows: result.rows.filter(
          (event) =>
            event["projectId"] === projectId &&
            event["sessionId"] === sessionId,
        ),
      }));
    },

    listAgentTasks(
      projectId: string,
      agent: ConsoleQueryRecord,
      input: { readonly offset?: number; readonly limit?: number } = {},
    ): Promise<AgentsProjectsPage<ConsoleQueryRecord>> {
      if (!validId(projectId) || agent.projectId !== projectId)
        throw new TypeError("Agent is not scoped to the selected project");
      if (!hasAnyIdentity(agent))
        throw new TypeError("Agent has no source-reported task identity");
      const filters = taskFilterForAgent(agent);
      if (!filters) throw new TypeError("Agent task identity is unknown");
      return page<ConsoleQueryRecord>({ kind: "project", projectId }, "tasks", {
        ...input,
        filters,
      }).then((result) => ({
        ...result,
        rows: result.rows.filter((task) => taskMatchesAgent(task, agent)),
      }));
    },

    async listAgentFiles(
      projectId: string,
      agent: ConsoleQueryRecord,
      input: { readonly offset?: number; readonly limit?: number } = {},
    ): Promise<AgentsProjectsPage<ConsoleQueryRecord>> {
      const tasks = await this.listAgentTasks(projectId, agent, input);
      const taskIds = tasks.rows
        .map((task) => task.id)
        .filter((id): id is string => validId(id));
      if (!taskIds.length) return { ...tasks, rows: [] };
      const files = await options.query.query<ConsoleQueryRecord>({
        version: 1,
        scope: { kind: "project", projectId },
        collection: "files",
        snapshotToken: tasks.snapshot.snapshotToken,
        filters: { taskId: { any: taskIds } },
        offset: input.offset ?? 0,
        limit: input.limit ?? PAGE_SIZE,
      });
      const unique = new Map<string, ConsoleQueryRecord>();
      for (const file of files.rows) {
        if (
          file.projectId !== projectId ||
          !validId(file.taskId) ||
          !tasks.rows.some((task) => task.id === file.taskId)
        )
          continue;
        const key = JSON.stringify([projectId, file.taskId, file.id]);
        if (!unique.has(key)) unique.set(key, file);
      }
      return { ...tasks, rows: [...unique.values()] };
    },

    async taskDetailsForFile(
      projectId: string,
      file: ConsoleQueryRecord,
      snapshotToken: string,
    ): Promise<AgentFileTaskDetail> {
      if (
        !validId(projectId) ||
        file.projectId !== projectId ||
        !validId(file.taskId) ||
        !validId(file["artifactId"]) ||
        !validId(snapshotToken)
      )
        throw new TypeError(
          "File reference does not have an exact project/task identity",
        );
      const scope = { kind: "project" as const, projectId };
      const taskPage = await options.query.query<ConsoleQueryRecord>({
        version: 1,
        scope,
        collection: "tasks",
        snapshotToken,
        filters: { id: { eq: file.taskId } },
        limit: 2,
      });
      const matches = taskPage.rows.filter(
        (task) => task.id === file.taskId && task.projectId === projectId,
      );
      if (matches.length !== 1)
        throw new Error(
          "Retained file does not resolve to one exact project task",
        );
      const task = matches[0]!;
      const artifactId = file["artifactId"] as string;
      const kinds = artifactKindsForFile(task, artifactId);
      if (kinds.length !== 1)
        return {
          task,
          file,
          artifact: null,
          artifactUnavailable: true,
          unavailableMessage: options.localeText.t(
            "agents.file.detailUnavailable",
          ),
        };
      const request: ConsoleArtifactRequest = {
        version: 1,
        scope,
        taskId: task.id!,
        artifactId,
        kind: kinds[0]!,
        snapshotToken,
        offset: 0,
        length: 256 * 1024,
      };
      const artifact = await options.query.detail(request);
      return {
        task,
        file,
        artifact,
        artifactUnavailable: !["available", "empty", "truncated"].includes(
          artifact.state,
        ),
        unavailableMessage: !["available", "empty", "truncated"].includes(
          artifact.state,
        )
          ? options.localeText.t("agents.file.detailUnavailable")
          : null,
      };
    },

    favoriteProject(projectId: string, favorite?: boolean): boolean {
      if (!validId(projectId)) throw new TypeError("Project ID is invalid");
      favorites = favoriteList(storage);
      const next = new Set(favorites);
      const selected = favorite ?? !next.has(projectId);
      if (selected) next.add(projectId);
      else next.delete(projectId);
      persistFavorites(storage, next);
      favorites = next;
      return selected;
    },

    isFavorite(projectId: string): boolean {
      if (!validId(projectId)) return false;
      favorites = favoriteList(storage);
      return favorites.has(projectId);
    },

    projectName(row: ConsoleProjectRecord): string {
      return typeof row.name === "string" && row.name.trim()
        ? row.name
        : options.localeText.t("projects.name.unknown");
    },

    setProjectAlias(
      projectId: string,
      alias: string,
      expectedRevision: ConsoleRevision,
    ): Promise<ProjectActionResponse> {
      return options.actions.execute({
        version: 1,
        action: "set-alias",
        projectId,
        alias,
        expectedRevision,
      });
    },

    resetProjectAlias(
      projectId: string,
      expectedRevision: ConsoleRevision,
    ): Promise<ProjectActionResponse> {
      return options.actions.execute({
        version: 1,
        action: "reset-alias",
        projectId,
        expectedRevision,
      });
    },

    setAgentAlias(
      projectId: string,
      identity: AgentAliasIdentity,
      alias: string,
      expectedRevision: ConsoleRevision,
    ): Promise<ProjectActionResponse> {
      return options.actions.execute({
        version: 1,
        action: "set-agent-alias",
        projectId,
        identity,
        alias,
        expectedRevision,
      });
    },

    resetAgentAlias(
      projectId: string,
      identity: AgentAliasIdentity,
      expectedRevision: ConsoleRevision,
    ): Promise<ProjectActionResponse> {
      return options.actions.execute({
        version: 1,
        action: "reset-agent-alias",
        projectId,
        identity,
        expectedRevision,
      });
    },

    archiveProject(
      projectId: string,
      expectedRevision: ConsoleRevision,
    ): Promise<ProjectActionResponse> {
      return options.actions.execute({
        version: 1,
        action: "archive",
        projectId,
        expectedRevision,
      });
    },

    restoreProject(
      projectId: string,
      expectedRevision: ConsoleRevision,
    ): Promise<ProjectActionResponse> {
      return options.actions.execute({
        version: 1,
        action: "restore",
        projectId,
        expectedRevision,
      });
    },
  };
}

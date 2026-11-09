import {
  clientKind,
  documentLabel,
  nonemptyId,
  openOperation,
  recordedTime,
  sourceName,
} from "./console-read-model";
import type { ConsoleRow, ConsoleSnapshot } from "./console-read-model";

export interface ConsoleFilters {
  scope?: string;
  ids?: string[];
  clientKind?: string;
  state?: string;
  presence?: string;
  work?: string;
  level?: string;
  component?: string;
  agent?: string;
  task?: string;
  request?: string;
  document?: string;
  since?: string;
  until?: string;
}
export interface ConsoleSelection {
  filters: ConsoleFilters;
  search: string;
  sort: string;
  order: (string | undefined)[];
  navigating?: boolean;
}
export function consoleSource(
  name: string,
  snapshot: ConsoleSnapshot,
  filters: ConsoleFilters = {},
): ConsoleRow[] | null | undefined {
  if (name === "agents")
    return snapshot.agents?.map((agent) => {
      const operations = (snapshot.operations || []).filter(
        (row) =>
          (nonemptyId(row.clientId) && row.clientId === agent.id) ||
          (nonemptyId(row.sessionId) && row.sessionId === agent.sessionId),
      );
      return {
        ...agent,
        clientKind: clientKind(agent.id),
        operations,
        work:
          operations
            .filter(openOperation)
            .map((row) => row.state)
            .join(", ") || "unknown",
      };
    });
  if (name === "logs") {
    if (
      (filters.task || filters.request || filters.ids) &&
      snapshot.taskEvents?.logs?.length
    )
      return [
        ...new Map(
          [...(snapshot.logs || []), ...snapshot.taskEvents.logs].map((row) => [
            row.id,
            row,
          ]),
        ).values(),
      ].sort(
        (a, b) =>
          (recordedTime(a.timestamp) || 0) - (recordedTime(b.timestamp) || 0),
      );
    return snapshot.logs;
  }
  if (name === "system") return snapshot.logs;
  return name === "overview" || name === "tasks" ? snapshot.operations : [];
}
/** Pure selection; navigation and terminal-specific search labels stay at the edge. */
export function selectConsoleRows(
  name: string,
  source: ConsoleRow[] | null | undefined,
  state: ConsoleSelection,
  logLabel: (row: ConsoleRow) => string = () => "",
): ConsoleRow[] | null {
  if (!source) return null;
  const query = state.search.toLocaleLowerCase(),
    f = state.filters;
  const rows = source.filter((row) => {
    if (f.ids && (!row.id || !f.ids.includes(row.id))) return false;
    if (f.clientKind && row.clientKind !== f.clientKind) return false;
    if (
      name === "agents" &&
      ((f.scope === "current" && row.presence !== "observed") ||
        (f.scope === "history" && row.presence === "observed"))
    )
      return false;
    if (
      ["tasks", "overview"].includes(name) &&
      ((f.scope === "open" && !openOperation(row)) ||
        (f.scope === "history" && openOperation(row)))
    )
      return false;
    if (
      (f.state && row.state !== f.state) ||
      (f.presence && row.presence !== f.presence) ||
      (f.work && row.work !== f.work)
    )
      return false;
    if (
      (f.level && !f.level.split(",").includes(row.level || "")) ||
      (f.component && row.component !== f.component)
    )
      return false;
    if (
      f.agent &&
      ![row.clientId, row.agentId, row.sessionId].includes(f.agent)
    )
      return false;
    if (
      (f.task || f.request) &&
      !(
        (f.task && [row.id, row.taskId].includes(f.task)) ||
        (f.request &&
          row.requestId === f.request &&
          (!f.task || !nonemptyId(row.taskId) || row.taskId === f.task))
      )
    )
      return false;
    if (
      f.document &&
      ![row.document, sourceName(row), documentLabel(row)].includes(f.document)
    )
      return false;
    const date =
      row.timestamp !== undefined && row.timestamp !== null
        ? recordedTime(row.timestamp)
        : f.scope === "history"
          ? (row.finishedAt ?? row.startedAt ?? row.submittedAt)
          : (row.submittedAt ?? row.startedAt);
    if (
      (f.since || f.until) &&
      (date === undefined || date === null || !Number.isFinite(date))
    )
      return false;
    if (
      typeof date === "number" &&
      ((f.since && date < Date.parse(f.since)) ||
        (f.until && date > Date.parse(f.until)))
    )
      return false;
    const search =
      name === "logs"
        ? String(row.message || "") + " " + logLabel(row)
        : name === "agents"
          ? [
              row.id,
              row.sessionId,
              row.name,
              ...(row.operations || [])
                .filter(openOperation)
                .flatMap((op) => [op.description, op.label, op.document]),
            ]
              .filter(Boolean)
              .join(" ")
          : JSON.stringify(row);
    return !query || search.toLocaleLowerCase().includes(query);
  });
  if (name !== "logs") {
    const byId = (a: ConsoleRow, b: ConsoleRow) =>
      String(a.id).localeCompare(String(b.id));
    rows.sort((a, b) =>
      state.sort === "name"
        ? String(a.label || a.id).localeCompare(String(b.label || b.id)) ||
          byId(a, b)
        : state.sort === "time"
          ? (b.finishedAt ?? b.lastSeen ?? b.startedAt ?? 0) -
              (a.finishedAt ?? a.lastSeen ?? a.startedAt ?? 0) || byId(a, b)
          : name === "agents"
            ? Number(b.presence === "observed") -
                Number(a.presence === "observed") || byId(a, b)
            : Number(openOperation(b)) - Number(openOperation(a)) ||
              (openOperation(a)
                ? (a.order ?? a.startedAt ?? 0) - (b.order ?? b.startedAt ?? 0)
                : (b.finishedAt ?? 0) - (a.finishedAt ?? 0)) ||
              byId(a, b),
    );
    const order = new Map(state.order.map((id, i) => [id, i]));
    if (state.navigating && state.order.length)
      rows.sort(
        (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
      );
  }
  return rows;
}

export function activeFilters(state: {
  filters?: ConsoleFilters;
  search?: string;
}) {
  return [
    ...Object.entries(state.filters ?? {})
      .filter(
        ([key, value]) =>
          value &&
          !(key === "scope" && value === "all") &&
          (!Array.isArray(value) || value.length),
      )
      .map(([key, value]) => ({ key, value: value as unknown })),
    ...(state.search ? [{ key: "search", value: state.search }] : []),
  ];
}
export function filterSummary(
  state: { filters?: ConsoleFilters; search?: string },
  ui: { language: string; L(key: string): string },
): string {
  const labels: Record<string, string> = {
    scope: ui.L("scope"),
    search: ui.L("search"),
    state: ui.L("state"),
    agent: ui.L("client"),
    document: ui.L("documentOrScript"),
    level: ui.L("level"),
    component: ui.L("source"),
    presence: ui.L("presence"),
    work: ui.L("work"),
    clientKind: ui.language === "pl" ? "Rodzaj klienta" : "Client kind",
    task: "Task ID",
    request: "Request ID",
    since: ui.language === "pl" ? "Od" : "Since",
    until: ui.language === "pl" ? "Do" : "Until",
  };
  return activeFilters(state)
    .map(({ key, value }) =>
      key === "ids" && Array.isArray(value)
        ? `${ui.L("records")}: ${value.length}`
        : `${labels[key] || key}: ${key === "scope" ? ui.L(String(value)) : value}`,
    )
    .join(" · ");
}

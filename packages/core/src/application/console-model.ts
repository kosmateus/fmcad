import {
  consoleSource,
  selectConsoleRows,
  type ConsoleSelection,
} from "./console-selectors";
import {
  correlate,
  type ConsoleRow,
  type ConsoleSnapshot,
} from "./console-read-model";

export const consoleViews = [
  "overview",
  "agents",
  "tasks",
  "logs",
  "system",
] as const;
type View = (typeof consoleViews)[number];
const views = consoleViews;
interface ViewState extends ConsoleSelection {
  selectedId: string | null;
  offset: number;
  frozen: ConsoleRow[] | null;
  frozenSnapshot?: ConsoleSnapshot | null;
  follow: boolean;
  newCount: number;
  focus?: number;
  lastIds?: (string | undefined)[];
  lastIndex?: number;
}
function viewState(name: View): ViewState {
  return {
    search: "",
    filters: { scope: "all" },
    sort: "default",
    selectedId: null,
    offset: 0,
    order: [],
    frozen: null,
    follow: name === "logs",
    newCount: 0,
  };
}
export class ConsoleModel {
  tab = 0;
  section = 0;
  language = "en";
  readonly states: Record<View, ViewState>;
  snapshot: ConsoleSnapshot = {};
  constructor(
    private readonly logMessage: (row: ConsoleRow, language: string) => string,
    private readonly clone: <T>(value: T) => T,
  ) {
    this.states = {
      overview: viewState("overview"),
      agents: viewState("agents"),
      tasks: viewState("tasks"),
      logs: viewState("logs"),
      system: viewState("system"),
    };
    this.states.overview.focus = 4;
  }
  get name(): View {
    return views[this.tab]!;
  }
  get state() {
    return this.states[this.name];
  }
  get focus() {
    return this.state.focus ?? 0;
  }
  set focus(value: number) {
    this.state.focus = value;
  }
  viewSnapshot(name = this.name) {
    return this.states[name].frozenSnapshot || this.snapshot;
  }
  update(snapshot: ConsoleSnapshot) {
    this.snapshot = snapshot;
    for (const name of views) {
      const state = this.states[name];
      const current = this.source(name, snapshot) || [];
      const before = new Set(state.lastIds || []);
      const added = current.filter((row) => !before.has(row.id)).length;
      if (name === "logs" && snapshot["logsResynced"]) state.newCount = 0;
      else if (state.lastIds && (state.frozenSnapshot || !state.follow))
        state.newCount += added;
      state.lastIds = current.map((row) => row.id);
    }
  }
  source(name = this.name, snapshot = this.snapshot) {
    return consoleSource(name, snapshot, this.states.logs.filters);
  }
  rows(name = this.name) {
    const state = this.states[name];
    const source = this.source(name, state.frozenSnapshot || this.snapshot);
    if (!source) return null;
    const rows = selectConsoleRows(name, source, state, (row) =>
      this.logMessage(row, this.language || "en"),
    );
    if (!rows) return null;
    if (name !== "logs") {
      state.order = rows.map((row) => row.id);
      if (!state.navigating) state.selectedId = rows[0]?.id || null;
    }
    if (name === "logs" && state.follow && !state.frozen)
      state.selectedId = rows.at(-1)?.id || null;
    if (!rows.some((row) => row.id === state.selectedId))
      state.selectedId =
        rows[Math.min(state.lastIndex || 0, rows.length - 1)]?.id || null;
    state.lastIndex = Math.max(
      0,
      rows.findIndex((row) => row.id === state.selectedId),
    );
    return rows;
  }
  refreshOrder() {
    this.state.order = [];
    this.state.newCount = 0;
    this.state.navigating = false;
  }
  resetFilters() {
    this.state.filters = { scope: "all" };
    this.state.search = "";
    this.refreshOrder();
  }
  navigate(delta: number | "home" | "end", page = 10) {
    const rows = this.rows() || [];
    const state = this.state;
    state.navigating = true;
    let index = Math.max(
      0,
      rows.findIndex((row) => row.id === state.selectedId),
    );
    if (this.name === "logs") state.follow = false;
    index =
      delta === "home"
        ? 0
        : delta === "end"
          ? rows.length - 1
          : index + delta * page;
    index = Math.max(0, Math.min(rows.length - 1, index));
    state.selectedId = rows[index]?.id || null;
    if (delta === "end" && this.name === "logs") {
      state.follow = true;
      state.newCount = 0;
    }
  }
  freeze() {
    const state = this.state,
      source = this.source();
    if (!source && !["overview", "system"].includes(this.name)) return;
    state.navigating = true;
    if (state.frozenSnapshot) {
      state.frozen = null;
      state.frozenSnapshot = null;
    } else {
      state.frozen =
        source === null || source === undefined ? null : this.clone(source);
      state.frozenSnapshot = this.clone(this.snapshot);
    }
    state.newCount = 0;
  }
  selected() {
    return (this.rows() || []).find((row) => row.id === this.state.selectedId);
  }
  related(
    kind: "tasks" | "logs" | "agents",
    row: ConsoleRow,
    snapshot?: ConsoleSnapshot,
  ) {
    if (snapshot || kind === "agents") {
      const related = correlate(row, snapshot || this.viewSnapshot());
      const matches =
        related[
          kind === "tasks"
            ? "operations"
            : kind === "logs"
              ? "events"
              : "agents"
        ];
      if (!matches?.length) return false;
      this.tab = views.indexOf(kind);
      const state = this.state;
      state.frozen = null;
      state.frozenSnapshot = null;
      state.filters = {
        scope: "all",
        ids: matches.flatMap((item) => (item.id ? [item.id] : [])),
      };
      state.search = "";
      state.order = [];
      state.navigating = true;
      state.selectedId = matches[0]?.id ?? null;
      state.follow = false;
      return true;
    }
    const agentRow = Array.isArray(row.operations);
    const correlation =
      kind === "logs" && !agentRow && row.state && (row.id || row.requestId)
        ? {
            ...(row.id ? { task: row.id } : {}),
            ...(row.requestId ? { request: row.requestId } : {}),
          }
        : kind === "tasks" && row.level
          ? row.taskId
            ? { task: row.taskId }
            : row.requestId
              ? { request: row.requestId }
              : row.agentId
                ? { agent: row.agentId }
                : null
          : null;
    const agent =
      row.clientId || row.sessionId || (row.operations ? row.id : null);
    if (!correlation && !agent) return false;
    this.tab = kind === "tasks" ? 2 : 3;
    const state = this.state;
    state.filters = {
      scope: "all",
      ...(correlation || (agent ? { agent } : {})),
    };
    state.order = [];
    state.search = "";
    state.navigating = false;
    return true;
  }
}

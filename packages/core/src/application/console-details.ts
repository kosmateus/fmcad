import {
  kindOf,
  correlate,
  presenceText,
  clientKind,
  documentFields,
  consoleRecordedDuration,
  openOperation,
  type ConsoleRow,
  type ConsoleSnapshot,
} from "./console-read-model";
import type { ConsoleModel } from "./console-model";
interface DetailText {
  language: string;
  L(key: string): string;
  date(value: unknown): string;
  duration(value: number): string;
  tone(value: unknown): string;
  statusText(value: unknown): string;
}
interface DetailField {
  label?: string | undefined;
  value?: unknown;
  group?: string;
  full?: boolean;
  block?: boolean;
  tone?: string;
}
interface DetailOptions {
  missing?: boolean;
  outsideFilter?: boolean;
  frozen?: boolean;
}
const words = {
  en: {
    task: "Task / operation",
    agent: "Client / session",
    log: "Log entry",
    identity: "Identity and correlation",
    intent: "Purpose and target",
    outcome: "State and result",
    times: "Recorded times",
    provenance: "Source and retention",
    events: "Correlated events · latest 20 matches",
    operations: "Related operations · latest 20 retained",
    event: "Event",
    rawState: "Source state",
    scope: "Result scope",
    transport: "Transport only — not CAD validation",
    command: "Technical operation",
    script: "Source script",
    path: "Local source path",
    hash: "Recorded source SHA-256",
    code: "Result code",
    exit: "Process exit code",
    submitted: "User script submitted",
    mutation: "May have mutated",
    refresh: "Context refresh required",
    elapsed: "Recorded wall-clock interval",
    observed: "Transport observation interval",
    limit: "Configured execution timeout",
    order: "Source ordinal",
    revision: "Revision",
    sequence: "Sequence mode",
    readAt: "Snapshot read",
    observedAt: "Source observation",
    frozen: "Frozen view",
    missing: "Record left the retained window; showing last inspected data",
    filter: "Record is outside current filters",
    unavailable: "Source unavailable; last known data",
    countEvents: "Events in retained buffer",
    countOps: "Operations in retained buffer",
    yes: "Yes",
    no: "No",
    kind: "Operation kind",
    type: "Reported client type",
    signal: "Presence source",
    heartbeat: "Last presence signal",
    presence: "Presence is not inferred from job history",
    noEvents: "No matching events in the retained buffer",
    unknownEvents: "Event source unavailable",
    omitted: "Completed records omitted",
    logsCut: "Log window truncated",
    sessionsCut: "Session window truncated",
    project: "Project directory",
    mode: "Routing mode",
  },
  pl: {
    task: "Zadanie / operacja",
    agent: "Klient / sesja",
    log: "Wpis logu",
    identity: "Tożsamość i korelacja",
    intent: "Cel i obiekt operacji",
    outcome: "Stan i wynik",
    times: "Zarejestrowane czasy",
    provenance: "Źródło i retencja",
    events: "Powiązane zdarzenia · ostatnie 20 trafień",
    operations: "Powiązane operacje · ostatnie 20 w retencji",
    event: "Zdarzenie",
    rawState: "Stan źródłowy",
    scope: "Zakres wyniku",
    transport: "Wyłącznie transport — nie walidacja CAD",
    command: "Operacja techniczna",
    script: "Skrypt źródłowy",
    path: "Lokalna ścieżka źródła",
    hash: "Zapisany SHA-256 źródła",
    code: "Kod wyniku",
    exit: "Kod wyjścia procesu",
    submitted: "Wysłano skrypt użytkownika",
    mutation: "Możliwa zmiana modelu",
    refresh: "Wymaga odświeżenia kontekstu",
    elapsed: "Zapisany przedział czasu",
    observed: "Przedział obserwacji transportu",
    limit: "Skonfigurowany timeout",
    order: "Numer w źródle",
    revision: "Rewizja",
    sequence: "Tryb sekwencji",
    readAt: "Odczyt migawki",
    observedAt: "Obserwacja źródła",
    frozen: "Zamrożony widok",
    missing: "Rekord wypadł z retencji; pokazano ostatnio oglądane dane",
    filter: "Rekord nie należy do bieżącego filtra",
    unavailable: "Źródło niedostępne; dane ostatnio znane",
    countEvents: "Zdarzenia w dostępnym buforze",
    countOps: "Operacje w dostępnym buforze",
    yes: "Tak",
    no: "Nie",
    kind: "Rodzaj operacji",
    type: "Raportowany typ klienta",
    signal: "Źródło obecności",
    heartbeat: "Ostatni sygnał obecności",
    presence: "Obecność nie jest wyprowadzana z historii zadań",
    noEvents: "Brak pasujących zdarzeń w dostępnym buforze",
    unknownEvents: "Źródło zdarzeń niedostępne",
    omitted: "Pominięte zakończone rekordy",
    logsCut: "Okno logów obcięte",
    sessionsCut: "Okno sesji obcięte",
    project: "Katalog projektu",
    mode: "Tryb routingu",
  },
};
export function describeConsoleRow(
  row: ConsoleRow | null | undefined,
  ui: DetailText,
  snapshot: ConsoleSnapshot = {},
  options: DetailOptions = {},
) {
  const W = words[ui.language === "pl" ? "pl" : "en"],
    kind = kindOf(row);
  const related = correlate(row, snapshot, kind);
  const fields: DetailField[] = [];
  const add = (
    label: string | undefined,
    value: unknown,
    extra: Partial<DetailField> = {},
  ) => fields.push({ label, value, ...extra });
  const section = (group: string) => fields.push({ group });
  const bool = (value: unknown) =>
    typeof value === "boolean" ? W[value ? "yes" : "no"] : null;
  const available = (value: unknown) => value !== undefined && value !== null;
  if (!row)
    return {
      title: ui.L("details"),
      fields: [{ label: ui.L("details"), value: ui.L("noSelection") }],
      related,
      kind,
    };
  if (options.missing) add(ui.L("state"), W.missing, { tone: "warning" });
  if (options.outsideFilter) add(ui.L("scope"), W.filter, { tone: "muted" });
  if (kind === "log") {
    section(W.log);
    add(ui.L("time"), ui.date(row.timestamp));
    add(ui.L("level"), row.level, { tone: ui.tone(row.level) });
    add(ui.L("source"), row.component);
    add(W.event, row.event);
    add(ui.L("source"), row.sourceFile);
    section(ui.L("message"));
    add(ui.L("message"), row.message, { block: true });
  } else if (kind === "agent") {
    section(W.agent);
    add(ui.L("presence"), presenceText(row, ui), {
      tone: row.source === "job-history" ? "muted" : ui.tone(row.presence),
    });
    add(
      ui.language === "pl"
        ? "Rodzaj klienta (prefiks ID)"
        : "Client kind (ID prefix)",
      clientKind(row.id),
    );
    add(ui.L("work"), row.work);
    add(W.signal, row.source);
    add(W.heartbeat, ui.date(row.lastSeen));
    if (row["pid"]) add("PID", row["pid"]);
    if (row["processCount"] !== undefined)
      add(
        ui.language === "pl" ? "Procesy o tym ID" : "Processes with this ID",
        row["processCount"],
      );
    if (row["type"] || row["clientType"])
      add(W.type, row["type"] || row["clientType"]);
    if (row.name) add(ui.L("agents"), row.name);
    add(ui.L("sourceReason"), W.presence, { tone: "muted" });
    add(W.countOps, related.operations?.length);
    if (related.operations)
      add(ui.L("open"), related.operations.filter(openOperation).length);
  } else {
    section(W.intent);
    add(ui.L("purpose"), row.description || ui.L("noDescription"));
    add(W.command, row.label || row.kind);
    if (row.kind) add(W.kind, row.kind);
    fields.push(...documentFields(row, ui));
    if (row.component) add("Component", row.component);
    section(W.outcome);
    add(ui.L("state"), ui.statusText(row.state), { tone: ui.tone(row.state) });
    add(W.rawState, row.state);
    if (row["outcomeScope"] === "transport" || snapshot.mode === "direct")
      add(W.scope, W.transport, { tone: "warning" });
    for (const [key, label] of [
      ["code", W.code],
      ["exitCode", W.exit],
      ["httpStatus", "HTTP"],
      ["executionOutcome", W.outcome],
    ] as const)
      if (available(row[key])) add(label, row[key]);
    for (const [key, label] of [
      ["userScriptSubmitted", W.submitted],
      ["mayHaveMutated", W.mutation],
      ["contextRefreshRequired", W.refresh],
    ] as const)
      if (available(row[key])) add(label, bool(row[key]));
    section(W.times);
    for (const [key, label] of [
      ["submittedAt", ui.L("received")],
      ["startedAt", ui.L("started")],
      ["finishedAt", ui.L("finished")],
    ] as const)
      add(label, ui.date(row[key]));
    const elapsed =
      typeof row.startedAt === "number" && typeof row.finishedAt === "number"
        ? consoleRecordedDuration(row)
        : null;
    add(
      row["outcomeScope"] === "transport" || snapshot.mode === "direct"
        ? W.observed
        : W.elapsed,
      elapsed === null ? null : ui.duration(elapsed),
    );
    if (
      typeof row["timeoutMs"] === "number" &&
      Number.isFinite(row["timeoutMs"])
    )
      add(W.limit, ui.duration(row["timeoutMs"]));
    if (row.sourcePath || row.script || row.sourceHash) {
      section(W.script);
      if (row.script) add(W.script, row.script);
      add(W.path, row.sourcePath);
      add(W.hash, row.sourceHash);
    }
  }
  section(W.identity);
  add("ID", row.id);
  for (const [key, label] of [
    ["requestId", "Request ID"],
    ["clientId", "Client ID"],
    ["agentId", "Agent ID"],
    ["sessionId", "Session ID"],
    ["taskId", "Task ID"],
    ["sequenceId", "Sequence ID"],
    ["sequenceMode", W.sequence],
    ["revision", W.revision],
    ["order", W.order],
  ] as const)
    if (available(row[key])) add(label, row[key]);
  if (kind !== "task" && related.operations?.length) {
    section(W.operations);
    const operations = related.operations.slice(-20);
    for (const op of operations) {
      add(
        op.id,
        `${ui.statusText(op.state)} · ${op.description || op.label || op.kind || "—"}`,
      );
      if (op.document) add(ui.L("document"), op.document);
    }
  }
  if (kind !== "log") {
    section(W.events);
    add(
      W.countEvents,
      related.events === null ? W.unknownEvents : related.events.length,
    );
    if (related.events?.length)
      for (const event of related.events.slice(-20)) {
        add(
          `${event.level || "OTHER"} · ${ui.date(event.timestamp)}`,
          event.message,
          { block: true, tone: ui.tone(event.level) },
        );
      }
    else
      add(
        ui.L("event"),
        related.events === null ? W.unknownEvents : W.noEvents,
      );
  }
  section(W.provenance);
  add(W.project, snapshot.project);
  add(W.mode, snapshot.mode);
  add(
    ui.L("source"),
    kind === "log"
      ? row.sourceFile || row.component
      : row.source || snapshot["source"],
  );
  add(W.observedAt, ui.date(snapshot.observedAt));
  add(W.readAt, ui.date(snapshot.readAt));
  add(W.frozen, bool(!!options.frozen));
  if (snapshot.taskEvents && snapshot.taskEvents.taskId === row.id) {
    add(
      ui.language === "pl"
        ? "Przeszukane pliki logów"
        : "Searched task log files",
      snapshot.taskEvents.sources?.join("\n"),
      { block: true },
    );
    add(
      ui.language === "pl"
        ? "Ograniczony odczyt archiwów"
        : "Archive search limited",
      bool(snapshot.taskEvents.limited),
    );
    if (snapshot.taskEvents.error)
      add(ui.L("sourceReason"), snapshot.taskEvents.error, { tone: "warning" });
  }
  if (snapshot.available === false)
    add(ui.L("state"), W.unavailable, { tone: "warning" });
  const retention = snapshot.retention ?? {};
  for (const [key, label] of [
    ["terminalTruncated", W.omitted],
    ["logWindowTruncated", W.logsCut],
    ["sessionsTruncated", W.sessionsCut],
  ] as const)
    if (available(retention[key]))
      add(
        label,
        typeof retention[key] === "boolean"
          ? bool(retention[key])
          : retention[key],
      );
  return { title: W[kind], fields, related, kind };
}

export interface ConsoleDetailSelection {
  readonly id: string;
  readonly rowType: Parameters<ConsoleModel["source"]>[0];
  row: ConsoleRow;
  frozen?: boolean;
  missing?: boolean;
  outsideFilter?: boolean;
  contextSnapshot?: ConsoleSnapshot;
}
export function refreshConsoleDetail(
  modal: ConsoleDetailSelection,
  model: Pick<ConsoleModel, "source" | "rows" | "snapshot">,
  clone: <T>(value: T) => T,
): void {
  if (modal.frozen) return;
  const source = model.source(modal.rowType);
  const row = source?.find((item) => item.id === modal.id);
  if (row) modal.row = clone(row);
  modal.missing = Array.isArray(source) && !row;
  modal.contextSnapshot = clone(model.snapshot);
  modal.outsideFilter =
    !!row &&
    !(model.rows(modal.rowType) || []).some((item) => item.id === modal.id);
}

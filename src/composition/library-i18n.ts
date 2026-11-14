import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultConfigPath } from "./library-configuration";
export interface Preferences {
  language: string;
  color: string;
  frames: string;
  warning?: string;
}
export interface LocaleEnvironment {
  LC_ALL?: string | undefined;
  LC_MESSAGES?: string | undefined;
  LANG?: string | undefined;
}
interface PreferenceDocument {
  console?: Record<string, unknown>;
}

export const en: Record<string, string> = {
  unknown: "Unavailable",
  noDescription: "No description supplied",
  purpose: "Command purpose",
  operation: "Operation",
  overview: "Overview",
  agents: "Agents",
  tasks: "Tasks",
  logs: "Logs",
  system: "System",
  operations: "Operations",
  direct: "Direct connection",
  broker: "Broker",
  unused: "unused",
  mode: "Mode",
  project: "Project",
  source: "Source",
  settings: "Settings",
  help: "Help",
  search: "Search",
  filters: "Filters",
  details: "Details",
  export: "Export",
  current: "Current",
  history: "History",
  all: "All",
  open: "Open",
  state: "State",
  presence: "Presence",
  work: "Work",
  noResults: "No results in this scope",
  noData: "Data unavailable",
  loading: "Loading data...",
  stale: "Last known data",
  live: "LIVE",
  frozen: "FROZEN",
  follow: "FOLLOW",
  newRows: "+{count} new",
  rows: "{count} results in retained window",
  resize: "Enlarge terminal to 80 x 24",
  quit: "Quit",
  cancel: "Cancel",
  apply: "Apply",
  reset: "Reset",
  refresh: "Refresh",
  scope: "Scope",
  retention: "Retention",
  language: "Language",
  color: "Colors",
  frames: "Frames",
  auto: "Automatic",
  off: "Off",
  unicode: "Unicode",
  ascii: "ASCII",
  saved: "Settings saved",
  notSaved: "Applied for this session; settings were not saved: {reason}",
  directPause:
    "Direct mode. Broker pause unavailable; the console does not stop the agent.",
  unsupported:
    "Control unavailable. This broker does not advertise compatible pause controls.",
  pause: "Pause new calls",
  resume: "Resume agents",
  pending: "Sent; awaiting authoritative confirmation",
  uncertain:
    "Control outcome unknown. Refresh status before any further action.",
  paused:
    "PAUSED: no admitted managed calls; external clients are not blocked.",
  pausing: "PAUSING: admitted calls are draining. Wait before manual work.",
  resuming: "RESUMING: checking readiness; admission remains closed.",
  blocked:
    "RECOVERY BLOCKED: unresolved operation. Observe receipts; do not replay.",
  unconfirmed:
    "Broker state unconfirmed; manual-work safety is not established.",
  running: "RUNNING: managed calls may be admitted.",
  confirm: "Tab selects Confirm or Cancel; Enter activates. Default: Cancel.",
  confirmed: "Confirm",
  exitPaused:
    "Console closed. Broker remains paused; open fmcad console to resume.",
  noContext:
    "No project selected; project monitoring and controls unavailable.",
  pathPrompt: "Project path (Enter: select, Esc: no context):",
  invalidPath: "Invalid project path: {reason}",
  exportPrompt:
    "Export retained, filtered snapshot. Enter path; Tab: JSONL/text; Enter: save.",
  overwrite: "File exists. Press y to confirm replacement; Esc cancels.",
  exported: "Exported {count} records to {path}",
  brokerScope: "All managed projects in this Fusion instance",
  fusion: "Fusion",
  connectivity: "Connectivity",
  observation: "Last source observation",
  host: "Local host",
  panel: "Console process",
  event: "Event",
  terminal: "Use an interactive terminal, or fmcad console --help.",
  mcpHelp:
    "Usage: fmcad-mcp [--backend mcp|addin] [--routing queue] [--client OWNER-ID] [--project-directory PATH]\n                 [--timeout positive-ms] [--queue-timeout positive-ms] [--help]\n\nStandalone local MCP server (default: addin physical backend, broker routing only).\ninitialize, ping, tools/list and fmcad_help need no configuration, OpenCode or Fusion.\nExecution lazily uses standalone fmcad configuration (FMCAD_CONFIG).\nQueue owner: --client or FMCAD_CLIENT (stable across restarts); clientInfo is only a label.\nSDK work needs --project-directory, FMCAD_PROJECT_DIRECTORY, or one validated MCP file root.\nTimeout limits active execution; queue-timeout optionally limits waiting for a slot.\nQueue tools provide explicit leases; tool metadata uses params._meta.fmcad.\nOptional session intent: --purpose TEXT. Per-operation intent: params._meta.fmcad.description.\nNo automatic backend fallback or retry.\nfmcad_execute accepts operation, data and context objects, never shell command strings.\ntools/list publishes the local fmcad_cad_* catalog without contacting Fusion.\nCatalog tools use data plus doc/identity pins, purpose and preview; execution shares CAD validation and broker admission.\nRead-only requested is not read-only enforced. Use fmcad tools --json for installed raw backend schemas.",
  shortcuts:
    "1-5 Views | Tab Focus | Enter Details | / Search | f Filters | o Sort | r Refresh | Space Freeze | b Broker | , Settings | ? Help | q Quit",
  helpBody:
    "Space freezes only the view. Broker pause is authoritative and survives console exit. Missing observations do not mean zero or Fusion idle. Up/PgUp stops log following; End/l follows. v changes compact sections. In details: t shows related tasks, g related logs. c in System changes project. Esc closes overlays.",
};
export const pl: Record<string, string> = {
  unknown: "Brak danych",
  noDescription: "Nie podano opisu",
  purpose: "Cel polecenia",
  operation: "Operacja",
  overview: "Przegląd",
  agents: "Agenci",
  tasks: "Zadania",
  logs: "Logi",
  system: "System",
  operations: "Operacje",
  direct: "Połączenie bezpośrednie",
  broker: "Broker",
  unused: "nieużywany",
  mode: "Tryb",
  project: "Projekt",
  source: "Źródło",
  settings: "Ustawienia",
  help: "Pomoc",
  search: "Szukaj",
  filters: "Filtry",
  details: "Szczegóły",
  export: "Eksport",
  current: "Bieżące",
  history: "Historia",
  all: "Wszystkie",
  open: "Otwarte",
  state: "Stan",
  presence: "Obecność",
  work: "Praca",
  noResults: "Brak wyników w tym zakresie",
  noData: "Dane niedostępne",
  loading: "Ładowanie danych…",
  stale: "Ostatnio znane dane",
  live: "NA ŻYWO",
  frozen: "ZAMROŻONE",
  follow: "ŚLEDŹ",
  newRows: "+{count} nowych",
  rows: "{count} wyników w oknie retencji",
  resize: "Powiększ terminal do 80 × 24",
  quit: "Zamknij",
  cancel: "Anuluj",
  apply: "Zastosuj",
  reset: "Reset",
  refresh: "Odśwież",
  scope: "Zakres",
  retention: "Retencja",
  language: "Język",
  color: "Kolory",
  frames: "Ramki",
  auto: "Automatycznie",
  off: "Wyłączone",
  unicode: "Unicode",
  ascii: "ASCII",
  saved: "Ustawienia zapisane",
  notSaved: "Zastosowano w tej sesji; nie zapisano ustawień: {reason}",
  directPause:
    "Tryb bezpośredni. Pauza brokera niedostępna; konsola nie wstrzymuje agenta.",
  unsupported:
    "Sterowanie niedostępne. Broker nie zgłasza zgodnej obsługi pauzy.",
  pause: "Wstrzymaj nowe wywołania",
  resume: "Wznów pracę agentów",
  pending: "Wysłano; oczekiwanie na potwierdzenie brokera",
  uncertain: "Wynik sterowania nieznany. Odśwież stan przed kolejną akcją.",
  paused:
    "PAUZA: brak dopuszczonych wywołań; niezależni klienci nie są blokowani.",
  pausing:
    "WSTRZYMYWANIE: trwają dopuszczone wywołania. Poczekaj z pracą ręczną.",
  resuming: "WZNAWIANIE: trwa kontrola gotowości; bramka pozostaje zamknięta.",
  blocked:
    "UZGODNIENIE WYMAGANE: nierozstrzygnięta operacja. Odczytaj dowody; nie ponawiaj.",
  unconfirmed:
    "Stan brokera niepotwierdzony; nie ustalono bezpieczeństwa pracy ręcznej.",
  running: "PRACA: broker może dopuszczać wywołania.",
  confirm:
    "Tab wybiera Potwierdź lub Anuluj; Enter zatwierdza. Domyślnie: Anuluj.",
  confirmed: "Potwierdź",
  exitPaused:
    "Panel zamknięty. Broker pozostaje w pauzie; uruchom fmcad console, aby wznowić.",
  noContext:
    "Nie wybrano projektu; monitorowanie projektu i sterowanie niedostępne.",
  pathPrompt: "Ścieżka projektu (Enter: wybierz, Esc: bez kontekstu):",
  invalidPath: "Nieprawidłowa ścieżka projektu: {reason}",
  exportPrompt:
    "Eksport filtrowanego okna retencji. Wpisz ścieżkę; Tab: JSONL/tekst; Enter: zapisz.",
  overwrite:
    "Plik istnieje. Naciśnij y, aby potwierdzić nadpisanie; Esc anuluje.",
  exported: "Wyeksportowano {count} rekordów do {path}",
  brokerScope: "Wszystkie zarządzane projekty tej instancji Fusion",
  fusion: "Fusion",
  connectivity: "Łączność",
  observation: "Ostatnia obserwacja źródła",
  host: "Host lokalny",
  panel: "Proces konsoli",
  event: "Zdarzenie",
  terminal: "Użyj interaktywnego terminala lub fmcad console --help.",
  mcpHelp:
    "Użycie: fmcad-mcp [--backend mcp|addin] [--routing queue] [--client ID-WŁAŚCICIELA] [--project-directory ŚCIEŻKA]\n                 [--timeout dodatnie-ms] [--queue-timeout dodatnie-ms] [--help]\n\nSamodzielny lokalny serwer MCP (domyślnie: backend fizyczny addin, wyłącznie routing przez broker).\ninitialize, ping, tools/list i fmcad_help działają bez konfiguracji, OpenCode ani Fusion.\nWykonanie leniwie odczytuje samodzielną konfigurację fmcad (FMCAD_CONFIG).\nWłaściciel kolejki: --client lub FMCAD_CLIENT (stały po restarcie); clientInfo jest tylko etykietą.\nPraca SDK wymaga --project-directory, FMCAD_PROJECT_DIRECTORY albo jednego zweryfikowanego lokalnego root MCP.\nTimeout ogranicza aktywne wykonanie; queue-timeout opcjonalnie ogranicza oczekiwanie na miejsce w kolejce.\nNarzędzia kolejki udostępniają jawne dzierżawy; metadane narzędzia używają params._meta.fmcad.\nOpcjonalny cel sesji: --purpose TEKST. Cel pojedynczej operacji: params._meta.fmcad.description.\nBrak automatycznego fallbacku backendu i ponowień.\nfmcad_execute przyjmuje obiekty operacji, danych i kontekstu, nigdy tekst polecenia powłoki.\ntools/list publikuje lokalny katalog fmcad_cad_* bez kontaktu z Fusion.\nNarzędzia katalogu używają danych, pinów dokumentu/tożsamości, celu i preview; wykonanie współdzieli walidację CAD i admission brokera.\nŻądanie trybu tylko do odczytu nie wymusza tego ograniczenia. Surowe schematy backendu: fmcad tools --json.",
  shortcuts:
    "1-5 Widoki | Tab Fokus | Enter Szczegóły | / Szukaj | f Filtry | o Sortuj | r Odśwież | Spacja Zamroź | b Broker | , Ustawienia | ? Pomoc | q Wyjdź",
  helpBody:
    "Spacja zamraża tylko widok. Pauza należy do brokera i przetrwa zamknięcie konsoli. Brak obserwacji nie oznacza zera ani bezczynności Fusion. Góra/PgUp wyłącza śledzenie logów; End/l je włącza. v przełącza sekcje kompaktu. W szczegółach: t pokazuje powiązane zadania, g powiązane logi. c w Systemie zmienia projekt. Esc zamyka nakładki.",
};
Object.assign(en, {
  rows_one: "{count} result in retained window",
  rows_other: "{count} results in retained window",
  newRows_one: "+{count} new",
  newRows_other: "+{count} new",
});
Object.assign(pl, {
  rows_one: "{count} wynik w oknie retencji",
  rows_few: "{count} wyniki w oknie retencji",
  rows_many: "{count} wyników w oknie retencji",
  rows_other: "{count} wyniku w oknie retencji",
  newRows_one: "+{count} nowy",
  newRows_few: "+{count} nowe",
  newRows_many: "+{count} nowych",
  newRows_other: "+{count} nowego",
});
Object.assign(en, {
  sort: "Sort",
  formKeys: "Tab / Up/Down: focus; Left/Right: value; Enter: activate",
  preferenceWarning: "Cannot read language preferences; using automatic locale",
});
Object.assign(pl, {
  sort: "Sortowanie",
  formKeys: "Tab / góra/dół: fokus; lewo/prawo: wartość; Enter: wybierz",
  preferenceWarning:
    "Nie można odczytać ustawień języka; wybrano tryb automatyczny",
});
const stateEn = {
  queued: "waiting",
  running: "executing",
  sending: "dispatching",
  succeeded: "success",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
  needs_reconciliation: "unresolved",
  completed: "transport ended",
  unknown: "unknown",
  observed: "observed",
  offline: "disconnected",
};
const statePl = {
  queued: "oczekuje",
  running: "wykonuje",
  sending: "wysyłanie",
  succeeded: "sukces",
  failed: "błąd",
  cancelled: "anulowane",
  expired: "wygasło",
  needs_reconciliation: "nierozstrzygnięte",
  completed: "transport zakończony",
  unknown: "nieznane",
  observed: "potwierdzona",
  offline: "rozłączona",
};
Object.assign(stateEn, {
  preparing: "preparing locally",
  processing: "processing locally",
});
Object.assign(statePl, {
  preparing: "przygotowanie lokalne",
  processing: "przetwarzanie lokalne",
});
for (const [key, value] of Object.entries(stateEn)) en["state_" + key] = value;
for (const [key, value] of Object.entries(statePl)) pl["state_" + key] = value;
const missing = new Set<string>();
export function preferencesPath() {
  return process.env["FMCAD_CONFIG"] || defaultConfigPath();
}
export function preferences(file = preferencesPath()): Preferences {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as PreferenceDocument;
    const value = doc.console || {};
    return {
      language: ["auto", "en", "pl"].includes(value["language"] as string)
        ? (value["language"] as string)
        : "auto",
      color: value["color"] === "off" ? "off" : "auto",
      frames: value["frames"] === "ascii" ? "ascii" : "unicode",
    };
  } catch (error) {
    return {
      language: "auto",
      color: "auto",
      frames: "unicode",
      ...((error as { code?: string }).code !== "ENOENT"
        ? {
            warning: "Cannot read language preferences; using automatic locale",
          }
        : {}),
    };
  }
}
export function detected(env: LocaleEnvironment = process.env) {
  const tag = (
    env.LC_ALL ||
    env.LC_MESSAGES ||
    env.LANG ||
    Intl.DateTimeFormat().resolvedOptions().locale ||
    "en"
  )
    .replace(/[.@].*$/, "")
    .replaceAll("_", "-")
    .split("-")[0]!
    .toLowerCase();
  return tag === "pl" ? "pl" : "en";
}
export function locale(
  prefs: Pick<Preferences, "language"> = preferences(),
  env: LocaleEnvironment = process.env,
) {
  return prefs.language === "auto" ? detected(env) : prefs.language;
}
export function t(
  key: string,
  params: Record<string, unknown> = {},
  language = locale(),
) {
  const table = language === "pl" ? pl : en;
  const plural =
    typeof params["count"] === "number"
      ? `${key}_${new Intl.PluralRules(language).select(params["count"])}`
      : key;
  if (!table[key] && !en[key] && !missing.has(key)) {
    missing.add(key);
    process.stderr.write(`I18N_MISSING: ${key}\n`);
  }
  const template =
    table[plural] ||
    table[key] ||
    en[plural] ||
    en[key] ||
    (language === "pl" ? "Komunikat niedostępny" : "Message unavailable");
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    typeof params[name] === "number"
      ? new Intl.NumberFormat(language).format(params[name])
      : typeof params[name] === "string"
        ? params[name]
        : "?",
  );
}
export function savePreferences(
  patch: Record<string, unknown>,
  file = preferencesPath(),
) {
  for (const [key, values] of Object.entries({
    language: ["auto", "en", "pl"],
    color: ["auto", "off"],
    frames: ["unicode", "ascii"],
  })) {
    if (patch[key] !== undefined && !values.includes(patch[key] as string))
      throw new Error("Invalid console preference: " + key);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + ".console-lock";
  const fd = fs.openSync(lock, "wx", 0o600);
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    let doc: PreferenceDocument = {};
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8")) as PreferenceDocument;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    doc.console = { ...doc.console, ...patch, version: 1 };
    const output = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(output, JSON.stringify(doc, null, 2) + "\n");
      fs.fsyncSync(output);
    } finally {
      fs.closeSync(output);
    }
    fs.renameSync(temp, file);
    return preferences(file);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export const number = (value: number, language = locale()) =>
  new Intl.NumberFormat(language).format(value);
export const duration = (ms: number, language = locale()) => {
  const [scale, suffix]: [number, string] =
    ms < 1000
      ? [1, "ms"]
      : ms < 60000
        ? [1000, "s"]
        : ms < 3600000
          ? [60000, "min"]
          : [3600000, "h"];
  return number(Math.round((ms / scale) * 10) / 10, language) + " " + suffix;
};

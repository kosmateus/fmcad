import type { RegisteredCommand } from "./library-commands";
import type { OperationDeclaration } from "@fmcad/core";
import { createRequire } from "node:module";
const load = createRequire(__filename);

const groups: Record<string, string> = {
  param: "parametry",
  parameter: "parametry",
  catalog: "katalog części",
  placement: "rozmieszczenie",
  cots: "części katalogowe",
  sketch: "szkic",
  curve: "krzywe",
  surface: "powierzchnie",
  shape: "kształty",
  spring: "sprężyny",
  thread: "gwinty",
  cam: "krzywki",
  seal: "uszczelnienia",
  dock: "dokowanie",
  mount: "mocowania",
  fastener: "elementy złączne",
  bearing: "łożyska",
  shaft: "wały",
  retention: "ustalanie części",
  snap: "zatrzaski",
  drawing: "rysunki",
  animation: "animacja",
  motion: "ruch",
  appearance: "wygląd",
  material: "materiały",
  styles: "style",
  component: "komponenty",
  occurrence: "wystąpienia",
  joint: "wiązania",
  assembly: "złożenia",
  feature: "operacje modelowania",
  history: "historia",
  change: "zmiany",
  entity: "obiekty",
  batch: "operacje wsadowe",
  definition: "definicje",
  check: "sprawdzenie",
  evidence: "dowody",
  deliver: "dostarczenie wyników",
  measure: "pomiary",
  selection: "wybór",
  datum: "bazy konstrukcyjne",
  document: "dokumenty",
  doc: "dokumenty",
  explode: "widok rozstrzelony",
  fpc: "obwody elastyczne",
  pcb: "płytki drukowane",
  port: "przyłącza",
  connector: "złącza",
  pack: "upakowanie",
  keepout: "obszary zastrzeżone",
  gear: "koła zębate",
  clearance: "luzy",
  visibility: "widoczność",
  camera: "kamera",
  shot: "zrzut widoku",
  view: "widoki",
  section: "przekroje",
  reference: "materiały referencyjne",
  import: "import danych",
  checkpoint: "punkty kontrolne",
  export: "eksport",
  undercut: "podcięcia",
  manufacturing: "wytwarzanie",
  marking: "oznaczenia",
  audit: "kontrola",
  snapshot: "migawki",
  diff: "porównanie",
  status: "stan",
  report: "raporty",
  mechanism: "mechanizmy",
  path: "ścieżki",
  model: "modelowanie",
  pattern: "szyki",
  optics: "optyka",
  sensor: "czujniki",
  pose: "położenie",
  references: "odniesienia",
  route: "prowadzenie",
  service: "obsługa",
  tool: "narzędzia",
  fixture: "oprzyrządowanie",
  sheet: "arkusze",
  simulation: "symulacja",
  texture: "tekstury",
  ui: "interfejs Fusion",
  image: "obrazy",
  fit: "pasowanie",
  mass: "masa",
  fluid: "płyny",
  thermal: "ciepło",
  hydraulic: "hydraulika",
  capabilities: "możliwości",
};
const verbs: Record<string, string> = {
  add: "dodawanie",
  create: "tworzenie",
  new: "tworzenie",
  list: "lista",
  inspect: "odczyt właściwości",
  status: "odczyt stanu",
  edit: "edycja",
  set: "ustawianie",
  delete: "usuwanie",
  remove: "usuwanie",
  rename: "zmiana nazwy",
  open: "otwieranie",
  close: "zamykanie",
  save: "zapis",
  save_as: "zapis pod nową nazwą",
  save_native: "zapis formatu natywnego",
  duplicate: "powielanie",
  copy: "kopiowanie",
  move: "przemieszczanie",
  transform: "przekształcanie",
  extrude: "wyciągnięcie",
  revolve: "obrót",
  sweep: "przeciągnięcie",
  loft: "wyciągnięcie po profilach",
  fillet: "zaokrąglenie",
  chamfer: "fazowanie",
  shell: "wydrążenie",
  thicken: "pogrubienie",
  offset: "odsunięcie",
  trim: "przycięcie",
  split: "podział",
  join: "połączenie",
  combine: "operacje bryłowe",
  intersect: "przecięcie",
  mirror: "odbicie",
  pattern: "szyk",
  run: "wykonanie",
  validate: "walidacja",
  preview: "podgląd bez wykonania",
  reconcile: "uzgodnienie wyniku bez ponownego wykonania",
  finalize: "finalizacja",
  summary: "podsumowanie",
  export: "eksport",
  import: "import",
  capture: "przechwycenie",
  refresh: "odświeżenie",
  diameter: "pomiar średnicy",
  radius: "pomiar promienia",
  distance: "pomiar odległości",
  angle: "pomiar kąta",
  length: "pomiar długości",
  area: "pomiar pola",
  volume: "pomiar objętości",
  mass: "pomiar masy",
  thickness: "pomiar grubości",
  clear: "czyszczenie",
  search: "wyszukiwanie",
  recent: "ostatnie dokumenty",
  apply: "zastosowanie",
  restore: "odtworzenie",
  compare: "porównanie",
  check: "sprawdzenie",
  analyze: "analiza",
  resolve: "rozwiązanie",
  respond: "odpowiedź",
  build: "budowanie",
  prepare: "przygotowanie",
  approve: "zatwierdzenie",
  verify: "weryfikacja",
  once: "jednorazowe wykonanie",
  observe: "obserwacja",
  instantiate: "utworzenie instancji",
  expand: "rozwinięcie",
  play: "odtwarzanie",
  stop: "zatrzymanie",
  definition: "definicja",
  connect: "połączenie",
  disconnect: "rozłączenie",
  "drive-test": "test napędu",
};
const specials: Record<string, string> = {
  "capabilities inspect":
    "Wyszukuje offline zarejestrowane operacje i helpery cad-v1 wraz z wymaganiami, ograniczeniami oraz przykładami katalogu. Nie łączy się z Fusion i nie uruchamia próby SDK.",
  "capabilities probe":
    "Jawnie zleca pojedynczą próbę SDK przez broker dla wskazanej operacji katalogu. Wymaga przypiętej tożsamości dokumentu; pomoc, inspekcja i lista narzędzi nie wykonują próby.",
  console:
    "Uruchamia terminalową konsolę monitorowania w trybie broker lub bezpośrednim. Nie uruchamia brokera i nie odpytuje Fusion. Bez --project wybiera najbliższy projekt nadrzędny; jawna ścieżka musi być poprawna. Zamknięcie panelu nie kończy usług i nie cofa pauzy. --web wypisuje adres gotowego Control Center bez wymagania terminala; bez --project wybiera widok globalny, a jawna ścieżka wymaga dokładnie jednego zarejestrowanego projektu.",
  help: "Wyświetla pomoc ogólną lub pomoc wybranego polecenia bez uruchamiania usług.",
  init: "Tworzy konfigurację fmcad; --force pozwala zastąpić istniejący plik. --from-opencode importuje ustawienia połączenia MCP.",
  doctor:
    "Sprawdza rzeczywiste połączenie z wybranym serwerem i odczytuje listę narzędzi. To nie jest walidacja modelu.",
  tools:
    "Odczytuje narzędzia udostępnione przez wybrany serwer; --json zachowuje format maszynowy.",
  run: "Wykonuje skrypt Python ze wskazanego pliku lub katalogu skryptów. --args i --args-file wykluczają się. --list wyświetla skrypty bez połączenia z Fusion. Opcje --doc-id i --doc-file-id przypinają tożsamość dokumentu.",
  call: "Wywołuje wskazane narzędzie serwera z obiektem argumentów JSON. Nie ponawia automatycznie niepewnej operacji.",
  review:
    "Przygotowuje zrzuty wskazanego dokumentu i raport do oceny. Zrzut ani powodzenie skryptu nie dowodzą poprawności fizycznej.",
  active: "Odczytuje informacje o aktywnym dokumencie.",
  licensing: "Odczytuje informacje licencyjne; wymaga backendu mcp.",
  undo: "Cofa ostatnią operację w Fusion; wymaga backendu mcp.",
  redo: "Ponawia cofniętą operację w Fusion; wymaga backendu mcp.",
  projects: "Wyświetla projekty w aktywnym hubie.",
  tree: "Wyświetla hierarchię folderów i plików projektu.",
};
const queue: Record<string, string> = {
  serve:
    "Uruchamia lokalny broker po jawnym przekazaniu własności Fusion przez --confirm-ownership true. Nie restartuje Fusion.",
  exec: "Przyjmuje całe polecenie fmcad i oczekuje na wynik. Argumenty polecenia potomnego oddziel przez --.",
  submit:
    "Trwale przyjmuje całe polecenie i zwraca jego jobId. Argumenty polecenia potomnego oddziel przez --.",
  status: "Odczytuje stan brokera lub zadania bez ruchu SDK Fusion.",
  result: "Odczytuje trwały wynik własnego zadania.",
  pause:
    "Trwale zamyka bramkę nowych wywołań. Dopuszczone wywołania kończą się; PAUSED jest potwierdzone dopiero po ich rozliczeniu.",
  resume:
    "Sprawdza gotowość i tożsamość Fusion przed otwarciem bramki. Niepewny wynik wymaga uzgodnienia; wznowienie nie ponawia zadań.",
  cancel:
    "Anuluje wyłącznie oczekujące zadanie. Rozpoczęta operacja Fusion nie jest anulowana.",
  release: "Zwalnia własną bezczynną sekwencję.",
  stop: "Opróżnia bieżące wykonanie i kończy broker. Niepewne operacje blokują zwolnienie własności.",
  reclaim:
    "Uzgadnia znacznik martwego brokera po sprawdzeniu PID i tożsamości procesu; nie odtwarza wykonania.",
  reconcile:
    "Uzgadnia niepewne zadanie na podstawie istniejących, powiązanych dowodów zakończenia; nigdy go nie wykonuje ponownie.",
};
export function description(entry: RegisteredCommand): string | undefined {
  if (specials[entry.key]) return specials[entry.key];
  if (entry.kind === "queue") return queue[entry.key.split(" ")[1]!];
  const parts = (
    entry.target && typeof entry.target === "string" ? entry.target : entry.key
  )
    .replaceAll("_", " ")
    .split(/[. ]/);
  const group = groups[parts[0]!] || parts[0];
  const actions = parts
    .slice(1)
    .map((part) => verbs[part] || part)
    .join(" / ");
  return (
    `Zakres: ${group}. ${actions ? `Działanie: ${actions}.` : "Polecenia z tej grupy opisano poniżej."} ` +
    (entry.kind === "cad"
      ? "Argumenty JSON muszą odpowiadać wskazanej operacji. Walidacja danych odbywa się przed wykonaniem."
      : entry.kind === "local"
        ? "Przetwarza dane lokalne zgodnie ze schematem tej komendy."
        : "Używa jawnie wybranego backendu i podanych argumentów.")
  );
}
export function detail(entry: RegisteredCommand): string {
  const { catalog } = load("../../catalog") as {
    catalog: Record<string, OperationDeclaration>;
  };
  const spec = entry.kind === "cad" ? catalog[entry.target!] : null;
  const offlineCapabilities = entry.target === "capabilities.inspect";
  let result = `Pomoc: ${entry.key}\n\nUżycie:\n  fmcad ${entry.usage}\n\n${description(entry)}\n\nPrzykład:\n  ${entry.example}\n`;
  if (spec) {
    result +=
      "\nParametry wejściowe (dokładne nazwy pól JSON):\n" +
      Object.keys(spec.inputs)
        .map(
          (name) =>
            `  ${name}: ${spec.required.includes(name) ? "parametr wymagany" : "parametr opcjonalny"}`,
        )
        .join("\n") +
      "\nWymagane parametry: " +
      (spec.required.join(", ") || "brak") +
      `\nTylko odczyt: ${spec.readOnly ? "tak" : "nie"}.\n`;
    result +=
      "Zamiast --data można użyć --file z plikiem JSON. Flagi wejściowe wymagają wartości, także logiczne. --preview waliduje dane bez wykonania.\n";
    const contract = entry.contract!;
    result +=
      `Kontrakt katalogu: ${contract.operation}; usługa=${contract.service.kind}:${contract.service.handler}; SDK=${contract.requirements.sdk}; chmura=${contract.requirements.cloud}.\n` +
      `Żądanie tylko odczytu: ${contract.readOnlyRequested ? "tak" : "nie"}; wymuszenie tylko odczytu: nie. Dostępność funkcji ani powodzenie wykonania nie potwierdzają poprawności geometrii ani dostępu do chmury.\n`;
    if (entry.requiresDoc)
      result +=
        "Wymagany --doc: dokładna, jednoznaczna nazwa otwartego dokumentu. Identyfikatory i nazwy z przykładów są zastępcze; najpierw odczytaj rzeczywiste dane.\n";
    if (!offlineCapabilities)
      result +=
        "\nWartości i ich strukturę przedstawia przykład JSON. Szczegółowy kontrakt SDK, jednostki i ograniczenia tej operacji opisano w docs/COMMAND_REFERENCE.md pod jej identyfikatorem. Przed zmianą modelu sprawdź ten kontrakt i odczytaj rzeczywiste identyfikatory obiektów.\n";
  }
  result += offlineCapabilities
    ? "\nTo wyszukiwanie jest lokalne: nie ładuje konfiguracji, nie używa backendu i nie odpytuje Fusion.\n\nOpcje wspólne:\n  --purpose TEXT  Opcjonalny cel polecenia; do 1000 znaków Unicode, bez znaków sterujących.\n"
    : "\nOpcje wspólne:\n  --purpose TEXT  Opcjonalny cel polecenia; do 1000 znaków Unicode, bez znaków sterujących.\n" +
      "  --config PATH  Plik konfiguracji. --backend mcp|addin  Jawny wybór serwera.\n" +
      "  --timeout MS  Limit wykonania; w kolejce nie obejmuje oczekiwania.\n" +
      "Brak automatycznego ponawiania ani przełączania backendu. Niepewny wynik uzgodnij przed kolejną operacją.\n";
  if (entry.kind === "queue")
    result +=
      "\nOpcje kolejki: --client LABEL --request-id ID --job ID --queue-timeout MS --sequence-action begin|continue|end --sequence-id ID --sequence-mode automatic|exclusive --expected-revision N.\n";
  return result;
}

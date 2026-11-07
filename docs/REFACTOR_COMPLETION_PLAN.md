# Plan dokończenia refaktoru fmcad

Stan odniesienia: GitHub `a80b7753e47b8260c2de362b6c4fad04025ab1b2`,
pełne archiwum projektu i pierwsza dostawa opisana w
[REFACTOR_STAGE_1.md](REFACTOR_STAGE_1.md). Keychain został celowo usunięty;
nie przywracamy implementacji ani testów.

## Punkt odniesienia i zakres dowodów

Referencją sprzed migracji TypeScript jest
`a26222ff617b0e9597b2a91b50474bdca8d0a0ce`. Pierwszy etap migracji narzędzi
TypeScript zaczyna się później, w `8b0be07`. Usunięcie Keychain (`46a1ff2`)
poprzedza tę referencję. Archiwum zachowuje historię, worktree i Beads; nie należy
wgrywać go jako zawartości repozytorium.

Poniższe porównanie dotyczy źródeł i asercji. Nie zastępuje ponownego wykonania
na Fusion. Zamrożony baseline zawiera 15 wybranych obserwacji, a nie pełną
kwalifikację live. Raport odzyskiwania odpowiedzi z 23 października potwierdza
dwa przebiegi na Fusion, lecz nie dowodzi przejścia wszystkich suite na tym SHA.
Pozostałe raporty mają również przerwane przebiegi lub niepełną identyfikację
wersji. W tym środowisku nie ma działającego natywnego Fusion.

| Historyczny zestaw                | Zachowanie podlegające ochronie                                                                                                                                                | Zmiana w obecnych testach                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `live-legacy.js`                  | Własność dokumentu; CRUD parametrów i płaszczyzn; komponenty; cm/mm/in; pudełko 10 mm, stats/bbox/bodies; rollback; PNG/eksport; zachowanie cudzych dokumentów                 | Plik identyczny bajtowo z referencją                                                                    |
| `live-cad.js`                     | Regeneracja wymiarów, bryły, otwory/pattern/fillet; definicje i wystąpienia; pomiary; odrzucenie błędnych lub niejednoznacznych danych bez nowych encji; timeline i checkpoint | Plik identyczny bajtowo                                                                                 |
| `live-extended.js`                | Sweep/loft/shell/chamfer/combine/split/draft; pattern/mirror; joint; clearance/interference; batch z nieudaną bramką; visibility, kamera i cleanup                             | Plik identyczny bajtowo                                                                                 |
| `live-feature-modes.js`           | Warianty extrude, hole, sweep i loft; wymiary, objętość, granice i zdrowie historii                                                                                            | Plik identyczny bajtowo                                                                                 |
| `live-motion-animation.js`        | Limity joint przed zmianą pozy; pięć klatek; workspace/storyboard; odrzucenie pustego play; przywrócenie workspace                                                             | Plik identyczny bajtowo                                                                                 |
| `live-definitions.js`             | Literalne definicje; idempotencja runId bez ponownych mutacji; stop po błędzie check; liczbowe rozmiary; odrzucenie składni                                                    | Zmieniono zwalnianie adaptera na `disposeBackend`; asercje zachowania pozostały                         |
| `live-style-save.js`              | Materiał/appearance i ich kaskada; walidacja refs; masa; status niezapisanego dokumentu; lokalny roundtrip                                                                     | Dostosowano separator generowanego typowanego requestu; asercje pozostały                               |
| Runner i `helpers/live-broker.js` | Identyfikacja klienta, kolejność, własność, settlement i brak replay wyniku unknown                                                                                            | Zmieniona infrastruktura; obecny runner wymaga wspólnego brokera, ma limit współbieżności i hash źródeł |

Późniejsze testy obejmują między innymi wielodokumentowość, import danych,
odzyskiwanie odpowiedzi, operacje szkicu, hierarchię komponentów, atrybuty,
eksporty, bryły/powierzchnie, style, motion i analitykę. Obecne `run-live all`
nie rejestruje wszystkich tych plików: trzeba rozliczyć każdy jako wymagany
scenariusz, profil specjalny albo jawnie nieobsługiwaną możliwość. Istnienie
pliku i zielony test jego źródła nie są wynikiem live.

## Broker: co jest ustalone, a co wymaga dowodu

| Problem                                                                                 | Ustalenie                                                                                                                                      | Następny dowód / oczekiwany wynik                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduling, pauza i własność sekwencji                                                  | Te same trzy testy kolejki przechodzą na referencji i obecnym kodzie                                                                           | Nie jest to regresja wykazana tymi scenariuszami. Osobno badać rzeczywistą ścieżkę transportu i dokumentu                                                         |
| Retained origin / strażnik UI                                                           | Sparowane testy reprodukują odrzucenie historycznego checkera `f708256` i poprawny wynik obecnego kodu                                         | Regresja późniejszej migracji, a nie zachowanie referencji `a26222f`; zachować rzeczywisty checker                                                                |
| Protokół odpowiedzi audytu                                                              | Siedem przypadków porównuje zachowany kod `843ce0d` z aktualnym                                                                                | Brak/niekońcowa odpowiedź nie oznacza sukcesu; nie ponawiać mutacji                                                                                               |
| Strict `stats` i pozostałe inspection                                                   | Programy wymagały typowanych granic SDK; pierwsza dostawa sprawdza pięć operacji prawdziwym checkerem i osiem przypadków starego/nowego Python | Wynik i efekty pozostają zgodne; odrzucenie checkera nie może zaliczać testu ochrony dokumentu                                                                    |
| Test pauzy przy zmianie kontekstu                                                       | Dawna akceptacja `PYTHON_CHECK_REJECTED` maskowała brak dowodu dotarcia do strażnika dokumentu                                                 | Po resume dopuszczalne są invalidated preparation albo unavailable target, oba z `not_started` i zerem wysłań operacji                                            |
| Timeout catalog worker                                                                  | Test używał podmiany loadera modułów; zastąpiono ją wspieranym adapterem ścieżek, bez wydłużania deadline                                      | Przejście CI nie dowodzi przyczyny każdego historycznego timeoutu; zachować diagnostykę ostatniego job i liczby wywołań                                           |
| Publiczny run z doc-id (`69j.2`)                                                        | Archiwalny wpis otwarty jest starszy od poprawki `8b2c237`                                                                                     | Rozliczyć exact installed path przed zamknięciem zadania; nie implementować poprawki drugi raz                                                                    |
| Pierwszy dokument o tej samej nazwie, ignorowany wynik activate, zero po błędzie volume | Zachowania obecne już w historycznym inspection                                                                                                | Dodać odrębne negatywy i zmienić kontrakt jawnie: odrzucenie niejednoznacznego celu, brak mutacji po nieudanym activate, unknown/error zamiast fałszywego pomiaru |

Dla nierozstrzygniętych problemów potrzebne są oba SHA uruchomione na tej samej
wersji Fusion i API, te same wejścia i asercje, logi brokera oraz receipts z
requestId, creationId, file/version ID, liczbą wywołań i rezultatem cleanup.
Nie zmieniamy oczekiwania testu tylko dlatego, że obecny kod zwraca inny wynik.
Dokładne cztery wyjątki baseline pierwszej dostawy mają osobne uzasadnienia
w `tests/fixtures/refactor-baseline/migration-allowances.json`; brak efektu,
inna tożsamość lub liczba wywołań pozostają błędami.

## Backend testowy i wspólne scenariusze

Kierunek jest uzasadniony i częściowo już zaimplementowany w `tests/scenarios`.
Rozwijamy ten moduł, zamiast budować drugi framework. Interfejs jest sprawdzany
z przypiętym Autodesk FusionAPIReference
`07814d19ac63bb3ff0d55e3d35517cf3a71bad8c` i snapshotem
`83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`.
Typy określają sygnatury, nullability i kolekcje; semantykę bierzemy z historycznych
asercji oraz pomiarów Fusion. Definicje API nie są implementacją kernela CAD.

Scenariusz zawiera jedną funkcję kroków i asercji. Backend dostarcza tylko wykonanie,
mapowanie plików, capabilities i wynik transportu. Nie może zmieniać wartości
oczekiwanych, tolerancji ani pomijać kroków. Brak wymaganej capability daje jawne
unsupported, które nie zalicza wymaganego profilu. Model uruchamiamy zarówno
komponentowo, jak i przez prawdziwy broker dla MCP i addin.

Obecne wspólne przypadki obejmują dokument i literalne parametry długości:
te same nazwy parametrów, inne wartości dla właścicieli, mm na wejściu i cm w API,
tolerancja `1e-9`, odczyt creationId i wartości po przeplataniu. Dalej przenosimy
CRUD parametrów/units/timeline, szkice/komponenty/atrybuty i import/export.
Operacje geometryczne otrzymują tylko jawnie ograniczony model; natywnej
poprawności geometrii nie zastępuje zgodność objętości ani sfabrykowany F3D.

Na Fusion trzeba sprawdzić: aktywację i lifetime uchwytów, null/false/error SDK,
jednostki i regenerację, timeline/health, tożsamość po reopen, zapis i usunięcie
chmurowe, eksport/import, binding encji, zachowanie po utracie odpowiedzi,
rendering oraz rzeczywiste bryły/pozy i tolerancje. Aktualny eksport modelu to
JSON stanu testowego oznaczony jako taki, nie plik Fusion.

## Izolacja, cleanup i limity

Każdy scenariusz ma własne runId/scenarioId/clientId, requestId, creationId,
plik i katalog raportów. Operacja w tej samej turze SDK weryfikuje tożsamość
i aktywuje dokładny własny dokument. Sama zgodność nazwy nie wystarcza.
Dzisiejszy runner tworzy niezapisany dokument i lokalny eksport; to nie zamyka
wymagania zapisanego pliku Fusion. Etap 2 musi dodać pełny cykl zapisu,
potwierdzenia file/version ID, close oraz usunięcia własnego pliku i potwierdzenia
nieobecności. Testowy projekt/folder Fusion musi być wskazany przed native run.

Cleanup działa w `finally` także po błędzie setup, operacji i asercji; jego błąd
nie może zastąpić pierwotnego błędu. Slot współbieżności jest zajęty do końca
sprzątania. Po nieustalonym wyniku najpierw rozliczamy pierwotny request i receipt,
bez replay; cleanup odroczony daje niezaliczony raport i manifest odzyskiwania.
Po zabiciu procesu cleanup wykonuje recovery z tego manifestu. Przed i po zestawie
porównujemy inwentarz cudzych dokumentów i odtwarzamy aktywny dokument, jeśli
wciąż istnieje i można go bezpiecznie przywrócić.

Limit jest konfigurowalny: Fusion domyślnie 10; model domyślnie
`min(2, availableParallelism)`. Po pomiarze RSS i budżetu pamięci kontenera:
`max(1, min(CPU, floor(memoryBudget / workerPeakRSS)))`. Nie używamy wolnej pamięci
hosta jako budżetu kontenera. Broker ma obecnie do czterech workerów przygotowania
offline oraz pojedynczą kolejkę fizycznego SDK. Test ma dowieść nakładania się
przygotowań przy `max SDK in flight = 1`, także podczas pause/resume i cleanup.

Obecne różne wartości parametru wykrywają pomylenie aktywnego dokumentu. Dodajemy
deterministyczny test, który celowo podmienia target/receipt scenariusza A na B:
A ma zostać odrzucony przed mutacją, a niezależny odczyt B ma potwierdzić brak
zmiany. Pokryć równe nazwy, zmianę aktywnego dokumentu między prepare/execute,
zamknięcie i reopen, oba transporty oraz właściciela cleanup.

## Etapy, zależności i odbiór

| Etap                             | Zakres                                                                                                                                                                                          | Zależności                                            | Dowód zakończenia                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — wykonywana dostawa           | Przenośne dowody historyczne; dokładne wyjątki baseline; strict inspection; regresje brokera; odtworzenie brakującego locale runtime z archiwum i testów przeglądarki; stabilny build definicji | Archiwum i aktualny GitHub                            | Wszystkie zadania CI zielone dla tego samego SHA, Node 22.13/24, Python, Playwright i oba transporty. Szczegóły w REFACTOR_STAGE_1.md; bez deklaracji native PASS                             |
| 2 — własność plików i broker     | Pełny cykl własnego zapisanego pliku, close/delete, recovery; test celowego obcego celu; duplicate names/failed activation; równoległe offline i pojedynczy SDK                                 | 1; testowy folder Fusion dla części native            | Fault injection na każdym kroku; cleanup po błędzie operacji/asercji; brak pozostawionych własnych plików po rozliczeniu; cudze dokumenty bez zmian; limity 1/2/10 i oba protokoły            |
| 3 — kontrakty backendów          | Rozszerzenie istniejącego modelu i wspólnych scenariuszy według tabeli historycznych asercji i nowszych testów                                                                                  | 2; przypięte definicje Autodesk                       | Te same kroki/wyniki w modelu i Fusion dla każdej deklarowanej capability; jawna lista niezweryfikowanych semantyk; regresje negatywne                                                        |
| 4 — reszta migracji runtime      | Pozostałe źródłowe JS usług, entrypointów i adapterów; reszta rodzin Python; wygaszenie fasad przejściowych; granice core/ports/adapters                                                        | 1, 2 i kontrakt danej rodziny z 3                     | Małe dostawy po rodzinie, strict typy bez obchodzenia admission, zgodność CLI/SDK/receipts, brak starej ścieżki w installed package; naprawy błędów już przeniesionego kodu z osobną regresją |
| 5 — live coverage i Beads        | Inwentarz wszystkich metod i testów; rejestracja nowszych suite; rozliczenie 69j/cb4/e4m oraz duplikatów                                                                                        | 2–4; może być opracowywany równolegle dokumentacyjnie | Każda metoda ma test efektu/readback i negatyw albo jawny brak; `all` uruchamia cały wymagany profil; task closed wymaga wskazanego SHA i dowodu                                              |
| 6 — Control Center i dystrybucja | Pozostałe System/global controls, rzeczywista telemetry/history, agenci/projekty, log retention, wycofanie demo/TUI, kompletność lokalizacji i assetów                                          | 1; stabilne kontrakty brokera z 2/4                   | Playwright na rzeczywistym składzie SQLite/broker, brak błędów konsoli i zasobów, instalacja spakowanego artefaktu, testy lokalizacji i dispose, pomiar kosztów runtime                       |
| 7 — kwalifikacja końcowa         | Zainstalowana paczka, obie ścieżki transportu, cały profil live, restart/utrata odpowiedzi, saved fixtures, natywna geometria/motion i panel                                                    | 2–6; dostęp do Fusion i własnych fixtures             | Raport SHA + wersje Fusion/API + wejścia/asercje + receipts + cleanup; każdy wymagany przypadek PASS, bez traktowania blocked/unsupported/NOTRUN jako sukcesu                                 |

Bezpieczna jednostka następnej iteracji to etap 2 ograniczony do lifecycle,
tożsamości i fault injection. Nie łączymy jej z migracją całej geometrii ani
wszystkich adapterów. Pierwszą dostawę wybrano dlatego, że niesprawdzony strict
inspection, historyczne commity nieobecne w świeżym checkout i niepełne testy
przeglądarki uniemożliwiały wiarygodną ocenę kolejnych zmian. Zabezpieczenia
ograniczają ryzyko fałszywie zielonego testu, utraty parity i ukrycia błędu brokera.

## Rozliczenie zakresu z archiwalnego Beads

Archiwum ma 150 zadań: 104 zamknięte i 46 pozostałych. Statusy są historyczne,
nie stanowią dowodu ukończenia. Otwarte `69j.2` i część prac UI są przykładem
koniecznej weryfikacji względem kodu. Nie przenosimy mechanicznie statusów.

- Etapy 2–5: `69j`, `69j.2`, `cb4`, `cb4.2`, `cb4.4`–`cb4.8`, `e4m`,
  `e4m.2`, `hex-integration`.
- Etap 6: `control-center`, `control-center.1`, `locale-catalogs`,
  `locale-selection`, `web-system-controls`, `web-agents-projects`, `web-bundle`,
  `web-operational-views`, `web-telemetry`, `browser-console`, `log-retention`.
- Etap 7 i jego prerequisites: `isc`, `dru`, `dru.2`, `dru.2.5`, `dru.2.6`,
  `native-drive-test`, `live-acceptance`, `hex-integration.2`.
- Osobny zakres funkcjonalny do rozliczenia po refaktorze, a istniejące części
  do ochrony w etapach 3–5: `brep-baselines`, `capture-integrity`,
  `selection-rules`, `semantic-model-state`, `attachment-check`, `channel-check`,
  `geometry-evidence`, `regional-contacts`, `adaptive-clearance`,
  `invariants-parameters`, `native-interfaces`, `native-route-check`,
  `qualified-recipes`, `rework-plan`, `verify-saved-model`. Nowe możliwości z tych
  zadań wymagają własnych etapów implementacji i kwalifikacji; nie są automatycznie
  ukończone przez zmianę języka lub przejście obecnego CI.

Wszystkie powyższe identyfikatory mają prefiks `fmcad-`. Podział zachowuje cały
nierozliczony backlog i oddziela dokończenie refaktoru od dodawania możliwości.

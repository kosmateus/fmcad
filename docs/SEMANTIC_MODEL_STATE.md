# Semantyczny stan modelu v2 — zakres i dowody

Moduły `runtime/python/fmcad/{domain,application,adapters/fusion}/semantic_model_state.py`
niezależne od implementacji transformacji `entity`/`datum`. Istniejące
`snapshot` i `diff` z `fmcad.measure.snapshot.v1` pozostają
niezmienionym, zgodnym kanałem obserwacji metadanych; nowy `snapshot.*_v2` nie
zmienia ich walidacji, handlera ani kolejności porównania. Nie powstaje nowy globalny
magazyn snapshotów: caller przekazuje obie obserwacje do funkcji diff.

## Audyt ramki

`frame.context_audit` przyjmuje `ref` ciała, `instance` jako tablicę segmentów
pełnej ścieżki occurrence (`[]` wyłącznie dla ciała root), `sourceId`,
`datumToRoot` (row-major, wektory kolumnowe) i `datumSource` z opisem źródła
oraz wersji obserwacji. Dla niezależnego audytu datum musi pochodzić np. z
analitycznego położenia fixture lub niezależnej obserwacji datum, **nie** z kopii
sprawdzanego `transform2`. Nie jest to automatyczne potwierdzenie poprawności
całego systemu datum ani dowód oparty na roundtrip inverse(transform).

Adapter oddzielnie odczytuje:

- `root.allOccurrences` → root-qualified proxy `transform2`, **bez** ponownego
  mnożenia transformacji rodziców;
- łańcuch `nativeObject.transform2` w lokalnych komponentach; brak nativeObject
  dla zagnieżdżonej proxy przerywa audyt zamiast zastępować ją root transform;
- maksymalnie 16 niezależnych par `native/proxy BRepVertex.geometry` w cm;
- tożsamość dokumentu źródłowego, jego wersję oraz lokalny light bulb i efektywną
  widoczność proxy. Widoczność jest obserwowana, a nie wyliczana z samych rodziców.

Niespójne datum/native/proxy/BRep oraz reflection/scale dają `fail`.
Brak wierzchołków daje `partial`, nie pozytywny dowód geometrii. `precision:
sampled` pozostaje dowodem próbkowanym nawet przy `status: pass`. Tolerancje
`lengthToleranceCm` i `matrixTolerance` rozdzielają przesunięcie od części
bezwymiarowej. Obserwacje nie dowodzą exact BRep equivalence.

## Snapshot i diff

`snapshot.capture_v2` przyjmuje `scope: {kind: "explicit-bindings", document:
{creationId, fileId, version}}` oraz `bindings: [{role, sourceId, ref, instance}]`.
Adapter weryfikuje dokument przed odczytem i tożsamość kontekstu przed i po nim.
`sourceId` jest jawną tożsamością definicji nadaną przez caller, nie nazwą/tokenem
arbitralnie wybranego occurrence. Caller odpowiada za zachowanie przypisania
roli i źródła między odczytami; zmiana przypisania jest zmianą tożsamości.

Snapshot deklaruje `schemaVersion: 2`, `status/coverage: partial`, `precision: observational`, `scope`,
`entities` i `exactBRepEquivalence: false`. Każdy wiersz zawiera:

| Pole | Znaczenie |
| --- | --- |
| `role`, `instance` | Semantyczny slot; pełna ścieżka instancji rozróżnia repeated instances |
| `source.id`, `source.document` | Jawne źródło, fileId/creationId/version; zmiana źródła lub wersji jest raportowana |
| `geometry` | Lokalne cm³, cm² i bounds cm; nie root AABB zależne od pozy |
| `pose` | Root-qualified transform2, bez double parents |
| `attributes` | Posortowane group/name/value atrybutów ciała |
| `topology` | Liczby faces/edges/vertices/shells; **nie** graf/topologiczna równoważność |
| `visibility` | Lokalny light bulb oraz efektywna widoczność proxy |
| `observedTokens` | Wyłącznie diagnostyka, nie klucz deduplikacji lub porównania |

`snapshot.diff_v2` indeksuje po `(role, instance)`; porządek wierszy API nie ma
znaczenia. Zmiana instancji to add/remove, zmiana źródła to kanał `source`.
Duplikaty slotów w obu wejściach są błędem, również przy różnych źródłach.
Brak kanału lub `null` daje `partial`, a usunięta rola/instancja daje `fail`.
Niezgodny scope daje `fail`. Dokumentów o różnych tożsamościach nie uznaje się
milcząco za ten sam model. V1 nie jest automatycznie promowane do v2.

`allowedMovedSubtrees` to tablice **niepustych segmentów ścieżki**, np.
`[["Assembly:1", "Motor:2"]]`, nie prefiksy tekstu ani wildcard root. Pozwalają
wyłącznie na zmiany `pose` tego occurrence i potomków. Nie pozwalają na zmianę
geometrii, źródła, roli, topologii, atrybutów ani widoczności. To allowlista
obszaru ruchu, nie sprawdzenie konkretnej żądanej delty ani wspólnego sztywnego
ruchu wszystkich potomków; dokładny ruch powinien mieć osobny invariant.

Domyślna tolerancja absolutna kanału wynosi `1e-7`; caller może przekazać
`tolerances: {geometry, pose, attributes, topology, visibility}`. Liczby są
skończone, tolerancje dodatnie; bool/missing nie są liczbami. Tolerancje stosują
się do liczb w ich jawnych jednostkach (geometry: cm/cm²/cm³, pose:
cm/bezwymiarowe). Wymagający caller powinien dobierać je do skali i nie używać
ogólnego diff jako testu konkretnej tolerancji produkcyjnej. Równe podsumowania
mogą ukryć zmiany geometrii/topologii — wynik nie twierdzi inaczej.
`coverage: partial` zapewnia także, że wspólny klasyfikator dowodów nie podniesie
pozytywnego porównania obserwacji do pełnego dowodu geometrii.

## Publiczne API i port artefaktów

`packages/core/src/application/semantic-model-state.ts` przyjmuje wstrzyknięty
Jawne DTO i typowane requesty są eksportowane z `@fmcad/core`.
`executeSemanticModelState` deleguje bezpośrednio do istniejącego
`executeCad`/`CadServices`: ten sam walidator, preparer niezmiennego
`PreparedPythonArtifact`, `CadExecutionPort`, parser terminalnego wyniku i
polityka braku replay dla unknown SDK outcome obsługują operację jako jeden
read-only SDK turn. Nie ma drugiego semantic artifact/execution portu.
Brak celu dokumentu odrzuca przed przygotowaniem. Błąd/unknown nie uruchamia
ponowienia. Parser wyniku, publikacja i kolejka nadal należą do canonical CAD
pipeline; ten moduł nie implementuje drugiego executora ani loadera Python.

Canonical `cadBundleManifest` dodaje trzy source units przez
`withSemanticModelState`; właścicielem trzech handlerów jest
`semantic-model-state`. CLI i MCP biorą schemat i walidację z jednego
`src/catalog/semantic-model-state.json` oraz specjalistycznego walidatora.
`FMCAD.frame_context_audit`, `FMCAD.snapshot_capture_v2` i
`FMCAD.snapshot_diff_v2` wołają te same read-only operacje. Katalog generuje
z nich typed CLI/MCP kontrakty i help; standardowy `executeCad` przygotowuje
niezmienny artefakt i używa wspólnego `CadExecutionPort`. Te integracje nie
dodają własnego schedulera, brokera, źródłowego loadera ani trwałego store.

## Weryfikacja offline

```sh
python3 -B tests/semantic_model_state_test.py
npm run build:code
node --test tests/semantic-model-state.test.js
node --test tests/semantic-model-state-e2e.test.js
```

Fixture obejmuje trzy poziomy, repeated instances, root i root-qualified proxy,
reorder/token drift, reflection/scale, brak roli, duplikaty, source version,
wszystkie kanały zmian oraz niedozwolony ruch innego poddrzewa. Fake Fusion
adapter odczytuje oddzielne macierze native/proxy i punkty BRep, nie tę samą
funkcję transformacji pod dwiema nazwami. Nadal jest to **wyłącznie offline**.

## Kwalifikacja native — autoryzowana, ale jeszcze niewykonana

Użytkownik udzielił stałej zgody na native Fusion i równoległych operatorów
przez wspólny broker. Mimo zgody sam skrypt
`tests/native/semantic-model-state/qualify.py` wymaga jawnego
`confirmNativeQualification: true`. Uruchamiać go jako skrypt `fmcad run` z
`--helpers cad-v1`, `--doc`, aktualnym `--doc-id` i `--doc-file-id`; podać
jednorazowe `runId`, `fixturePrefix`, `documentName`, `expectedFusionBuild`,
`capabilityProbeRequestId`/`capabilityProbeJobId` oraz dokładne
`projectId/folderId/fileId/creationId/version` w `ARGS`. Każdy request trafia
do wspólnego fmcad queue; nie używać fizycznego SDK, bezpośredniego transportu,
top-level `fmcad_execute` ani starej aktywnej dokumentacji. Pierwszy odczyt
sprawdza pinned saved scratch, kompletny, zapisywalny i pusty; `app.version`
musi odpowiadać świeżemu, przypiętemu broker capability-probe receipt.

```sh
fmcad run /ABSOLUTE/PATH/tests/native/semantic-model-state/qualify.py \
  --helpers cad-v1 --doc '<exact scratch name v1>' \
  --doc-id '<creationId>' --doc-file-id '<fileId>' \
  --args '{"confirmNativeQualification":true,"runId":"<unique-run-id>","fixturePrefix":"<8-20-UPPERCASE-CHARS>","documentName":"<exact scratch name v1>","documentFileName":"<scratch file name>","expectedFusionBuild":"<fresh app.version>","capabilityProbeRequestId":"<probe-requestId>","capabilityProbeJobId":"<probe-jobId>","capabilityProbeStatus":"partial","capabilityProbeIdentity":"verified","capabilityProbeBuild":"<fresh app.version>","projectId":"<projectId>","folderId":"<folderId>","fileId":"<fileId>","creationId":"<creationId>","version":1}'
```

Skrypt tworzy wyłącznie własne A → B → C z obróconym rodzicem, powtórzenie C
w root i ciało root. Niezależne `datumToRoot` wylicza z wejściowych placementów,
a audyt osobno odczytuje lokalny łańcuch native, root-qualified proxy
`transform2` (bez podwójnego mnożenia rodziców), pary punktów native/proxy BRep,
wersję dokumentu, light bulb i widoczność proxy. Dodatkowe sprawdzenia obejmują
reorder, zmianę rzeczywistej instancji, allowlistę i odmowę nieautoryzowanego
poddrzewa, visibility hide/restore, duplikat, brak roli, drift wersji źródła
oraz błędne reflection/scale. Drift źródła jest testowany przez podniesienie
wersji na kopii snapshotu **z realnego odczytu**; nie zapisuje dodatkowej
wersji cloud. Reflection/scale to wadliwe wejścia audytu — skrypt nie próbuje
umieszczać takiej macierzy jako occurrence w Fusion.

Przed mutacją `document.clear` w trybie dry-run potwierdza, że cały dokładnie
przypięty scratch jest pusty. Po przejściu testów skrypt sprawdza i niezależnie
odczytuje przywrócenie pozy oraz visibility, po czym weryfikuje ten sam pinned
file/version i zamyka **wyłącznie własny** dokument przez `close(False)`.
Niezapisana geometria fixture zostaje odrzucona do zapisanej, pustej wersji
bazowej. Nie próbuje reaktywować wcześniejszego `activeDocument`. Po SDK turnie
należy wykonać świeży brokerowy `doc list` i potwierdzić brak własnego
creationId. Błąd testów pozostawia własny fixture otwarty do inspekcji; nie
ponawiać ani nie zamykać go po unknown wyniku bez świeżego odczytu i uzgodnionej
procedury odzyskania. Testy offline ani sam status `succeeded` nie stanowią
native PASS. Kwalifikacja 2706.1.14 nadal jest niewykonana.

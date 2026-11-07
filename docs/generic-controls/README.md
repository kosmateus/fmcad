# Syntetyczne fixture i pomiar generycznych kontroli

Zestaw zawiera offline'owe dane kontrolne oraz osobny generator okazów w Fusion.
Jest przeznaczony do powtarzalnych testów generycznych kontroli geometrii; nie
kopiuje produktów ani modeli użytkownika.

## Fixture offline

Pliki `tests/fixtures/generic-controls/*.json` definiują pięć rodzin:

| Rodzina            | Przypadek poprawny                                   | Przypadki wadliwe                   | Sprawdzane warunki                                       |
| ------------------ | ---------------------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| Obudowa            | grubość ścianki 2 mm, ciągły świadek szwu            | ścianka 0,8 mm; przerwa szwu        | minimum 1,5 mm i połączenie szwu                         |
| Wał i gniazdo      | średnica wału 10 mm, otwór 10,2 mm, zazębienie 12 mm | wcisk; zazębienie 8 mm              | luz średnicowy 0,1–0,3 mm i minimum 10 mm zazębienia     |
| Kanał rozgałęziony | wszystkie trzy gałęzie połączone i z prześwitem      | odłączona gałąź; prześwit 0,9 mm    | każda gałąź osobno, minimum 1,5 mm                       |
| Szkic łukowy       | środek `[0, 0]` i promień 10 mm                      | przesunięty środek; promień 10,1 mm | tolerancja środka 0,05 mm i promienia 0,02 mm            |
| Para kół           | moduł 1 mm, 20/40 zębów, rozstaw 30 mm               | rozstaw 31 mm; różne moduły         | zgodność modułu i nominalny rozstaw z tolerancją 0,05 mm |

Każdy przypadek ma oddzielne `identity`, jawny wariant `good`/`bad` oraz
oczekiwany status i listę identyfikatorów niezaliczonych kontroli. Harness
wylicza kontrole ponownie z pomiarów i porównuje je z tymi oczekiwaniami; status
nie jest tylko odczytywany z pola `expected`.

Zestaw uzupełnia istniejące `tests/fixtures/recipe-reduction` zamiast je
przepisywać. Generator natywny zachowuje wzorzec przypiętej tożsamości scratch
z `tests/native/iw7.4_*`. Nie uruchamia ciężkich produktów ani nie zmienia
istniejących testów.

Uruchomienie testu i pomiaru offline:

```sh
node --test tests/generic-controls.test.js
node --experimental-strip-types tests/generic-controls/harness.ts --iterations 100
python3 -B -m unittest discover -s tests -p 'generic_controls_native_generator_test.py'
```

Testy Node sprawdzają identity, warianty i równoważność wyników. Testy Pythona
wykonują generator wyłącznie wobec lokalnego fake adaptera, aby sprawdzić
odmowę bez zgody, weryfikację tożsamości oraz selektywne usuwanie. Nie importują
Fusion SDK ani nie dowodzą poprawności geometrii natywnej.

Harness jest własnym modułem TypeScript z `strict` i uruchamia się przez
obsługiwane w toolchainie Node type stripping. Wymaga Node z wersji wspieranych
przez root `fmcad`; nie jest loaderem Fusion.

## Metoda i wynik pomiaru offline

Harness sprawdza te same ścieżki odczytu i tę samą funkcję kontroli w dwóch
wariantach: pojedyncze odczyty (`individual`) oraz jeden batch (`bundled`). Fake
adapter naprawdę liczy wywołania i bajty JSON żądań; przed porównaniem wyniki
muszą być identyczne oraz przejść oczekiwany status. Mierzone są też bajty
rezultatu, UTF-8 bajty krótkich przykładowych callerów Python, glue LOC, czas
pierwszego wywołania (odczyt JSON fixture + inicjalizacja adaptera) oraz czasy
ciepłe: mediana i p95 z przeplatanym porządkiem pomiarów.

Poniższy zrzut to rzeczywisty pomiar offline z 2026-10-24, Node `v24.15.0`, 100
ciepłych iteracji dla każdego z 15 przypadków:

| Rodzina            | Przypadki | Fake RPC: osobne → batch | Bajty żądań: osobne → batch |
| ------------------ | --------: | -----------------------: | --------------------------: |
| Obudowa            |         3 |                    6 → 3 |                   312 → 216 |
| Wał i gniazdo      |         3 |                    9 → 3 |                   483 → 282 |
| Kanał rozgałęziony |         3 |                   18 → 3 |                  1185 → 669 |
| Szkic łukowy       |         3 |                    6 → 3 |                   276 → 180 |
| Para kół           |         3 |                   15 → 3 |                   768 → 357 |
| **Razem**          |    **15** |              **54 → 15** |             **3024 → 1704** |

W tym fake'u batch miał 39 mniej logicznych odczytów (72,2%) i 1320 mniej bajtów
żądań (43,7%). Przykładowy caller miał 224 → 162 bajty Python oraz 5 → 3
niepuste linie. Zsumowane rezultaty wszystkich przypadków zajęły 10 745 bajtów
i były identyczne w obu wariantach. Po przejściu harnessu na TypeScript pierwsze
wywołanie (odczyt JSON fixture + inicjalizacja fake'a) zmierzyło się w zakresie
0,01442–0,395474 ms dla odczytów osobnych i 0,008351–0,178981 ms dla batch.
Czasy ciepłe w tej próbie: mediana per przypadek od 0,00098 do 0,00581 ms dla
odczytów osobnych oraz od 0,00108 do 0,00992 ms dla batch; p95 per przypadek
odpowiednio 0,00106–0,0122 ms i 0,00115–0,02335 ms. Łączny pomiar zajął
21,115 ms, przy limicie 30 000 ms.

Są to pomiary samego lokalnego fake'a i krótkich przykładów kodu, a nie czasu
Fusion, sieci, rzeczywistych RPC, kodu wygenerowanego przez fmcad ani dowodu
oszczędności w produkcyjnym workflow. Batch zmniejszył liczbę logicznych
wywołań w tym scenariuszu, ale nie wykazał korzyści czasowej; p95 batch bywał
wyższy. `fakeRpcCount` nie jest licznikiem brokera. Warianty payloadów Python
to mierzone przykłady glue, nie uruchamiane skrypty Fusion. Harness jawnie
oznacza raport `offline-fake-only` i sprawdza limity: do 1 wywołania batch,
1024 bajtów Python, 4096 bajtów wyniku, 2000 ms pierwszego wywołania i 250 ms
ciepłego p95 na przypadek.

## Generator Fusion — wymaga osobnej zgody

`tests/native/generic-controls/generate.py` jest oddzielony od offline fake'a.
Obecnie **nie był uruchamiany**. Jego raport po utworzeniu artefaktów oznacza
`nativeModelQualification: not performed`; sam generator nie sprawdza wyników
kontroli ani poprawności B-Rep.

Po osobnej zgodzie na odbiór native należy użyć wyłącznie przeznaczonego,
zapisanego i pustego scratch dokumentu `FmcadGenericControlsScratch`:

- przekazać dokładne `projectId`, `folderId`, `fileId`, `creationId` i `version`
  odczytane z `document.status`;
- ustawić unikatowe `fixturePrefix` (8–20 wielkich liter/cyfr),
  `mode: "generate"` oraz `confirmNativeFixtureGeneration: true`;
- utrzymać jawne wskazanie tego samego dokumentu w `fmcad run`; nie uruchamiać
  na dokumencie użytkownika ani na kopii projektu dostawcy.

Generator wymaga zgodności nazwy i całej przypiętej tożsamości dokumentu oraz
pustych root bodies/occurrences przed pierwszą mutacją. Tworzy własne komponenty
z prefiksem `FMCAD_GC_<fixturePrefix>_`, nie zapisuje ani nie zamyka dokumentu i
nie wykonuje automatycznego rollbacku. Po sukcesie zwraca dokładny
`ownedOccurrences` ledger. Ewentualne sprzątanie to osobny, potwierdzany tryb:
przekaż ten ledger, tę samą tożsamość/wersję/prefix, `mode: "cleanup"` i
`confirmOwnedFixtureCleanup: true`. Usuwane są tylko dokładne lokalne occurrence
z tokenami i nazwami z ledgeru; skrypt odmawia obcych/refektywnych elementów.
Po błędzie częściowym trzeba najpierw sprawdzić stan i ledger — skrypt nie
ponawia operacji ani nie kasuje szerokim prefiksem.

Generator używa publicznych poleceń modelu Fusion do zbudowania syntetycznych
świadków obudowy, wału/gniazda, rozgałęzionych ścieżek, łuków i kół. Nie
tworzy osobnych projektów, nie kopiuje modeli użytkownika, nie zapisuje zmian i
nie jest równoznaczny z końcowym odbiorem natywnych kontroli. Taki odbiór,
odczyty geometrii i ewentualne przywrócenie scratch wymagają odrębnej zgody i
osobnej weryfikacji fizycznej.

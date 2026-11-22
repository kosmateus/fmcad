# Odblokowanie pracy z konkretnym dokumentem Fusion

Ta procedura pozwala uprawnionemu agentowi wznowić pracę, gdy broker wymaga sprawdzenia stanu dokumentu. Agent nie przejmuje tokenu poprzedniego właściciela i nie ponawia niepewnej operacji CAD.

> **Status dostępności:** front MCP/CLI jest w trakcie integracji z brokerem. Przykłady sprawdzono względem dekodera i definicji pomocy CLI z aktualnego kandydata frontu, ale nie potwierdzono jeszcze zintegrowanego buildu ani zachowania live. Funkcja nie jest gotowa do użycia produkcyjnego.

## Szybki start

1. **Ustal dokładny cel.** Użyj `docId` albo `docFileId` uzyskanego z wiarygodnego źródła. Możesz podać oba, jeśli znasz oba. Nie wybieraj dokumentu po nazwie lub aktywnej karcie. Dla zamkniętego, zapisanego pliku użyj dokładnego `docFileId`.
2. **Sprawdź stan brokera.** `status` jest odczytem brokera i nie wykonuje operacji SDK. Podaj nowy `requestId`, jeśli chcesz powiązać odczyt z własną próbą.
3. **Wykonaj dokładnie następne wskazane działanie.** Gdy odpowiedź wskazuje `inspect`, wykonaj świeży odczyt przez `inspect` z nowym `requestId`. Odczyt wymaga uprawnienia do czytania dokładnie wskazanego dokumentu.
4. **Zaakceptuj tylko bieżącą obserwację.** Jeśli wynik `inspect` zwraca `observationId` i wskazuje `accept`, przekaż tę wartość z nowym `requestId`. Akceptacja wymaga aktualnego uprawnienia modelowania do tego samego celu. Jest osobnym checkpointem; sama nie uruchamia modelowania.
5. **Dopiero po odpowiedzi pozwalającej kontynuować** rozpocznij nową pracę, kierując ją do dokładnego dokumentu. Jeśli cel, generacja lub checkpoint się zmieniły, wróć do `status` i ponownie wykonaj wymagane kroki. Nie używaj starej obserwacji jako uprawnienia.

Każde żądanie MCP ma postać:

```json
{
  "action": "status",
  "target": { "docFileId": "FILE_ID" }
}
```

Narzędzie MCP: `fmcad_document_unlock`. Dla `inspect`:

```json
{
  "action": "inspect",
  "target": { "docFileId": "FILE_ID" },
  "requestId": "inspect-unique-id"
}
```

Dla `accept` użyj identyfikatora obserwacji zwróconego przez świeże `inspect`:

```json
{
  "action": "accept",
  "target": { "docFileId": "FILE_ID" },
  "requestId": "accept-unique-id",
  "observationId": "OBSERVATION_ID_FROM_INSPECT"
}
```

Identyfikatory w przykładach są zastępcze. `status` dopuszcza opcjonalny `requestId`; `inspect` wymaga `requestId`; `accept` wymaga obu identyfikatorów. Każdy identyfikator to niepusty tekst o długości do 256 znaków. Żądanie przyjmuje wyłącznie pokazane pola.

Odpowiedniki CLI:

```sh
fmcad queue document-unlock --action status --doc-file-id FILE_ID
fmcad queue document-unlock --action inspect --doc-file-id FILE_ID --request-id inspect-unique-id
fmcad queue document-unlock --action accept --doc-file-id FILE_ID --request-id accept-unique-id --observation-id OBSERVATION_ID_FROM_INSPECT
```

Możesz zamiast `--doc-file-id` wskazać `--doc-id`. CLI dopuszcza też normalne opcje klienta i konfiguracji; nie dodawaj parametrów uprzywilejowanych. Definicję pomocy CLI sprawdzono w kandydacie frontu. Uruchomienie zintegrowanego polecenia pomocy pozostaje **NOTRUN**, bo gotowy artefakt CLI nie jest dostępny.

## Co zrobić po odpowiedzi

Kieruj się polem `next` zwróconym przez brokera; nie odtwarzaj go na podstawie starej rozmowy ani historii innego właściciela. Poniższa tabela opisuje bezpieczny następny krok, nie gwarantuje, że dana odpowiedź wystąpi w każdym backendzie.

| Odpowiedź / kod | Następne działanie |
| --- | --- |
| `DOCUMENT_UNLOCK_REQUIRED` | Wykonaj `status` dla dokładnego celu; postępuj według aktualnego `next`. |
| `SDK_TURN_ACTIVE` | Poczekaj na zakończenie aktywnej tury i ponownie sprawdź `status`. Nie przerywaj jej ani nie ponawiaj mutacji. |
| `SDK_QUIESCENCE_UNPROVEN` | Nie akceptuj stanu. Wymagana jest wiarygodna granica bezczynności SDK; ponownie sprawdź stan po jej potwierdzeniu. |
| `DOCUMENT_STATE_CHANGED` | Stara obserwacja nie opisuje już bieżącego dokumentu. Wykonaj nowy `status`, a potem wymagane świeże `inspect`. |
| `CHECKPOINT_CHANGED` | Nie używaj poprzedniego checkpointu. Sprawdź stan i uzyskaj nową obserwację, jeśli broker nadal wymaga inspekcji. |
| `TARGET_UNAVAILABLE` | Zweryfikuj dokładny identyfikator. Dla istniejącego, zamkniętego pliku wskaż jego `docFileId` i rozpocznij od nowego `status`/`inspect` po bezpiecznym wznowieniu dostępu. |
| `UNKNOWN_SCOPE_UNPROVEN` | Nie rozszerzaj uprawnień ani zakresu. Wymagana jest potwierdzona granica dla wskazanego zasobu; sam `--doc A` nie dowodzi, że nieznana praca dotyczy tylko A. |
| `NOT_AUTHORIZED` | Uzyskaj właściwy grant od uprawnionego właściciela dla tego samego celu i wymaganej czynności. Rejestracja klienta nie nadaje uprawnień. |
| `STORAGE_UNAVAILABLE` | Wstrzymaj procedurę i zgłoś problem trwałego zapisu operatorowi brokera. Nie ponawiaj `accept` w ciemno. |

## Granice bezpieczeństwa i przypadki szczególne

- **Brak tokenu poprzednika:** nowy agent używa własnej rejestracji i własnych świeżych identyfikatorów żądań. Nie odzyskuje prywatnego wyniku poprzedniego właściciela dla zablokowanej pracy.
- **Granty:** prawo do odczytu i prawo do zaakceptowania checkpointu to różne uprawnienia. Grant do dokumentu B ani grant do stałej, ograniczonej próby nie upoważnia do dokumentu A. Samo zarejestrowanie klienta nie jest grantem modelowania.
- **Wynik `UNKNOWN`:** traktuj go jako nierozstrzygnięty. `accept` zapisuje osobny, zweryfikowany checkpoint; nie zmienia historycznego wyniku `UNKNOWN`, nie dowodzi rollbacku i nie zezwala na ponowne wysłanie pierwotnej operacji.
- **Niezapisany dokument, który już nie istnieje:** nie da się odzyskać jego geometrii tą procedurą. Nie zastępuj go dokumentem znalezionym po nazwie ani aktywną kartą.
- **Dokument B podczas niepewności dla A:** praca na B może być niezależna po jej własnej, dokładnej weryfikacji i grancie. Niepewna praca globalna wymaga jednak bariery hosta i ograniczonego checkpointu dla zasobu; samo wskazanie A nie zawęża jej automatycznie.
- **Restart/generacja brokera:** po zmianie generacji wykonaj nowy odczyt i, jeśli wymagane, nową akceptację. Nie przenoś obserwacji ani uprawnień z poprzedniej generacji.
- **Rebaseline runtime:** jest osobną, administracyjną procedurą kolejki. Nie jest grantem modelowania ani publicznym sposobem odblokowania dokumentu. Nie czyści historii, nie rozstrzyga niepewnego wyniku i nie zastępuje checkpointu.

## Weryfikacja kontraktu

Wspólny decoder z aktualnego kandydata frontu zaakceptował trzy przykładowe żądania i odrzucił cztery nieprawidłowe lub uprzywilejowane warianty. Sprawdzono też definicję pomocy CLI w źródle; wygenerowany artefakt `dist/entrypoints/queue-cli.js` nie jest dostępny, więc wykonanie polecenia pomocy jest **NOTRUN**. Po integracji powtórz kontrole względem zintegrowanego buildu i odpowiedzi rzeczywistego brokera. Nie traktuj tej walidacji jako dowodu działania live.

# Pomiar i kontrole geometryczne — typy runtime

Rodzina `measure`, `containment`, `interference`, `checking` i `dfm` używa
wspólnych aliasów `JsonValue`/`JsonObject` oraz istniejącego `CadContext`.
Warstwa domenowa opisuje czyste operacje DTO, aplikacja `checking` przyjmuje
jawne callbacki, a adaptery Fusion deklarują kontekst, kształty odpowiedzi,
opcjonalne wyniki SDK i konkretne geometrie B-Rep. Adaptery korzystają z
publicznych delegatów `scope`, `entities`, `proxy` i `expression` tam, gdzie są
właściwe; nie wprowadzają drugiego kontekstu ani solvera.

Wiązania z niezweryfikowanym payloadem pozostają w typach JSON do walidacji lub
wąskiego `cast` na granicy istniejącego kontraktu. Sygnatury SDK pochodzą z
przygotowanych definicji Autodesk, a testy `python_measurement_runtime_test.py`
uruchamiają kanoniczne źródła z lokalnymi fake SDK. Testy nie wykonują Fusion i
nie zastępują walidacji kernelowej.

## Regresje lokalne

```sh
python3 -B -m unittest discover -s tests -p 'python_measurement_runtime_test.py'
python3 -B -m unittest discover -s tests -p '*_test.py'
```

Pełny strict replay rodziny należy wykonywać na przygotowanym bundle i
niezmienionym checkerze basedpyright `1.40.2`, z Linux/Python `3.11`, wszystkimi
jednostkami źródłowymi oraz zweryfikowanymi definicjami SDK. Diagnostyki innych
rodzin i wspólnych jednostek są osobnym blockerem; nie należy ich maskować przez
zmianę limitów ani wyłączenie reguł.

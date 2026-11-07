# Report unavailable body measurements

The historical `a26222f` inspection handler catches physical-property errors and
prints `volume=0.00 mm3` followed by `DONE`. Paired tests reproduce this inherited
false measurement with the frozen source and compare the current adapter on the
same SDK failure. It is not attributed to the refactor.

The current handler raises an error identifying the body and preserves the original
exception as its cause. Nonfinite or negative volume values also fail. A real zero
remains a valid result; positive values retain the historical cm3-to-mm3 conversion
and output format. The handler reads each measurement once and does not replay it.
Rows printed before a later failure are partial output; the failed command emits
no `DONE`. This is the intended contract because an unavailable measurement cannot
establish zero material volume.

The manual describes the new failure contract. The AST parity exception records
both exact hashes and this justification; the old source remains unchanged.
Verification includes paired failure/valid-value tests, the existing eight historical
inspection cases, real production admission, source parity and full CI. A native
physical-property failure still needs final Fusion qualification; no mock result
is represented as native evidence.

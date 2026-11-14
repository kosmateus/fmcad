# Third-party notices

The bundled Autodesk Fusion API editor definitions are pinned and verified by
`dist/runtime/python/typing/current.json` and the referenced snapshot
`manifest.json`. That snapshot includes the upstream `LICENSE`, `README`, and
`NOTICES.md`, together with the exact source commit and per-file hashes. The
only local annotation change is recorded in its notice. These are editor/type
definitions, not Autodesk SDK implementations.

The project owner authorized distribution with the documented licensing
uncertainty accepted. This notice does not claim an Autodesk grant, legal
clearance, or Autodesk sponsorship/endorsement. The root MIT license applies
to fmcad-authored material only; it does not relicense bundled third-party
material. The referenced snapshot manifest is the source of truth for its
provenance and hashes.

## Help text layout

The typed help formatter adapts Unicode width rules and measured emoji ranges
from String Kit 0.19.5 by Cédric Ronvel, copyright 2014–2021, under the MIT
license reproduced in `src/composition/library-help-format.ts` and emitted code.
The runtime does not require the terminal renderer.

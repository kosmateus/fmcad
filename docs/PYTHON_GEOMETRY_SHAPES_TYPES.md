# Python `geometry_shapes` strict typing

The shape adapter uses the shared `CadContext`, `JsonObject`, and `JsonValue`
contracts. Casts are limited to values checked by the existing recipe
validation, JSON results returned by known CAD handlers, and SDK entities
resolved through typed entity kinds. The adapter continues to use the shared
expression resolver and existing Fusion context; it introduces no parallel
context or family DTO.

## Verification

Run `npm ci --ignore-scripts`, `npm run build`, then:

```sh
node tests/typesgeometry/geometry_typecheck_report.cjs /tmp/opencode/types-geometry-shapes-final.json
npm run test:python
```

The final strict replay used basedpyright 1.40.2, Python 3.11/Linux, strict
mode, `reportAny`, `reportExplicitAny`, missing imports/source/stubs as errors,
`cadBundleUnits(root, 'full')`, and the prepared Autodesk SDK definitions. The
verified definitions snapshot was
`83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`; the full
bundle contained 121 units (1,627,962 bytes; artifact hash
`dd35febc00004cc0d388e93310252cb3eaba4256212142445ddbf2d22f382499`).

There were **zero strict source diagnostics** in
`runtime/python/fmcad/adapters/fusion/geometry_shapes.py`. The complete bundle
still reports 26,953 diagnostics in other source units, so this result is not
an admission pass. No checker limits or source units were changed.

The complete Python/fake-SDK suite passed **1,287 tests**, with **105 live tests
skipped**. Focused shape recipe, GM10 recipe, source-preservation, and new type
contract tests were included. No live Fusion or physical geometry validation
was performed.

## Narrow behavior correction

Making `_shapes_cap_face`'s nullable comparison explicit exposed an operator
precedence error in the old minimum-selection branch: with `maximum=False`, the
first comparison used `None`. The explicit max/min condition now selects the
same intended extreme for both opening directions; the focused fake-face test
covers each direction. Other shape construction order, validation, DTOs, and
feature operations remain unchanged.

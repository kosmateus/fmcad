# Geometry runtime extraction

The retained `model`, `sketch`, `sketch_plan`, `curve`, `datum`, `surface`,
`shapes` and `feature` implementations now live in
`runtime/python/fmcad`. There is no second copy of the handler algorithms in
`assets/cad`.

## Boundaries

- `domain/geometry_*.py`: JSON/numeric field validation, vector checks, numeric
  curve distances/G2 deviation, names and recognition/capability tables.
  Every module imports independently without `adsk`, a CAD context
  or a registry. Existing error types, tolerances and unsupported fields remain.
- `application/geometry_*.py`: handler ownership/registration, legacy feature
  dispatch, model mode routing, recipe routing and shape use-case orchestration.
  Dimensional expressions pass through the retained context port; these modules
  do not implement UnitsManager or dereference native geometry.
- `adapters/fusion/geometry_*.py`: the actual native implementation, entity/proxy
  resolution, occurrence/native scope, evaluators, feature inputs, readbacks and
  dimensional-expression evaluation through the existing context adapter. BRep,
  Sketch, ModelParameter and SDK enums never enter the domain layer. The existing
  inverse-curvature parser remains in the surface adapter (it is not a new or
  general replacement for UnitsManager).

The migration preserves cad-v1's shared execution namespace. This is not a new
Python package loader, executor, scheduler or SDK transaction facility. Adapter
functions are still assembled into the same prepared immutable artifact. Common
helpers come from the artifact baseline `23cc436`; this family does not replace
`assets/cad/core.py` or `helpers.py`.

## Manifest and compatibility

`packages/node-adapters/src/python/geometry-manifest.ts` provides the isolated
`withGeometryModules` integration hook. It expands each family's original
manifest entry into explicit **domain → Fusion adapter → application → asset**
units, preserving the entry's existing dependencies and ID. Registration owners
remain the original family names, including sketch's checked pop/replace and the
manifest-authorized `model.thread` / `shape.helix` transfers. Source units retain
their own paths for hashing, diagnostics and source mapping.

The canonical `bundle.ts` applies this hook exactly once after composing the
assembly manifest. The default production bundle therefore includes the actual
geometry units, without a test preload or a separate production execution path.
The overlapping `thread` family remains owned solely by the previously integrated
assembly implementation (`domain/thread.py` and `adapters/fusion/thread.py`);
geometry contributes no duplicate thread module or registration. All eleven
assembly families and their 71 registrations are retained.

The asset files are compatibility facades for old offline fixtures that directly
`exec` an asset. They locate the runtime checkout from `_FMCAD_GEOMETRY_ROOT`,
`__file__` or the current checkout directory, and execute those same source files
in the fixture namespace. They contain no handler bodies. Prepared bundles load
all explicit units before reaching the facade, so the facade does **no filesystem
access** in Fusion. A dedicated test denies filesystem access while importing the
entire prepared bundle. The compatibility loading path is not a Fusion transport.

## Verification

```sh
npm run build:code
node --test tests/python-geometry.test.js
python3 -B tests/python_geometry_test.py
python3 -B -m unittest discover -s tests -p '*_test.py'
```

`tests/fixtures/python-geometry/baseline.json` records AST statement hashes and a
normalized SDK-double transcript captured from commit `23cc436`. Tests compare
every original executable statement across the extracted layers, exactly once;
the added ownership and initialization markers are the only excluded statements.
The transcript checks result DTOs and ordered SDK effects for extrusion/sweep,
preflight rejection, unsupported helix, a retained partial-effect failure and
document identity drift. Opaque fake handles are normalized, not advertised as
serializable native references. Existing family fixtures additionally cover
native/occurrence scope, parameter identity, marker restoration, work budgets and
unsupported modes.

These are offline preservation checks only. They do not establish live Fusion
acceptance, physical manufacturability, kernel success or native rollback. No
new capability, automatic retry, geometry repair or sampled helix was introduced.

# Python geometry type migration

The geometry runtime families use the shared `CadContext`, `JsonObject`,
`JsonValue`, and `CadHandler` contracts. Fusion adapters declare their context
and JSON input parameters, while domain helpers remain SDK-free. The output
typing is being tightened against the actual prepared bundle and the published
Autodesk definitions; this is not a claim that the full bundle currently passes
strict checking.

## Verification contract

Use the built, staged repository artifacts and the pinned basedpyright 1.40.2
with Python 3.11/Linux, strict mode, `reportAny`, `reportExplicitAny`, missing
imports, missing module source, and missing stubs as errors. The diagnostic
replay must use `cadBundleUnits(root, 'full')`, `preparePythonArtifact`, and the
SDK snapshot identified by `dist/runtime/python/typing/current.json`. Do not
replace that replay with isolated synthetic family units or loosen checker
limits/configuration. The repository checker remains bounded to 2,000
diagnostics and 2 MiB output; a larger direct engine replay is diagnostic data,
not a successful admission report.

The AST regression normalizes function annotations and the type-only boundary
casts. The fake-SDK transcript still compares the established result, effect
order, invalid-input behavior, partial-failure behavior, and document-drift
behavior against its committed baseline. It does not establish live Fusion or
physical geometry correctness.

## Current checkpoint

After `npm run build`, the direct strict replay on 2026-10-25 used basedpyright
1.40.2, the full prepared 121-unit artifact (1,592,417 bytes), and verified SDK
snapshot `83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`.
The prepared artifact hash was
`1b9c76aee57240ebe832f3cb86e7f5181d2ae077cc21e9d704bd2fa29e43dc8a`. The engine
analyzed the full concatenated wire and reported **28,848 errors overall**, of
which **4,872 map to geometry sources**:

| Family | Remaining diagnostics |
| --- | ---: |
| feature | 1,355 |
| shapes | 925 |
| model | 604 |
| sketch | 428 |
| sketch plan | 473 |
| curve | 318 |
| datum | 388 |
| surface | 381 |
| **Geometry total** | **4,872** |

These are not a passing admission report. The regular bounded checker returns
`tool_error: output limit exceeded` on the full bundle; production checker
limits were not changed. Most remaining geometry diagnostics are still in the
family's Fusion adapters and require local signature, nested JSON narrowing, and
SDK-readback typing. One exact cross-family blocker is
`geometry_feature.py:18`: the handler returned by the untyped assembly helper
`_assembly_handler` in `runtime/python/fmcad/adapters/fusion/assembly.py:904`
has unknown return type. That dependency should be resolved with the assembly
owner rather than hidden by a cast here.

Run the focused and full Python suites after staging with:

```sh
node tests/typesgeometry/geometry_typecheck_report.cjs /tmp/opencode/geometry-types.json
python3 -B -m unittest tests.typesgeometry.python_types_geometry_test
npm run test:python
```

## Datum/surface follow-up

On the working tree based on the shared type checkpoint `903248f`, the full
prepared-bundle replay used basedpyright `1.40.2`, Python `3.11`/Linux, 121
units (1,632,612 bytes), and the verified Autodesk snapshot
`83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`. The
prepared artifact hash was
`8b5b2c95ab89e7641f48119637731cb02d0dbab0f9d9bae9966212261faa4ae5`.
`geometry_datum.py` and `geometry_surface.py` have **zero local strict
diagnostics**. The whole bundle still has **27,208 errors** and is not an
admission pass.

**Verification:** `npm run test:python` passed **1,285 tests** with **105 live
tests skipped**. The focused datum/surface Node suites passed **11 tests**;
eight document-dependent GM08 integration cases were skipped because
`FMCAD_TEST_DOC` was not set. No live Fusion acceptance is claimed.

The remaining relevant cross-family unknown is outside these files:
`runtime/python/fmcad/application/geometry_feature.py:18` calls
`_assembly_handler(_assembly_history, mode)(ctx, payload)`; the factory and
returned handler in `runtime/python/fmcad/adapters/fusion/assembly.py:904-910`
remain untyped. This was reported to the assembly owner and was not patched in
the datum/surface worktree.

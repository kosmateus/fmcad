# Strict Python types: sketch geometry

This page documents the strict typing boundary for the sketch, sketch-dimension
plan, and curve adapters. The implementation remains in the canonical runtime
modules; no parallel runtime or Autodesk stub overlay was added.

## Typing boundaries

- Public handlers accept the shared `CadContext` and `JsonObject` contracts.
  Nested request arrays and objects are narrowed only after the existing shape
  checks, and handler results remain `JsonValue` or `JsonObject`.
- Sketch resolution uses the shared context's typed `sketch` resolver. Geometry
  selection continues through `_model_entities`; adapter operations narrow those
  SDK entities to the concrete `Sketch`, `SketchEntity`, `SketchPoint`,
  `SketchLine`, `SketchEllipse`, and `SketchDimension` types they actually use.
- Curve evaluation uses the Autodesk `Curve3D`/`CurveEvaluator3D` contract.
  SDK point creation remains nullable and is checked through `_model_ok` before
  passing results to subsequent SDK operations.
- `_OffsetConstraintFactory` records the nullable result of the Fusion cast
  operation locally. The shared verified SDK definitions remain unchanged.
- Sketch profiles are emitted as JSON references with the existing explicit
  zero-based profile index. No collection ordering, proposal ordering, solver
  sequence, existing request validation, work budget, or geometry algorithm was
  changed.

## Verification

`tests/typesgeometry/python_types_geometry_sketch_test.py` protects the family’s
JSON, SDK, and nullable signatures and rejects `Any` or type-suppression escape
hatches. Existing fake-SDK coverage remains in `tests/gm06_sketch_test.py`,
`tests/gm07_curve_test.py`, and `tests/gm07_offset_edit_test.py`.

The complete prepared-bundle strict replay uses basedpyright 1.40.2, Python 3.11,
Linux, all 121 source units, and verified Autodesk definitions snapshot
`83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`. The strict
result is recorded in the corresponding Beads update. A zero count for this
family does not imply that the remaining bundle is strict-clean or that
admission passed.

# Stage 3h — shared rectangular sketch scenarios

The `sketches` family runs the same public `sketch.create` and
`sketch.geometry` operations on either backend. Each scenario owns a saved file,
uses an XY construction plane, creates a named rectangle and reads the geometry
back by its exact sketch token. The existing runner closes the document and
removes its file after success, operation failure or assertion failure.

## Reference and expected behavior

The pre-refactor CAD suite creates `RevolveSection`, adds a rectangle, uses four
named edge references and asserts one profile before adding dimensions and a
revolve feature. The shared family preserves this bounded setup and the profile
assertion. It does not claim to cover the subsequent dimensions, revolve or
regeneration. The original `live-cad.js` remains byte-identical to `a26222f`.

The complete `assets/cad/model.py` from that revision is frozen and hash-checked.
A paired test executes its creation/rectangle handlers and current handlers with
the same named length parameters. Both must return four resolvable edge refs,
one profile and matching coordinates. UUID token strings differ between owned
fixtures; their resolvability and entity kinds are compared instead.

Additional shared coordinate assertions check the four ordered endpoints in
centimetres, within `1e-9 cm`. This catches wrong units and a request dispatched
to another scenario's document. Owners deliberately reuse the sketch name while
varying dimensions. A separate concurrent test supplies each owner's token to
the other document, requires rejection and verifies both sketches remain empty.
Degenerate input must fail before creating curves. No old live success assertion
has been weakened or changed to accept a failure.

The newer `live-sketch-operations.ts` requires dimensions, constraints, mirror,
offset, pattern, projection and transforms. Those operations remain pending;
fixture creation alone does not qualify the newer suite.

## Test model boundary

Model version 8 adds construction-plane `addWithoutEdges`, sketch/line/point token
lookup and health readback for the existing bounded rectangle geometry. Reused
corner point tokens resolve once within their owning open design. Rectangle
inputs are copied, so later mutation of a supplied Point3D cannot edit the profile.

UnitsManager uses the existing dimensional evaluator for explicit units, scalar
ratios and named parameters. Unsupported expression syntax remains unsupported.
The pinned Autodesk snapshot verifies call and property shapes; it supplies no
solver behavior. Current coverage is 54 methods and 20 property accessors.

Non-XY support, projected edges, multiple loops, arbitrary curves, fixed and
construction edits, constraints, persistence/reopen and native archive export are
still unsupported. Geometry saves continue to fail explicitly. Final live tests
must confirm rectangle edge ordering, token/handle lifetime, native inference,
health readback and expression behavior. There is no claim of native validation.

## Completion checks

- Twelve focused model tests cover both transports and limits 1/2/10, invalid
  input, foreign tokens, cleanup faults, historical parity and model boundaries.
- Run all model families after changing shared geometry and unit interfaces.
- Run the unchanged shared source through production checking in both MCP and
  addin component profiles; require complete cleanup and equal before/after hashes.
- CI adds the `sketches` family to both real-broker transport jobs. This makes 22
  jobs in the full matrix; a green older 20-job run does not qualify this stage.
  Sketch jobs use two owned files with a ceiling of ten, like attribute jobs,
  because each public CAD helper passes through the full production checker.
  The CLI retains configurable owner/worker counts and the native default of ten;
  this two-owner family alone is not a ten-active-sketch qualification.
- Retain build, strict TypeScript/Python, API-shape, lint, format and inventory checks.

Native Fusion qualification remains scheduled after the offline refactor. The
remaining service migration and historical batch binding compatibility are still
open in the completion plan.

Local model/inventory regression run: 125/125 passed. The MCP component profile
passed both owners and removed both files; source hash stayed
`84dddc066e3d6aedd6a4c1e86204aee24d007d8d9db456b3298188b5124c932f`.
The addin component profile also passed both owners with complete cleanup and
the same source hash. Expanded broker CI is still pending.

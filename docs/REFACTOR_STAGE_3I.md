# Stage 3i: shared sketch coordinate checks

The rectangle scenario now calls the public `sketch.coordinate-check` operation.
The same saved fixture and assertions run with the model or real Fusion: three
coordinate frames, six endpoint/roundtrip/world checks per frame, matching
document identity and unchanged geometry after the read. A deliberately wrong
coordinate must produce `fail`, not an exception or a successful proof. Cleanup
remains owned by the shared runner.

The positive assertions come from `coordinateCheck` in the later
`live-sketch-operations.ts` suite. The negative expectation matches the existing
`sketch_geometry_proof_test.py` comparison contract. The original live suite is
unchanged; its dimension, curve-operation, assembly, feature and solver scenarios
are not claimed as covered. The historical rectangle comparison still runs.

The model adds independent point copies, a sketch-curve base type, root builtin
XY coordinate conversion and endpoint world readback. Call/property shapes are
checked against the same pinned Autodesk snapshot: 57 methods and 21 accessors.
Child component and offset-plane conversion explicitly raise unsupported errors.
These bounds avoid presenting a full assembly transform or sketch solver model.

Additional tests reject a curve belonging to another sketch in the same owned
document and check that point-copy edits cannot change model geometry. Existing
foreign-document token, operation/assertion failure cleanup and concurrency
1/2/10 cases remain required for both transports.

Native assumptions: builtin XY orientation, returned endpoint world geometry,
roundtrip values and read-only behavior. Root-XY identity is a model assumption
until final qualification; API types alone do not prove it.

Local validation: 127 shared-scenario/inventory tests and 20 existing Python
coordinate-proof tests passed. Full pinned build, lint, test types, formatting,
strict model types and the API-shape check passed. Two concurrent component
runs ended without a terminal report; they are not counted as passes. A serial
component run and full broker CI remain required before merging.

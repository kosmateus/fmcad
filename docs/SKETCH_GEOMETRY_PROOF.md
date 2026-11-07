# Read-only sketch geometry proof

## State and boundaries

Pure, SDK-free proof decisions are colocated with the application handlers in
`runtime/python/fmcad/application/sketch_geometry_proof.py`; native Fusion reads
remain in the separate adapter unit. The application module registers both
operations with owner `sketch_geometry_proof`. The family
manifest is defined in
`packages/node-adapters/src/python/sketch-geometry-proof-manifest.ts`; the
canonical bundle composes it after the existing sketch-family owner. The public
declarations live in `src/catalog/sketch-geometry-proof.json` and the audit/help
manual in `src/manual/sketch-geometry-proof.json`. The existing catalog projects
these declarations into CLI, MCP and typed API routes; no CLI/MCP root adapter or
second catalog/dispatcher was added.

The standalone `sketch-geometry-proof-public-routes.ts` descriptor records the
generated CLI/MCP spellings without copying input schemas. Tests exercise the
actual catalog-derived CLI/MCP contracts, typed API catalog, and help manual
alongside the canonical prepared-bundle registry.

The prepared-bundle regression uses the real canonical manifest and production
prepared artifact, imports it with filesystem access denied, and checks exact
registry ownership/callables. A strict focused typecheck projects both new proof
units from the complete canonical source map, with the approved Autodesk
snapshot and canonical helper context. It checks both proof units under
basedpyright strict/reportAny/reportExplicitAny; it is not a full admission or
helper-wide pass.

The adapter reuses `_curve_evidence` for strokes, curve connected components,
closure, intersections and curvature. Domain decisions augment those graph
results with sampled endpoint branching, zero-length curves and duplicate
strokes. They do not reconstruct a second loop graph or attempt geometry repair.

## `sketch.coordinate-check`

```json
{
  "schemaVersion": 1,
  "sketch": "Proof sketch",
  "tolerance": "0.001 mm",
  "expectations": [
    {
      "entity": {"token": "explicit-native-arc-token"},
      "frame": "sketch",
      "center": ["0 cm", "0 cm", "0 cm"],
      "diameter": "2 cm"
    }
  ]
}
```

Expectations require explicit entity selectors and at least one of `point`,
`center`, `start`, `end`, `radius`, `diameter`. Coordinates and lengths are
expressions with explicit units, evaluated by the retained context port. At most
256 expectations are accepted. Radius and diameter are distinct assertions.
An unavailable requested property is `unknown`, not silently skipped.

For each requested point/center/endpoint the adapter reads sketch-local geometry,
uses `sketchToModelSpace`, checks `modelToSketchSpace` roundtrip, then compares
the native `worldGeometry` point against the independently transformed model
point. It also compares the requested frame's value against the expectation.
Frames are `sketch` (default), `model` (native component space), or `world`.
An explicit `occurrence` must instance the sketch's component; its `transform2`
maps model points to assembly world coordinates and its curve proxy supplies
`worldGeometry`. Without an occurrence, only a root-native sketch is accepted,
so model and world are both root space, not a guessed placement among potentially
many instances. Proxy sketches and
entities from other sketches are rejected. Transforms are snapshots.

Optional `featureBRep` has `feature` and `expectations` with the same shape,
but frame is **`model` only**. BRep edges/faces/vertices must be native, their
body must occur in the explicit feature's `bodies` and belong to the selected
component. Requested geometry properties are read back; unsupported ones remain
unknown. This proves explicit body membership and geometric values, not inferred
feature provenance, a generating-profile relation or occurrence placement.

The result separates `healthStatus`, `geometryStatus`, `analytic`, and
`sampled: {"status": "notRequested"}`. A healthy shifted center or incorrect
diameter fails geometry. Health is never evidence of shape correctness.

## `sketch.profile-query`

```json
{
  "schemaVersion": 1,
  "sketch": "Proof sketch",
  "query": {
    "area": 15.0,
    "centroid": ["2 cm", "2 cm", "0 cm"],
    "contains": ["3 cm", "3 cm", "0 cm"],
    "outerLoops": 1,
    "innerLoops": 1
  },
  "expected": {"profiles": 1, "loops": 2},
  "tolerance": "0.001 mm",
  "areaTolerance": 0.000001,
  "maxSamples": 2000,
  "budgetMs": 10000
}
```

Query fields are optional and conjunctive. Explicit `index` is a nonnegative
integer, never a fallback. A unique passing candidate is required, and no
unresolved candidate may remain in the query's scope. Missing loops, missing
integrals, multiple matches and no match return no usable `profile` selector.
Health, global sampled sketch topology, all enumerated native profile topology
and `expected` counts must also pass before a selector is returned. The diagnostic
`selection.selectedIndex` can identify a matching candidate even when global
geometry fails; only the top-level `profile` is authorized for downstream use.

Area/area-tolerance inputs are finite numeric cm² values. Area and centroid
come from native `areaProperties(HighCalculationAccuracy)`.
They are numerical native integrals, not exact symbolic proofs. `analytic`
reports completeness of native topology/integrals and expected counts, not a
claim that sampled selection is analytic. Individual query checks identify
`nativeIntegral`, `nativeTopology` or `sampled` methods. `sampled` separately
reports the existing curve graph, open chains, branches, duplicate strokes,
degeneracies and intersections. No G1/G2 or continuous curvature certificate is
implied. Native profiles use `profileLoops`, `isOuter` and `profileCurves.geometry`.
Native loop directions and enumeration order do not determine containment.

A passing bounded profile check has `geometryStatus: pass` but
`evidenceStatus: partial` and `precision: sampled`, so the canonical evidence
classifier cannot promote sampled evidence into a full analytic pass. Coordinate
readback uses `precision: analytic` for the explicitly requested properties only.

Containment uses parity over the actual native profile-loop strokes, including
inner holes. Points within the stroke tolerance band are `unknown`; off-plane
points are outside. A hole is not filled by centroid or bounding-box heuristics.
Microgaps larger than tolerance fail graph closure; gaps below tolerance cannot
be excluded and must not be described as analytically closed. Sampled duplicate
strokes do not prove equality of all analytic curves.

`expected` supports `profiles`, `loops`, `outerLoops`, `innerLoops`. Loop counts
sum **enumerated loops of all native profiles**, including repeated boundaries
shared by different profiles; they are not the number of unique sketch edges.
Missing topology cannot be counted as zero. Profile/curve enumeration is capped
at 256; the shared stroke budget (2..10000) covers the sketch and all profile
loops, with one shared monotonic deadline (1..120000 ms). A work-limit failure
raises rather than inventing evidence. Output uses cm, cm² and radians.

## Offline verification versus native qualification

```sh
node --test tests/sketch-geometry-proof-bundle.test.js
python3 -B tests/sketch_geometry_proof_test.py
python3 -B tests/typesgeometry/python_types_sketch_geometry_proof_test.py
FMCAD_TYPING_ROOT=/path/to/approved/runtime/python/typing node tests/typesgeometry/sketch_geometry_proof_check.cjs
python3 -B -m unittest discover -s tests -p '*_test.py'
```

Offline doubles cover healthy-but-shifted center, bad diameter, wrong native
world point, microgap, duplicate edge, hole containment, ambiguous/explicit
profiles and missing native topology. They are not a native kernel qualification.

`tests/fixtures/sketch-geometry-proof/native_qualification.py` is an opt-in runner
for an **already prepared synthetic document**. It does not create or edit a
sketch. Loading the fixture does nothing; calling it requires explicit
`authorize_live=True` in addition to actual user permission. Pin the document
through `--doc`, `--doc-id` or `--doc-file-id` in the approved queue path. Never
run it on a user's production document. No live Fusion execution is authorized
or claimed by the offline work.

After live authorization, prepare separate synthetic sketches for all fixture
case names, record independently calculated expected coordinates/dimensions and
areas, and supply explicit tokens. Set negative expected geometry statuses;
requiring `healthStatus: pass` additionally demonstrates that health alone is
insufficient. Include hole material/void checks, no-selector ambiguity and a
unique area/index selection. Include a translated/rotated plane and explicit
occurrence placement, and optional feature BRep readback when qualifying those
paths. Preparation is a separate authorized operation, not part of inspection.

The caller-supplied `fingerprint(ctx)` must capture document identity, component,
occurrence transform, timeline marker and count, sketch transform, point/curve
geometry, constraints/dimensions, deferred-compute state and active edit state.
The runner checks the fingerprint even on failure, makes no setters and performs
no automatic retry or restore mutation. Any state change fails the invariant and
requires investigation. Retain before/after fingerprints and raw result JSON.
If missing topology cannot be reproduced with the real SDK, mark that case
unavailable with a reason: qualification remains `unknown`, never mock it as
native evidence. The Beads task stays open until all native acceptance criteria
and integration verification are actually satisfied.

## Reviewed public SDK contracts

The public Autodesk API pages confirm that profile integral centroids are
relative to the sketch origin, profile-curve geometry describes the actual
profile portion, and point world geometry accounts for assembly context:

- [AreaProperties.centroid](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/fusion_AreaProperties_centroid.htm)
- [ProfileCurve.geometry](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/fusion_ProfileCurve_geometry.htm)
- [SketchPoint.worldGeometry](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/fusion_SketchPoint_worldGeometry.htm)
- [Sketch.sketchToModelSpace](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/fusion_Sketch_sketchToModelSpace.htm)

Reviewing documentation is not execution or qualification of those SDK calls.

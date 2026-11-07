# Section series and finite witnesses

`section_witness.py` has domain, application and Fusion adapter units. The canonical
family manifest is `packages/node-adapters/src/python/section-witness-manifest.ts`;
it exports `sectionWitnessBundleManifest` and `sectionWitnessHandlers`. Its explicit
fourth unit, `application/section_witness_handlers.py`, registers the two handlers
with owner `section-witness`. The canonical `bundle.ts` composes this family once
after the existing `measure` owner. Public catalog routes are
`measure.section-series` and `measure.witness-check`; the functions are
`_measure_section_series` and `_measure_witness_check`.

The adapter explicitly depends on existing `core` and `measure` units and preserves
the asset inventory and lightweight profile. `tests/section-witness-bundle.test.js` prepares and imports
the canonical artifact with filesystem access denied, verifies handler ownership and
baseline registrations, and rejects duplicate/missing dependencies. This is not a
second runtime loader.

## Contracts

Both requests require a `frame` exactly identifying the existing measurement
space/component. They reuse `_measure_space` / `_measure_frame_context`, the
existing occurrence-transform and temporary-copy policy, and existing geometric
serialization. One context is resolved before work. Mixed component-local and
occurrence frames are rejected, not silently transformed together.

Section-series requires `body`, `origin` (three dimensional expressions), `normal`
(direction), and nonempty `stations` (offset length expressions). Coordinates and
offsets in responses are cm; area is cm². The response records the common plane
origin/normal and each requested station, closed outer/inner loops, positive loop
area, net material area and diameters. `diameter` is only populated for a native
single circular edge. `equivalentAreaDiameter` is explicitly an area-derived
quantity, not a minimum wall, inscribed circle or guaranteed bore diameter.

Plane intersection is native TemporaryBRepManager, as in existing `measure.section`.
`createFaceFromPlanarWires` validates closed non-overlapping planar wires and
native face loops supply `isOuter`; no polyline sampling or guessed closure is
used. Individual loops are rebuilt as temporary planar faces to obtain their
unsigned areas. Net area comes from the complete native section face body.
Null/invalid wires, empty edge collections, open curves, incomplete loop coverage,
failed area construction and kernel exceptions produce `unknown` stations with
explicit missing values. They **never mean verified empty**. `complete` only
means all requested discrete sections were computed, not that an entire ring,
Its evidence classifier field is `coverage:'partial'` for completed stations and
`'unknown'` if any station is unresolved; `coverageDetail` carries the discrete
station counts. Section results never independently return `pass`.

Witness-check requires `body`, `witness` (explicit finite positive-volume solid
body references), `expect: material|void`, and explicit `volumeTolerance` expression.
Material uses **witness minus body**; void uses **witness intersect body**. A valid
native Boolean residual within the explicit volume tolerance yields `pass`; a
larger residual yields `fail`; failed/invalid/nonfinite results yield `unknown`.
An invalid result after a successful Boolean is conservatively unknown, even if
the SDK might represent an empty result that way. Native qualification must resolve
this SDK convention before claiming positive-case support on a Fusion version.

This is finite-solid *volume* evidence, not point sampling, a boundary/contact
test, positive clearance, physical qualification or mathematically exact proof.
`coverage` is `pass` only when the finite Boolean completed, otherwise `unknown`;
`coverageDetail` identifies the finite-solid Boolean and explicitly says `sampled:false`.
The categorical `precision` is `kernel`; `precisionDetail.exact` remains false and
the actual SDK-controlled tolerance is not invented. Existing containment samples and parallel-face thickness may supplement
these results but cannot promote them or prove a whole witness. Unknown is not pass.

## Work limits and mutation policy

Optional `limits` has `stations` (default 64/max 256), `edges` per station
(4096/16384), `kernelCalls` (512/4096),
`bytes` (1048576/4194304 UTF-8 JSON bytes), `timeMs` (30000/120000). Values must be
positive integers. Copies, transforms, intersections, wire/face constructions and
Booleans are charged before SDK admission. The time budget is best-effort and
cannot cancel a call already executing. Output is checked after every station and
before return; an oversized response fails rather than truncating evidence into
an apparently complete result. Limits do not predict the internal cost of an
indivisible kernel operation. There are no document writes, feature additions,
geometry repairs or rollback claims in the runtime modules; only private temporary
copies are mutated.

## Verification and qualification boundary

```sh
npm ci
npm run build:code
node scripts/stage-core.cjs --identity-only
node --test tests/section-witness-bundle.test.js tests/workspace-toolchain.test.js
python3 -B tests/section_witness_test.py
python3 -B -m unittest discover -s tests -p '*_test.py'
```

Install dependencies in this worktree itself, not via a symlink to another
checkout's `node_modules`. Full Python discovery also executes Node-based bundle
tests and requires the staged build; absent `dist` is an environment prerequisite
to fix, not an acceptable final regression result.

Offline tests use SDK doubles with shared shape dimensions from
`tests/fixtures/section_witness_shapes.json`: good annulus, missing radial sector
with a contained finite witness, a local axial void strictly between sample
heights, closed outer/inner loops, absent section, open curves, kernel error,
frame mismatch and work/output limits. They check orchestration/policy, **not
real BRep geometry**.

`tests/native/section_witness_qualification.py` is an opt-in native runner using
the same dimensions and actual model features/TemporaryBRep kernel. First create
a uniquely named unsaved scratch with `fmcad doc new`, read its new
`creationId`/`doc-id`, and record a fresh document-list baseline. Supply that pin,
the actually probed Fusion build, and the fixture JSON through `ARGS`. The runner
never creates, opens, activates, or closes a document; it creates test features
only in the already-pinned scratch and checks model counts around evidence. The
radial-sector cut is expected to form a *closed C-shaped* planar boundary; an
independent transient three-edge open wire exercises native face-builder
rejection. Material and void Boolean cases also distinguish accepted zero-volume
results from invalid/null kernel results. The local axial cavity keeps one solid
body, while its finite witness sits wholly inside the cavity and the requested
section stations lie on either side. The caller then uses a short brokered
exclusive sequence: fresh `doc list` must show
the exact scratch creationId active immediately before `fmcad doc close --discard`;
a final fresh list must show the scratch absent and every pre-existing document
still present with its prior saved/modified flags. If the active identity differs,
do not close anything or activate an old document; report restore failure/unknown.
Coordinate the short create/run/close lifecycle window with other Fusion
operators. Route every operation through the shared fmcad broker; do not invoke
this native script directly or during offline discovery.

**Native qualification has NOT run on Fusion `2706.1.14`.** The empty-result
behavior of material/void Boolean checks, actual open-wire face failure,
non-intersection vs tangent/degenerate kernel result, frame rejection and scratch/active
document restoration all need the pinned native run and independent readback.
All native acceptance items remain pending; no offline mock result closes the
ticket.

SDK reference: Autodesk `TemporaryBRepManager.createFaceFromPlanarWires` (reviewed
2026-10-25) requires closed, coplanar, non-overlapping wires and returns null on
failure. It does not establish a caller-visible distinction between an absent
plane intersection and a kernel failure.

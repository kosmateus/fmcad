# Finite regional geometry evidence

`geometry.delta` and `geometry.compare-region` compare **finite solid sets**, not
sampled points, rays, bounding boxes or the difference of scalar total volumes.
Both retain `removed = before − after` and `added = after − before` separately.
Equal-volume edits therefore never cancel. A result addresses positive-volume
solid coverage, **not** topology identity, zero-thickness face/edge changes,
manufacturability or physical acceptance.

## Input

```json
{
  "schemaVersion": 1,
  "before": "body-before",
  "after": "body-after",
  "frame": { "space": "assembly", "component": "root-component" },
  "allowed": { "include": ["mask-a", "mask-b"], "exclude": ["hole"] },
  "protected": { "include": ["keep-out"], "exclude": [] },
  "operationBudget": 256,
  "timeBudgetMs": 10000
}
```

Refs use the retained `CadContext.resolve` contract. Every operand and mask is
an explicit valid solid BRep body. A root-context occurrence-qualified proxy
identifies an instance; a child-component native token never guesses which
instance was intended. `frame` explicitly names `assembly` or `component local`
and its component. All input bodies must share that resolved frame.

Each mask is `Union(include) − Union(exclude)`. Overlapping inclusions count
once, exclusions remain actual holes, and gaps/missing sectors remain outside.
The protected mask is independent: **protected wins over allowed** in overlap.
An empty include means an empty mask, never the universe. `allowed` is required
by `geometry.compare-region`; `geometry.delta` defaults to empty allowed and
protected masks, making its controls strict unchanged-solid checks. It still
reports both directed differences when they are nonempty.

Only native solid references are accepted. There is deliberately no primitive
descriptor, arbitrary `method`, sampling budget, points/rays or numerical unit
override. Source bodies already embody UnitsManager-resolved dimensions. Output
uses kernel internal **cm / cm³**, with explicit units. For example a native box
constructed from `10 mm` has the same set as one constructed from `1 cm`.
Different frames are rejected, not silently rescaled or aligned.

## Result and proof gate

For both `delta.removed` and `delta.added`, results contain:

- `total`: directed finite difference;
- `insideAllowed`: its intersection with the allowed mask;
- `outsideAllowed`: its difference from the allowed mask;
- `insideProtected`: its intersection with the protected mask.

Each value has `empty`, finite nonnegative `volume` and `bounds` (or null for
empty). Bounds only **locate** a change; they never prove occupancy or coverage.
No temporary body handles escape into the JSON result or any persistent store.

`controls.outsideAllowedUnchanged` and `controls.protectedUnchanged` pass only
when **both** added and removed relevant solids are empty, with no positive
volume tolerance. `status` is `pass` only if both controls pass. A completed
negative case is `fail` with retained exact-volume evidence. `precision` and
`coverage` use the shared evidence vocabulary (`pass` for a completed finite
BRep calculation); method and limitations define its precise scope.

The retained comparator is called through the port with explicit zero volume,
length and angular tolerances. Its result is included as `comparison`, but its
legacy invalid-result-as-empty heuristic does **not** decide regional coverage.
Regional Booleans independently retain the actual directed sets.

Kernel false/exception, invalid temporary result, unresolved/missing body,
non-solid input, missing entity-token provenance, document/body/instance drift,
nonfinite volume or budget exhaustion yield `unknown`, `passed: null`,
`success: false`, null delta/controls/comparison and no exact-pass claim. An
invalid native BRep after a successful Boolean is **not assumed empty**. Native
qualification must establish any supported empty-result behavior before a
broader rule could be justified; no heuristic is added here. Invalid input
schema, unsupported fields or missing required fields are rejected before SDK
work rather than disguised as geometric proof.

## Ownership, freshness and budgets

Domain rules are in `runtime/python/fmcad/domain/regional_geometry.py`, the
application use case in `application/regional_geometry.py`, and Fusion effects
in `adapters/fusion/regional_geometry.py`. The application receives one port,
not a new solver, store, executor, scheduler or geometry transport. The Fusion
port reuses the existing temporary-body/frame/comparator helpers read-only.

Both Boolean operands are private manager copies, including tools. Assembly
transforms apply to copies, never source bodies. There are no feature edits,
body additions, document activation, persistent temporary objects or rollback
claims in either operation. Provenance pins references, native body
`entityToken`/`revisionId`, resolved frame and full transform. Final verification
re-resolves each ref and checks document identity, body token/revision/validity
and occurrence transform. This uses current native identity/change markers, not
an unqualified durable baseline.

The operation budget counts **port turns**, not individual kernel primitives.
Time is checked before/after every turn. SDK calls within a port turn are
indivisible: expiry never claims remote cancellation or retries. Expiry after
a completed call still returns unknown. A partition-conservation sanity check
can reject inconsistent kernel evidence, but its numeric allowance is not an
acceptance tolerance: outside/protected pass requires zero finite volume.

## Integration and verification status

The dedicated `regional-geometry-manifest.ts` hook prepares these modules after
the retained measure implementation, without touching the light document-status
profile. The canonical manifest applies the hook once. The adapter's
`regional_geometry_register` assigns the single registry owner to the application
layer; only `geometry.delta` and `geometry.compare-region` are registered. Public
declarations and shared specialist validation are in `src/catalog/measure.json`
and `src/catalog/regional-geometry.js`; command help is in
`src/manual/measure.json`. The typed `FmcadServices.execute` regional invocation
overload delegates to the same catalog command/broker route; there is no special
entrypoint, direct SDK call or alternate execution pipeline.

```sh
python3 -B tests/regional_geometry_test.py
npm run build:code
npm run typecheck:tests
node --test tests/regional-geometry.test.js
```

Offline fixtures use analytic disjoint orthogonal solids with exact planar
intersection/slab subtraction. They are not point samples, voxel coverage or
native BRep qualification. Tests include allowed edits, external additions,
balanced added/removed volumes, overlap, holes/gaps, protected overlap, stale
references/entity tokens/poses, frames, budget expiry and Boolean false/exception/
invalid results. The real comparator implementation is exercised via the port.

`tests/fixtures/regional-geometry-native.py` is an **unexecuted consent-only**
qualification fixture for the canonical prepared runtime after integration.
Importing it performs no SDK work. It constructs one unsaved synthetic document,
checks positive/negative cases and source identity/volume preservation, closes
without saving and restores the original active document/dirty state. A failed
or unknown case, failed cleanup or failed restore keeps qualification failed.
It must run through the existing queue with an exact document target only after
explicit approval. Record the actual Fusion build, all case results and restore
evidence. Offline injection of kernel failure is not native kernel proof.

**No native qualification has been performed. The ticket cannot be closed as
successful from these offline tests or from compilation alone.**

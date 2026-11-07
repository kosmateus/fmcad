# Box geometry and timeline contracts

The historical `live-legacy.js` test creates a 10 mm box, checks one body and a
healthy timeline, reads 10 x 10 x 10 mm bounds and 1000 mm3 volume, rolls back the
last feature to zero bodies and restores it to one body. The shared `boxes` suite
now runs those steps with owned saved fixtures and cleanup. A second 25 mm case
uses the same steps to detect size-dependent or cross-document mistakes.
Independent numeric readbacks allow 1e-6 mm for lengths and 1e-6 mm3 for volume,
well below the original printed precision. These additional tolerances need native
qualification; the historical formatted-output assertions remain unchanged.

## API migration

The exact `a26222f` builtin box source is retained with its hash. It calls
`setDistanceExtent`, absent from the pinned Autodesk reference. A production
admission test reproduces that rejection; this is an API compatibility gap in
retained code, not proof that the current native Fusion implementation rejects
the deprecated call at runtime.

The shipped script now uses `DistanceExtentDefinition.create` and
`setOneSideExtent` in the profile-normal direction. Optional SDK results and false
extent acceptance are checked before claiming creation. Both ordinary and
identity-bound public `run` preparations pass strict admission. Paired execution
of old and new scripts on independent models preserves output, geometry, volume,
sketch/feature counts and timeline length for the historical 10 mm case.

## Analytical model

The model computes an untapered rectangular prism from actual sketch points and
extrusion distance. It exposes body bounds, physical volume and stable revisions
for production broker snapshots. Timeline markers hide and restore the affected
body; operations crossing unsupported feature kinds or editing behind the marker
remain unsupported. Parameter-driven regeneration, arbitrary profiles, boolean
operations, constraints and native export are not implemented.

Geometry save/reopen remains unsupported. Save attempts with modeled geometry now
fail before creating a file; parameter-only serialization cannot silently discard
it. Shared box fixtures save the empty owned document first and inspect geometry
before discarding it, matching the explicit fixture lifecycle contract.

The model and native runner use identical steps and assertions. Final Fusion
qualification must verify current extent API behavior, default design history,
rollback visibility and measurement tolerances. Local and CI results qualify the
model/adapters only. Required gates are historical comparisons, both transports,
concurrency 1/2/10, production admission, strict model types, pinned interface
shapes and full CI.

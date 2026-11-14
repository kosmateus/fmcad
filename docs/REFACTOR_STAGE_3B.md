# Document commands and shared contracts

Plane and component commands now use typed Fusion adapters. Parameters, inspection,
planes and components share one document-selection guard. The obsolete component
asset is removed; the old data-manager asset retains only cloud commands.

## Historical evidence

Paired tests run the exact `a26222f` plane, component and inspection sources and the
current adapters against independent model instances. Seventeen operations compare
output and observed state: offset/mid/angle planes, list/rename/delete, duplicate
and invalid references, nested components and unit changes. The component fixture
has its own recorded SHA-256; the complete data-manager fixture is reused.

Six additional before/after cases reproduce inherited wrong-document writes for
planes and components. Duplicate names, a false activation result or activation
of a different document formerly allowed mutation. The shared guard rejects each
case before mutation. The intended result changes because a command naming one
document must never modify another; ordinary successful results are preserved.

## Shared model and native scenarios

`--suite documents` adds three saved-file scenarios: construction planes, component
hierarchy and display units/timeline boundaries. They execute the shipped commands
and independently read geometry, hierarchy and units. Both backends use the same
steps and assertions, exact ownership and cleanup. `all` includes these scenarios.
Unit tests use both protocols at concurrency 1, 2 and 10; CI also runs both protocols
through the actual broker and production checker.

The model implements explicit plane offsets, parallel midplanes and angles around
origin axes, identity component placement, nested components and unit selection.
A 10 mm offset reads back as 1 cm; its midplane is at 0.5 cm. The angle scenario
checks the absolute normal Z component against cos(30 degrees), with 1e-9 tolerance.
These geometrical expectations extend the historical command assertions without
weakening them. This stage records no native confirmation of orientation,
tolerances or SDK rejection behavior. Targeted local Fusion checks may run against
the matching installed build and shared broker; model results are not native
evidence.

Stable component identities and conservative content revisions support the broker's
optimistic document snapshots. A regression test uses the production snapshot code
to verify stable reads, changed fingerprints after edits, unchanged foreign state
and no implicit activation. Unsupported geometry, transforms, dependency regeneration,
rollback and geometry persistence fail explicitly or remain unadvertised; this is
not a replacement for Fusion's geometry kernel.

## Checker cleanup

Local production-admission testing exposed `ENOTEMPTY` while deleting a checker-owned
analysis directory. The retained `f708256` checker uses the same non-retrying cleanup;
this is not established as a migration regression. Cleanup now retries local
filesystem removal three times with a short delay. It does not retry an SDK operation
or relax admission. Fault tests cover transient recovery and persistent failure,
including propagation of the final error and process termination within a deadline.
Node may retry both parent and child removals, so syscall count is not the retry count.
The precise cause of the original filesystem visibility race remains unproven.

## Completion checks

Required checks are the historical comparisons, shared scenarios, real admission
for all generated commands, strict model typing, pinned API call shapes, Python
source/manifest parity and full CI. Passing this family does not complete the
remaining runtime migration or native qualification.

The component lookup follow-up is recorded in [stage 3f](REFACTOR_STAGE_3F.md):
duplicate component names must no longer select the first parent or imply a unique
existing result. This is separate from the document-name guard delivered here.

# Agent B — shared Fusion backend and live scenario migration

Status: **claimed by Agent B** on 8 November 2026, starting from `0b84454`.
The existing shared families and historical assertions remain the baseline.
Implementation proceeds through separate inventory, transactional/file, analytical
modeling and profile-registration deliveries; native execution remains deferred. Read [the shared plan](../REFACTOR_PARALLEL_PLAN.md).

## Outcome and ownership

Extend the existing model and shared scenario framework until every historical
and later live assertion has an explicit disposition. Use one scenario body for
the model and real Fusion: identical operations, expected values and tolerances.
Backends provide transport, capabilities, paths and environment identifiers only.

Own `tests/support/fusion-simulator/**`, `tests/scenarios/**`, `tests/live-*`,
`tests/helpers/live-*`, `tests/run-live.js`, `tests/live-suite-inventory.json`,
their inventory tests and scenario documentation. Do not modify A's broker or
C/D's production runtime to fit the simulator. Send minimal production bug
reproducers to its owner. G integrates shared CI/build registrations.

## B1 — complete assertion inventory and fixture contract

Start from the 36-entry inventory: 21 pending, 4 partial, 5 native-only and 6
helpers. Map individual assertions, not just filenames, to scenario IDs and
capabilities. Compare all historical tests at `a26222f` and later changes. Include
backend-adapter, definitions, batch-reference, multidocument/recovery, newer
sketch/component/attribute, import/export, feature, style and motion suites.
Do not mark a suite done because a single representative operation exists.

Retain completed foundation/saved/parameters/documents/cloud/boxes/attributes/
sketches. Inspect their remaining omissions. Every normal scenario creates its
own saved file in an explicitly supplied project/folder, uses exact creation and
file/version identity, and removes only that file after completion. Unsaved/export
assertions remain separately named lifecycle cases, not an excuse to omit saved
fixtures for other scenarios.

Strengthen setup/finally/recovery tests at every boundary: accepted creation/save,
operation error, assertion error, close/delete loss, false deletion, delayed cloud
visibility, changed version, foreign receipt, cancellation and process restart.
Keep primary and cleanup errors separate, hold the concurrency slot through
cleanup, and audit original documents/files plus active-document restoration.
Unknown mutation/cleanup does not permit replay and never counts as success.

## B2 — migrate transactional and file scenarios

Move normal multidocument, response/RPC recovery, definitions, batch-reference
and batch negative-check scenarios onto shared saved fixtures. Verify idempotent
run IDs, stop-after-failure, original receipt recovery, zero duplicate mutations
and wrong-owner isolation. Coordinate transport fault injection with A.

Implement model version/reopen state and import/export lifecycle contracts with
D. The current model archive is marked JSON, not genuine F3D. Never use its bytes
as evidence for STEP/F3D/native rendering validity. Keep lineage, replacement,
source pins, persistence and cleanup testable offline; native format assertions
remain explicit pending obligations in the same scenario catalog.

## B3 — extend defensible geometry and model state

Work with C on sketches beyond rectangle/root-XY: additional curves, dimensions,
constraints, transforms, profiles, regeneration, components/occurrences and
entity identity. Start with bounded analytical behavior justified by historical
tests. Add shape/feature modes with independent geometric expectations where
defensible (for example simple extrude/revolve and known volumes/bounds).

Audit `live-cad`, `live-extended`, `live-feature-modes`, native solids, thicken/slot/
patterns, thread, engineering analytics and fixed GM fixtures. General topology,
solver behavior and arbitrary BRep cannot be inferred from type definitions.
Reject unsupported capabilities honestly and keep those native scenario
assertions intact. Do not encode canned output for one fixture or weaken checks
so unsupported geometry appears to pass.

Use pinned Autodesk commit `07814d19ac63bb3ff0d55e3d35517cf3a71bad8c` and snapshot
`83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179` for interfaces.
Extend type/shape checks when adding a modeled API. Behavior comes from historical
assertions and explicit assumptions, not method signatures alone.

## B4 — global-state profiles and registration

Extract camera, styles/materials/mass, motion/pose/joint limits, animation and UI
setup/error/cleanup contracts. Global UI/workspace state needs an exclusive scope
and verified restoration; do not run old exclusive suites blindly in parallel.
Fixed external fixture diagnostics require their own explicit owned copy or
profile and cannot mutate an unrelated user's model.

Create a single required-profile manifest with supported shared cases, native-only
obligations and diagnostic helpers clearly separated. A required supported case
that is blocked/unsupported/not-run fails its profile. The legacy `all` runner
must not imply full concurrent or full-model coverage. Provide migration-safe
commands and CI registration patches to G.

## Completion and evidence

Run scenario units, simulator strict types/API verifier, real production checker,
both component profiles and real broker/model MCP+addin profiles at 1/2/10.
Retain deterministic A-to-B target/receipt substitution with independent B
readback. Keep model default `min(2, CPU)` until memory measurements justify more;
native default remains 10. Coordinate with A's single physical SDK lane.

Exit only when every inventory assertion maps to a shared tested scenario or an
explicit, justified native-only obligation, fixture isolation/cleanup is proven,
all required model capabilities pass, and G has a runnable final native manifest.
Native execution is deferred until the offline refactor is complete. Record
PR/SHA, per-family checks, assumptions and remaining cases after every delivery.

## Delivery ledger — bounded model persistence

Starting point: `0b84454`; claim PR #36 (`ce68130`). The pinned build and all
123 existing scenario tests passed before changes. Original archive Git history
was recovered separately; its AGENTS.md diagnosis rules were read. No archived
worktrees or database are added to the repository.

The model now snapshots its supported design graph and opens the latest complete
file into a new document identity. Regression tests prove rectangular geometry,
attributes, parameters and timeline survive close/reopen, unsaved edits do not
leak into snapshots, modified/no-op save version behavior, and refusal of foreign,
incomplete, deleting, deleted and superseded files without creating documents.
The old refusal test is replaced because bounded geometry persistence is now
implemented, not because an unsupported native format is accepted.

Validation: strict simulator types (zero errors); pinned API shape verifier
(58 methods / 21 property accessors); two new persistence tests pass. Full scenario
and CI evidence will be recorded before merge.

Remaining B1–B4 work is still open. In particular this delivery does not yet add a
shared saved-reopen scenario: the runner needs a receipt-bound creation-identity
handoff and loss/restart tests before reopening is safe under its cleanup contract.
Historical-version opening and native archive formats remain explicit unsupported
capabilities. Token continuity here is a model assumption requiring native checks.

## Delivery ledger — assertion audit and exclusive legacy profiles

[Assertion audit](B_ASSERTION_AUDIT.md) freezes 1,588 static sites across 39 live
sources and compares 613 historical sites (612 unchanged; one explicit MCP name
change). It adds an anti-omission unit gate and a required-profile manifest, while
leaving semantic per-assertion dispositions explicitly pending. Legacy global-state
suites now have exclusive barriers and block later work after an uncertain failure.
This is an intermediate B1/B4 delivery, not package completion or native evidence.

Persistence PR #44 (`fe1c66f`) passed all 124 scenario unit tests locally; full CI
is pending. The archive contains the pre-refactor Git baseline and is kept separate.

## Delivery ledger — saved revisions and receipt-bound reopen

PR #36 merged as `2e96778` after all 22 checks passed on `ce68130`
([CI](https://github.com/kosmateus/fmcad/actions/runs/42523647038)).
PR #44 merged as `ecf4f60` after all 22 checks passed on `fe1c66f`
([CI](https://github.com/kosmateus/fmcad/actions/runs/42524121814)).
The assertion-ledger PR #45 is now targeted at main.

New shared `reopen` and `revisions` families retain exact file/folder/version
identity while adopting a new creation ID only from the original successful
request and matching durable receipt. A revision records its intent before save,
observes the next completed version separately, and never resubmits an unknown
save. An unmodified save keeps its version. Reopen closes once, opens once, and
rejects existing open handles, changed versions and foreign receipts.

The same scenario bodies run on the model and Fusion. They verify saved parameter
and analytical box persistence, independent readback of unsaved edits before
close, discard of those edits after reopen, and exact cleanup of the saved version.
Loss tests cover save, observation, close, open and deletion; recovery uses original
backend evidence and does not rerun scenario assertions. Cancellation after known
save/close completion still cleans the owned file. Ambiguous post-open failures
remain deferred. Explicit second save/reopen attempts are rejected before submission.

The model tests exercise both transports at concurrency 1/2/10. Production checker
and full CI results will be recorded before merge. G owns the separate broker-matrix
registration proposal in `tests/scenarios/CI_REGISTRATION.md`; local broker execution
remains blocked by the unmodified Linux process-identity prerequisite.

Native-only assumptions: an accepted modified save publishes exactly the next
version; close(False) discards edits; reopen establishes a new creation ID; reopened
parameters and bounded geometry match the saved version. These are qualification
obligations, not native results. General native formats, solver/topology behavior,
transactional suite migration and complete per-assertion dispositions remain open.

## Delivery ledger — bounded dimensioned rectangles

PR #45 merged as `0d6f757` after all 22 checks passed on `895eb69`
([CI](https://github.com/kosmateus/fmcad/actions/runs/42524676732)).
PR #58 (`c4ab2f9`) adds revision/reopen receipts. Its production-checker component
revision scenario passed through MCP and addin in an immutable checkout, with
identical source hashes before and after both runs. Full CI remains the merge gate.

The new `rectangles` shared family executes the production `shape.box` recipe,
checks independent rectangular-prism dimensions and volume, modifies a driving
parameter, saves/reopens the owned version and checks regeneration again. Each
transport exercises ten separate owners at concurrency 1/2/10. Model v11 adds
only an analytical anchored rectangle with two driving dimensions and retained
extrusion expressions; it rejects unsupported constraints rather than simulating
arbitrary solver success. API shape coverage increases to 61 methods / 21 accessors.

Native-only assumptions and exclusions are recorded in the simulator README.
This delivery unlocks the box prerequisite for definitions and batch scenarios;
it does not claim those migrations or the full assertion disposition audit done.

Local rectangle delivery validation: all 163 scenario unit tests pass, simulator
strict typing reports zero errors, and the expanded API verifier passes. The
six rectangle transport/concurrency combinations cover 60 owned saved fixtures;
a separate negative test checks unsupported, foreign and duplicate dimensions.

## Delivery ledger — shared definition and batch orchestration

PR #63 (`9be5e0f`) passed the production-checker rectangle component profile on
MCP and addin in the immutable verification checkout; both before/after source
hashes match. CI is queued and remains required before merge.

The transaction family retains literal definition parameters, feature/body result
references, 23/11/7 mm bounds and 1771 mm³ volume, exact successful replay, changed
run-ID rejection, negative-check skip behavior, 18/9/12 mm driven bounds and 1944
mm³ volume, unsupported parameter syntax, and literal code-like string rejection.
Its shared journal checks bind request/context/hash/steps and confirm lock removal.
Separate model transport tests count physical SDK executions for replay/rejection
and exercise lost completed results and foreign context recovery without replay.

The first 37 individual historical definition assertion sites are mapped in
`tests/scenarios/assertion-dispositions.json`; unlisted sites remain open. Whole
native audit snapshots and CLI/backend-specific lifecycle assertions are not
silently replaced by simpler geometry checks. Atomic command-event rollback,
full global-state profile extraction, import/export migration and the remaining
semantic inventory are still outstanding. Native execution remains deferred.

Concurrency investigation: the first full transaction matrix passed MCP/addin at
1/2 and addin at 10; MCP at 10 intermittently reported `EEXIST` reopening a journal
whose prior close/unlink completed. A direct 500-lock baseline and a ten-owner
production-journal publication/reopen baseline passed. An isolated uninstrumented
MCP run reproduced the refusal; a stat-instrumented run passed. No lock deletion,
retry or production persistence workaround has been introduced. Retain the
concurrency test and resolve this discrepancy against ordinary CI before merge.

## Delivery ledger — shared exclusive barriers

PR #70 (`5f2bed1`) retains production definition/batch orchestration. The complete
local scenario regression was 172/174; both failures concern the unresolved
journal lock discrepancy above. Its exact-head CI, and CI for #58/#63, remain
queued. No failing PR is merged. Main was fetched at `7ec4886`; A's retained
broker gates and E's public-boundary changes are preserved.

Shared scenarios now declare owned-document or exclusive-instance scope. The
coordinator drains earlier cleanup before an exclusive case, blocks all later
cases after exclusive failure or unsettled cleanup, and records durable not-run
reports without requests. Recovery only settles the original fixture and never
starts those blocked cases. Six focused integration/scheduling tests pass.
This establishes scheduling, not native global-state restoration: each migrated
global scenario still needs capture/restore assertions and its native assumptions.
One coordinator per Fusion instance remains an explicit prerequisite.

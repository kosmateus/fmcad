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

## Delivery ledger — explicit camera state

PR #72 (`68d4e4d`) contains shared exclusive scheduling; 28 focused runner and
scheduling tests passed. Full CI remains queued. The immutable PR #70 transaction
component profile passed through MCP with identical source hashes before/after
(`37185e8e...`); addin verification is running. The concurrency journal discrepancy
remains open and no production guard has changed.

The camera shared family preserves the historical perspective projection,
40-degree lens, 80/60/50 mm eye, 10/6/5 mm target and 0.00001 internal-unit
assertions on an owned saved fixture. It verifies independent readback,
foreign/invalid-state rejection without view changes, and restoration. An
assertion failure restores before close; a lost write blocks restoration/new
mutations and later scenarios. Recovery reads the original receipt and closes
only its owned file; it does not claim camera restoration or qualification.
Aggregate errors retain both the original and restoration failure messages.

Model v13 supplies detached camera snapshots and document-owned viewport state,
with explicit square framing assumptions. All six MCP/addin concurrency 1/2/10
camera combinations pass. Detached-copy/isolation, assertion-failure restoration
and loss/recovery tests pass. The failure-injection fixture was corrected to
preserve the separate FMCAD_RESULT receipt line rather than parsing all stdout
as one JSON value. Strict simulator typing has zero errors; pinned API checks
cover 65 methods and 41 property accessors. Full regression is running.

Three exact live-extended camera assertions are mapped, bringing the individually
reviewed shared ledger to 40 sites. Neighboring shot-pack/PNG/ViewCube assertions
remain open native obligations. No rendering, smooth transitions, fit, arbitrary
aspect-ratio behavior or camera persistence across reopen is simulated or claimed.
Global material/motion/UI contracts and the remaining B1–B4 migration remain open.

## Delivery ledger — command settlement and recovery

Camera PR #75 (`b35d82a`) passed 184/186 local scenario tests. Both failures are
journal lock refusals in the transaction family at concurrency ten, now reproduced
on MCP and addin. Camera tests pass; the production-checker camera profile runs
separately in an immutable checkout. Full CI is still required before any merge.

Before migrating native command-event cases, the shared runner now distinguishes
transport completion from the command's own settlement. Explicit unknown/running/
pending outcomes and incomplete results defer cleanup even if the transport says
settled. Recovery rechecks original command control fields and document context
against receipt-proven owned identities; a foreign or still-unknown original
result cannot authorize cleanup. Literal input fields named status do not affect
this control decision. Four transport/defect integration cases and one control
parsing test pass, including independent retained-document readback and cleanup
only after the original known evidence is supplied. No mutation is replayed.

The stronger settlement gate exposed a concrete production dependency, documented
with the original literal request in [B_COMMAND_SETTLEMENT_BLOCKER.md](B_COMMAND_SETTLEMENT_BLOCKER.md).
Five selected transaction tests now stop at the coordinator's explicit unknown
no-eval outcome; two recovery tests still pass. Do not weaken the gate or call
that unknown mutation successful. C/G must provide a receipt-proven rejection
contract before these required cases can pass. The independent immutable addin
component run also reproduced the separate journal lock refusal with one owner;
MCP passed. Both source hashes remained stable. These PRs remain blocked to merge.

## Delivery ledger — assertion helper call sites

The earlier static scanner missed expected values at local helper call sites
(`check`, camera/pose comparison helpers and their wrappers). Corrected discovery
adds 2,119 assertion-bearing call sites while preserving all 1,588 frozen IDs.
The current inventory is 3,707 static sites; wrappers and inner assertions are
intentionally separate, so this is not a runtime assertion count. Archive
comparison is now 1,334 sites, 1,333 retained, with the same sole MCP name change.
Four inventory/disposition tests pass; the 40 reviewed semantic mappings remain
intact. Dynamic/imported helper resolution and full semantic classification remain
open; no increase in detected sites is represented as migrated coverage.

Settlement PR #78 (`a32c49e`) is a draft with the C/G dependency and failing
transaction evidence recorded. Native Fusion remains deferred.

PR #58 merged as `2ed8017` after all 22 checks passed on `c4ab2f9`
(CI run 42529825311). PR #63 merged as `6c9f6c5` after all 22 checks passed on
`9be5e0f` (CI run 42530763341). Main's intervening E/F changes were inspected and
preserved. The immutable PR #75 camera component profile passed on both MCP and
addin; source hashes before/after were identical (`eb0237a4...`). These successes
do not remove the separate transaction settlement and journal blockers.

## Delivery ledger — pose manifests and visibility

Assertion-helper audit PR #88 (`ab1b2d2`) retains all earlier sites and exposes
previously missed helper-call expectations. The pose delivery maps 28 of those
individual historical checks onto one shared saved-fixture sequence: manifest
revisions 1/2, exact document identity, declared fill/spring/route/service fields,
list membership, apply/readback, temporary evaluation/restoration, baseline apply,
confirmed deletion and empty index. The order and expected values are retained.

Fixture correction: `live-pose-methods.js` searched for a body named `PoseBody`,
but current and archived `b0a8081` geometry handlers assign the requested name to
the feature and return separate body refs. The shared case uses that exact owned
body token for independent visibility readback. It does not invent a body-rename
side effect. The historical source and its original guard remain in the inventory.

Model v14 adds component attributes and body light-bulb state, with root-body
visibility only. Production pose handlers implement the manifests and restoration;
there is no duplicate pose implementation in the simulator. Joint solving,
configuration tables, rendering and inherited occurrence visibility remain native
obligations. Both transports pass at concurrency 1/2/10. Lost-apply recovery never
replays, and deterministic foreign-token substitution leaves an independently
observed protected saved document unchanged. The eight initial tests pass; added
assertion-failure restoration and the non-transaction regression are running.
Strict simulator types pass; pinned API coverage is 65 methods / 46 accessors.
The disposition ledger now distinguishes the 37 blocked transaction mappings from
other offline-tested/native-pending mappings. Overall B1–B4 completion remains open.

Pose regression result: all 191 tests in the non-transaction scenario selection
pass, including the new assertion-failure restoration case. The transaction file
is explicitly excluded from this result because its five known settlement failures
remain blocked; this is not a green whole-package claim. API shape and strict model
type checks pass. Production-checker and full CI evidence will follow on the PR.

## Delivery ledger — deterministic animation planning

Pose PR #89 (`c51dacf`) retains the 191 passing non-transaction tests; its
production-checker component run is in progress and CI is queued. No blocked
transaction dependency is treated as resolved.

The shared animation family preserves all 11 historical camera-manifest checks
from `live-animation-methods.js`: exact track input, three frames, count/order,
fps, time and camera interpolation with unchanged 1e-9 tolerances, stable target
and up vector, and no authored native actions or affected entities. Independent
saved-document readback additionally verifies no geometry, timeline, parameter
or modification-state changes after planning and three rejected inputs. The
production planner supplies all results; the simulator adds only a capability
registration. There is no duplicate animation implementation.

The required-model catalog now includes the animation family and the per-assertion
ledger contains 79 reviewed mappings. Native storyboard actions, joint sampling,
rendered frames/video and restoration of UI state remain open obligations. A
manifest does not prove any of them. Full matrix and CI evidence follow below.

Animation validation: all six MCP/addin × concurrency 1/2/10 combinations pass
(28 owned saved fixtures), as do the four disposition/profile barrier checks.
Runtime-test compilation passes. Native execution remains deferred, and full
exact-head CI remains required before merge.

## Delivery ledger — preserve historical definition order

Animation PR #90 (`55a31a8`) carries the passing six-profile matrix and eleven
additional reviewed historical assertions. Full CI is pending.

The first definition migration placed the numeric parameter case after the
code-like literal rejection, unlike `live-definitions.js` lines 190–242. Corrected
the shared sequence to run numeric parameters first, with the same 18/9/12 mm
bounds and 1944 mm³ volume tolerances. Unsupported/rejected input readback now
compares against an independently observed snapshot after that successful case,
including both created bodies. No expected geometry was weakened.

Two transport tests pass: injecting loss at the final literal rejection proves
all earlier numeric and unsupported-syntax assertions completed in their historical
order, then cleanup is deferred and no later readback is submitted. The existing
positive transaction suite still requires known settlement from C/G; this order
correction does not resolve that blocker or the journal-lock issue.

## Delivery ledger — immediate predecessor evidence

Transaction-order PR #91 (`f9e9454`) preserves the historical sequence and passes
both transport/loss tests. The latest exact archive versions of all 39 live/helper
sources are now compared with their first parents, including explicit JavaScript
predecessors for three TypeScript ports. The frozen evidence preserves 421 removed
or changed expressions and 1,197 added current-site IDs. Six audit/disposition tests
and runtime-test compilation pass. This records textual changes, not missing-check
counts or semantic equivalence; 396 changed sites belong to the three ports.

Reviewed differences and unresolved active-document, motion-order and GM07 build
pin obligations are recorded in B_ASSERTION_AUDIT.md. Earlier intermediate revisions
and per-assertion port equivalence remain open. No whole-suite completion is inferred.
The immutable pose component profile has passed MCP; addin is still running.

## Delivery ledger — shared native solid obligations

Predecessor-audit PR #92 (`d76805f`) preserves exact historical changes without
claiming semantic completion. The shared native-solids sequence now retains the
rib/web/sector/arc-strip/O-ring geometry requests, body counts, bounds and volumes,
using normal owned saved-file lifecycle. Eighteen native-only assertion mappings
join the 79 shared mappings. The old unsaved lifecycle checks remain explicit
unmigrated obligations, not implied by saved fixture cleanup.

The model does not advertise the native profile/sector/torus capability; both
transports refuse all ten owners before any SDK operation. CLI admission requires
explicit native run and project/folder. Seven registration/refusal tests and
runtime-test compilation pass; no native geometry execution is claimed.

The historical annular-sector Y expectation conflicts with the declared outer-arc
extremum. B_NATIVE_SOLIDS_ASSUMPTIONS.md records the calculation and production
recipe boundary. The expectation and tolerance are preserved; qualification is
blocked pending an evidenced C/G review. This is separate from transaction
settlement and journal blockers. Native execution remains deferred.

## Delivery ledger — restore creation-time active-document proof

Native solid catalog PR #93 (`b73f7f4`) registers the saved native sequence and
its explicit bound conflict. The non-transaction regression ran 204 tests: 203
passed and one could not create a temporary directory because this host has no
`/tmp`. All three tests in that same broker-path file passed unchanged with an
explicit workspace TMPDIR. This does not include the blocked transaction file.

The removed legacy active-document assertion is now restored at creation
completion, before any later guarded activation can mask failure. Both the returned
result and durable creation receipt record the observed active creation ID. A
known inactive creation fails before export/save, then closes only its proven
owned document. Contradictory observations defer cleanup; recovery reads the
original successful result without replay or promotion to a passed scenario.

Four new MCP/addin fault tests and 22 existing runner tests pass. They retain a
separate saved document with independently verified parameter state and active
identity. The historical mapping names the exact predecessor SHA, not a fabricated
current assertion ID. Saved/reopen/revision/recovery regression is running. Native
activation semantics still require later qualification.

Creation-proof regression: all 58 saved/reopen/revision/command-settlement tests
pass, plus all three disposition/predecessor checks. Together with the 26 runner
and new activation tests this is 87 passing focused tests. Runtime-test compilation
passes. These results do not include or resolve the blocked positive transaction
profile, and exact-head full CI remains required before merge.

The immutable pose component profile at `c51dacf` has now passed both MCP and
addin with complete cleanup. Source hashes before and after both runs are identical:
`9109371b62dcd5f3f08995d5aa08ced778b1b01964c966df8f2ad7e8513db653`.
This is production-checker/model evidence, not native Fusion qualification.

## Delivery ledger — design-local material metadata

Creation proof PR #94 (`c521ea7`) carries the restored historical activation gate.
The immutable production-checker animation profile has passed MCP at that head
with identical before/after source hash `32035565...`; addin is still running.

Model v15 adds an explicitly synthetic read-only library and design-local material
metadata collections. Copies detach names/descriptions, retain design ownership,
refuse library/closed-document mutation, and survive saved revision/reopen with the
supported graph. No physical/visual properties, density, mass, assignments,
inheritance, appearances or rendering are modeled or claimed by this delivery.

The shared material prefix preserves the historical library selection, exact local
copy IDs, rename, second copy, collision rejection and list readback. Independent
metadata readback and revision/reopen add persistence checks. Both transports pass
at concurrency 1/2/10 (28 saved fixtures). Loss tests recover original copy evidence
without replay; a protected saved document remains unchanged after deterministic
foreign-ID substitution, and assertion failure cleans the owned file before any
rename. Eleven distinct material tests and four profile/disposition checks pass.

Strict simulator typing has zero errors; the pinned API verifier passes 72 methods
and 58 property accessors against snapshot `83dc3697...`. Fourteen additional
historical assertion mappings are recorded (112 total reviewed mappings, including
18 native obligations and one removed historical assertion). This is partial style
migration; appearance/property/assignment/mass contracts remain open. Full
non-transaction regression and exact-head CI are still required.

## Delivery ledger — restore exact legacy expectations

Material PR #95 (`ce0cef6`) passed all 219 non-transaction scenario tests with a
writable workspace TMPDIR. The immutable animation production-checker profile at
`c521ea7` passed both MCP and addin with complete cleanup and identical source
hashes (`32035565aaff971c47b9b67b046c15a2b47818001580805fb9b44d0433eae800`).
These are model/checker results; native execution remains deferred.

Auditing the retained parameter/plane/component families against `live-legacy.js`
found a strict value assertion weakened to a tolerance and several textual list
assertions replaced only by state readback. Restore strict equality to 2 and the
rename/delete/angle/parent list outputs, retaining the additional independent state
checks. Negative fault tests inject a 5e-10 value error or wrong list text while
leaving the actual model unchanged; both transports must fail and clean the owned
fixture. No production implementation or historical expectation is weakened.

Twenty individual legacy assertions now map to the existing parameter, plane,
component, units and 10 mm box/rollback families. The ledger contains 132 reviewed
mappings, including 18 native obligations and one predecessor-only assertion.
Legacy native PNG, STEP/STL, unsaved lifecycle and remaining wrapper/ownership
assertions are still open; this does not mark the complete suite migrated.

Legacy expectation validation: all 42 focused parameter/document/box and injected
regression tests pass, plus the disposition check. Runtime-test compilation passes.
The immutable material component profiles are now running at `ce0cef6`.

## Integration checkpoint — confirmed CI blocker

Main was fetched again and remains `6c9f6c5`. PR #96 (`a585110`) contains the
43 passing focused legacy/disposition checks. No dependent B PR has been merged.
Exact-head CI for #78, #88 and #89 fails the scenario-unit steps in both Node
contract jobs; the other 20 jobs pass. Decoded #89 Linux logs confirm seven
transaction failures, all at the original no-eval command's explicit unknown
outcome. B_COMMAND_SETTLEMENT_BLOCKER.md contains run/job links and the exact
failure boundary. This is not explained by the local host's missing `/tmp`.
Newer descendant CI runs remain queued at this checkpoint.

Remaining package work is substantial and is not marked complete: individual
assertion dispositions and intermediate-history/port review; import/export and
reference lineage/source pins; broader sketch/component/feature semantics;
appearance/assignment/mass, joint/motion/UI contracts; and G's final required
broker/native registration. There are 132 reviewed mappings (131 current sites
plus one removed predecessor assertion) against 3,707 current static sites; wrapper
sites overlap, so these counts are not runtime coverage percentages. Model v15 and
16 supported-family registrations are intermediate deliveries, not B1–B4 exit.

The transaction contract requires production-owner work outside B before full CI
can pass. Keep its positive tests required, preserve original literals/assertions,
and do not replace the unknown result with a synthetic known rejection. Native
Fusion stays deferred and keychain remains excluded. The material production-checker
profile at `ce0cef6` is still running in the immutable verification checkout.

## Appearance metadata prefix — v16

The shared appearance family retains the original live-design-styles local/library
list, safe source ID selection, actual copy ID, copiedFrom, rename, changed-fields
and nullable projection assertions. Twelve individual frozen assertions map to
this prefix; wrapper sites and the later texture/assignment sequence remain open.
Independent metadata readback and saved revision/reopen extend the original checks.
The model provides immutable synthetic library metadata and detached local copies;
null projection is absent fixture data, not a rendered or texture simulation.

Both backends use one scenario body. Required-model registration now proposes 17
families; native execution remains deferred. The pinned SDK verifies 75 methods and
65 property accessors and strict model typing reports zero errors. Validation also
includes foreign saved-document IDs, lost-copy receipt recovery without mutation
replay, closed/library writes, assertion cleanup and rejection of a boolean
projection. Full exact-head CI remains mandatory before merging this dependent
stack; the production command-settlement blocker is unchanged.

Focused appearance validation: six transport/concurrency cases (28 owned saved
fixtures), both lost-copy recovery cases, assertion cleanup, foreign-ID isolation,
read-only/closed resource protection and the boolean-projection regression pass.
The first guard-test run used the nonexistent appearanceLibraries name; correcting
the test to the documented Application.materialLibraries made both failing checks
pass without changing model behavior. Three profile-registration checks and the
individual-disposition gate pass. The broader nontransaction regression is running;
required transaction tests remain failing for the documented production blocker.

## Appearance validation and body style assignment follow-up

PR #98 (`282e596`) contains the appearance metadata prefix. All 235 nontransaction
scenario tests pass, including the final corrected guard tests. Required positive
transaction tests remain excluded only from this explicitly scoped local result;
they stay required in full CI. The immutable material production-checker profiles
at `ce0cef6` pass through MCP and addin with complete cleanup and matching source
hash `5ca23a95aeba40fd96d4e8fe602f3fedb4f6ed759aa67a0b952e27a9a4727734`.
The appearance production-checker profiles now run at immutable `282e596`.

The next shared family retains the style suite's 4 x 5 x 6 mm box, appearance
assignment/map and material assignment/map counts/IDs, and renamed local appearance
list check. Both backends use the same steps. Independent body getters, 120 mm3
volume and saved revision/reopen add readback evidence. Local resources must belong
to the exact design. The model supports explicit root-body assignment only; library
or foreign resources, override clearing, inheritance and nonempty assembly-context
enumeration remain unsupported. This is not a claim of native material density,
mass, face/occurrence overrides or rendered appearance. The historical texture
probe remains a separately open obligation and is not replaced by canned output.


The assertion ledger now has 157 reviewed mappings (156 current sites plus one
removed predecessor assertion), including 18 native-solid obligations. Thirteen
body-assignment assertions are mapped individually. Strict typing is clean and the
pinned API verifier covers 75 methods and 70 accessors. Required-model registration
contains 18 bounded families; none of these counts marks B1–B4 complete.

CI #90 at `55a31a8` also fails both contract jobs; all other 20 jobs pass. The decoded
Node 24 log (job 128986990913, run 42564190010) shows seven transaction failures with
the same explicit unknown command outcome. This reinforces the existing blocker;
no dependent branch is eligible to merge.

Focused assignment validation: all six transport/concurrency combinations (28
saved fixtures), both lost-assignment recovery cases, foreign body-token isolation
and assertion-failure cleanup pass. The guard test initially used an existing
session directory and omitted the required box name; after fixing its setup, the
foreign/library/closed-target checks pass without changing model behavior. Four
registration/disposition tests also pass. The final nontransaction regression is
running on the corrected sources; the earlier 10/11 test run is not called green.
The immutable appearance MCP component profile passes with complete cleanup and
matching source hash `1c169b45a431d83e306c93653ed48e53d3385c949515feb0a7eb832c6eabeb44`;
its addin profile is running. Full CI remains the mandatory merge gate.

## JavaScript-to-TypeScript assertion syntax review

PR #99 (`c691d72`) preserves the explicit root-body style assignment fragment.
Its corrected nontransaction regression reports 245/246 passing. The sole failure
was the unstaged generated src/queue-broker module in the new worktree; after the
normal stage-queue-runtime step, all three unchanged broker-path tests pass. The
first broad run is retained as 245/246, not relabeled as a clean full run. All 11
assignment checks pass on the corrected sources in that regression.

A separate review ledger now pairs 138 of the 396 removed port assertions with
unique current expressions using deliberately narrow syntax normalization. It
preserves regexes, literal content, operators, optional access and array holes,
rejects malformed/multiple-expression fragments and leaves ambiguous pairs open.
The remaining 258 sites are explicitly listed. Frozen commits/hashes and IDs bind
the evidence to the already audited predecessors. This reduces syntax-review work;
it does not assert changed helper behavior equivalent or increase migration coverage.
Eight focused audit tests and runtime-test compilation pass. Full exact-head CI
and the unresolved production transaction contract still prevent stack merging.

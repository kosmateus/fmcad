# fmcad refactor completion plan

Reference: GitHub `a80b7753e47b8260c2de362b6c4fad04025ab1b2` and the original
archive, including Git history, worktrees and Beads. Keychain was deliberately
removed; neither its implementation nor its tests will be restored.

Stage 1 and stage 2a are merged into `main`. Their evidence is recorded in
[stage 1](REFACTOR_STAGE_1.md) and [stage 2a](REFACTOR_STAGE_2A.md).
Saved-file support and cleanup recovery were merged in PR #3; see
[stage 2b](REFACTOR_STAGE_2B.md).
PR #4 merged [parameter commands and contracts](REFACTOR_STAGE_3A.md),
including inherited document-selection and deletion-reporting defects.

## Delivery order

Finish every part of the refactor that can be implemented and checked with the
mock backend, production checker and real broker. Native Fusion testing is a
single final qualification stage after the refactor, as requested by the owner.
It does not block intermediate implementation or merging verified changes.

Every delivery must pass the complete CI matrix before merging to `main`.
Keep PR descriptions and commit messages short; put detailed evidence here or
in the corresponding stage document. Do not upload the archive's Git directory,
worktrees, generated reports or unrelated Beads data as repository source.

A green mock run proves only its declared model behavior. Keep a separate list of
assumptions for native qualification; do not silently turn unsupported behavior
or an unexecuted live case into a pass.

## Historical reference and evidence

The pre-TypeScript reference is `a26222ff617b0e9597b2a91b50474bdca8d0a0ce`.
The tool migration starts later at `8b0be07`. Keychain removal (`46a1ff2`)
predates the reference. The complete archive remains available locally.

The comparison below concerns source and assertions, not a new native run.
The frozen baseline covers 15 selected observations. An October 23 response
recovery report records two Fusion runs, but does not establish that every live
suite passed at this exact SHA. Other reports include interrupted runs or lack
complete version identification. Native Fusion is unavailable in this environment.

| Historical suite                    | Behavior to preserve                                                                                                                                          | Changes during the refactor                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `live-legacy.js`                    | Document ownership; parameter and plane CRUD; components; cm/mm/in; a 10 mm box, stats/bbox/bodies; rollback; PNG/export; preservation of other documents     | Byte-identical to the reference                                                                                      |
| `live-cad.js`                       | Dimension regeneration; bodies, holes/patterns/fillets; definitions and occurrences; measurements; rejection without extra entities; timeline and checkpoints | Byte-identical                                                                                                       |
| `live-extended.js`                  | Sweep/loft/shell/chamfer/combine/split/draft; patterns/mirrors; joints; clearance/interference; failed batch checks; visibility, camera and cleanup           | Byte-identical                                                                                                       |
| `live-feature-modes.js`             | Extrude, hole, sweep and loft variants; dimensions, volumes, bounds and timeline health                                                                       | Byte-identical                                                                                                       |
| `live-motion-animation.js`          | Joint limits before posing; five frames; workspace/storyboard; rejection of empty play; workspace restoration                                                 | Byte-identical                                                                                                       |
| `live-definitions.js`               | Literal definitions; runId idempotency without repeated mutations; stop after a failed check; numeric dimensions; syntax rejection                            | Adapter disposal changed to `disposeBackend`; behavioral assertions retained                                         |
| `live-style-save.js`                | Material/appearance precedence; reference validation; mass; unsaved document status; local roundtrip                                                          | Generated typed-request separator changed; behavioral assertions retained                                            |
| Runner and `helpers/live-broker.js` | Client identity, ordering, ownership, settlement and no replay of unknown outcomes                                                                            | Infrastructure changed; the current runner requires a shared broker and records concurrency limits and source hashes |

Later tests cover multiple documents, data imports, response recovery, sketch
operations, component hierarchy, attributes, exports, solids/surfaces, styles,
motion and analytics. `run-live all` does not register every existing suite.
Classify each file as a required shared scenario, a special profile or an
explicit unsupported capability. A test of generated source is not a live result.

## Broker findings

| Problem                                     | Evidence                                                                                                                                                                  | Required behavior or remaining check                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scheduling, pause and sequence ownership    | The same three queue tests pass on the reference and current code                                                                                                         | These cases do not demonstrate a migration regression. Keep separate transport and document tests                                                      |
| Retained origin / UI guard                  | Paired tests reproduce rejection by historical checker `f708256` and acceptance by the current checker                                                                    | A later migration regression, not behavior of `a26222f`; retain the real checker                                                                       |
| Audit response protocol                     | Seven cases compare retained code from `843ce0d` with current code                                                                                                        | Missing/nonterminal output must not imply success or permit mutation replay                                                                            |
| Strict inspection                           | All five generated operations now pass the real checker; eight ordinary historical Python cases retain behavior                                                           | Preserve results and effects. Checker rejection must not count as a passed document guard                                                              |
| Pause after context changes                 | Historical acceptance of `PYTHON_CHECK_REJECTED` hid whether the document guard was reached                                                                               | After resume, preparation may be invalidated or the target unavailable; require `not_started` and zero operation submissions                           |
| Catalog worker timeout                      | Replaced module-loader substitution with the supported path adapter. CI also exposed a test observation budget that incorrectly combined separate local and SDK deadlines | Observe both production budgets without changing them; retain final job state and physical call counts. This does not explain every historical timeout |
| Public run with doc-id (`69j.2`)            | The archived open task predates fix `8b2c237`                                                                                                                             | Verify the installed path before closing the task; do not implement the same fix twice                                                                 |
| Duplicate names and failed/wrong activation | Six paired negative cases reproduce unsafe historical behavior; stage 2a rejects it before mutation                                                                       | Require one exact target and successful activation of the same creationId                                                                              |
| Volume read errors reported as zero         | Already present in historical inspection                                                                                                                                  | Stage 3c makes unavailable or invalid volume an explicit error; paired tests preserve valid zero and ordinary measurements                             |

Unresolved historical attribution needs both SHAs run with identical inputs,
Fusion/API versions and assertions, plus broker logs and receipts containing
requestId, creationId, file/version identity, physical call counts and cleanup.
Until that final qualification, mark the attribution as unresolved.

Do not change expected results merely to fit current output. The four stage-1
baseline exceptions are justified individually in
`tests/fixtures/refactor-baseline/migration-allowances.json`. Wrong effects,
identities or call counts remain failures.

## Test backend and shared scenarios

Extend `tests/support/fusion-simulator` and `tests/scenarios`; do not create a
second competing test framework. The pinned Autodesk FusionAPIReference commit
is `07814d19ac63bb3ff0d55e3d35517cf3a71bad8c`, with snapshot
`83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`.
Check implemented call shapes against these definitions. Derive semantics from
historical assertions and later tests, recording any assumption separately.
Types alone do not define a CAD kernel.

Each scenario has one implementation of its steps and assertions. Backends supply
execution, environment identifiers, path mapping, capabilities and transport
results. They cannot change expected values, tolerances or skip scenario steps.
A missing required capability is explicit unsupported status and fails the
required profile. Run the model both directly through production Python admission
and through the real broker over MCP and addin.

Expand coverage in this order:

1. Document identity, saved file lifecycle, partial failure and recovery.
2. Parameter CRUD, literal units, timeline boundaries and invalid inputs.
3. Sketch/component/attribute operations and import/export contracts.
4. Remaining API families, preserving each historical success and failure case.
5. Geometry, motion and rendering only to the extent supported by an explicit
   analytical model; retain native-only assertions for final qualification.

Current parameter cases use the same name with different values across owners,
mm input and cm API values, a `1e-9` tolerance and readback after interleaving.
Saved fixtures must distinguish acceptance from cloud completion and deletion
acceptance from observed absence. Model exports contain marked JSON test state,
not genuine F3D bytes.

Native assumptions to verify at the end: activation and handle lifetime;
null/false/error behavior; units and regeneration; timeline/health; identity
across reopen; cloud save/version/delete visibility; entity binding; lost replies;
native export/import; geometry, poses, rendering and numerical tolerances.

## Isolation, cleanup and concurrency

Each scenario owns a runId/scenarioId/clientId, request IDs, document creationId,
file identity and report directory. The operation selects and activates that exact
document in the same SDK call. A name alone is insufficient. Unsaved-document
cases remain explicit tests of the historical unsaved/export behavior; saved-file
cases must exercise save, exact file/version binding, close, deletion and absence.

Cleanup runs after setup, operation and assertion failures. Preserve the primary
error separately from cleanup errors. Keep the concurrency slot until cleanup
settles. Unknown outcomes require recovery of the original result; never replay
a possibly completed mutation. Deferred cleanup fails the scenario and leaves a
recovery manifest. Recovery must not turn unexecuted assertions into a pass.

Compare other documents and configured-folder files before and after a run.
Restore the original active document where it still exists. Recovery after a
process restart must also restore coordinator state safely. Reject foreign
creation/save receipts and foreign file versions before destructive operations.

Concurrency is configurable. Native Fusion defaults to 10 scenarios. The model
defaults to `min(2, availableParallelism)` until measured worker RSS and container
memory budgets justify a different limit. With measurements, use
`max(1, min(CPU, floor(memoryBudget / workerPeakRSS)))`; host free memory is not a
container budget.

The broker supports up to four offline preparation workers and one physical SDK
queue. Tests must prove overlapping offline work with `max SDK in flight = 1`,
including pause/resume, cancellation and cleanup. Exercise limits 1, 2 and 10.

Use deterministic misrouting tests: substitute scenario B's target or receipt
into A, reject A before mutation, then read B independently and verify no change.
Include duplicate names, active-document changes between preparation/execution,
close/reopen, both transports and cleanup ownership.

## Stages and completion criteria

| Stage                            | Scope                                                                                                                                                           | Dependencies                                                            | Completion evidence                                                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — completed                    | Portable historical fixtures, exact baseline exceptions, strict inspection, broker regressions, restored translations, browser checks and API download handling | Archive and current repository                                          | Full CI passed for the same SHA on Node 22.13/24, Python, Chromium and both transports; merged in PR #1                                                                 |
| 2a — completed                   | Immutable document ownership, request-bound receipts, deferred cleanup without replay, duplicate-name and activation fixes                                      | 1                                                                       | Paired historical cases, fault injection, full CI and both broker profiles; merged in PR #2                                                                             |
| 2b — completed                   | Saved-file model and shared lifecycle; exact file/version ownership; async completion; close/delete/absence; recovery; foreign file preservation                | 2a and pinned Autodesk definitions                                      | Fault injection at every lifecycle boundary; no retained owned files after settled cleanup; other files unchanged; both protocols and configurable concurrency          |
| 3 — backend contracts            | Extend the model and shared scenarios using the historical/later assertion inventory                                                                            | 2b for saved fixtures; each capability may proceed independently        | Every declared capability has matching shared steps and expected results; negative tests; explicit native assumptions. Native execution is deferred to 7                |
| 4 — remaining runtime migration  | Remaining service/entrypoint/adapter JavaScript and Python families; transitional facades; core/ports/adapters boundaries; defects in already migrated code     | 1, 2 and the relevant contract from 3                                   | Small family-sized deliveries, strict types without admission bypasses, CLI/SDK/receipt parity, installed-package tests, no obsolete execution path                     |
| 5 — coverage and Beads           | Inventory all methods/tests; register later suites; reconcile `69j`, `cb4`, `e4m` and duplicates                                                                | 2–4; inventory work can proceed earlier                                 | Each method has effects/readback and negative coverage or a documented gap. `all` includes every required supported profile. Native tasks remain awaiting qualification |
| 6 — Control Center and packaging | Remaining system/global controls; real telemetry/history; agents/projects; retention; demo/TUI retirement; translations and assets                              | 1 and stable broker contracts from 2/4                                  | Chromium against real SQLite/broker composition; no console/resource errors; packaged installation; disposal/localization checks and runtime cost measurements          |
| 7 — final native qualification   | Installed package; both transports; full live profile; restart/lost reply; saved fixtures; native geometry/motion and UI                                        | Offline refactor complete; access to Fusion and dedicated test fixtures | SHA, Fusion/API versions, inputs/assertions, receipts and cleanup recorded; every required case passes. Blocked/unsupported/not-run is never counted as pass            |

The current safe delivery covers [document commands](REFACTOR_STAGE_3B.md):
planes, component hierarchy, units and their shared selection guard. Each delivery
combines the relevant runtime migration with historical comparisons and model scenarios. Continue with the next contract
family and its migration after this delivery passes CI. Native availability is
not a reason to stop the mock-backed refactor.

Stage 1 came first because unchecked inspection typing, inaccessible historical
commits in fresh checkouts and incomplete browser coverage made further changes
hard to assess. These checks reduce false-green tests, lost behavioral parity
and hidden broker defects.

## Archived Beads scope

The archive contains 150 tasks: 104 closed and 46 remaining. Historical task
status is not proof of implementation. Open `69j.2` and several UI tasks already
have later code changes; reconcile them against source and evidence.

- Stages 2–5: `69j`, `69j.2`, `cb4`, `cb4.2`, `cb4.4`–`cb4.8`, `e4m`,
  `e4m.2`, `hex-integration`.
- Stage 6: `control-center`, `control-center.1`, `locale-catalogs`,
  `locale-selection`, `web-system-controls`, `web-agents-projects`, `web-bundle`,
  `web-operational-views`, `web-telemetry`, `browser-console`, `log-retention`.
- Stage 7 and prerequisites: `isc`, `dru`, `dru.2`, `dru.2.5`, `dru.2.6`,
  `native-drive-test`, `live-acceptance`, `hex-integration.2`.
- Separate feature scope, with existing behavior protected during stages 3–5:
  `brep-baselines`, `capture-integrity`, `selection-rules`, `semantic-model-state`,
  `attachment-check`, `channel-check`, `geometry-evidence`, `regional-contacts`,
  `adaptive-clearance`, `invariants-parameters`, `native-interfaces`,
  `native-route-check`, `qualified-recipes`, `rework-plan`, `verify-saved-model`.
  New features need their own implementation and qualification; language migration
  or current CI alone does not complete them.

All identifiers have the `fmcad-` prefix. This mapping retains the outstanding
backlog while distinguishing refactor work from new features.

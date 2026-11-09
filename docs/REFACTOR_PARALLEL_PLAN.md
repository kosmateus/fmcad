# Parallel refactor completion plan

Audited on 8 November 2026 against `main` at
`3c7dc83114c9e9d0cf78f78adb2d5dbb45092d34` (PR #34).
This is the current execution and ownership plan. The earlier
[completion plan](REFACTOR_COMPLETION_PLAN.md) and stage reports remain the
historical evidence ledger; their old “remaining” lists are not new assignments.

## Sources and verified starting point

- Current source: <https://github.com/kosmateus/fmcad>. The default branch is
  **main**, not master. Fetch it before starting and before merging.
- Original archive with Git history, worktree metadata and Beads:
  <https://drive.google.com/file/d/1hwOc_iKIpt5zpTPEuBrdWj2NX1oUip1e/view?usp=drivesdk>.
  Keep it separate from the working checkout. Do not upload its Git directory,
  generated builds, reports, worktrees or database into the source repository.
- Pre-TypeScript reference: `a26222ff617b0e9597b2a91b50474bdca8d0a0ce`.
  Toolchain migration: `8b0be07560f293cf5c373b51eecb7df9e8e714cf`.
  Use the immediate predecessor of each later change as a second reference.
  Keychain was intentionally removed and is outside all work packages.
- [CI for the audited main commit](https://github.com/kosmateus/fmcad/actions/runs/42482583940)
  passed all 22 jobs. This covers the selected offline matrix, not every test file
  in the repository and not native Fusion qualification.
- The archive was downloaded and extracted again for this audit. All 28 frozen
  historical fixtures match their recorded SHA-256: 14 verified against archive
  commits and 14 against later GitHub commits. Five major historical live suites
  are byte-identical; definitions changes only backend disposal, and style-save
  changes the generated request separator. Existing assertions remain evidence.
- Current inventory: 36 live/helper files = 21 pending, 4 partial, 5 native-only,
  6 helpers. The eight shared families are foundation, saved, parameters,
  documents, cloud, boxes, attributes and sketches. None represents a complete
  replacement of all historical and later live suites.
- Source inventory contains 170 tracked JavaScript files under `src` (98 exceed
  40 lines), 149 Python files under `runtime/python`, and 49 under `assets/cad`.
  These are scope indicators, not migration percentages: many files are facades
  or deliberate loaders, while extracted Python can still contain coupled logic.

## What is already delivered

Do not reimplement stages 1, 2a/2b, 3a–3i, 4a–4r or 5a–5d. Recheck their
contracts when changing their consumers. Delivered work includes historical
fixtures, exact document/file ownership, saved-fixture cleanup/recovery,
parameter/plane/component/cloud contracts, analytical boxes, body attributes,
rectangle/coordinate scenarios, typed CAD/run/batch/save composition, journals,
clock budgets, invocation context, request preparation and stage ownership.

Already fixed defects include ambiguous document/component selection, volume
errors reported as zero, duplicate native results, foreign atomic receipts,
contradictory batch receipts, historical null-selector replay, inverted run guard
submission evidence, missing save intent and artifact verification classification.
The six gaps listed in stage 4e must not all be reopened: stages 4f and 5a already
fixed artifact classification and stale helper/definition fixtures.

## New audit findings and first delivery

Six retained broker regression files are absent from the commands reached by
`.github/workflows/ci.yml`: `queue-scheduling`, `queue-cloud-save`,
`queue-document`, `queue-native-receipt`, `queue-probe-recovery` and
`queue-snapshot-size` (all under `tests`, with `.test.js`). `npm test` discovers
them, but CI does not invoke that aggregate. Related newer integration coverage
does not establish that these exact assertions execute.

The three historical sequence/ownership/pause cases pass both at `a26222f` and
at current main, with a writable temporary directory and unchanged assertions.
This does not show a scheduling regression. The full six-file selection gives
20 passes and 7 failures in this host: five need Linux `/proc` process evidence
(including the Python metadata probe), and two need explicit offline WSL path
fixtures. These are not seven demonstrated product defects. Run them on Linux CI,
repair only unsupported fixture assumptions, and investigate any remaining real
failure against both source revisions. Preserve physical call counts and guards.

The new local audit also passed the pinned build, test typecheck, 123 shared
scenario tests, simulator typecheck and API-shape verification (57 methods and
21 property accessors). Full local regression results and limitations are in
the [broker plan](refactor-agents/A_BROKER.md); the Linux CI result above remains
the successful whole-matrix evidence for the audited commit.

**Agent A owns the first delivery:** restore these broker gates and their
historical comparisons, then continue admission/recovery migration. One safe PR
contains one behavioral boundary or this six-file gate repair plus its fixture
fixes. A work package is intentionally much larger than one PR. Do not combine
admission, epoch recovery, CAD geometry and UI migration in a single change.

## Work packages and ownership

Agents A–F may start independently after reading current main. G can audit in
parallel, but final integration and facade removal wait for their deliveries.

| Agent                                 | Large work package                                                                     | Primary ownership                                                                                | Dependencies and completion                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — current coordinator, reserved** | [Broker correctness, admission and recovery](refactor-agents/A_BROKER.md)              | Queue/runtime control, execution/admission, recovery receipts, broker tests                      | First restore missing gates; then migrate bounded families. Unknown results never replay; offline work overlaps while SDK concurrency stays one.                                 |
| **B — available**                     | [Shared Fusion backend and live scenario migration](refactor-agents/B_SCENARIOS.md)    | `tests/scenarios`, simulator, `tests/live-*`, live inventory and runner                          | Extend existing framework; coordinate production fixes with A/C/D. Every live assertion mapped; supported shared profiles use identical steps and results with model/Fusion.     |
| **C — available**                     | [CAD modeling services and Python runtime](refactor-agents/C_MODELING.md)              | Modeling service adapters, geometry/assembly/entity Python, corresponding non-live tests         | Preserve public contracts supplied to B/E. Complete service boundaries and types with paired history, meaningful readback and negative cases.                                    |
| **D — available**                     | [Files, import/export, references and publication](refactor-agents/D_FILES.md)         | Data import, reference refresh, externalization, drawing/file workflows and their non-live tests | Use A's existing receipts and provide fixtures to B. Exact file/version lineage, no retry of unknown mutations, durable publication and cleanup.                                 |
| **E — claimed by Agent E**             | [Public CLI, MCP, SDK and remaining host adapters](refactor-agents/E_PUBLIC_API.md)    | Public entrypoints, CLI/help/catalog registration, host/tool adapters, API consumers             | Preserve routing to A/C/D. Typed installed interfaces, stable errors/results, no private workspace imports or accidental direct Fusion path.                                     |
| **F — available**                     | [Control Center completion and TUI retirement](refactor-agents/F_CONTROL_CENTER.md)    | `packages/control-center`, console UI/assets/locales/read models and browser tests               | Use A's control API; coordinate public exports with E. Real broker/SQLite browser evidence, lifecycle/retention/localization, planned retirement of obsolete UI.                 |
| **G — integration owner, available**  | [Coverage, Beads, packaging and final qualification](refactor-agents/G_INTEGRATION.md) | Cross-package inventory, shared build/CI configuration, packaging, acceptance ledger             | Audit now; integrate A–F after their merge gates. Close offline refactor only with full inventory and installed-package evidence; prepare and later record native qualification. |

Directory ownership is refined in each linked plan. Explicit exceptions win over
broad prefixes: A owns broker control even if consumed by console; D owns
reference/import/externalization even if invoked by CAD; B owns live test files;
E owns public registration; G owns shared build/CI files. A's first gate repair
is an explicit bootstrap exception for `package.json` and the CI workflow.

## Delivery stages

| Stage                         | Scope                                                                                                               | Dependencies                                                                            | Exit evidence                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — planning                  | Merge this plan and seven detailed assignments; A reserved, others unclaimed                                        | Audit of current main and archive                                                       | Plans linked, disjoint owners, CI green on plan PR                                                                                      |
| 1 — parallel implementation   | A–F execute complete packages through small PRs; G inventories coverage and Beads                                   | Stage 0; existing typed/model foundation                                                | Each family has history comparison, compiled contracts, passing relevant tests and full CI before merge                                 |
| 2 — cross-package integration | Shared scenarios consume final production routes; migrate remaining tests; retire obsolete paths; reconcile backlog | Delivered A–F interfaces; B capability inventory                                        | All required offline cases run, no unexplained drops, installed CLI/MCP/SDK and browser tests, clean package/build                      |
| 3 — native qualification      | Same scenario bodies on real Fusion, both transports, saved files, loss/restart and native geometry/UI              | Offline refactor complete; matching installed build and dedicated Fusion fixture folder | SHA/API/Fusion versions, assertions, receipts, counts and cleanup recorded; no required blocked/unsupported/not-run cases called passed |

Native access is not available to this coordinator. As previously requested,
native tests are deferred until the offline refactor is finished. Their absence
does not block stage 1/2 work; it does prevent declaring native qualification
complete. G prepares the runbook and machine-readable outstanding evidence.

## Rules shared by every agent

1. Read this plan, your own assignment, the historical ledger and applicable
   repository instructions. Fetch current main and inspect merged PRs before
   coding. Claim your assignment in its status block; do not take reserved A.
2. Branch from current main. Use English plans, short natural English commit
   messages and PR descriptions. Commit only relevant source/tests/documentation.
3. For a failure, compare the same inputs and assertions before/after the relevant
   change. A later-introduced module may not exist at the pre-TypeScript baseline.
   Classify inherited defect, migration defect, fixture drift or unresolved.
   Justify every expectation change with required behavior, not current output.
4. Use pinned Autodesk interfaces for call shapes; derive behavior from historical
   assertions and newer scenarios. Do not weaken production Python admission,
   process identity, ownership, source hashes or receipt checks to obtain a pass.
5. Keep request/client/run/document/file/version identity through every boundary.
   Unknown post-submit state is recovered from the original evidence, never by
   repeating the mutation. Preserve the original failure alongside cleanup errors.
6. Every scenario owns its Fusion file and report directory. Saved fixtures observe
   save completion, close, delete and absence. Unsaved/export cases remain explicit
   historical lifecycle tests. `finally` handles known failures; uncertain cleanup
   remains failed/deferred with a recovery manifest. Never delete another fixture.
7. Fusion defaults to 10 concurrent scenarios; the model conservatively defaults
   to `min(2, availableParallelism)`. Keep limits configurable and test 1/2/10.
   Current broker offline workers are bounded at four; physical SDK concurrency
   remains one. Ten scenario owners does not mean ten concurrent Fusion API calls.
8. Add deterministic cross-owner routing and receipt substitution tests, including
   independent readback of the protected document. Test setup/operation/assertion/
   cleanup failures and lost replies. Keep native-only capabilities explicit.
9. Do not edit another package's files silently. Describe a dependency with exact
   file/symbol/contract and a proposed patch in the PR; let its owner or G integrate
   it. Shared registries/configuration changes belong in a separate small commit.
10. Run relevant checks locally, then the full CI matrix on the exact PR head.
    Fix failures; an unchanged rerun requires an explanation and retained evidence.
    Recheck current main before merging. Do not force-push over other agents or
    merge with stale checks. Keep branch-specific work isolated from other agents.
11. Each PR updates its assignment's evidence ledger with SHA, tests, limitations,
    native assumptions and remaining scope. An intermediate PR is not completion
    of the large package. Continue until its exit checklist is met or record a
    concrete cross-owner dependency for G; do not silently shrink scope.
12. A green typecheck, generated source, mock export or rename from `.js` to `.ts`
    is insufficient behavioral evidence. No new keychain work; no unrelated new
    product features. Existing feature behavior stays protected during migration.

## Integration contract and backlog

All agents keep public signatures stable until a coordinated change is merged.
B supplies reusable scenario fixtures; C/D supply runtime behavior; A supplies
execution/identity/recovery; E supplies installed public paths; F consumes those
paths; G joins their evidence and owns final deletion of transitional facades.

G must reconcile the archived Beads database rather than trust old task status.
The earlier ledger reports 150 tasks, 104 closed and 46 remaining; this audit
confirmed the embedded Dolt store is present but did not independently re-export
it. Existing mappings in `REFACTOR_COMPLETION_PLAN.md` retain the scope. New feature
requests are separately recorded and must not be counted as refactor completion.

No final “done” until every runtime family and public method has an owner and a
disposition, every required offline scenario is executed, every remaining native
assertion is explicitly assigned to stage 3, and all packages are integrated on
main. Native completion is a separate, evidence-backed milestone.

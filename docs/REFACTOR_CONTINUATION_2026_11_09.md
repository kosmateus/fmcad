# Refactor continuation and integration checkpoint — 9 November 2026

This checkpoint supersedes the delivery order and stale status labels in
[the parallel plan](REFACTOR_PARALLEL_PLAN.md), not the scope of its seven packages.
Plans and commits remain in English. Keychain is intentionally excluded.

## Verified sources and scope

- [Repository](https://github.com/kosmateus/fmcad), audited main:
  `6c9f6c5a1c98d0e6413e6cea006e725e25063836`.
- Original archive supplied privately by the project owner:
  downloaded again (196,879,449 bytes), extracted separately, containing 141 Git
  refs, worktree metadata and embedded Beads data. Never publish these private
  stores or archived reports in the public repository.
- Pre-TypeScript reference: `a26222ff617b0e9597b2a91b50474bdca8d0a0ce`;
  toolchain migration: `8b0be07560f293cf5c373b51eecb7df9e8e714cf`.
  Later mechanisms require their own immediate predecessor.
- All 34 frozen fixtures on the A integration candidate match both manifest
  SHA-256 and original Git bytes (16 from the archive, 18 from GitHub history).
- Direct old/current comparison confirms identical live-legacy, live-cad and
  live-extended sources. Backend-adapter and definitions change backend disposal;
  style-save changes its generated-request separator. live-design-styles does
  not exist at the original reference: use its later predecessor.
- These checks establish source provenance, not proof that every historical live
  suite passed. Missing native evidence remains missing.

The snapshot contains **48 open PRs: 14 with successful CI and 34 with failed CI**.
A successful branch is not automatically ready: dependencies, newly required
tests, review and current-main integration still matter. The table below records
the exact branch head and observed run, rather than trusting PR descriptions.

## Existing work: preserve rather than repeat

Main already includes the typed CAD/run/batch/save foundation, durable journals,
ownership and recovery gates, public library/MCP/catalog/help migrations,
Control Center foundations and eleven bounded shared scenario families through
saved revisions/reopen and dimensioned rectangles. Earlier stage ledgers remain
the evidence source, not a list of new assignments.

Unmerged branch tips contain substantial additional work:

| Package | Pending stack, oldest first | Actual next action |
| --- | --- | --- |
| A | #51 → #56 | Integrate admission, authenticated epoch evidence and cross-owner publication on current main; then finish remaining A3/A4 controllers. |
| B | #70 → #72 → #75 → #78 → #88 → #89 → #90 → #91 → #92 → #93 → #94 → #95 → #96 → #97 → #98 → #99 → #100 | Resolve production settlement and inventory failures before accepting the stack. Keep the stricter unknown-outcome checks. |
| C | #37 → #47 → #57 → #61 → #65 → #82 → #66 | Repair newly exposed fake-platform, baseline and loader expectations; integrate complete registration/admission gates. |
| D | #38 → #49 → #53 → #54 → #55 → #59 | Explain and repair exact generated-artifact baseline drift, then qualify files/publication as a combined candidate. |
| E | #71 → #73 → #76 → #80 → #81 → #83 → #84 → #85 → #86 → #87 | Qualify real installed consumers; coordinate console/telemetry composition with F. |
| F | #60 → #69 → #74 → #77 → #79 | Repair browser and telemetry regressions, retain durable recovery evidence, then finish TUI retirement. |
| G | #40 | Fix expanded broker profile execution/timeouts and contract failures; regenerate inventory after each accepted stack. |

The G branch reports 674 runtime files, 420 public executable routes, 494 test
sources, 250 registered sources and 244 gaps at its pinned main. These are its
inventory results, not percentages of refactor completion. It reports independently
reconciled Beads totals of 150 / 104 closed / 46 remaining. This session confirms
the archive data exists but has not independently re-exported Dolt; reconcile
individual tasks again against integrated code before final closure.

## Historical behavior and broker attribution

| Evidence | Classification and required behavior |
| --- | --- |
| Queue owner/release, dependent sequence and pause comparisons at a26222f | Existing paired tests preserve the same outcomes; no scheduling regression established by these cases. |
| Admission observer replacement, changed receipt/request binding (#51) | Module introduced after the original baseline; defects in earlier refactor mechanisms, reproduced against 843ce0d and immediate predecessors. A certificate must authorize the same retained object and exact request. |
| Epoch qualification/identity/request separate-read races (#56) | Later refactor mechanism, compared with bed4300. Hash and parse the same authenticated bytes; never switch authority to an unauthenticated request namespace. |
| Shared pending recovery-publication promise (#56) | Reproduced against 5102259; history traces it to 303ae42. Distinct owners must not receive one another's activation or publication error. Same-receipt polls may join; publication retry must not repeat SDK mutation. |
| B transaction failures after settlement hardening | Confirmed in Linux CI, including #100: seven positive transaction tests fail because the original no-eval command remains unknown and cleanup is deferred. Compare command result, SDK termination and receipt evidence against the pre-hardening path; attribution to native Fusion is unresolved. Do not label an unknown result a successful rejection. |
| G expanded reopen/revision/rectangle profiles | Actual CI timeouts (exit 124), including addin/reopen/concurrency 1. Preserve artifacts; establish per-stage timings and journal/worker state before changing budgets. Concurrency alone does not explain a concurrency-1 timeout. |

The original tests cover document creation/activation/close, parameter and unit
changes, planes/components and lists, primitive bounds/volume/rollback, backend
transport behavior, definition references/replay/negative batches and style/save
roundtrips. Later suites add import receipts, fixed-source admission, native
feature modes, design styles, motion/animation, response recovery, multi-document
ownership and installed stdio. Use B's per-assertion ledger for the full mapping.

B's latest branch records 3,707 current static assertion/helper sites and 157
reviewed mappings (including 18 native obligations and one removed predecessor
assertion). Its port review pairs 138 of 396 removed expressions syntactically;
258 remain open. Syntax equivalence is not behavioral equivalence, and helper
sites overlap. Do not turn these counts into coverage percentages.

B found and repaired a weakened parameter equality and omitted textual list
checks (#96), historical step order (#91), and creation-time activation proof
(#94). Preserve exact values/list text/order; independent state readback supplements
them. Native annular-sector bounds have an unresolved analytical discrepancy:
retain the assertion until historical/current execution on the same Fusion
version establishes the correct geometry and justifies any expectation change.

For unresolved native failures collect the exact old/new SHA, Fusion/API version,
inputs, source hashes, request/job/client/document/file/version identities,
original receipt and termination events, physical call counts and cleanup state.
A missing historical report or unmatched environment cannot prove a regression.

## Fusion test backend and isolation

Extend the existing simulator; do not create a competing mock architecture.
Its SDK shape is checked against pinned Autodesk commit
`07814d19ac63bb3ff0d55e3d35517cf3a71bad8c`, snapshot
`83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`.
Types establish interface shape only. Historical assertions and later tests define
the supported behavior. Independent readback and injected defects prevent a model
that merely echoes expected outputs.

Each shared scenario body must execute identical requests, order and assertions
with model or Fusion. Backend adapters provide transport and capabilities, not
different expected answers. Unsupported native kernel/rendering behavior must be
explicitly unqualified, never synthesized as a pass. Model JSON is not an F3D
roundtrip. Remaining native assumptions include solver/timeline behavior,
geometry tolerances/topology, export/import formats, cloud visibility/version
completion, SDK lifetimes/activation, appearance inheritance/mass, camera/UI state,
command destruction and process restart.

Every scenario creates and saves its own file in a dedicated folder, records
creation/file/version identity, verifies mutation through independent readback,
closes, deletes and verifies absence. Register cleanup before assertions.
Operation/assertion failures still run cleanup. An uncertain mutation or foreign
receipt must defer destructive cleanup with an original-evidence recovery
manifest; blindly deleting an unproven file would violate isolation. Preserve the
original failure alongside cleanup errors. Retain separate historical unsaved
lifecycle obligations rather than silently replacing their assertions.

Keep configurable concurrency, Fusion default **10**, model default
`min(2, availableParallelism)` subject to the existing resource checks. Measure
CPU/RSS/checker cost before raising it. Run 1/2/10 against MCP and addin; test both
ten distinct owners and small failure-focused groups. The broker must overlap
offline preparation (currently bounded at four workers) while serializing actual
Fusion SDK calls to one lane. Test pause, cancellation, worker death, reply loss,
restart and late termination without replay.

A deterministic cross-routing test substitutes B's document/file/token/receipt in
A's request, requires rejection before mutation, then reads B independently and
checks its sentinel unchanged. Check physical call counts as well as response
labels. Global camera/UI scopes drain in-flight owners and restore global state.

## Execution stages and completion gates

| Stage | Scope and dependencies | Exit evidence |
| --- | --- | --- |
| 1. Integrate verified broker foundations | A #51/#56 on audited main, preserving original commits; update this continuation ledger. No unrelated C/D/E/F stack in this candidate. | Provenance checks, admission/epoch/publication regressions, staging and installed consumer checks; full CI on exact candidate and eventual main. |
| 2. Unblock scenario truth and execution | A production settlement diagnosis with B #78–#100; G registration and timing diagnosis. Depends on stage 1 receipt/owner contracts. | Positive and negative transaction scenarios pass without fabricated settlement or replay; native-solids inventory classification repaired; reopen/revisions/rectangles run through broker on both transports at 1/2/10. |
| 3. Integrate modeling and file stacks | C and D candidate branches, separate from stage 2 until stable interfaces exist. | Historical comparisons, exhaustive real Python admission, import/source/version lineage, delayed cloud outcomes, partial failures, immutable plans and recovery/publication cleanup. All required tests actually registered. |
| 4. Complete shared historical/new scenarios | B uses final A/C/D behavior; preserve existing model capabilities. | Each assertion has semantic disposition; imports/exports, references, broader sketches/features/components, styles/mass, joints/motion/UI covered or explicit native obligations. Identical scenario bodies, isolation and failure cleanup verified. |
| 5. Integrate public and Control Center paths | E and F, coordinated telemetry and console launcher; may proceed independently of modeling fixes. | Installed CLI/MCP/SDK/OpenCode, framing/errors/help/preflight; real broker/SQLite browser controls, filtering races/disposal/retention/locales/assets. Feature-by-feature TUI parity or documented retirement before deletion. |
| 6. Finish remaining runtime migration and acceptance | A3/A4 controllers, remaining C/D/E/F checklist items; G joins all prior stages. | Every runtime/public route/test/Beads item assigned and resolved; required offline tests executed; strict test migration and facade removal only after consumers move; clean/incremental tarball installs and startup/memory/package measurements; integrated main CI green. |
| 7. Native qualification | Only after offline completion, on matching installed build and dedicated Fusion folder. | Same scenarios through MCP/addin, 1/2/10, exact versions/hashes/receipts/call counts, kernel/cloud/UI evidence and final cleanup inventory. Resolve failures with old/new comparisons and rerun affected qualification. |

Remaining A scope explicitly includes original-result/audit reconstruction,
epoch succession and runtime/checker upgrades, saved-fixture controls, physical
instance identity/reset and integration interleavings. C includes complete
modeling service/Python boundaries and contracts; D includes the full
import/reference/externalization/save/drawing/export checklist; E includes all
public and host adapters; F includes feature reconciliation and actual retirement.
No branch tip or green typecheck closes a package.

The safe first iteration is **one current-main integration of A #51/#56 plus
this audited plan**, not 48 simultaneous merges. It protects request authority,
cross-owner publication and recovery before broader scenario integration.
Existing paired tests are the first gate because these defects can otherwise
misattribute results or release the wrong owner even when geometry looks correct.
If that candidate fails, repair the demonstrated boundary with a historical
reproducer before merging. Follow with separate bounded stack integrations;
do not manufacture completion by merging green ancestors around known failing
descendants.

## CI blockers read directly from logs

- #100 run 42570882067: seven transaction unit failures; additionally the
  live-suite inventory rejects unclassified `native-solids`.
- #66 run 42539039802: Node 22 regression log has two BRep fake-backend WSL
  platform failures, frozen capture mismatch and compatibility-loader mismatch.
- #59 run 42530843571: both regression jobs fail the frozen capture, including
  a stale exact generated-CAD allowance. Review generated bytes before updating it.
- #87 run 42545679904: installed/public consumer failures, browser fixture
  timeout and regression failures; do not claim installed acceptance.
- #79 run 42534993953: production history telemetry assertion and browser failure.
- #40 run 42563032582: expanded scenario timeouts and contracts failure despite
  a successful independent inventory workflow. The jobs connector returns only
  its first page (30 here), so that page is not a full-matrix count.

## First candidate local verification

The combined A candidate passes the pinned build, lint, formatting and strict
test typecheck. The focused historical/admission/epoch/publication/staging gate
reports 158 tests: 141 pass and 17 fail at the opened-descriptor storage guard
(`STORAGE_UNAVAILABLE`) in this restricted host. These are the same 17 lineage
cases recorded by A on its prior host; they remain mandatory in Linux CI.
No guard, expected owner, receipt or assertion was relaxed. CI on the newly
integrated candidate is required before merge; prior branch CI is not substituted.

## Audited open PR heads

Snapshot only; fetch again before any merge. Successful old heads still require
current-main verification and all additional required registrations.

| PR | Head | Base | Observed CI |
| --- | --- | --- | --- |
| [#37](https://github.com/kosmateus/fmcad/pull/37) | `94bb152` | `main` | [success](https://github.com/kosmateus/fmcad/actions/runs/42524758225) |
| [#38](https://github.com/kosmateus/fmcad/pull/38) | `9a7432b` | `main` | [success](https://github.com/kosmateus/fmcad/actions/runs/42524393016) |
| [#40](https://github.com/kosmateus/fmcad/pull/40) | `f6462a5` | `main` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42563032582) |
| [#47](https://github.com/kosmateus/fmcad/pull/47) | `15fd980` | `refactor/agent-c-modeling` | [success](https://github.com/kosmateus/fmcad/actions/runs/42525303799) |
| [#49](https://github.com/kosmateus/fmcad/pull/49) | `ffe5d1e` | `refactor/agent-d-files` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42526711724) |
| [#51](https://github.com/kosmateus/fmcad/pull/51) | `bed4300` | `main` | [success](https://github.com/kosmateus/fmcad/actions/runs/42526553187) |
| [#53](https://github.com/kosmateus/fmcad/pull/53) | `b768425` | `refactor/agent-d-external-evidence` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42526977304) |
| [#54](https://github.com/kosmateus/fmcad/pull/54) | `e01e032` | `refactor/agent-d-import-values` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42530478945) |
| [#55](https://github.com/kosmateus/fmcad/pull/55) | `66d8894` | `refactor/agent-d-reference-plans` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42530822868) |
| [#56](https://github.com/kosmateus/fmcad/pull/56) | `d9def49` | `refactor/agent-a-admission` | [success](https://github.com/kosmateus/fmcad/actions/runs/42531951000) |
| [#57](https://github.com/kosmateus/fmcad/pull/57) | `1c94657` | `refactor/agent-c-feature-policies` | [success](https://github.com/kosmateus/fmcad/actions/runs/42529553914) |
| [#59](https://github.com/kosmateus/fmcad/pull/59) | `cb62994` | `refactor/agent-d-external-input` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42530843571) |
| [#60](https://github.com/kosmateus/fmcad/pull/60) | `0594f41` | `main` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42533143052) |
| [#61](https://github.com/kosmateus/fmcad/pull/61) | `255dd86` | `refactor/agent-c-curve-preparation` | [success](https://github.com/kosmateus/fmcad/actions/runs/42530208843) |
| [#65](https://github.com/kosmateus/fmcad/pull/65) | `c61a251` | `refactor/agent-c-modeling-artifacts` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42534155539) |
| [#66](https://github.com/kosmateus/fmcad/pull/66) | `f5ff983` | `refactor/agent-c-specialist-policies` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42539039802) |
| [#69](https://github.com/kosmateus/fmcad/pull/69) | `2603afa` | `refactor/agent-f-operational-integration` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42532642709) |
| [#70](https://github.com/kosmateus/fmcad/pull/70) | `5f2bed1` | `main` | [success](https://github.com/kosmateus/fmcad/actions/runs/42532663024) |
| [#71](https://github.com/kosmateus/fmcad/pull/71) | `5030081` | `refactor/agent-e-mcp-compatibility` | [success](https://github.com/kosmateus/fmcad/actions/runs/42533430466) |
| [#72](https://github.com/kosmateus/fmcad/pull/72) | `68d4e4d` | `refactor/b-transactions` | [success](https://github.com/kosmateus/fmcad/actions/runs/42533564927) |
| [#73](https://github.com/kosmateus/fmcad/pull/73) | `32e30e1` | `refactor/agent-e-ui-boundaries` | [success](https://github.com/kosmateus/fmcad/actions/runs/42533998469) |
| [#74](https://github.com/kosmateus/fmcad/pull/74) | `e7c4a42` | `refactor/agent-f-diagnostic-retention` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42534011963) |
| [#75](https://github.com/kosmateus/fmcad/pull/75) | `b35d82a` | `refactor/b-global-scopes` | [success](https://github.com/kosmateus/fmcad/actions/runs/42534273300) |
| [#76](https://github.com/kosmateus/fmcad/pull/76) | `b8cbd5d` | `refactor/agent-e-ui-commands` | [success](https://github.com/kosmateus/fmcad/actions/runs/42536514628) |
| [#77](https://github.com/kosmateus/fmcad/pull/77) | `0183cb4` | `refactor/agent-f-locale-packaging` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42534704696) |
| [#78](https://github.com/kosmateus/fmcad/pull/78) | `a32c49e` | `refactor/b-camera-contract` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42534983879) |
| [#79](https://github.com/kosmateus/fmcad/pull/79) | `7cc23f1` | `refactor/agent-f-telemetry-producer` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42534993953) |
| [#80](https://github.com/kosmateus/fmcad/pull/80) | `3c4c33f` | `refactor/agent-e-host-registration` | [success](https://github.com/kosmateus/fmcad/actions/runs/42536549199) |
| [#81](https://github.com/kosmateus/fmcad/pull/81) | `d41a246` | `refactor/agent-e-local-reference-outcomes` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42536563055) |
| [#82](https://github.com/kosmateus/fmcad/pull/82) | `cb2a655` | `refactor/agent-c-python-modeling` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42537365880) |
| [#83](https://github.com/kosmateus/fmcad/pull/83) | `c2eaf0b` | `refactor/agent-e-console-boundary` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42542060501) |
| [#84](https://github.com/kosmateus/fmcad/pull/84) | `794c1ed` | `refactor/agent-e-public-ci` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42542176254) |
| [#85](https://github.com/kosmateus/fmcad/pull/85) | `1eaba7e` | `refactor/agent-e-console-integration` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42542220132) |
| [#86](https://github.com/kosmateus/fmcad/pull/86) | `6f11b05` | `refactor/agent-e-locale-presence` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42542264819) |
| [#87](https://github.com/kosmateus/fmcad/pull/87) | `84df40a` | `refactor/agent-e-mcp-producer` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42545679904) |
| [#88](https://github.com/kosmateus/fmcad/pull/88) | `ab1b2d2` | `refactor/b-command-settlement` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42562546855) |
| [#89](https://github.com/kosmateus/fmcad/pull/89) | `c51dacf` | `refactor/b-assertion-helper-audit` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42563565989) |
| [#90](https://github.com/kosmateus/fmcad/pull/90) | `55a31a8` | `refactor/b-pose-state` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42564190010) |
| [#91](https://github.com/kosmateus/fmcad/pull/91) | `f9e9454` | `refactor/b-animation-plan` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42564434768) |
| [#92](https://github.com/kosmateus/fmcad/pull/92) | `d76805f` | `refactor/b-transaction-order` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42564999057) |
| [#93](https://github.com/kosmateus/fmcad/pull/93) | `b73f7f4` | `refactor/b-later-history-audit` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42565507082) |
| [#94](https://github.com/kosmateus/fmcad/pull/94) | `c521ea7` | `refactor/b-native-solids-catalog` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42566174987) |
| [#95](https://github.com/kosmateus/fmcad/pull/95) | `ce0cef6` | `refactor/b-creation-active-proof` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42567244546) |
| [#96](https://github.com/kosmateus/fmcad/pull/96) | `a585110` | `refactor/b-local-materials` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42567817741) |
| [#97](https://github.com/kosmateus/fmcad/pull/97) | `fdfabac` | `refactor/b-legacy-expectations` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42568295756) |
| [#98](https://github.com/kosmateus/fmcad/pull/98) | `282e596` | `refactor/b-ci-evidence` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42569129027) |
| [#99](https://github.com/kosmateus/fmcad/pull/99) | `c691d72` | `refactor/b-local-appearances` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42570415131) |
| [#100](https://github.com/kosmateus/fmcad/pull/100) | `be4fcd3` | `refactor/b-style-assignments` | [failure](https://github.com/kosmateus/fmcad/actions/runs/42570882067) |


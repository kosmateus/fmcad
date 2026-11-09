# Agent G — coverage, backlog, packaging and final qualification

Status: **claimed by Agent G; in progress** (8 November 2026).
Starting baseline: `0b84454d8e5d22abb23bcf52999c506894ebf5bf`.
Branch: `refactor/g-integration-inventory`. G1 starts immediately; final removals
and acceptance depend on evidenced A–F deliveries. Read [the shared plan](../REFACTOR_PARALLEL_PLAN.md)
and every assignment. This package is integration work, not permission to replace
another agent's implementation or declare their unfinished scope complete.

## Outcome and ownership

Account for the entire remaining refactor and integrate its deliveries on main.
Close gaps between tests that exist and tests that execute. Finish packaging,
architecture enforcement, aggregate backlog reconciliation, obsolete-path removal,
measurements and the native qualification handoff.

Own root shared configuration: `package.json`/lock, workspace manifests when
cross-package, TypeScript project/staging configuration, lint/format policy,
`.github/workflows`, build/package/install scripts and integrated acceptance
documentation. A may change package scripts/CI for its explicit first broker
gate repair; coordinate before overlapping edits. B owns live inventory/scenarios;
E owns public route metadata; F owns console implementation. Gather their
manifests and integrate them without independent competing edits.

## G1 — complete inventory and aggregate backlog reconciliation

Enumerate tracked runtime families, facades, generated loaders, public methods,
non-live tests, live assertions and actual CI reachability. File-extension or line
counts alone do not establish progress. Every item needs an owner, disposition,
tests/effects/readback and negative coverage, or a precise gap with next action.
Build a coverage-registration check that detects newly orphaned required files.
Avoid executing destructive/manual/live helpers through an indiscriminate glob.

The approved aggregate is 150 total, 104 closed and 46 remaining, but historical
status is not current acceptance evidence. Reconcile the public package plans
against commits and tests without publishing underlying records, identifiers or
relationships. Record duplicate or superseded public scope without silently
dropping work. Keep new features separate; preserve existing behavior. Keychain
remains excluded.

## G2 — continuously integrate contracts and test execution

Track A–F PR dependencies, public signature changes and required registry/build
patches. Merge only after the full CI matrix passes the exact head; if main has
advanced, verify the merge candidate and rerun affected checks. Do not force-push
over other agents or replace current main with a historical branch.

Keep Node 22.13/24, Python, Chromium, strict admission, both physical transport
models and installed-package coverage. Register A's broker gate and B's expanded
required profiles. Distinguish component model, actual broker/model and native
Fusion qualification in reports. Preserve failure logs and investigate recurring
timeouts; rerunning a failure unchanged does not explain its cause.

Move remaining handwritten regression tests to strict compiler-based execution
in coherent groups, retaining assertions and without overwriting staged runtime
entries. Ensure each test source has one intended runtime path. Add architectural
import/ownership checks where they guard an actual boundary; avoid tests that
merely mirror implementation details.

## G3 — installed packaging, facade retirement and measurements

Install a built tarball outside the monorepo. Validate CLI/MCP/SDK/OpenCode
entrypoints, declarations, Python runtime, pinned type definitions, browser
assets, source provenance and export allowlists. Verify clean and incremental
builds, missing dependency errors and absence of private workspace imports.
Do not package tests, private backlog records or generated investigation data.

With A–F approval, remove transitional JavaScript facades, obsolete loaders and
stale staging paths after all consumers move. Preserve necessary platform
bootstrap shims as explicitly documented exceptions without business logic.
Check Python compatibility assets similarly. F owns TUI removal; coordinate its
packaging/dependency changes instead of deleting UI independently.

Repeat the retained baseline observations and practical startup, checker,
preparation, memory and package-size measurements against the documented
reference. Separate cold/warm runs and measured host/container budgets. Investigate
material regressions with evidence; do not relax guards or deadlines to achieve
an attractive number. Provide B a measured simulator concurrency recommendation.

## G4 — final offline acceptance and native qualification

Offline exit requires all A–F checklists complete, every required supported model
case executed, all public/runtime inventory items accounted for, package/browser
checks passing, and no unexplained exclusions. Publish one exact integrated SHA
and runnable commands. Mark native-only assertions as awaiting qualification,
never as an offline pass.

Prepare native commands for the same shared scenarios over MCP and addin, with
explicit test project/folder, concurrency default 10 and comparison runs at 1/2/10.
Include all historical success/negative assertions, saved file lifecycle,
activation/lifetime, reopen/version visibility, real exports/imports, geometry/
solver/timeline, styles/mass, motion/animation/camera, installed stdio and UI.
Global UI tests need coordinated restoration. Fixed fixtures require owned copies.

After the offline refactor is complete and real Fusion is supplied, record the
integrated SHA, Fusion/API versions, source hashes, inputs/assertions, owner and
request IDs, creation/file/version identity, RPC counts, receipts, screenshots
where relevant, and cleanup/inventory restoration. Replay identical scenarios
against historical/current code for unresolved broker attribution, on the same
Fusion version. Never replay an uncertain mutation merely to obtain evidence.

Without native access, finish all preparation and publish the exact remaining
runbook; do not claim qualification or stop earlier offline integration work.
After native failures, route minimal reproductions to the correct owner and
repeat required qualification on the fixed integrated build.

## Required final deliverables

- Integrated main with all package completion ledgers and green full CI.
- Runtime/public-method/test disposition matrix plus aggregate backlog reconciliation,
  with no unassigned public scope.
- Installed-package and architecture/facade-retirement evidence.
- Reproducible measurements and explicit native assumptions.
- Native runbook with machine-readable required cases and cleanup recovery.
- Separate final statuses: offline refactor complete; native qualification
  pending or passed with actual evidence. Append PR/SHA and blockers throughout.

## Initial integration delivery (PR #40)

The [acceptance ledger](../integration/ACCEPTANCE.md) records the starting SHA,
A–F dependencies and the independently verified backlog aggregate. A separate
registration workflow detects newly orphaned test sources without executing live
helpers. The initial 263-file registration debt has explicit owners/next actions;
this is not a coverage waiver or completion claim. Inventory commands expose
runtime files and actual public registry metadata. The native plan generator
validates current shared-family commands and keeps all native results NOTRUN.

Local validation: pinned build, strict test typecheck, registration checker units,
registration inventory and native CLI argument generation. Installed consumer
checks and full exact-head CI are tracked in the acceptance ledger as they settle.
No production implementation or another agent's owned file was changed. G1–G4
remain in progress; final removal and acceptance depend on A–F evidence.

### Verified aggregate reconciliation

The approved aggregate is independently confirmed: 150 total, 104 closed and 46
remaining. Underlying records, identifiers and relationships are not published.
Native and separate-feature obligations remain explicit, and no task was closed.

### First A–F merge checkpoint

Merged main `ecf4f60` contains Agent B's claim (PR #36) and its first bounded
persistence delivery (PR #44). All 22 CI jobs passed the implementation head
`fe1c66f` in workflow `42524121814`; the only intervening main change is the
claim. G's combined candidate still requires its own full CI and merge-head CI.

The integrated inventory recognizes the new persistence test through the
existing scenario-unit glob: 487 test sources, 224 registered, 263 explicit gaps.
The combined local checks pass 124 scenario tests, simulator strict typing and
58 method / 21 property API shapes. Native commands remain unexecuted. Shared
saved-reopen migration, receipt/restart recovery, assertion profiles and native
file/token behavior remain B dependencies, so neither B nor G is complete.

### Second A–F merge checkpoint

Merged main `1023664` adds Agent E's first bounded image-command delivery from
PR #39. Its exact head `8a707c2` passed all 22 jobs in workflow `42524333282`.
Merge-head workflow `42529116914` ended with `startup_failure` on its second
attempt, so it is not passing evidence. G integrates the merge only on a new
candidate that must run fresh CI.

The combined local tree passes build, strict test types, 124 scenario tests and
all 38 runtime-consumer cases with an explicit writable workspace `TMPDIR`.
Those cases include frozen predecessor comparisons and a tarball installed
outside the repository with strict declaration compilation. The initial direct
runtime-consumer invocation failed only because this host has no `/tmp`; the
rerun changed no test or production assertion.

Inventory is now 651 runtime files, 420 public routes and 487 test sources, with
224 registered and 263 explicit gaps. The package contains 1,571 files. No image
loader is retired because public and installed consumers still use it. Remaining
E public surfaces, complete installed profiles, native UI/Fusion and image quality
stay open; G and offline acceptance remain incomplete.

### Third A–F merge checkpoint

Merged main `0d6f757` adds Agent B's assertion audit and required profiles from
PR #45. Its exact head `895eb69` passed all 22 CI jobs in workflow `42524676732`.
The merge-head workflow `42530438963` was cancelled, so this is not successful
merge-head evidence. G's new combined candidate requires fresh full CI.

The audit freezes 1,588 static sites across 39 live sources. Of 613 historical
sites, 612 are unchanged and the one recorded change is the public MCP server
name. This is an anti-omission gate, not semantic per-assertion disposition.
Required profiles now separate eight supported model families, 27 retained
native obligations and nine diagnostic/helper cases. Legacy native suites execute
behind exclusive barriers; uncertain restoration blocks later work as `not-run`.

G's native manifest now consumes that merged profile. It validates and emits 48
shared MCP/addin command arrays for concurrency 1/2/10, all 27 native obligations
as explicit argument arrays with status `NOTRUN`, and the nine diagnostics as
non-substituting cases. Every legacy obligation keeps lifecycle/cleanup migration
as a blocking prerequisite. Native Fusion remains unexecuted.

The combined local tree passes build, strict test types, nine registration tests,
129 scenario tests and required-profile listing. Inventory is 651 runtime files,
420 public routes and 489 test sources, with 226 registered and 263 explicit gaps.
The package remains 1,571 files and unchanged in size because B's ledgers and test
sources are not published. No facade is retired. Semantic mapping, shared reopen,
transactional migration and global-state restoration remain B dependencies, so
B, G and offline acceptance remain incomplete.

### Fourth A–F merge checkpoint

Merged main `171c972` adds Agent A's A1 broker-regression gates from PR #42.
Its exact head `709741a` passed the expanded 24-job matrix in workflow
`42525055817`, including dedicated Node 22.13 and 24 broker jobs. Merge-head
workflow `42531784829` was cancelled, so it is not successful merge-head evidence.

The named selection registers all six retained queue families, an execution-path
guard and compiled historical scheduling comparisons. Coverage is now 491 test
sources, 234 registered and 257 open gaps. G removes the six closed gaps from the
explicit debt ledger and pins that ledger to merged main `171c972`; nothing is
waived. The combined build, strict types, nine registration tests and 129 scenario
tests pass locally.

The broker command passes 27 of 34 cases in this container; seven stop at missing
`/proc` process evidence. Those assertions are unchanged and pass in the exact
PR-head Linux matrix. Package allowlisting remains 1,571 files; only published
package metadata changes, to 3,375,397 compressed bytes and 16,628,497 unpacked
bytes. Runtime payloads and facade dispositions are unchanged. A1 is integrated,
while A2–A4, G and offline acceptance remain incomplete; Fusion was not run.

### Fifth A–F merge checkpoint

Merged main `7ec4886` adds Agent E's typed compatibility client and configuration
composition from PR #46. Its exact head `94cb3f1` passed all 22 jobs in workflow
`42524870768`. No workflow run is registered for the merge SHA, so G requires a
fresh complete matrix on its combined candidate and eventual merge head.

The public `client.js` and `config.js` paths remain deliberate runtime loaders;
their canonical metadata/validation composition now lives in two strict typed
modules. Eight library tests preserve historical denial, metadata, context,
configuration, initialization and accepted-service behavior and install a tarball
outside the repository with strict declaration compilation. The 22 existing
configuration cases also pass. Local setup required an explicit writable sibling
`TMPDIR` and prepared npm cache; assertions were unchanged.

Inventory is now 653 runtime files, 420 public routes and 491 test sources, with
234 registered and 257 explicit gaps. The package contains 1,575 files,
3,376,304 compressed bytes and 16,631,918 unpacked bytes, shasum
`9a90747a162a58f72cc4233469b86f6ae28a11df`. No facade is retired because both
loaders remain active consumers. Remaining public surfaces and complete installed
CLI/MCP/OpenCode parity keep E1–E4 open. Offline acceptance is incomplete and
Fusion was not run.

### Sixth A–F merge checkpoint

Merged main `04a42b4` adds Agent F's first Control Center lifecycle delivery from
PR #41. Its exact head `7f0ab88` passed all 22 jobs in workflow `42525302616`,
including Linux Chromium. No merge-SHA workflow is registered, so the combined G
candidate and eventual merge head still require fresh full CI.

The delivery rejects late snapshot/detail work after disposal or dialog closure,
shares startup and clears timers. Fourteen combined project/history/agent cases
pass locally with a writable sibling `TMPDIR`; the initial direct invocation only
failed because `/tmp` is absent. The UI ledger retains system controls, richer
project/localization behavior, production-broker browser evidence, retention and
terminal retirement as open work. No TUI or public entrypoint is retired, so
F1–F4 remain incomplete.

### Seventh A–F merge checkpoint

Merged main `5d5a793` adds Agent E's typed engineering and reference host-command
composition from PR #48. Its exact head `ae3faff` passed all 22 jobs in workflow
`42525428442`; no merge-SHA workflow is registered. Both adapters remain offline,
preserve historical input/output/preflight effects and acquire neither broker nor
Fusion.

All 33 engineering/batch-local cases pass. The combined installed library/runtime
consumer selection passes 48 cases after explicit offline-cache preparation and
installs its tarball outside the repository; declarations and packaged host assets
are exercised unchanged. Inventory is 655 runtime files, 420 public routes and
491 test sources, with 234 registered and 257 explicit gaps. Package inspection
reports 1,579 files, 3,377,457 compressed bytes and 16,640,729 unpacked bytes,
shasum `afdd52049a4cb6138d0a6fb9e9460b7d81170cf2`.

Engineering/reference loaders remain active consumers and are not retired.
Remaining metadata, MCP, review/shot/UI, Control Center parity and complete
installed CLI/MCP/OpenCode evidence keep E1–E4, F1–F4, G and offline acceptance
open. Native image/Canvas/UI/Fusion qualification was not run.

### Eighth A–F merge checkpoint

Merged main `2463569` adds Agent E's MCP reconciliation helper parity from PR
#50. Its exact head `1380599` passed all 22 jobs in workflow `42525845618`; no
merge-SHA workflow is registered. Fresh full CI is required on this combined G
candidate and on its eventual merge head.

The typed helper schema now distinguishes allowed and required fields, accepts
only the advertised `committed`/`aborted` optional outcomes and preserves owned
request/document/file pins. Paired tests require one reconcile plus one owned
status read and prohibit submit or wait. Unknown fields and invalid outcomes
still reject before registration; broker policy and receipt validation did not
move.

The combined build, lint, formatting, strict test types, nine changed library
cases, 129 scenarios, simulator typing and 58-method / 21-property API shape
check pass. The library test keeps its external offline tarball installation
unchanged. The companion framing/catalog selection passes 18 of 24 locally; six
cases stop only at unavailable `/proc` verification and remain asserted for the
Linux matrix.

Inventory is 656 runtime files, 420 public routes and 491 test sources, with 234
registered and 257 explicit gaps. Package inspection reports 1,581 files,
3,377,886 compressed bytes and 16,642,858 unpacked bytes, shasum
`0c80e85af09e93821e6cec3149c32870674c6d2c`. The compatibility loader remains an
active public consumer and is not retired. E1–E4, F1–F4, G and offline acceptance
remain open; native preparation remains `NOTRUN` and Fusion was not executed.

### Ninth A–F merge checkpoint

Merged main `cf3e6ad` adds Agent E's typed review and screenshot boundaries from
PR #52. Its exact head `24b0ec5` passed all 22 jobs in workflow `42529230482`;
no merge-SHA workflow is registered. The combined candidate and eventual merge
head still require fresh full CI.

G adds review, review-application, screenshot, installed MCP and the packed V1/V2
OpenCode adapter suite to the existing contracts gate. The existing offline-cache
preparation and Linux `/tmp/opencode` setup are retained. Registration becomes
491 test sources / 239 registered / 252 explicit gaps; exactly five debt entries
close as execution-path gaps, not as whole-package acceptance.

Build, lint, formatting, strict test types and nine registration tests pass. All
30 library/review/application/screenshot cases pass with the external installed
tarball and declarations unchanged. The ten installed MCP/OpenCode cases cannot
create their hard-coded `/tmp/opencode` fixtures in this restricted host, so no
assertion runs locally and none is relaxed; Linux candidate CI is the required
evidence. Simulator typing and the 58-method / 21-property API check pass.

Inventory is 658 runtime files and 420 public routes. Package inspection reports
1,585 files, 3,378,941 compressed bytes and 16,648,056 unpacked bytes, shasum
`cd897a4821b64c68320f074daa18aea12e616ccd`. Review/shot/MCP/OpenCode loaders
remain active and are not retired. E1–E4, G and offline acceptance remain open;
native review/screenshot/Fusion qualification was not run.

### Tenth A–F merge checkpoint

Merged main `9daedef` adds Agent E's typed MCP catalog/context and optional
companion correction from PR #62. Its exact head `33f7539` passed all 22 jobs in
workflow `42530327335`; no merge-SHA workflow is registered. The combined
candidate and eventual merge head still require fresh full CI.

G registers MCP application, catalog and client-context in the contracts gate,
moving coverage to 491 test sources / 242 registered / 249 explicit gaps. The
online cache-preparation step now installs explicit runtime package specs plus the
pinned V1 OpenCode host package, while every consumer install remains offline and
production dependencies stay unchanged.

Build, lint, formatting, strict test types and nine registration tests pass. All
17 library/installed-MCP/companion cases and nine packed OpenCode V1/V2 cases pass
outside the checkout. The retained MCP selection passes 15 of 18 locally; two
process-identity and one owned-artifact assertion stop only at unavailable
`/proc` and remain unchanged for Linux candidate CI. Simulator typing and the
58-method / 21-property API check pass.

Inventory is 661 runtime files and 420 public routes. Package inspection reports
1,591 files, 3,380,374 compressed bytes and 16,654,784 unpacked bytes, shasum
`e87a7421aa9ad042539f28b0ed2d1b382ebe176e`. MCP loaders remain active installed
consumers and are not retired. E1–E4, G and offline acceptance remain open;
native preparation remains `NOTRUN` and Fusion was not executed.

### Eleventh A–F merge checkpoint

Merged main `cafe940` adds Agent E's typed command registry and bilingual help
composition from PR #64. Its exact head `3d54993` passed all 22 jobs in workflow
`42531269978`; no merge-SHA workflow is registered. The combined candidate and
eventual merge head still require fresh full CI.

G adds registry, command-catalog, help-details and manual-coverage to the contracts
gate. With the already-selected library, capabilities and legacy-manual suites,
the exact 60-case public boundary passes locally. It covers all 505 routes, 337
aliases, EN/PL help, contextual/manual data, frozen predecessors and the installed
npm executable outside the checkout. Registration becomes 491 test sources / 246
registered / 245 explicit gaps.

Build, lint, formatting, strict test types, nine registration tests, simulator
typing and the 58-method / 21-property API check pass. Inventory is 670 runtime
files and 420 public routes. Package inspection reports 1,609 files, 3,382,730
compressed bytes and 16,669,251 unpacked bytes, shasum
`3307b5262e5df2fb6f0a6497c307fceda5b71b18`.

Command/help source files remain active installed loaders and are not retired.
E1–E4, G and offline acceptance remain open; three native documentation audits,
queue/framing and UI orchestration remain, and Fusion was not executed.

### Twelfth A–F merge checkpoint

Merged main `2ed8017` adds Agent B's saved revision and receipt-bound reopen
families from exact implementation head `c4ab2f9`. All 22 jobs passed that head
in workflow `42529825311`; the merge SHA has no registered workflow. The combined
G candidate and eventual merge head still require fresh full CI.

G registers `reopen` and `revisions` in the broker matrix for MCP and addin at
concurrency 1/2/10 with ten owners. Artifact names include concurrency, and a
guard verifies the twelve new combinations plus the runtime matrix argument.
Coverage is 493 test sources / 248 registered / 245 explicit gaps.

Build, strict test types, 156 scenario tests, simulator typing, API verification
and both registration assertions pass locally. The broker regression selection
passes 28 of 35; seven unchanged process-identity cases stop at missing `/proc`
and require exact-head Linux CI. No assertion is waived.

The native generator now validates 60 shared commands for ten families. Its 27
native obligations and nine diagnostics remain `NOTRUN`; Fusion was not executed.
Runtime inventory remains 670 files and 420 routes. Package content remains 1,609
files, 3,382,730 compressed bytes and 16,669,251 unpacked bytes, shasum
`3307b5262e5df2fb6f0a6497c307fceda5b71b18`.

No facade is retired without consumer evidence. Semantic assertion mapping,
remaining lifecycle migration, owner checklists, exact candidate CI and later
merge-head CI keep G and offline acceptance incomplete; native qualification is
still a separate post-offline milestone requiring real Fusion access.

### Thirteenth A–F merge checkpoint

Merged main `be50c47` adds Agent E's typed catalog registry composition from PR
#67. Its exact head `eaa3ff9` passed all 22 jobs in workflow `42531860636`; no
merge-SHA workflow is registered. Fresh full CI remains required on the combined
candidate and eventual merge head.

The changed `library-api` consumer was already registered, so coverage remains
493 sources / 248 registered / 245 explicit gaps. After explicit cache preparation
and a writable temporary directory outside the checkout, all 16 library cases pass,
including offline installation and strict declarations. Build, simulator typing
and the 58-method / 21-property API verifier pass.

Inventory is 671 runtime files and 420 public routes. Package inspection reports
1,611 files, 3,383,482 compressed bytes and 16,677,940 unpacked bytes, shasum
`43a9119831e0be960bea7c19b0a40db677468bf7`. The catalog loader remains an active
installed consumer and is not retired. E1–E4, G and offline acceptance remain
open; native preparation remains `NOTRUN` and Fusion was not executed.

### Fourteenth A–F merge checkpoint

Merged main `54b31e4` adds Agent E's typed MCP queue, compatibility and forwarder
composition from PR #68. Its exact head `90d7d55` passed all 22 jobs in workflow
`42532613149`; no merge-SHA workflow is registered. Fresh full CI remains required
on the combined candidate and eventual merge head.

G adds `mcp-stdio` to the retained contracts gate alongside library and
catalog-sharing consumers. Their exact 35 cases pass locally after explicit cache
preparation and outside-checkout installation, with zero failures or skips.
Coverage becomes 493 test sources / 249 registered / 244 explicit gaps.

Build passes. Inventory is 674 runtime files and 420 public routes. Package
inspection reports 1,617 files, 3,385,022 compressed bytes and 16,694,315 unpacked
bytes, shasum `22dd30f1e463c1b7bcb4989dda969668ff6555fe`.

The JS compatibility path remains an active installed loader and is not retired;
the separate queue-lifecycle source remains open pending its own evidence. E1–E4,
G and offline acceptance remain incomplete. Native preparation is still `NOTRUN`
and Fusion was not executed.

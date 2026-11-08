# Agent G — coverage, Beads, packaging and final qualification

Status: **claimed by Agent G; in progress** (8 November 2026).
Starting baseline: `0b84454d8e5d22abb23bcf52999c506894ebf5bf`.
Branch: `refactor/g-integration-inventory`. G1 starts immediately; final removals
and acceptance depend on evidenced A–F deliveries. Read [the shared plan](../REFACTOR_PARALLEL_PLAN.md)
and every assignment. This package is integration work, not permission to replace
another agent's implementation or declare their unfinished scope complete.

## Outcome and ownership

Account for the entire remaining refactor and integrate its deliveries on main.
Close gaps between tests that exist and tests that execute. Finish packaging,
architecture enforcement, historical/Beads reconciliation, obsolete-path removal,
measurements and the native qualification handoff.

Own root shared configuration: `package.json`/lock, workspace manifests when
cross-package, TypeScript project/staging configuration, lint/format policy,
`.github/workflows`, build/package/install scripts and integrated acceptance
documentation. A may change package scripts/CI for its explicit first broker
gate repair; coordinate before overlapping edits. B owns live inventory/scenarios;
E owns public route metadata; F owns console implementation. Gather their
manifests and integrate them without independent competing edits.

## G1 — complete inventory and Beads reconciliation

Enumerate tracked runtime families, facades, generated loaders, public methods,
non-live tests, live assertions and actual CI reachability. File-extension or line
counts alone do not establish progress. Every item needs an owner, disposition,
tests/effects/readback and negative coverage, or a precise gap with next action.
Build a coverage-registration check that detects newly orphaned required files.
Avoid executing destructive/manual/live helpers through an indiscriminate glob.

Inspect the archive's Git branches/worktrees and Beads embedded Dolt data in a
separate copy. Re-export status if tooling is available; otherwise state exactly
which old status is unverified. The earlier plan reports 150 tasks (104 closed,
46 remaining), but later code may implement open tasks. Reconcile `69j`, `cb4`,
`e4m`, `hex-integration`, Control Center and qualification tasks against commits
and evidence. Record duplicates/superseded work without silently dropping scope.
Keep new features separate; preserve existing behavior. Keychain remains excluded.

## G2 — continuously integrate contracts and test execution

Track A–F PR dependencies, public signature changes and required registry/build
patches. Merge only after the full CI matrix passes the exact head; if main has
advanced, verify the merge candidate and rerun affected checks. Do not force-push
over other agents or replace current main with an archive branch.

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
Do not package tests, Beads, archives, worktrees or generated investigation data.

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
- Runtime/public-method/test/Beads disposition matrix with no unassigned scope.
- Installed-package and architecture/facade-retirement evidence.
- Reproducible measurements and explicit native assumptions.
- Native runbook with machine-readable required cases and cleanup recovery.
- Separate final statuses: offline refactor complete; native qualification
  pending or passed with actual evidence. Append PR/SHA and blockers throughout.

## Initial integration delivery (PR #40)

The [acceptance ledger](../integration/ACCEPTANCE.md) records the starting SHA,
A–F dependencies, archive fingerprint and independently exported Beads statuses. A separate
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

### Verified archive reconciliation

A disposable embedded-Dolt copy was read with the checksum-verified Dolt 2.7.2
binary. Counts match the historical ledger: 150 tasks, 104 closed and 46 remaining
(22 open, 11 in progress, 9 deferred, 4 blocked), plus 307 dependency edges.
Detailed task records and relationships remain outside the public repository;
automatic approval review rejected their publication from the private archive.
The acceptance ledger publishes aggregate verification and already-public scope
only. Native and separate-feature obligations remain explicit; no task was closed.

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
archive/token behavior remain B dependencies, so neither B nor G is complete.

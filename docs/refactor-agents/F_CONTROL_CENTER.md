# Agent F — Control Center completion and TUI retirement

Status: **claimed by Agent F** on 8 November 2026. Starting from main
`0b84454d8e5d22abb23bcf52999c506894ebf5bf` (PR #35). Read
[the shared plan](../REFACTOR_PARALLEL_PLAN.md). Modeling remains the product
priority; console work must not require unrelated changes to the modeling path.

## Outcome and ownership

Finish the Control Center with real broker/history data, reliable lifecycle and
packaged assets, and retire obsolete demo/TUI code only after its supported
behavior is accounted for. Existing localization, browser bundle, project/history
and agent features are foundations to verify, not assignments to recreate.

Own `packages/control-center/**`, browser/console assets and locale catalogs,
`src/console-*` rendering/controller modules, console UI infrastructure and
console read-model/presentation services; corresponding browser, history,
retention and console tests. Project-history persistence belongs here when it
serves console/history behavior. Coordinate any shared persistence primitive with
A/G. E owns public CLI entrypoints; A owns broker admin/control semantics even
when consumed by this UI; G owns shared packaging/CI configuration.

## F1 — reconcile delivered and archived UI scope

Inspect current source and archived UI branches/Beads instead of replaying old
tasks. Map system/global controls, agents/projects, operational views, history,
telemetry, logging/retention, localization, source/result views and disposal to
implemented behavior and remaining gaps. Imported locale catalogs are present;
do not overwrite current UI with an old branch merely to recover a feature.

For each preserved TUI/demo feature decide: equivalent web behavior, deliberate
documented retirement, or required remaining feature. Keep this an explicit
migration ledger so deleting the old UI cannot silently remove operations.
No new unrelated dashboard feature should delay completion.

## F2 — complete typed views and real operational data

Finish remaining controller/read-model/presentation migrations and remove demo
data from production paths. Use actual broker/SQLite composition for agents,
projects, scopes, telemetry, retained jobs and history. Preserve identity and
authorization of read/control operations. Unknown/incomplete operation outcomes
must remain visible, not be rendered as successful or idle.

Complete system/global controls using A's stable API: status, pause/resume,
cancellation/reconciliation and safe error states as actually supported. Do not
reimplement broker policy in the browser. Request contract changes from A rather
than editing queue runtime. Use request generation/cancellation to prevent late
responses from overwriting a newer filter or disposed view.

## F3 — retention, lifecycle and localization

Verify bounded history/log queries, retention/quota behavior and ownership of
stored records. Destructive retention must not remove evidence required by an
unsettled operation. Cover active/retained agent filtering, project scopes,
selection state, listener/timer disposal and late render rejection. Preserve
current historical filter assertions; wait for the specific new response before
checking rendered results, not a row already on screen.

Review locale key/parameter completeness, selector persistence, fallback,
formatting and missing assets. Verify startup/shutdown and repeated mount/unmount
without leaked listeners, polling or stale requests. Retain accessible labels and
keyboard interaction while completing remaining views.

## F4 — browser verification and retirement

Run Chromium against production browser/broker/history composition as well as
focused fixtures. Check filters and controls, real server responses, console
errors, failed network requests, missing scripts/styles and disposal. A request
failure must be correlated with its own UI error; source snapshot tests alone
are insufficient. Retain failure artifacts for diagnosis.

Once the ledger proves feature parity or explicit retirement, remove obsolete
TUI/demo implementation and dependencies in a separate PR coordinated with E/G.
Check public `console` entrypoints, scripts, help, assets and installed runtime
paths before deleting anything. Do not keep two production UI implementations
indefinitely or treat merely hiding the old route as completed retirement.

## Completion and evidence

Require strict build/types/lint, read-model/history/retention tests, production
browser E2E, packaged asset/consumer checks and full CI on each merge head.
Measure relevant startup/idle/query costs using stable fixtures; explain material
regressions rather than inventing an arbitrary threshold to make them pass.

Exit when all existing console scope is reconciled, production views use real
data, controls preserve A's contracts, lifecycle/locales/retention are verified,
obsolete UI retirement is complete and installed assets work. Native Fusion UI
interaction remains in B/G's final qualification where required. Append PR/SHA,
browser evidence and remaining scope here after each delivery.

## Agent F evidence and remaining scope

Claim: PR #41, starting from `0b84454d`. The first delivery fixes inherited
browser disposal and delayed detail-response defects, adds quota/reopen protection
coverage and retains production browser network/console traces.
See [the feature migration ledger](F_UI_LEDGER.md) for archived source mappings,
local measurements, test limitations and the required remaining work.

A/E/G coordination: [issue #43](https://github.com/kosmateus/fmcad/issues/43).
No broker semantics, public entrypoints or shared packaging files are changed by
this delivery. No obsolete terminal implementation is deleted before its controls
and project/config behavior have verified web equivalents. F1–F4 remain open.

Second delivery: [PR #60](https://github.com/kosmateus/fmcad/pull/60) integrates
localized operational/System/agents/projects views, guarded production SQLite
mutations, lazy broker controls and the registered-project launcher for E.
Packaged contracts and five new resources are explicit allowlist entries.
Installed alias authorization, passive history isolation and asset integrity
checks pass locally. Full CI/Chromium remains pending; no TUI deletion is claimed.
The original embedded Beads database has now been queried on a disposable copy;
its open retention task is broader than SQLite quotas.

Diagnostic retention follow-up: [policy and evidence](../CONTROL_CENTER_RETENTION.md).
Five new limit/redaction/ownership/disk-full/recovery tests and three existing
file-rotation tests pass. The observer IPC test is blocked by this host's Linux
abstract-socket `EPERM`, with a retained bounded diagnostic and explicit failed
readiness. This is not a CI pass.

Remaining package gates: production Chromium on the integration head, full CI
before each merge, A's authoritative phase/activity-fence boundary, E's public
launcher transition, the explicit terminal administration retirement decision,
and G's CI inventory/dependency integration. Native Fusion/platform launch
qualification remains required separately. Modeling delivery stays independent.

First delivery merged as `04a42b4c1b300fa2222d39ab9a78b7c86d345e2e` after all
22 checks passed on `7f0ab88`, including Chromium. The merge candidate against
fetched main had no changes to the affected Control Center/history sources.
Operational integration now includes a separate session-filter race regression
and retains the historical-agent assertions. The locale/CI proposal packages
licensed Greek/Cyrillic WOFF2 fallback fonts and registers the restored System,
diagnostic retention and existing observer rotation tests in the contracts gate.
The small shared script/build-list changes are an explicit proposal for G,
following coordination on PR #40; they are not independently accepted packaging.

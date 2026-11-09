# Control Center migration ledger

Audited by Agent F on 8 November 2026 from main
`0b84454d8e5d22abb23bcf52999c506894ebf5bf` and the original `plugins.zip`.
This is an implementation inventory, not a declaration of package completion.
Keychain is excluded. Modeling and Fusion mutation routes are unchanged.

## Archived scope and current dispositions

Archived task identifiers below were verified by querying the extracted Dolt
store with Dolt 2.7.2 on a disposable copy. The original database was untouched.
`web-query-api` and `web-service` were closed; `web-system-controls` was blocked;
`browser-console` and `log-retention` were open; the other listed UI tasks were
in progress. Archived status is not current acceptance.
Archived branch commits are source evidence, not proof of successful qualification.

| Archived task / feature | Current production evidence | Disposition / remaining work |
| --- | --- | --- |
| `control-center`, `control-center.1` | `src/composition/control-center.ts`, installed service and authenticated HTTP query routes | Preserve local web service; complete mutation composition and terminal transition. |
| `web-bundle` | Strict ESM build, local font/vendor manifest and SHA-256 verification; browser-bundle tests | Preserve assets and verify installed consumers on every delivery. |
| `web-operational-views` | Typed `web/app.ts`, query contracts, overview/tasks/agents/logs, correlated source/response artifacts and exports | Preserve all four views, exact project/task/request bindings, explicit unavailable/unknown data. Repair async lifecycle and selection races. |
| `web-agents-projects` | Typed presentation/controller, SQLite alias and archive/restore services and tests | Foundations exist, but production composition does not inject project actions and the main app does not mount the richer project controls. Required integration remains. |
| `web-system-controls` | Main has broker control core/IPC adapters and terminal controls; web has translated control messages only | Required web integration. Archive `impl/console-system-controls` at `3d8f73e` and `integration/control-center` at `fc7940a` contain contracts, server, web and QueueClient adapter. Audit each against current A contracts; do not transplant entire branch. |
| System status view | Main overview renders a small host strip; archived integration has full System view | Required parity review of broker/process/lock/health detail. A controls broker semantics; F owns presentation. |
| `web-telemetry` | Passive production telemetry reads broker/presence evidence and registered histories; `console-telemetry` tests | Preserve absent/stale/unknown distinctions. Real running broker browser evidence remains beyond the existing retained-SQLite browser test. |
| `log-retention` | SQLite page/query/read-snapshot bounds, database cap, bounded ingestion; no explicit purge API in the current history port | New quota-exhaustion test proves failed writes keep the committed revision, original unresolved event/job/file records and foreign project unchanged across reopen; page/read byte bounds reject excessive queries. No automatic deletion is introduced. Remaining retention policy and archived task acceptance must be reconciled. |
| `locale-catalogs`, `locale-selection` | Imported catalogs, key/argument test, persistent selector and fallback runtime | Preserve catalogs. Main app still contains Polish literals in detail/filter/help surfaces and fixed `pl-PL` host formatting; translation completeness is not UI completeness. |
| `browser-console` | Fixture interaction suite and production registered-SQLite test | Preserve exact response waits and network/error evidence. Add deterministic delayed-response and disposal regressions; extend production broker coverage. |
| Terminal project/config discovery | `src/console.js`, `console-project.js`, CLI help | E-owned entrypoint coordination required; do not silently drop options or diagnostic alias. |
| Terminal keyboard, freeze/follow, search/filter, details/export | Web counterparts are present | Verify web keyboard accessibility and dynamic filtering; terminal-specific rasterization/PTY behavior can retire only with entrypoint change. |
| Terminal broker pause/lifecycle and system inspection | `console-controller.js`, `console-services.js`, System terminal tab | Keep until web parity is verified. Do not delete controller/services merely because their names start with `console-`. |
| Terminal rendering/dependencies | `console-app`, renderer/view/chrome/tabs, `terminal-kit`, visual/PTY scripts and tests | Separate retirement PR after parity; E changes public routes, G integrates shared package/staging/CI removals. |

## Coordination

[Issue #43](https://github.com/kosmateus/fmcad/issues/43) records exact A/E/G
boundaries. A must confirm existing status, generation/instance fences and original
receipt recovery APIs. E owns `console`/`diagnostic` dispatch and help. G owns shared
package dependencies, staging and CI changes. These dependencies do not authorize
F to replace their implementations or block independent modeling delivery.

## Verification and native qualification

The first lifecycle delivery targets repeated startup, disposal during a pending
snapshot, and closing a task dialog while its refresh is in flight. Test-only PR
head `dc9488983d468ac29fdae12a4fb1f5dfcc2cd364` compares against unchanged main
production code. Linux Chromium remains a merge gate; local paired DOM comparisons below establish the pre-fix failures while the browser job is queued.

Local build and test typecheck pass. Local Chromium 141.0.7390.37 exits with
SIGTRAP at process startup in this host; this is not a passed browser run. Linux
CI remains required. Browser scripts/styles, console errors and failed requests
must be checked against installed production composition.

Native qualification still requires Fusion-backed system observations, supported
broker controls against a real session, platform launch/open-browser behavior and
shutdown with active native work. Browser/SQLite tests do not qualify these.

No TUI implementation has been deleted. F1–F4 remain open until all required rows
above are integrated and verified; claim or intermediate lifecycle PR is not completion.

## First delivery evidence

- Same disposal/start harness against archived `master` (`f474e943`) and current
  main (`0b84454d`): both perform 3 snapshots, 21 queries and 3 watches. Archived
  code additionally repopulates 17,105 characters of disposed DOM; current main
  already rejects that render. The patched app performs 1 snapshot, 0 queries and
  0 watches and leaves both mounts empty. This is an inherited lifecycle defect,
  partly mitigated by later render guards, not a new broker regression. The local
  harness uses JSDOM with identical delayed input and transpiles each app source;
  it is supplementary evidence, not Chromium qualification.
- Focused existing history/agents/locales/bounded-read/read-model/telemetry set:
  41 passes. Expanded history suite with quota/reopen protection: 6 passes.
- Production reader and asset tests pass except the offline npm consumer: this
  host does not retain registry metadata for its clean offline install, even after
  the repository cache preparation command. The failure is `ENOTCACHED` for
  `basedpyright`, before consumer execution. Keep the installed test unchanged.
- Stable local fixture (two registered projects, one retained task each, absent
  broker), Node 24.22.1: composition construction 18.06 ms; 20 snapshot+task-query
  pairs median 6.52 ms and p95 20.79 ms; one idle second used 25.48 ms process CPU.
  This is a host-specific starting measurement, not a portable performance gate
  or live broker benchmark. Lifecycle changes add no polling.

The paired detail-refresh harness also reproduces the archived/main defect:
closing leaves zero dialogs, then the delayed response reopens one. The patched
app keeps zero dialogs after the identical response. Both Chromium regressions
retain these expectations.

Additional archived integration source: `delivery/console-ui-locales` at
`fcb101321ae77c6b0d63eb72dc4f47c0c76167f5` already combines localized operational,
project and System views. This is a recovery reference for the next integration;
it must be merged selectively with current artifact/identity behavior and the
new lifecycle guards, not copied over main as a complete application.

## Operational integration delivery (in progress)

The localized archived views are selectively merged with current artifact and
identity handling and the lifecycle fixes. System controls consume the unchanged
BrokerControl/QueueClient ports, retain durable request receipts and generation
fences, and perform no startup action when opening the page. Browser disposal
invalidates System reads and prevents a pending status read from dispatching a
control after disposal or a project-scope change.

Production composition now injects SQLite project/agent alias and restore
handlers. Archival deliberately remains blocked: legacy queue admission and
presence writers do not participate in the project-history activity fence.
Issue #43 requests A's production fence adapter; idle telemetry alone cannot
establish safe archival. Isolated storage compositions never connect controls
to a different default broker directory.

The public launcher for E is `openControlCenter({port, projectPath?})`, returning
`{url, projectId, dispose}` after authenticated readiness. A supplied canonical
path must match exactly one registered project. The URL selects that registered
identity, with server-side authorization retained. Caller disposal does not stop
the shared detached service or broker.

Installed asset validation caught and fixed the archived root-level contract
placement: System contracts now live under `contracts/`, with all five new
resources explicitly allowlisted. No staging wildcard or integrity relaxation.
Local checks: strict build and typecheck, locale keys/parameters, all eight
agents/projects regressions, installed alias authorization and blocked archive,
passive history isolation, static tamper rejection and real HTTP asset serving
pass. The browser ESM dependency graph loads 20 modules and the manifest has 31
resources. The restored System suite has 19 tests; five local tests pass and 14
real IPC tests fail before assertions because this host cannot read `/proc/PID/stat`.
Full CI/Chromium on this delivery remains required before merging or TUI deletion.

## Verified archived acceptance gaps

The Dolt task `fmcad-log-retention` requires bounded private temporary service
diagnostics, ownership-safe cleanup, redaction, bounded writer queues and
disk-full/restart tests. SQLite quota alone does not satisfy it. Existing
`observer-errors.log` remains unbounded and durable project logs must not be
deleted when implementing that diagnostic policy.

`fmcad-web-system-controls` explicitly limits the primary panel to
pause/drain/resume and guarded STOPPED start, forbids reimplementing restart in
HTTP, and requires original receipt recovery. Terminal inspect/stop/restart/reload
therefore remain an explicit retirement decision with A/E rather than silently
being included in the web controls. `web-telemetry` records authoritative phase
boundaries as a remaining producer gap; polling timestamps must not fill it.


## Continuation audit: 9 November 2026

The operational integration and retention described above are now implemented in
this package; the earlier table is the original discovery inventory, not a second
list of unimplemented features. The current acceptance state is:

| Area | Implemented evidence | Remaining acceptance |
| --- | --- | --- |
| Browser query selection | Task-range buttons are selected inside the task range control in E2E; global project scope is a different control even when Polish labels both start with `Wszystkie` | Chromium rerun of exact request and row assertions; no expected query or result was weakened |
| Installed System integration | `control-center-production-browser` now opens installed assets, uses an actual QueueClient, authenticated IPC, lifecycle dispatcher/gate and durable receipts; pause/resume/drain each issue one mutation and opening System issues none | Execute on CI host with process-birth observations and Chromium; the offline supervisor makes no native Fusion claim |
| Telemetry registration | Default MCP entrypoint uses `createMcpStdioTelemetry`; owned operation and close lifecycle are tested by `mcp-default-telemetry` | Complete authoritative phase producer with A; `timing-samples-not-connected` remains an explicit unavailable observation |
| Retention | Bounded private diagnostic writer/cleanup in `CONTROL_CENTER_RETENTION.md`, bounded history reads and SQLite quota protection | CI across supported Node versions; no deletion of durable project evidence |
| Presentation retirement | E is changing default `console`/`diagnostic` launch to the browser and retaining `--web`; administrative CLI commands remain with A/E | Merge browser acceptance before deleting terminal paint modules and runtime dependency |
| Preserved historical contracts | Historical identity counts moved out of the agents renderer; task-event and client-presence assertions use text/domain interfaces without ScreenBuffer | Continue separating mixed terminal suites; preserve source/response ownership, bounds, correlation, false/zero and freshness assertions |
| Project archival | Alias/restore production handlers are integrated | Archival stays unavailable until queue admission and presence writers share an authoritative activity fence; idle telemetry is insufficient |

Local test typecheck passes after the browser integration test. Task-event and
presence suites report 9 passes and 4 environment failures: this host rejects
Unix socket listen and cannot establish Linux process birth via `/proc`. These
four assertions are unchanged and remain CI requirements. Chromium still exits
at startup in this host; it is not recorded as passing.

The original tests did not assert that a global scope button could substitute
for a task range button. Scoping the selector fixes an interaction ambiguity
introduced by restored project navigation; both the unfiltered query predicate
and the expected 12 task rows remain unchanged.

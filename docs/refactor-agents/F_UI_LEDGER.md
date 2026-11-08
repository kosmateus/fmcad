# Control Center migration ledger

Audited by Agent F on 8 November 2026 from main
`0b84454d8e5d22abb23bcf52999c506894ebf5bf` and the original `plugins.zip`.
This is an implementation inventory, not a declaration of package completion.
Keychain is excluded. Modeling and Fusion mutation routes are unchanged.

## Archived scope and current dispositions

Archived task identifiers below follow the completion plan. The embedded Dolt
store was extracted separately; no independent task-status export has been made.
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

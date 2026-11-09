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

### Chromium trace and locale correction (2026-11-09)

CI run 42675903303 passed the installed SQLite and authenticated System IPC
browser cases. The remaining interaction case stopped at filter reset: trace
call 250 requested `Wyczyść`, while the rendered dialog exposed `Resetuj`.
The exact dialog selector now uses its localized caption; the same unfiltered
request and rows remain required. Later modal and response selectors likewise
use the captions rendered by the production catalog.

Auditing those captions also exposed a production defect: deriving positional
translation keys from English object insertion order and the alias list bound
filter validation, search hints and shortcut descriptions to unrelated strings
in every non-English locale. The translation row keys are now explicit and
stable. Existing key/argument parity plus independent Polish/German semantic
regressions pass (3 tests); the complete test typecheck and browser build pass.
Chromium remains unavailable locally, so the interaction scenario still needs
the CI rerun; this is not recorded as a browser acceptance pass.

### Atomic observation follow-through

The former JavaScript observation module now delegates to strict typed host
composition, with pure bounded MCP result validation in core and filesystem
report snapshots in node-adapters. Public export names and closed-holder,
owner, original envelope, source ABI, report, queue-generation and instance
fences remain intact. Preparing a holder now rejects undefined, fractional or
NaN physical turn counts, matching candidate admission's existing safe-integer
requirement; malformed evidence must not authorize an SDK observation.

Nine focused historical/regression cases pass, including the existing paused
scheduler and full canonical source fences. API/core/adapter compilation and
focused lint pass. Raw-origin isolation now uses the configured temporary root.
That case still requires CI here: exact pre-migration and migrated versions
both fail closed because the host does not expose `/proc` for readBytes'
opened-path verification. The path guard and test's successful projection
assertion are unchanged; neither is bypassed for this environment.

### Source-reported phase timing implementation

The broker now records completed phase intervals at its own durable state
transitions, and workers report local prepare/finalize boundaries. Durations
come from a monotonic clock; read-side polling and wall-clock timestamp
subtraction do not generate samples. Queue waiting ends at admission, SDK
measurement begins at the sending transition, and manual queue pauses are
accounted separately. Unknown SDK outcomes and intervals open during a restart
remain explicitly incomplete. Observations never affect admission outcomes.

Per-job metadata is bound to the immutable job hash, contains no code or file
content, keeps exact bounded-size phase aggregates and at most 64 recent queue
wait samples. Overview uses at most 2048 latest source-reported samples. The
passive reader now consumes these receipts instead of the disconnected timing
placeholder; absent legacy receipts remain missing.

Five focused tests pass, including real durable QueueState transitions,
parallel local intervals, wall-clock adjustment, restart uncertainty and sample
bounds. All 17 existing telemetry tests pass; core/node/API compilation passes.
Full fresh build reached devtools tests and browser assets, then hit unrelated
`tests/data_import.test.ts` duplicate `require` declaration (reported to owner).


### Current continuation: typed boundaries and authoritative archive (2026-11-09)

The five small console runtime facades now delegate to strict typed host
composition; domain, bounded artifact, event correlation, response, source,
offline retention, metrics and installed-composition cases retain their original
assertions in TypeScript. The local focused runs executed 40 passing cases with
no skips (26 domain/artifact cases, eight read-model cases, six metrics/offline/
snapshot/installed-composition cases). The source formatter suite remains a
supported-Ubuntu check: both the exact dce47c5 predecessor and the migrated suite
fail the same three Python preflight expectations on Debian 13; the platform
fence and expected behavior are unchanged.

Project archival is now wired to the production passive activity reader while
holding the existing SQLite writer fence. It verifies the current live broker
PID/birth/nonce, registry capability, full durable queue, retained jobs and
complete client/OpenCode/legacy-direct observations. Admission and presence
publication use that same fence. Missing/legacy capability, unknown ownership,
partial state, pending queue commits and uncertain activity still refuse the
mutation. Closed fenced writers and confirmed dead process identities cannot
resurrect monitoring. Source freshness is measured at the fenced read and checked
after observation; the event-driven diagnostics timestamp is not a heartbeat.

Seven reader/archive cases passed, including separate competing admission and
archive processes using the actual registration and SQLite locks. Archive fails
promptly without a lifecycle change during contention; admission takes effect
only after the fence releases, and a later successful archive blocks subsequent
admission. A real broker IPC case then archived through the production reader and
ProjectActions, verified both lifecycle records, preserved the original receipt
lookup, and rejected a new request without repeating a physical operation.

Chromium is usable with the managed environment's approved local-server/process
execution path. The new snapshot-expiry regression passed: a table filter obtains
one fresh snapshot, preserves the selected filter and rejects the old rows. A
long interaction trace also exposed transposed copy-entry/back-to-task translated
row keys. Their mapping and independent Polish/German semantic checks were fixed;
the copy behavior assertion is retained. Final complete browser acceptance and
exact-head CI are recorded by the integration owner after the rerun, rather than
inferred from these focused results. These are offline proofs, not native Fusion
qualification.


C completed the two larger retained-test migrations in 03376ae:
`console-telemetry` preserves all 259 original assertions (plus two narrowing
checks) and executes 17 passing cases against both dce47c5 and current code.
`control-center-browser-bundle` preserves its four cases, all 53 assertions and
the byte-identical VM/installed-runtime source harness. Strict compilation and
lint pass; the full packaging/browser-bundle run awaits the stable integration
slot. E owns the six remaining service/pause/data/root-service/interface/client
presence test migrations. E completed those six strict migrations in 0c261a1,
preserving all 44 cases and 268 original assertions; runtime execution is
recorded separately by E and the integration owner.


The final three retained F suites (`project-history-telemetry-runtime`,
`project-logger-rotation`, `project-responses`) now use strict TypeScript. All
16 original tests and 97 original assertions remain; additional guards validate
unknown query rows, nullable logger paths and the worker's actual stdout file
descriptor. Focused compilation and lint pass. Their runtime execution remains a
post-staging requirement, including installed producer composition and the
observer process; compilation alone is not acceptance.

The archive reader additionally refuses isolated-admission and epoch-succession
markers. Root queue-state data cannot qualify the active queue while an isolated
epoch lives below `admission-epochs`. Broker build hash, control generation,
context epoch and queue epoch must have the required shapes. The refusal matrix
covers each marker and malformed metadata; its final execution follows central
staging, preserving the existing ownership and no-replay guards.

The [global state obligation ledger](F_GLOBAL_STATE_NATIVE_OBLIGATIONS.md) accounts
for the remaining 568 frozen style/motion/animation/camera/pose assertion IDs.
Twelve exact shared-case matches and three offline preflight matches await their
registered execution. The other 553 are explicit retained native obligations
whose `ScenarioSession` migration is still required; this ledger is not evidence
that those native fixtures or the overall offline migration are complete.


The retained passive project observer now has one strict canonical composition,
`library-project-observer.ts`; the CJS path keeps its eight historical exports and
executes `runProjectObserver` only as the child entrypoint. Process startup still
uses that public path. Queue polling remains read-only, project writes remain
serialized and bounded (64 projects, 128 pending writes per project), hourly
rotation remains exclusive, and shutdown retains bounded draining. The public
`locations` and `createEventSink` exports retain their original function identity.

The frozen dce47c5 source is public repository history. The paired observer suite
runs the same five rotation/correlation/protocol cases against actual old and
current observer subprocesses: the historical child executes a checked source
copy with the same staged dependencies. Protocol refusals cover wrong tokens,
malformed/incomplete/oversized observations, relative project paths and oversized
IPC packets while asserting unchanged durable queue bytes. Strict compilation
and lint pass; paired process execution is pending central staging.

### Staged process and browser execution checkpoint (2026-11-09)

After central build/staging, the three retained project suites execute: history
telemetry 6, observer rotation/protocol 5, responses 6; all pass without skips.
The paired observer test passes both wrappers, each running all five cases
against the actual dce47c5/current subprocess. Authoritative archive reader tests
pass 7/7, and the real installed broker admission/archive case passes. Sixteen
retained tests needed imports before their `createRequire(path.join(...))`
initializer after actual CJS emission; their original test/assertion ASTs remain
identical. The forty affected console cases execute successfully.

A deterministic Chromium regression showed background query completion replacing
an open locale menu, dropping focus and its option nodes. Keeping the existing
selector host across table rendering fixes this race; final app disposal still
removes its subscriptions/listeners. The regression fails against the previous
bundle (closed menu, lost focus, replaced node), then passes after the browser
build. The full browser run executes eleven cases successfully, including real
installed SQLite/all locales and real broker System controls. Its remaining main
case exposed an obsolete refresh label; scoped `common.refresh` selectors now
match the actual Polish label. That complete main case passes on rerun, including
pagination, exports, freeze/refresh, mobile layout and outage/recovery guards.
All twelve current cases have therefore executed successfully across 11+1 runs;
a single full run on the exact final commit is still required in integration CI.

The Python-dependent console-source cases remain platform-limited on this Debian
host: the same three checker/preflight failures reproduce against dce47c5. This
is a recorded environment limitation, not a weakened assertion or a green claim.
Native global-state factories are being moved onto the existing ScenarioSession;
source compilation and unsupported/lost-response tests do not qualify Fusion.

The remaining native camera/pose/design-style/animation/motion sources are now
ported onto the existing ScenarioSession. Strict TypeScript checks use the
current core sources while the shared component-reference declaration awaits
central staging; focused lint passes. The exact native scope, stricter original
user-view precondition and pending lifecycle/native execution are recorded in
F_GLOBAL_STATE_NATIVE_OBLIGATIONS.md. No simulator capability advertises native
materials, motion, viewport rendering or workspace behavior.

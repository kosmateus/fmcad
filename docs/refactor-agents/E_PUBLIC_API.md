# Agent E — public CLI, MCP, SDK and remaining host adapters

Status: **claimed by Agent E**, 8 November 2026. Implementation branch:
`refactor/agent-e-public-api`. Starting main: `0b84454`. Read
[the shared plan](../REFACTOR_PARALLEL_PLAN.md).

## Outcome and ownership

Finish public and host-side migration so the installed package exposes the same
supported behavior through CLI, MCP, OpenCode and library APIs. A source checkout
that compiles while packaged consumers fail is not completion.

Own public `src/entrypoints` (except A's broker runtime entry and F's UI internals),
`src/api` and their source facades, `src/commands.js`,
`client.js`, `config.js`, `mcp-stdio-compat.js`, public manual/help/catalog metadata,
OpenCode adapters and consumer tests. Include remaining offline host services
such as engineering-local, image trace/optimize/boundaries, reference-image
tools, shot/review/UI command adapters and their platform/process ports.
Public console entrypoints may delegate to F but must preserve CLI/API contracts.

Exceptions: A owns queue runtime/control, physical execution/admission and reset;
C owns modeling services; D owns file/import/reference-refresh/externalization/
drawing workflows; F owns Control Center implementation/browser/console renderers;
B owns live files; G owns shared build/staging/configuration and final removals.
`reference.js` for reference-image tooling is distinct from D's
`references-refresh.js`. Catalog metadata changes requested by C/D are coordinated
here so multiple agents do not race on registration.

## E1 — public route and compatibility audit

Inventory CLI commands/aliases/help, MCP methods, SDK exports and supported
OpenCode versions. Link each public route to its core service, adapter and tests.
Inspect generated documentation's unfinished audits; a command list is not
behavioral coverage. Compare baseline CLI/MCP behavior and current intentional
changes. The server name `fmcad`, broker-only routing and explicit discovery-only
mode are existing changes, not reasons to revert to the old direct backend.

Check parsing/defaults, JSON/text output, error/exit codes, Unicode arguments,
timeouts/cancellation, capability responses and disposal. Every request must
retain owner and document/file pins through A's broker boundary. Offline
calculations and image processing must stay offline; do not acquire Fusion merely
because the command is invoked through a public frontend.

## E2 — migrate remaining entrypoint and adapter implementations

Use strict TypeScript with runtime validation for external JSON and explicit
ports for filesystem, process, platform and transport work. Preserve public
signatures unless a coordinated change is justified by user-visible behavior.
Finish real implementations rather than adding `.d.ts` files over unchecked JS.
Keep loader shims small, documented and free of business logic.

Review `mcp-stdio-compat`, CLI dispatch/commands, client/config and remaining
entrypoint facades. Preserve framing, protocol IDs, initialization, tool discovery,
stdin/stdout separation, context isolation and response recovery. Share core
services rather than duplicating route policy in each frontend. Keep source
preparation synchronous where downstream immutable input contracts require it.

## E3 — finish host-side services and UI command boundary

Migrate the remaining image/reference/engineering/review/shot/UI command
orchestration into typed application/adapter boundaries. Keep interpreter and
dependency preflight, explicit runtime paths, no output on failed preflight and
original input preservation. Use realistic process fixtures rather than assuming
`/tmp`, WSL or system dependencies exist on every host.

UI command service migration concerns public request/response/lifecycle and
native watcher ownership, not F's browser rendering. Coordinate watcher/native
settlement receipts with A and UI/global-state shared scenarios with B. Do not
change unknown outcomes into successful or safe-to-retry responses.

## E4 — installed consumer parity and handoff

Exercise a tarball installed outside the monorepo through CLI, stdio MCP, library
APIs and both supported OpenCode adapter lines. Declarations must resolve without
private workspace imports. Verify runtime assets, entrypoint paths, initialization
and disposal; ensure test compilation does not overwrite staged runtime facades.
Provide G any staging/export/config changes as isolated commits for integration.

Update public catalog/help/documentation only when actual support exists.
Preserve unsupported-capability errors and make direct/raw paths obey the same
identity/admission contracts as ordinary calls. Propose facade deletion only after
G verifies every consumer, historical test and packaged path has migrated.

## Completion and evidence

Run public contract/CLI/parser/MCP framing and recovery tests, host preflight
faults, strict build/types/lint, generated-source admission where applicable,
installed package consumer checks and full CI. Compare operation counts and
side effects with historical tests, not just output snapshots.

Exit when every public route is typed and registered, supported API behavior and
errors are stable, host tools are migrated, packaged declarations/assets work
outside the repository, and G has the full route/facade inventory. Record native
UI/Fusion assumptions separately. Append PR/SHA and remaining groups after each
delivery; do not stop after the first CLI facade extraction.

## Delivery ledger

- Claim: PR #39, starting main `0b84454`; package E is in progress.
- Route inventory and outstanding groups: [E_ROUTE_AUDIT.md](E_ROUTE_AUDIT.md).
- First boundary: image trace/optimize/boundaries command orchestration and
  installed local-pipeline declarations. Historical process comparisons preserve
  exact requests, output and call counts. Full CI and final SHA pending.
- E1–E4 are not complete; remaining CLI/MCP compatibility, configuration/client,
  engineering/reference/review/shot/UI orchestration and complete installed
  CLI/MCP/library/OpenCode qualification remain assigned to E.

### Public compatibility boundaries (next delivery)

`library-client.ts` now owns the metadata-only compatibility client;
`library-configuration.ts` owns configuration loading, initialization and accepted
service validation. The old source paths remain small runtime loaders. Historical
comparisons cover all control-method denials, immutable header snapshots, context
replacement, repeated disposal, malformed configuration, forced initialization,
accepted-service bytes and runtime anchors. The existing configuration suites
pass 22 cases. Installed declaration coverage includes both new modules.

### Offline engineering and reference composition (next delivery)

`library-engineering.ts` owns CLI parsing, input-size checks and publication with
explicit file ports. The existing typed calculation engine remains unchanged.
`library-reference.ts` owns reference-image validation and synchronous interpreter
preflight. Neither imports broker execution or acquires Fusion. Unknown engineering
operation keys now produce an explicit unsupported-operation error before file
work rather than an incidental missing-method TypeError; supported routes retain
historical output and side effects.

Paired tests preserve input bytes, schemas, calculation statuses, malformed-input
errors, nonfinite rejection, output bytes and refusal to overwrite. Reference
comparisons retain synchronous preflight failure and exact helper arguments.
The existing six engineering/batch-local suites pass all 33 cases. Native image
quality and Canvas semantics remain deferred. Declarative metadata is still a
separate registration migration; these adapters do not close all of E3.

### MCP helper schema parity

The frozen predecessor rejects the advertised optional `acceptedOutcome` on
`fmcad_queue_reconcile` because it treats `required` as the allowed-field list.
Typed helper declarations and validation now distinguish allowed and required
fields and enforce the advertised committed/aborted enum. Paired tests preserve
the no-outcome response, reject malformed/foreign fields before registration,
and require one reconcile call plus one owned status read with zero submit/wait
calls. Request/document/file context stays bound to the owned job. Agent A was
notified on PR #42; no broker policy or receipt validation changed.

Build, lint and test typecheck pass. The focused library/framing/catalog set has
32 passes and five host-limited failures: one retained fixture requires
`/tmp/opencode`, and four artifact checks require `/proc` inode verification
(the last manifests as missing success output after that rejection). Relevant
framing, owned-artifact and retained test sources are unchanged from `0b84454`.
No path/ownership assertion was relaxed. Linux CI remains the qualification gate.

## Published sequence and dependencies

- #39: `8a707c2`, image host orchestration and declarations; CI pending.
- #46: `94cb3f1`, public client/configuration; stacked on #39.
- #48: `ae3faff`, offline engineering/reference; stacked on #46.
- MCP helper parity follows #48; full compatibility orchestration remains open.
- F's issue #43 owns the web lifecycle contract needed before retiring public
  console/diagnostic terminal launch. E requested URL/project selection,
  readiness failure and disposal semantics before changing `src/console.js`.
- G was given staging/test registration and writable npm cache findings on #40.
  Existing source facades remain until complete installed-consumer qualification.

### Review command boundary

`library-review-command.ts` owns argument parsing, source preparation and capture
composition, retaining the source facade and existing typed review workflow.
The unchanged review suite passes against both frozen and migrated wrappers:
12 historical cases, and 17 current review/application cases. They retain one-call
capture, two-owner output claims, failed restoration, corrupted evidence and
unknown timeout without replay. The source payload is byte-identical for the
same pinned request. Public parser/report and installed declaration comparisons
are added to the existing library contract gate.

G was asked on #40 to register the retained review/application/shot suites plus
installed MCP and both OpenCode adapters in the shared CI selection, with cache
preparation and the existing Linux temporary fixture directory. Their assertions
must execute before final qualification; a local pass is not full CI evidence.

- PR #52 also types the screenshot boundary. Fourteen paired observations preserve
  single dispatch, response precedence, malformed responses and publication errors;
  the two retained screenshot tests pass. Installed declarations cover ShotClient.

### MCP context and installed consumer follow-up

PR #39 completed full CI (run 42524333282) and merged as `10236646`.
PR #46 is now based on main. Review/screenshot PR #52 head `24b0ec5`
passes 13 library/screenshot tests, including installed declarations.

Queue metadata validation now moves to `library-mcp-metadata.ts`; paired
historical cases cover owner/document/file pins, sequence/revision validation,
Unicode, root hints, private metadata stripping and input non-mutation.
An inherited defect is retained explicitly: projectDirectory advertises 4096
characters but the shared identifier predicate limits it to 256. Changing that
acceptance range requires a separate behavior decision and downstream check.

MCP/OpenCode fixtures use the host temporary directory rather than assuming
`/tmp/opencode`. G was notified that offline-cache preparation must include the
supported V1 host dependency, not just runtime dependencies. Installed MCP and
both OpenCode lines remain open until the unchanged assertions pass in CI.

MCP catalog routing now uses `library-mcp-catalog.ts` with explicit catalog and
post ports. Seventy-two paired observations preserve local/broker routing,
notification failures, backend restrictions, response formatting and owner pins.
The installed OpenCode suite passes all nine tests after online preparation of
the V1 host dependency; actual consumer installs remain offline.

The installed MCP warning was traced to eager application configuration parsing
for optional companion startup, not missing installed assets. The existing
poison-config fixture failed because the parse error became a console warning.
The entrypoint now skips companion launch when configuration is unavailable,
preserves that error for the first queued operation, and retains exactly-once
best-effort startup and diagnostics for valid configuration. Existing tests are
unchanged; a new regression covers ping, config-required failure and subsequent
ping without a broker or companion call. F was notified in #43.

Final validation for this MCP delivery: full build, lint and test typecheck pass;
17 library/installed MCP/companion tests pass, including closed strict protocol
DTO declarations. Nine installed OpenCode tests pass. Three existing full
MCP integration cases remain locally blocked by missing /proc process identity
or opened-artifact verification, with guards and assertions preserved for CI.

### Command registration and help migration

PR #62 (`33f7539`) contains the typed MCP catalog/metadata and the installed
companion correction. Its full CI and G's added retained gates are pending.

Command registration now lives in `library-commands.ts`; all 505 canonical
routes, 337 aliases, flags, argument limits and longest-prefix dispatch are
compared with the frozen predecessor. Typed help modules implement English and
Polish rendering, contextual sections, manual registration and text formatting.
Every registered help page and the legacy/broker manual data are compared with
the predecessor. The three native documentation audits remain unfinished.

Two stale descriptions of legacy document selection now match the already
migrated `legacy_document.py`: one case-insensitive open-name match is required,
with ambiguity rejected before activation. This changes documentation only.
The comparison tests explicitly account for these exact wording corrections;
route/alias behavior and all other text remain covered.

The retained help/registry run exposed two inherited defects without weakening
assertions: batch.summary's audit pointed to the removed `.js` test rather than
`tests/batch-summary.test.ts`; two registry upload fixtures supplied only a WSL
environment variable, although detection now also requires the OS signature.
The audit points to the existing typed test and the two fixtures use the retained
fake-WSL helper. Production platform detection and upload assertions are unchanged.

Validation for command/help delivery: build, lint and test typecheck pass;
60 retained library/registry/help/manual/capability tests pass. The installed
consumer additionally runs the npm-created `fmcad` executable link for detailed
batch help with poisoned configuration, no source tree/host SDK and a read-only
package; it returns complete bundled workflow help with empty stderr. Historical
hashes of all nine migrated modules match the recorded `0b84454` git bytes.

### Catalog registry composition

PR #64 contains command registration and bilingual help. Catalog assembly now
uses `library-catalog-registry.ts`, retaining specialist configuration order,
validation, local classification, capability authorization and pinned probes.
Frozen/current catalogs run in separate processes because specialist configure
functions mutate loaded declaration objects. Every operation, MCP projection,
invalid argument outcome and CLI contract is compared without shared state.
Build and lint pass; 33 catalog/library/installed-consumer tests pass, including
strict declarations for the registry. No A/C/D specialist policy changes.

### Complete MCP compatibility orchestration

PR #46 passed full CI 42524870768 and merged as `7ec4886`; #48 now targets main.
PR #67 contains typed catalog registry composition.

`mcp-stdio-compat.js` is now a loader for typed catalog composition, queue
submission/recovery and the historical compatibility forwarder. Queue ports
preserve single admission, stable request context, owned-artifact reads,
reconciliation, caller-only wait abort and disposal. The newer bounded stdio
transport remains separate; its stronger wire rules are not silently applied to
the compatibility forwarder. Forwarder parity covers 110 request/response pairs
and session propagation. Nine paired queue scenarios cover successful/failed or
uncertain outcomes, Python preflight, lost acknowledgement with successful or
failed recovery, missing results and registration failure.

Full build, lint and test typecheck pass. All 35 library/stdio/catalog-sharing
tests pass, including installed strict declarations for the complete compatibility
module. Existing frame bytes, bounded metadata diagnostics, no-retry errors and
accepted-running-job assertions pass unchanged. Native ownership/inode checks
remain CI qualification rather than locally weakened assertions.

### UI host, domain and durable state boundaries

PR #68 contains complete typed MCP compatibility orchestration; retained gate
registration and full CI remain pending.

UI helper execution, request/identity/profile logic and durable observation/
lifecycle storage now have typed implementations. The host adapter preserves
bounded argv/output, exact request/lifecycle readiness, and the crucial distinction
between stopping an owned action helper and detaching a read-only status helper.
The state store exposes an explicit file port, retaining exclusive claims,
fsync-before-publication and absorbing unknown/finished transitions.

Historical parity covers 13 host scenarios, UI validation/identity/probe bytes,
profile declarations and observation/lifecycle files. All 53 library/UI cases pass
(the new store fixture's missing os import was corrected without assertion
changes); the retained real add-in guard also passes. Build, lint and test
compilation pass. Installed declarations cover all three modules. UI command
orchestration, watcher recovery and public console integration are still open;
no native Fusion/Windows qualification is claimed.

### Complete UI command and watcher orchestration

PR #71 contains typed host/domain/state boundaries. `library-ui-command.ts` now
owns inspect/respond/resolve, SDK probes, native command script preparation,
watcher status, arming and authorized continuation. The JS path is a loader.
Existing lease, exact identity/profile, one-time claim and unknown-outcome guards
remain in place; no retry or native qualification is introduced.

Strict compilation exposed a historical native cancellation defect:
`terminationScript` called undefined `pythonValue` despite importing
`pythonLiteral`. Existing tests injected terminateNative, hiding the actual-path
failure. A regression reproduces the old failure before dispatch, then requires
one guarded call with the existing serializer and zero calls for unqualified
profiles. Script bytes match the historical generator with only that missing
binding repaired; Python AST parsing succeeds. A was notified on #42.

All 55 library/UI tests pass, including installed declarations. The unchanged
retained UI suite also passes in a separate process against the frozen predecessor.
Build, lint and test typecheck pass. The historical subprocess explicitly clears
NODE_TEST_CONTEXT so Node actually runs the child suite; no test is skipped.
PR #48 passed full CI 42525428442 and merged as `5d5a793`; #50 now targets main.

### Remaining host registration modules

PR #73 contains complete typed UI orchestration. Image trace/optimize/boundaries,
engineering-local, reference-image and review registration modules now contain
only loaders at the old JS paths. Typed registration modules retain their actual
composition and all descriptors/manuals. Direct typed engineering composition
also exposed a weak provenance type; it now permits the existing structured
provenance fields alongside the optional CLI inputPath, without runtime changes.

Full build, lint and test typecheck pass. Historical metadata comparisons pass;
the retained library/registry/reference/review/image run has 75 passes and two
existing environment-dependent skips. Worker subprocess, no-config offline
routing, preflight and unchanged outputs are exercised; skipped native/interpreter
checks are not counted as qualified. No runtime assets or build lists changed.

### Local reference completion versus unresolved evidence

PR #76 preserves remaining host registrations. Selecting available Python image
dependencies uncovered a pre-existing CLI regression: successful reference layout,
calibration and comparison returned exit 1 solely because image confidence was
`unknown`. The documented worker contract permits successful computation with
unresolved evidence. A shared narrow predicate now accepts only the three exact
schemaVersion-1, document-free reference envelopes with success:true and
nativeAcceptance:notEvaluated. CLI uses it only for local receipts and the actual
invocation operation; MCP retains failed transport/job precedence. Broker unknown
outcomes and evidence values are unchanged. CLI also rejects explicit fail/blocked
statuses even if a contradictory success flag is supplied.

Historical code reproduces the exit-code defect. Negative cases retain rejection
for wrong schema/operation, native identity/acceptance, failed/blocked statuses,
unknown execution and reconciliation receipts. All 43 library/CLI/reference tests
pass with no skips, including real image processing in an installed read-only
tarball outside the repository with poisoned Fusion config and exact source-byte
preservation. Build, lint and test typecheck pass. An initial installed check caught
a workspace-only import; the CLI now consumes the existing staged composition
boundary. Three CLI temp fixtures use os.tmpdir; the legacy WSL fixture uses the
retained platform helper. Assertions and production platform detection are intact.

### Public console boundary and explicit web launch

The console/project entrypoints now contain typed implementations behind small
compatibility loaders. Terminal defaults, diagnostic alias, artifact discovery,
TTY errors and injected launch contracts are compared against frozen historical
implementations. Explicit `--web` consumes F's published openControlCenter port:
configured readiness, global view without an implicit project, exact registered
project selection and caller-only disposal, including output failures. English
and Polish help explain the distinction. Installed declarations include the
console ports without private workspace dependencies. Terminal administration
remains available until F/G's retirement gate resolves; no HTTP broker policy is
added. This delivery also removes a redundant string expression from the review
registration module discovered by the full lint gate.

The web route must remain draft until integrated with F's production launcher
and qualified as an installed consumer. Native qualification remains deferred.

### Shared public-consumer gate proposal for G

The isolated proposal registers 33 retained public suites in a separate Node
22.13.0/24.x CI job, installs the image test requirements and explicitly sets
FMCAD_REFERENCE_PYTHON=python3. It warms the optional supported OpenCode V1 host
metadata in the disposable offline cache without adding production dependencies.
TERM=xterm describes the injected interactive-terminal fixture. Three temporary
directories use os.tmpdir and the isolated child preserves PATH for hosts where
process.execPath is relative; all behavioral assertions are unchanged.

Local initial gate: 227 tests, 220 passed, seven failed, zero skips. Three
failures require /proc (broker birth/artifact identity), two were hard-coded
/tmp fixtures corrected here, and two presence reporters cannot establish birth
identity on this host. Corrected broker fixture reruns reach the retained /proc
guard; the stopped-broker child reaches a sandbox Unix-socket EPERM rather than
the Linux ENOENT contract. The additional review/UI/retained-origin run has 34
passes and one corrected temporary-directory failure; its broker rerun reaches
the same /proc guard. These are not green qualification claims. Full Linux CI
must run unchanged assertions before merging.

The isolated E/F integration tree builds and its installed tarball passes real
console readiness, static assets, registered/global URL selection, both aliases,
caller disposal and shared-service reuse. The diagnostic compatibility warning
introduced by F is retained. No terminal implementation is retired.

### Final E/F public-console integration

The integration combines E's public boundary and G proposal with F's published
terminal-boundary branch (7cc23f1), preserving all F telemetry/build additions.
It retains the real installed-console probe as tests/console-installed.test.js
and selects it in the public consumer gate. The test uses the actual launcher,
registration store and HTTP assets, checks both aliases and global/project URLs,
and verifies a single shared service survives caller disposal. Cleanup owns the
spawned child handle and restores test environment; it never trusts a PID from
discovery. The route audit table now records implemented surfaces separately
from outstanding full-CI, shared integration and native qualification gates.

Integrated validation: full build, lint, formatting and test typecheck pass.
All 36 focused console/library/installed-consumer tests pass with zero skips,
including actual Python reference processing and strict external declarations.
Full GitHub CI, G's shared-gate acceptance and predecessor merges remain open.

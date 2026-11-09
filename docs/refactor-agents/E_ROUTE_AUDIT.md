# Public route migration audit

Agent E, starting from `0b84454d8e5d22abb23bcf52999c506894ebf5bf`.
This is a migration inventory, not a claim of completed behavioral coverage.

The complete per-route/alias/source/test mapping remains in
[COMMAND_COVERAGE.md](../COMMAND_COVERAGE.md): 505 canonical registrations and
337 aliases. Regenerating that document does not qualify its listed assertions.
The three unfinished audits are `frame context_audit`, `snapshot capture_v2` and
`snapshot diff_v2`; all retain native qualification requirements. Their gaps
must not be cleared by offline entrypoint checks.

| Surface | Typed implementation / boundary | Retained evidence | Acceptance still required |
| --- | --- | --- | --- |
| CLI routes and errors | `entrypoints/cli`, parser/application; broker receipts and narrow local-reference result policy | CLI/parser, library API, historical CLI failure reproduction | Full Linux CI on final integration |
| 505 commands / 337 aliases | `library-commands`, `library-help*`, typed manuals and catalog registry | Exact route/flag/argument metadata and EN/PL historical pages | Three native audits remain deferred |
| MCP framing/catalog/queue | `entrypoints/mcp*`, `library-mcp-*` | 110 paired wire cases, nine queue outcomes, strict metadata, process framing and installed MCP | Linux process/artifact ownership tests |
| SDK and declarations | `src/api`, `composition/library*` | Strict external consumer compilation, read-only installed package, no host SDK/startup effects, disposal | Final integrated full CI |
| OpenCode V1/V2 | `packages/opencode-adapter/src/v1` and `/v2` | Installed object/factory loaders, context, permission denial, unknown outcomes and owned cleanup | G cache/gate integration and Linux presence identity |
| Help locale / preferences | `library-i18n` | All translations, plural/number/duration formatting, malformed config and exclusive-write history | Final full CI |
| OpenCode reporter / retained hooks | `library-opencode-presence` | Historical identities/events, host mapping, local abort and independent disposal failures | Real process-birth presence remains a Linux gate |
| OpenCode passive event client | `library-project-events` | Historical IPC framing, bounds, private token reads, errors, disabling and disposal; installed declarations | Real observer startup remains a Linux gate; observer policy stays with F |
| Default MCP telemetry producer | MCP process root delegates to F's `createMcpStdioTelemetry` | Once-only construction/cleanup, failure isolation, clean protocol stdout, installed discovery | Full integrated Linux CI; no inferred execution phases |
| Config / compatibility client | `library-configuration`, `library-client` | Historical validation/config writes, add-in protocol selection, compatibility factory dispatch and direct-dispatch denials | Final Linux/installed gates stay enabled |
| Image tools | Typed Python image command and `library-image-*-registration` | Historical argv/preflight/output, real synthetic images and installed assets | Native/image quality qualification is separate |
| Reference images | Typed local reference pipeline and registration | Real Python worker; original bytes and unknown evidence preserved; installed poison-config test | Full CI with explicit Python interpreter |
| Engineering local | Typed engineering core, command and registration | Fit/thermal/mass/fluid/hydraulic and historical metadata | Retained public-consumer gate |
| Screenshot/review | `library-shot`, `library-review-command`, registration | One dispatch, partial/restoration/publication failures; strict declarations | Retained public-consumer gate |
| Native UI commands | `library-ui-command/domain/host/state` | Historical host/state/guards, unchanged historical suite, serializer defect reproduction | Native Windows/Fusion qualification deferred |
| Console/diagnostic | `library-console`, `library-console-project`; F `openControlCenter` | Default web and explicit --web parity; installed registered/global readiness, assets and shared-service reuse | Full integration CI; F owns renderer retirement |

## Ownership handoffs

- A: execution/admission, ownership, recovery and native settlement remain owned
  by A. No direct fallback or mutation replay is introduced here.
- C/D: operation declarations consumed by CLI/MCP must preserve exact document,
  file/version and request pins. Send registration changes to E; do not duplicate
  service policy in the public adapters.
- F: public console commands retain signatures and delegate to F's implementation.
- G: retain all transitional public facades until installed consumer verification.
  The image adapter uses existing Python staging; it needs no shared build change.
  Its tests extend `runtime-consumers.test.js`, already selected by regression CI.

## First image delivery

Frozen immediate-predecessor sources and SHA-256 provenance are in
`tests/fixtures/public-host-baseline`. Twenty-four paired observations compare
complete worker input, selected interpreter/features, call counts, stdout,
stderr, exit status and errors for all three modes. No assertion is weakened.

The pre-existing local-pipeline declaration referenced private `core/src` paths;
it now imports the exported core contract so the existing staging rewrite closes
that dependency. Installed strict compilation tests the new adapter transitively.

The existing fake interpreter used `#!${process.execPath}`. On this host
`process.execPath` is the relative command `node`, so the inherited fixture could
not start. The fixture now uses `/usr/bin/env node` for relative executable names;
normal absolute Node installations retain the original shebang. The eight
previously failing consumer cases pass with unchanged assertions. A writable
`TMPDIR` is supplied externally; production paths and preflight are unchanged.

The table separates implemented migration from outstanding integration gates.
Native Fusion/UI qualification and image quality are not inferred from fixtures.

Screenshot orchestration now uses `library-shot.ts` with explicit client, output,
file and clock ports. It preserves existing permissive CLI parsing and Buffer
decoding behavior; stricter screenshot input validation would be a separate
behavior change. Historical malformed responses and write failures retain their
errors, with no retry or extra backend call.

MCP metadata/catalog now use typed composition and shared protocol DTOs. The
72 catalog comparisons retain local execution, broker forwarding and exact pins;
metadata comparisons retain private-field stripping without mutating callers.
Installed verification passes 17 library/MCP/companion tests and 9 OpenCode
V1/V2 tests. The companion poison-config regression is fixed without changing
existing assertions. Full CI and G's retained-gate registration remain required.
Queue submission/recovery and compatibility framing were completed separately
in the typed modules described below; `mcp-stdio-compat.js` is now a loader.

Command registration and help composition use typed `library-commands` and
`library-help*` modules, including typed legacy/broker manuals. The paired route
comparison covers all 505 canonical entries and 337 aliases, argument limits,
flags and dispatch. Paired help comparisons cover every EN/PL page, contextual
sections, manual data and ANSI wrapping. Only two stale document-selection
sentences change, reflecting the existing unique-match activation guard.

Catalog registry assembly now uses `library-catalog-registry.ts`. Isolated paired
processes compare all declarations, specialist validation, local classification,
MCP schemas/adaptation, CLI contracts and capability/probe outcomes. Installed
strict consumer compilation covers its exported declarations. Shared specialist
module mutation is isolated by the harness, not removed from production.

MCP compatibility orchestration is now typed in `library-mcp-compat`,
`library-mcp-queue` and `library-mcp-forwarder`; the old JS path is a loader.
Paired historical checks retain wire bytes, sessions, errors, single admission,
request/document ownership, acknowledgement recovery and caller disposal.
All 35 library/stdio/catalog-sharing checks pass, including installed declarations.

UI host execution, domain validation/profiles and durable observation/lifecycle
storage are typed in `library-ui-host`, `library-ui-domain`, `library-ui-state`.
Historical comparisons and retained tests cover bounded process behavior,
readiness ownership, exact identities, one-time claims and absorbing state
transitions. Command/watcher orchestration was completed in the following delivery;
this does not qualify native Windows/Fusion behavior.

UI command/watch orchestration is now typed in `library-ui-command`; `src/ui.js`
is a loader. Fifty-five library/UI tests pass, and the retained UI suite also
passes against the frozen predecessor. The actual native-cancellation generator
had an undefined serializer identifier; the narrow fix is covered by historical
reproduction, exact generated bytes, syntax parsing and guarded dispatch counts.
Native qualification remains deferred, with unknown outcomes preserved.

Image, engineering-local, reference-image and review source registrations are now
loaders for typed `library-*-registration` modules. Descriptors/manuals and
reference catalog configuration match frozen predecessors. The retained
library/registry/reference/review/image run passes 75 tests with two pre-existing
environment-dependent skips, recorded separately from qualified coverage.

Real reference-image tests now run with an explicit available interpreter: all
three pass without skips. A reproduced historical CLI exit-code defect confused
successful offline computation with unresolved image confidence. Narrow shared
CLI/MCP reference policy preserves unknown evidence and all broker failure gates.
The installed tarball runs the real worker offline with poisoned Fusion config,
read-only package files and exact source-byte preservation; the full focused
library/CLI/reference run passes all 43 tests.

## Current delivery and handoff status — 9 November 2026

The E1–E4 implementations are present in the integrated E/F base `178d37b`.
Historical PR numbers above describe provenance, not a current queue of remaining
implementation. Current package verification is against `refactor/agent-e-completion`.
The follow-up source scan found four small but real implementations previously
missed by this ledger: CAD input file decoding, the public add-in subclass, the
compatibility backend factory and add-in asset loading. These now delegate to
`library-cad-input`, `library-addin-client`, `library-backends` and
`library-addin-bridge`. Paired frozen-source tests preserve worker byte verification,
protocol fallback, pre-construction direct-routing denial and exact checked bridge
program bytes. Installed strict declarations cover all four. Remaining E source
paths delegate to emitted typed modules. A's execution/ownership, C/D's
operation policies and F's observer/browser internals remain separate ownership.

The default console now uses F's ready web service. `diagnostic` and `--web`
remain compatibility aliases; explicit registration, global selection, readiness
failure and caller-only disposal retain their existing contracts. This intentional
behavior change retires the TTY-only launch, so its old launch expectation is
replaced by the same web contract in default and explicit modes. Artifact project
discovery retains its standalone historical tests, but cannot silently substitute
for web project registration. Explicit broker administration remains in A's CLI.

Help layout no longer imports terminal-kit at runtime. Typed ANSI grouping and
pinned Unicode widths preserve frozen historical wrapping, including wide glyphs,
combining marks, emoji, punctuation, long words and incomplete escape sequences.
The historical oracle must remain test-only when F/G remove the root terminal-kit
dependency; no production dependency is needed for help text layout.

MCP process tests had stale fake-backend receipt parsing: the old assignment
regex silently ignored the current typed receipt binding, so no exact receipt
could settle. The fixture now unwraps the actual prepared artifact, requires its
binding/path, and tests both official/nonofficial `prepareReceiptScript` output.
Fake WSL path spelling is installed in both parent and real worker processes.
The 180-second public request budget matches the existing library contract and
retained 67–74-second admission evidence; short deadline contracts remain tested
separately. Duplicate requests, exact output, owner isolation, pause/restart and
one physical send per distinct request retain their assertions.

Still required before qualification: final integrated Linux CI on both supported
Node lines, including real process birth/open-file identity and broker consumers;
F's final renderer retirement; G's installed dependency and facade audit. The
restricted work host cannot provide `/proc` evidence, so no production guards
are bypassed and no local pass is substituted for those gates. The three native
audits and native Windows/Fusion UI behavior remain explicitly unqualified.

### Strict retained-test follow-up

Eleven existing E test files have moved to strict TypeScript: console bootstrap
and installed launch, default and installed MCP, MCP client context, screenshot,
OpenCode presence/historical hooks/web startup, passive project events and review
library services. Historical sources remain immutable provenance fixtures.
Larger CLI/MCP/framing/library/catalog/image/engineering test suites still need
strict migration under the final whole-project acceptance requirement. They must
remain registered while this work continues; a filename rename without typed
ports and decoded external data does not close that requirement.

The passive-event test migration exposed a source/dist nominal identity mismatch:
E's two passive composition modules now import EventSink from the same public
core boundary as their node adapter. Runtime behavior is unchanged. Four paired
IPC/reporter/hook tests pass. The two real presence tests return null reporters on
this restricted host both before and after migration; Linux qualification remains
required without substituting fake process birth checks.

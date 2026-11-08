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

# Public route migration audit

Agent E, starting from `0b84454d8e5d22abb23bcf52999c506894ebf5bf`.
This is a migration inventory, not a claim of completed behavioral coverage.

The complete per-route/alias/source/test mapping remains in
[COMMAND_COVERAGE.md](../COMMAND_COVERAGE.md): 505 canonical registrations and
337 aliases. Regenerating that document does not qualify its listed assertions.
The three unfinished audits are `frame context_audit`, `snapshot capture_v2` and
`snapshot diff_v2`; all retain native qualification requirements. Their gaps
must not be cleared by offline entrypoint checks.

| Surface | Implementation and service boundary | Evidence | Remaining work |
| --- | --- | --- | --- |
| CLI parsing and execution | `src/entrypoints/cli.ts`, `cli/parser.ts`, `cli/application.ts`; library execution and broker receipts | CLI/parser, library-api, queue-cli-recovery-parity tests | Audit legacy dispatch, flags, error framing and all registration metadata |
| Canonical commands and aliases | `src/commands.js`, `src/help*.js`, shared core catalog | registry, manual-coverage, capabilities tests; generated route mapping | Type remaining registration implementations and check stale prose against migrated handlers |
| MCP server and framing | `src/entrypoints/mcp*.ts`; catalog services and queue API | mcp-framing, mcp-owned-result-root, mcp-stdio-catalog-sharing, mcp-installed-package | Migrate `src/mcp-stdio-compat.js`; preserve IDs, context, ownership and acknowledgement recovery |
| Library API | `src/api`, `src/composition/library*.ts` | library-api, workspace-toolchain and installed declaration tests | Audit every supported export, disposal and installed runtime dependency |
| OpenCode V1 | `packages/opencode-adapter/src/v1`, root entrypoint | adapter and installed consumer tests | Verify supported >=1.18.29 <2 installed object-loader path |
| OpenCode V2 | `packages/opencode-adapter/src/v2`, root entrypoint | adapter and installed consumer tests | Verify supported >=2.1.3 <3 installed factory path |
| Configuration and compatibility client | `src/config.js`, `src/client.js`; typed config domain/platform | runtime-consumers, config and client tests | Typed composition implemented in the next delivery; direct transport remains denied |
| Image trace/optimize/boundaries | `src/image-*.js` metadata/composition; typed local pipeline and Python process ports | runtime-consumers paired historical observations; image command suites | First delivery moves command orchestration into `python/image-command.ts`; full image/native quality qualification is separate |
| Reference images | `src/reference.js`; typed reference/local-worker pipeline | reference, reference_images, runtime-consumers | Validation and synchronous preflight composition typed in the next host delivery; metadata remains; distinct from D's references-refresh |
| Engineering local | `src/engineering-local.js`; typed engineering core | engineering-fit/thermal/mass/fluid/hydraulic, batch-local | CLI parsing/publication composition typed in the next host delivery; metadata remains; offline routing retained |
| Screenshot/review | `src/shot.js`, `src/review.js`; typed review core/adapters | shot, review, review-application | Type CLI boundaries and preserve one-call, partial failures and restoration evidence |
| Native UI command orchestration | `src/ui.js` | ui, retained-origin-ui-guard and native receipt tests | Type request/lifecycle boundary, coordinate watcher receipts with A and UI implementation with F |

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

Remaining E1–E4 work in the table is open. Native Fusion/UI qualification and
image quality are not inferred from process fixtures.

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
Legacy queue submission/recovery and compatibility framing orchestration still
remain in `mcp-stdio-compat.js`; they are not declared migrated by this extraction.

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
transitions. Command/watcher orchestration remains in the source facade pending
the next delivery; this does not qualify native Windows/Fusion behavior.

UI command/watch orchestration is now typed in `library-ui-command`; `src/ui.js`
is a loader. Fifty-five library/UI tests pass, and the retained UI suite also
passes against the frozen predecessor. The actual native-cancellation generator
had an undefined serializer identifier; the narrow fix is covered by historical
reproduction, exact generated bytes, syntax parsing and guarded dispatch counts.
Native qualification remains deferred, with unknown outcomes preserved.

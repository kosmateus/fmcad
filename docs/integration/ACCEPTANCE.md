# Integration acceptance ledger

Agent G owns this ledger. Starting source is
`0b84454d8e5d22abb23bcf52999c506894ebf5bf` (8 November 2026).
**Offline refactor: incomplete. Native qualification: not run.**
A claim, static registration, compilation or model output is not acceptance.

## Reproducible inventory

After `npm ci && npm run build`, run:

```sh
python3 -B scripts/integration/coverage.py --check --output .test-artifacts/integration/ci-registration.json
python3 -B scripts/integration/inventory.py --output .test-artifacts/integration/inventory.json
python3 -B -m unittest discover -s tests -p integration_registration_test.py
```

The starting snapshot contains 650 runtime source files and 420 executable public
routes (the existing registry has 505 entries including family headings). The
public inventory includes existing source/test audit references and aliases.
Those references still need effect/readback and negative-case review by E and
the runtime owners. Literal CommonJS shims are candidates, not approved deletions.
Other source forms deliberately remain `requires-semantic-review`: neither line
count nor extension can establish whether a family is migrated.

The initial test audit finds 485 test sources, 222 with a recognized CI execution
path and 263 without one. The new guard adds one Python test source, giving 486
and 223 respectively. Source wrappers and their TS bodies are separate inventory
rows, not independent test counts. None of these numbers counts assertions or
proves a test passed. The audit traces workflow run commands through npm scripts,
Node test selections, Python package discovery and literal test-wrapper imports.
Build/typecheck commands alone do not count. Dynamic dispatch, conditional jobs,
per-case skips, matrix completeness and actual results still require log review.

[Registration debt](ci-registration-gaps.json) names every currently missing
source, its triage owner and next action. This is open debt, not a waiver. New
unregistered sources and unexplained removal of listed gaps fail the separate
integration workflow. The A1 gate closes six initial gaps, reducing the current
ledger from 263 to 257 entries.
Do not add a blanket glob: `tests/integration` mixes native mutations and local
checks; `tests/native` also contains offline harness tests. Review each selection.

Initial gap routing: A 64, B 48, C 40, D 3, E 43, F 19, G 46. These are review
assignments under the seven plans, not final assertions of code ownership. G
resolves ambiguous ownership. In particular, A's six broker gates remain A's
bootstrap exception; G does not race edits to `package.json` or `ci.yml`.

## Delivery dependencies

Observed open heads below are proposals, **not merge evidence**. Refresh them
before any integration; record exact merged SHA and full matrix results here.

| Package | Observed delivery              | Required evidence / remaining disposition                                                                             |
| ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| A       | PR #42 merged as `171c972`     | A1 broker gates restored; A2–A4 admission/recovery/concurrency still required.                                        |
| B       | Deliveries merged through `6c9f6c5` | Persistence, assertion/profile increments, receipt-bound reopen/revision and bounded rectangle regeneration; semantic assertion mapping and remaining lifecycle migration stay open. |
| C       | PR #37 `a4943f3`               | Claim only at observation; canonical modeling services, Python boundaries and negative/readback evidence required.    |
| D       | PR #38 `ee0fd54`               | Claim only at observation; file/source/version/publication and recovery contracts required.                           |
| E       | PR #39 / #46 / #48 / #50 / #52 / #62 / #64 / #67 / #68 merged through `54b31e4` | Image, client/configuration, host commands, review/shot, MCP, command/help and catalog/queue boundaries; UI and complete installed parity stay open. |
| F       | PR #41 merged as `04a42b4`     | First lifecycle/race delivery and UI ledger; controls, production broker parity, retention and TUI retirement remain open. |
| G       | PR #40                         | Registration guard and inventories are an initial delivery, not G1–G4 completion.                                     |

Base-main CI run `42523257166` subsequently completed with all 22 jobs successful
on `0b84454d8e5d22abb23bcf52999c506894ebf5bf`. G's own exact-head workflows still
need their independent complete results. Merge neither this delivery nor another
owner's work on stale or partial checks.

The first A–F integration checkpoint is Agent B's merged `ecf4f60d1e597a5dfe2e7736509eb0c97025a2ba`.
PR #36 contributes only the package claim. PR #44 contributes saved-design
persistence at `fe1c66f74d61b0899f1aef64c501e7152b8166ad`; all 22 CI jobs passed
that exact head in workflow `42524121814`. The merge commit's only intervening
parent is the claim, so this ledger accepts the PR-head result for this bounded
delivery while still requiring push CI on the integrated G candidate and its
eventual merge head.

## Aggregate backlog reconciliation

The independently verified aggregate is **150 total, 104 closed and 46
remaining**. Historical closure does not establish current acceptance, and no
new closure is inferred or written. Underlying records, identifiers and
relationships are not included. Current scope is reconciled only through the
public package plans, merged commits and test evidence in this document.
Keychain remains excluded.

## Qualification preparation

Generate commands with real dedicated fixture identifiers after the pinned build:

```sh
python3 -B scripts/integration/native-plan.py --project-id PROJECT_ID --folder-id FOLDER_ID --output .test-artifacts/integration/native-plan.json
```

This command only constructs scenario objects and validates CLI arguments; it
does not connect to Fusion, start a broker or execute a scenario. Schema 2 consumes
B's merged required-profile manifest. It produces 66 shared command arrays for
eleven model families, MCP/addin and concurrency 1/2/10 with ten owners; it also
retains 27 native obligations as `NOTRUN` argument arrays and nine diagnostics as
non-substituting cases. It records source/profile hashes, dirty state, receipts
and cleanup policy. Semantic per-assertion mapping and legacy lifecycle migration
are still incomplete, so this remains a runnable **partial** handoff. Global UI
restoration and fixed owned fixture copies remain explicit B/F dependencies;
native export geometry is not model JSON.

Do not dispatch until offline acceptance is complete and the installed broker
matches the integrated source/build. Use the dedicated project/folder, verify the
configured transport, preserve original reports under `.test-artifacts/scenarios`,
and record Fusion/API versions, owners, request/creation/file/version IDs, physical
call counts, source hashes and before/after inventories. Execute command arrays
without shell interpolation. A blocked, unsupported, skipped or unexecuted
required assertion cannot pass qualification.

After uncertainty, inspect the original request's receipts. Use the existing
`--cleanup ORIGINAL_MANIFEST --backend fusion --profile broker --protocol ORIGINAL_PROTOCOL --run`
path only against the original backend/owner. Never replay the mutation, delete
by name, substitute another version or clear an unrelated document. Keep primary
and cleanup errors separately. Cleanup completion cannot pass assertions that
never ran. The older `tests/native/integrated-qualification/manifest.json` is
historical feature evidence with its own pinned runtime/hold; it is not the final
refactor manifest and its safety holds must not be removed by this inventory.

## Remaining integration work

- G1: resolve semantic family ownership, per-method effects/negative coverage,
  actual job results and assertion mapping from B. The approved aggregate is
  verified; semantic reconciliation and current closure evidence remain open.
- G2: register reviewed offline selections, migrate handwritten tests in bounded
  groups, and integrate delivered A–F contracts on current main with full CI.
- G3: complete installed CLI/MCP/SDK/OpenCode/declarations/assets checks, clean and
  incremental builds, owner-approved facade retirement and retained cold/warm,
  startup/checker/preparation/RSS/package-size comparisons. No concurrency increase
  is justified yet; retain model default `min(2, CPU)` and one physical SDK lane.
- G4: publish one accepted integrated SHA only after every A–F checklist and G1–G3
  closes. Finalize all native assertions, then qualify separately with real Fusion.

## Initial local verification and unresolved findings

- `npm run build` and `npm run typecheck:tests`: passed.
- Registration units: 8 passed, including rejection of compile-only/name-filtered
  selections and commented or quoted wrapper imports. Inventory check passed.
- Shared scenario units: 123 passed, zero failed/skipped. Simulator typecheck:
  zero errors/warnings. API verifier: 57 methods and 21 property accessor shapes.
- Native plan: 48 command arrays validated by the existing CLI parser, not run.
- Installed MCP test: initial attempt failed on missing offline npm metadata.
  Preparing cache and executing in the same host invocation resolves that setup
  problem, then the unchanged test fails its empty-stderr assertion with
  `fmcad: Control Center unavailable; MCP remains available.` E/F must diagnose
  the lifecycle/platform prerequisite before registration; expectations retained.
- Installed OpenCode tests initially failed dependency-cache setup; checker and
  admission packaging tests also encounter npm-pack JSON parsing. These attempts
  are failures, not installed acceptance; rerun with isolated prerequisites and
  retain complete stdout/stderr before attributing product versus fixture drift.
- Retained final-benchmark harness: three tests pass; its multi-client worker
  fails because `process.memoryUsage()` returns `ENOENT: uv_resident_set_memory`
  in this host, after setting a writable TMPDIR. RSS measurement is unavailable
  here; do not invent values, relax thresholds, or change concurrency defaults.
  Repeat on Linux CI with process/RSS evidence. No comparative timing claim made.

The dependency table is a timestamped observation, not a moving branch status.
Later A–F proposals must be fetched and verified before their status changes here.

Package inspection at `f1bed91f1e2c51ec33123f7b7d1fdfc758fbd64c`:
`npm pack --dry-run --ignore-scripts --json` reports 1,567 files,
3,374,032 compressed bytes and 16,624,667 unpacked bytes. No tests, node_modules
or investigation artifacts occur in the package list.
This checks the allowlist only; it does not replace installed behavior tests or
establish a before/after performance comparison.

## First merged A–F checkpoint — saved-design persistence

G rebased the initial inventory delivery onto merged main `ecf4f60`. The pinned
build and strict test typecheck pass. The shared scenario selection now contains
124 passing tests, including two model-only persistence cases. Simulator strict
types report zero diagnostics; the pinned API verifier now covers 58 methods and
21 property accessors. Static registration moves from 486/223 to 487/224 test
sources/registered sources, while the explicit debt remains 263: the new
`tests/scenarios/persistence.test.ts` is reached by the existing scenario-unit
glob and needs no new CI registration.

This bounded delivery deep-copies the supported in-memory design graph and
restores geometry, attributes, parameters and timeline state under a new modeled
document identity. It rejects foreign, incomplete, deleting, deleted and
superseded files before document creation. It does not qualify disk durability,
native F3D/STEP, historical-version opening or Fusion token continuity. It also
does not add a shared saved-reopen case: receipt-bound creation identity,
lost-reply/restart recovery and cleanup ownership remain required before that
scenario can run through both production transport profiles.

The native-plan generator still validates 48 command arrays and keeps every
result `NOTRUN`; native execution did not occur. The package allowlist remains
1,567 files and unchanged in size because tests and simulator sources are not
published. No facade or loader is retired at this checkpoint. B's assertion and
required-profile work remains an unmerged dependency and must be evaluated from
its final merge SHA rather than an open branch.

## Second merged A–F checkpoint — image command boundary

Merged main `10236646df47dfab961c35fa41eb9e9888980d08` contains Agent E's
first bounded public-host delivery from PR #39. All 22 CI jobs passed its exact
implementation head `8a707c2dd8e2a5b70365ba26a279ecd2b7fe9582` in workflow
`42524333282`. Main push workflow `42529116914` ended with `startup_failure` on
its second attempt; it is not successful merge-head evidence. G's newer combined
candidate likewise requires fresh CI.

The delivery moves trace, optimize and boundary process orchestration into a
typed image-command adapter while retaining the three public CommonJS loaders.
Twenty-four frozen-predecessor comparisons preserve complete worker input,
interpreter/feature selection, call counts, stdout, stderr, status and errors.
The full `runtime-consumers.test.js` selection passes 38 tests with a writable
workspace `TMPDIR`, including a tarball installed outside the repository and
strict compilation of its exported adapter declarations. The first attempt on
this host failed before assertions because `/tmp` did not exist; no assertion or
production path was changed for the rerun.

The combined build, strict test typecheck and 124 shared scenario tests pass.
Static registration remains 487 sources / 224 registered / 263 explicit gaps;
the runtime inventory increases to 651 files while public routes remain 420.
The package allowlist increases to 1,571 files, 3,375,315 compressed bytes and
16,628,068 unpacked bytes, reflecting the published adapter output. Simulator
typing and the 58 method / 21 property API check remain clean. The 48-command
native plan remains `NOTRUN` and offline acceptance remains `INCOMPLETE`.

No facade is retired: installed and source consumers still enter through the
public image loaders. E1–E4 remain open for CLI/MCP compatibility, configuration,
client, reference, engineering, review, shot, UI and complete installed
CLI/MCP/library/OpenCode qualification. Native Fusion/UI and image-quality checks
remain separate from these offline process fixtures.

## Third merged A–F checkpoint — assertion profiles

Merged main `0d6f75748da5e43ee7aaf4138d3bc523147a70ac` contains Agent B's
assertion audit and required-profile delivery from PR #45. All 22 CI jobs passed
its exact head `895eb69da90bd0f426d8760431c3604e2f30d8ef` in workflow
`42524676732`. Merge-head workflow `42530438963` was cancelled and is not
passing evidence. G's combined candidate must receive its own complete checks.

The audit freezes 1,588 static assertion/helper sites across 39 live sources.
It records 612 of 613 historical sites unchanged and retains the one intentional
MCP server-name change. Static equality is an anti-omission gate; semantic
per-assertion mapping and later immediate-predecessor comparisons remain open.
The required-profile manifest accounts for eight supported model families, 27
retained native obligations and nine diagnostic/helper cases. Diagnostics cannot
substitute for a required case, and uncertain exclusive-suite restoration blocks
later work with failing `not-run` results.

G's schema-2 native plan now consumes the merged required profiles. It validates
48 shared MCP/addin command arrays at concurrency 1/2/10, emits all 27 retained
native commands as argument arrays with status `NOTRUN`, and carries the nine
diagnostics separately. Every native obligation retains exact-owned-fixture and
lifecycle/cleanup migration prerequisites. The plan still reports offline
acceptance `INCOMPLETE`; no Fusion command was executed.

The combined build and strict test typecheck pass, as do nine registration tests
and 129 scenario tests. Static registration is now 489 sources / 226 registered /
263 explicit gaps. Runtime/public inventory remains 651/420. Package inspection
remains 1,571 files, 3,375,315 compressed bytes and 16,628,068 unpacked bytes;
the new audit and test sources are excluded from publication. No facade is
retired. Shared reopen, transactional/file migration, semantic dispositions and
global-state restoration remain B dependencies, so neither B nor G is complete.

## Fourth merged A–F checkpoint — retained broker gates

Merged main `171c972c1de8845aa300371798dcb6be5fd5416a` contains Agent A's A1
broker-regression delivery from PR #42. Its exact final head
`709741a4c083d59430479d00aa0b43c7abd17314` passed all 24 CI jobs in
workflow `42525055817`, including dedicated `broker-regressions` jobs on Node
22.13 and 24. Merge-head workflow `42531784829` was cancelled and does not
provide successful exact-merge evidence. G's combined candidate needs fresh CI.

The named broker selection registers the six retained queue files plus its
registration guard and compiled `a26222f` sequence comparisons. Static coverage
now reports 491 test sources, 234 registered and 257 open gaps: two new tests are
registered and all six previously missing broker families leave the debt ledger.
The explicit debt baseline is updated to the merged main SHA; no gap is waived.

The combined build, strict test typecheck, nine registration tests and 129
scenario tests pass locally. The broker selection passes 27 of 34 cases here;
the seven failures stop at unavailable `/proc` process evidence, matching the
documented host limitation. Assertions remain unchanged. The exact PR-head Linux
matrix passes both broker jobs and all 24 jobs, which is the applicable evidence.

Runtime/public inventory remains 651/420. Package allowlisting remains 1,571
files; the added development script changes package metadata to 3,375,397
compressed bytes, 16,628,497 unpacked bytes and shasum
`ca5bcec226058425f7fd80924919bda6d8429077`. Runtime payloads are unchanged,
tests and historical fixtures remain excluded, and no facade is retired. A1 is
integrated, but A2–A4 and offline acceptance remain incomplete. Native Fusion
was not executed.

## Fifth merged A–F checkpoint — public client and configuration boundaries

Merged main `7ec4886655875d5ecbc57c02c4d672baca92670a` contains Agent E's
second bounded delivery from PR #46. Its exact head
`94cb3f14035b6fc5f9a2ee525dd41163cea88d5d` passed all 22 CI jobs in
workflow `42524870768`. No workflow run is registered for the merge SHA at this
checkpoint, so the PR-head result is not merge-head evidence. G's combined
candidate and eventual merge head both require fresh full CI.

The delivery moves the metadata-only compatibility client and configuration
composition into strict TypeScript while retaining `src/client.js` and
`src/config.js` as the public runtime loaders. Historical comparisons preserve
immutable metadata, denial codes, context replacement, repeated disposal,
configuration validation, forced initialization, accepted-service bytes and the
configuration loader's runtime anchor. Every physical compatibility-client call
still rejects before transport.

The combined tree passes the pinned build, lint, formatting, strict test
typecheck, 129 shared scenario tests, simulator strict typing and the 58-method /
21-property API check. All 22 existing configuration cases and all eight library
cases pass unchanged. The library selection builds a tarball, installs it outside
the repository in offline mode and strictly compiles the two new declarations.
This host required a writable sibling `TMPDIR` and an explicitly prepared npm
cache; initial setup failures were retained and no assertion was changed.

Static registration remains 491 sources / 234 registered / 257 explicit gaps;
the modified library test was already selected by the contracts job. Runtime
inventory increases from 651 to 653 files for the two canonical typed modules,
while public routes remain 420. Package inspection reports 1,575 files,
3,376,304 compressed bytes, 16,631,918 unpacked bytes and shasum
`9a90747a162a58f72cc4233469b86f6ae28a11df`. Tests and investigation caches
remain excluded.

No facade is retired: both source loaders remain current public consumers and E
explicitly retained them. E1–E4 remain incomplete for MCP compatibility, catalog,
reference/engineering/review/shot/UI adapters and complete installed CLI/MCP/
OpenCode parity. Offline acceptance remains `INCOMPLETE`; the schema-2 native
plan still emits 48 shared commands, 27 `NOTRUN` native obligations and nine
non-substituting diagnostics. Fusion was not executed.

## Sixth merged A–F checkpoint — Control Center lifecycle guards

Merged main `04a42b4c1b300fa2222d39ab9a78b7c86d345e2e` contains Agent F's
first bounded delivery from PR #41. Its exact head
`7f0ab88ec0ed46658a20f0516911fb67f6daf811` passed all 22 CI jobs in
workflow `42525302616`, including the Linux Chromium job. No workflow run is
registered for the merge SHA, so this is not merge-head evidence and the combined
G candidate still requires the full matrix.

The browser app now shares startup, invalidates pending snapshots and dialog
refreshes at disposal/closure, clears timers and refuses late subscription or
dialog recreation. Paired baseline/current harnesses characterize both inherited
races. The merged UI ledger keeps controls, richer project/localization behavior,
retention and terminal retirement as explicit remaining work rather than deleting
the TUI after this first lifecycle fix.

On the combined tree, 14 focused project/history/agent cases pass with a writable
sibling `TMPDIR`, including quota exhaustion that preserves unresolved evidence,
foreign projects and committed revisions across reopen. The direct invocation's
initial failures were only missing `/tmp`; assertions were unchanged. Local
Chromium is not substituted for the exact PR-head Linux browser result. No public
console entrypoint, package dependency or obsolete terminal implementation is
retired; F1–F4 and native UI qualification remain open.

## Seventh merged A–F checkpoint — engineering and reference host commands

Merged main `5d5a793e7f5569608355415b3fb35fab1ef077be` contains Agent E's
third bounded delivery from PR #48. Its exact head
`ae3faff9802b2b4df6a420edaa8fe6fb6461a9f6` passed all 22 CI jobs in
workflow `42525428442`. No workflow run is registered for the merge SHA. Fresh
full CI is therefore required on G's combined candidate and eventual merge head.

Typed engineering composition now owns CLI parsing, finite/input-size checks and
atomic no-overwrite publication through explicit file ports. Typed reference
composition owns reference-image validation and synchronous interpreter preflight.
Both remain offline and acquire neither the broker nor Fusion. Historical input,
schema, status, output-byte, helper-argument and failure behavior is preserved;
unknown engineering operation keys now reject explicitly before file effects.

The six engineering/batch-local suites pass all 33 cases with a writable sibling
`TMPDIR`. The combined installed selection passes 48 library/runtime-consumer
cases, including tarball installation outside the repository, strict host/client/
configuration declarations, packaged assets, engineering schema and reference
preflight. The npm cache was prepared explicitly; no installed assertion was
weakened. Native image quality and Canvas semantics remain deferred.

Static registration remains 491 / 234 / 257 and public routes remain 420. Runtime
inventory is now 655 files. Package inspection reports 1,579 files, 3,377,457
compressed bytes, 16,640,729 unpacked bytes and shasum
`afdd52049a4cb6138d0a6fb9e9460b7d81170cf2`. No source loader is retired because
the installed and source consumers still use them. E1–E4, F1–F4, G and offline
acceptance remain incomplete; Fusion was not executed.

## Eighth merged A–F checkpoint — MCP reconciliation helper parity

Merged main `246356900061f7b95dc6bcddc6c067aaad72ceb0` contains Agent E's
MCP reconciliation helper correction from PR #50. Its exact head
`138059934f3bf2be649816161fb4e1ecdabf35b9` passed all 22 jobs in workflow
`42525845618`. No workflow run is registered for the merge SHA, so the exact
combined G candidate and its eventual merge head still require fresh full CI.

The public helper now treats `acceptedOutcome` as the optional field its schema
advertises and admits only `committed` or `aborted`. Paired historical/current
tests require exactly one reconciliation call and one owned-status read, with no
submission, replay or wait. Invalid outcomes, unknown fields and missing job
identity still reject before registration. Request, document and file pins remain
owned by the accepted job; broker policy and receipt validation are unchanged.

The combined pinned build, lint, formatting and strict test typecheck pass. The
changed library selection passes all nine cases, including an unchanged tarball
installation outside the repository after explicit offline-cache preparation.
The companion framing/catalog selection passes 18 of 24 cases on this host; all
six failures stop at unavailable `/proc` process or artifact verification. No
assertion was changed or waived, and the exact PR-head Linux matrix is the
applicable delivery evidence. All 129 shared scenario cases, simulator strict
typing and the 58-method / 21-property API shape check also pass.

Static registration remains 491 sources / 234 registered / 257 explicit gaps;
the modified library test was already selected. Runtime inventory increases to
656 files for the canonical typed helper module, while public routes remain 420.
Package inspection reports 1,581 files, 3,377,886 compressed bytes and 16,642,858
unpacked bytes, shasum `0c80e85af09e93821e6cec3149c32870674c6d2c`.

`src/mcp-stdio-compat.js` remains the active public loader and is not retired.
E1–E4, F1–F4, G and offline acceptance remain incomplete. The schema-2 native
handoff remains preparation only; Fusion was not executed and every native
obligation remains `NOTRUN` pending offline completion and real Fusion access.

## Ninth merged A–F checkpoint — review and screenshot boundaries

Merged main `cf3e6ad9532b02ea11ac76560893daa9c79e2163` contains Agent E's review
and screenshot boundary delivery from PR #52. Its exact head
`24b0ec58075974a254b63b2fb86109a23c228daf` passed all 22 jobs in workflow
`42529230482`. No merge-SHA workflow is registered; the combined G candidate and
eventual merge head still require their own complete matrices.

Typed review composition now owns argument parsing, source preparation and capture
coordination with explicit client/output/filesystem ports. Typed screenshot
composition preserves one dispatch, response precedence and publication failure
behavior. Review request identity, output claims, partial capture/restoration
evidence and unknown timeouts remain pinned without replay. The source loaders
remain public consumers.

G registers five delivered retained gates in `test:contracts`: review,
review-application, screenshot, installed MCP and the packed V1/V2 OpenCode
adapter suite. Static registration therefore moves to 491 sources / 239 registered
/ 252 explicit gaps, and the debt ledger removes exactly those five entries.
Existing CI cache preparation and `/tmp/opencode` fixture setup remain unchanged.

The combined pinned build, lint, formatting, strict test typecheck and nine
registration tests pass. All 30 library/review/application/screenshot cases pass,
including the unchanged external tarball installation and strict declarations.
This restricted host cannot create the hard-coded `/tmp/opencode` directory, so
the ten newly registered installed MCP/OpenCode cases stop at fixture creation;
their assertions are unchanged and the fresh Linux candidate matrix is required.
Simulator strict typing and the 58-method / 21-property API shape check pass.

Runtime inventory is 658 files and public routes remain 420. Package inspection
reports 1,585 files, 3,378,941 compressed bytes and 16,648,056 unpacked bytes,
shasum `cd897a4821b64c68320f074daa18aea12e616ccd`. No review, screenshot, MCP or
OpenCode loader is retired. E1–E4, G and offline acceptance remain incomplete;
native review/screenshot quality and Fusion qualification were not run.

## Tenth merged A–F checkpoint — MCP catalog and installed discovery

Merged main `9daedef4f763bd9b229cc88dc376967a488b55e3` contains Agent E's MCP
catalog, context and optional-companion delivery from PR #62. Its exact head
`33f75395dbbd6d2d27630cb2427d628d235e6846` passed all 22 jobs in workflow
`42530327335`. No merge-SHA workflow is registered; G's combined candidate and
eventual merge head still require their own fresh full matrices.

Typed catalog, metadata and protocol composition preserves offline discovery,
broker-only physical routing, exact owner/document/file pins, notifications and
private metadata stripping. Invalid application configuration no longer pollutes
offline MCP discovery through optional companion startup; the first queued
operation still receives the original error. Valid configuration keeps once-only
best-effort startup and its diagnostic. The inherited 256-character identifier
limit beneath the advertised project-directory range is recorded, not silently
changed.

G registers the retained MCP application, catalog and client-context suites in
`test:contracts`, moving static registration to 491 sources / 242 registered /
249 explicit gaps. Offline-cache preparation now installs explicit package specs
and includes the pinned supported V1 OpenCode host package so npm retains both
packuments and tarballs. Product dependencies are unchanged.

The combined build, lint, formatting, strict test typecheck and nine registration
tests pass. All 17 library/installed-MCP/companion cases and all nine packed
OpenCode V1/V2 cases pass with offline consumer installation outside the checkout.
The newly registered MCP selection passes 15 of 18 locally; two process-identity
and one owned-artifact case stop at unavailable `/proc`. Those guards and
assertions remain unchanged and require the fresh Linux candidate matrix.
Simulator typing and the 58-method / 21-property API shape check pass.

Runtime inventory is 661 files and public routes remain 420. Package inspection
reports 1,591 files, 3,380,374 compressed bytes and 16,654,784 unpacked bytes,
shasum `e87a7421aa9ad042539f28b0ed2d1b382ebe176e`. MCP compatibility and
entrypoint loaders remain active installed consumers and are not retired. E1–E4,
G and offline acceptance remain incomplete; native Fusion qualification was not
run and all native obligations remain `NOTRUN`.

## Eleventh merged A–F checkpoint — command registration and public help

Merged main `cafe9404a644f9ab27ac230bf3a13687e55d38b3` contains Agent E's
typed command registration and bilingual help delivery from PR #64. Its exact
head `3d549933732c4d60a545797638e5e976f5971f20` passed all 22 jobs in
workflow `42531269978`. No merge-SHA workflow is registered; G's combined
candidate and eventual merge head still require fresh full matrices.

Typed composition now owns all 505 canonical registrations, 337 aliases, flags,
argument limits, English/Polish help, contextual sections and legacy/broker
manual data. Two stale legacy-document selection descriptions now match the
already-migrated unique case-insensitive guard. The batch-summary audit link and
two fake-WSL upload fixtures are corrected without changing production platform
validation or upload assertions. Three native documentation audits remain open.

G registers registry, command-catalog, help-details and manual-coverage alongside
the already-selected library, capabilities and legacy-manual cases. Static
registration moves to 491 sources / 246 registered / 245 explicit gaps. The
exact 60-case public selection passes locally, including all routes/aliases and
help pages, frozen predecessor comparisons, and a tarball installed outside the
checkout whose npm-created executable renders complete batch help with poisoned
configuration, a read-only package and empty stderr.

The combined build, lint, formatting, strict test typecheck, nine registration
tests, simulator typing and the 58-method / 21-property API shape check pass.
Runtime inventory is 670 files and public routes remain 420. Package inspection
reports 1,609 files, 3,382,730 compressed bytes and 16,669,251 unpacked bytes,
shasum `3307b5262e5df2fb6f0a6497c307fceda5b71b18`.

The source command/help files remain small installed loaders and are not retired.
E1–E4, G and offline acceptance remain incomplete; queue/framing and native UI
scope is still open, no Fusion command ran, and native obligations remain
`NOTRUN`.

## Twelfth merged A–F checkpoint — saved revisions and receipt-bound reopen

Merged main `2ed8017eb2eb53ba9c1a4d0c796dad215dce5823` contains Agent B's saved
revision and reopen delivery from exact implementation head
`c4ab2f94bd9df66fa92770340dffa19151be9fef`. All 22 jobs passed that exact head
in workflow `42529825311`. No workflow is registered for the merge SHA; G's
combined candidate and eventual merge head still require fresh complete CI.

The shared `reopen` and `revisions` families preserve exact file, folder and
version ownership while moving to a new creation identity only through the
original successful request and matching durable receipt. Save observation,
close, open and deletion recovery read original evidence and do not replay an
uncertain mutation. The model exercises MCP and addin at concurrency 1/2/10,
including failure, cancellation, foreign-receipt and cleanup boundaries.

G adds both families to the broker CI matrix for both transports at concurrency
1/2/10 and keeps ten owners for every new job. Artifact names include concurrency
to prevent cross-job collisions. A registration guard proves all twelve required
new matrix cases remain present and that the command uses the matrix concurrency.
The required-profile ledger already names both families; static coverage therefore
moves to 493 sources / 248 registered / 245 explicit gaps without waiving debt.

The combined pinned build, strict test typecheck and all 156 shared scenario unit
cases pass. Simulator typing reports zero diagnostics, the API verifier retains
58 methods / 21 property accessors, and the two CI-registration assertions pass.
The unchanged local broker gate passes 28 of 35 cases; seven stop at unavailable
`/proc` process identity, so no assertion is relaxed and exact-head Linux CI is
required. A direct component-profile attempt produced no completion evidence
before it was terminated on this restricted host; it is not recorded as passing.

The native-plan generator now includes both delivered families and validates 60
MCP/addin command arrays. All 27 native obligations and nine diagnostics remain
`NOTRUN`; Fusion was not started. Runtime inventory remains 670 files and public
routes remain 420. Published package content is unchanged at 1,609 files,
3,382,730 compressed bytes and 16,669,251 unpacked bytes, shasum
`3307b5262e5df2fb6f0a6497c307fceda5b71b18`.

No facade is retired: the delivery adds owned scenario and recovery evidence but
does not prove any public loader has no consumers. Semantic per-assertion mapping,
remaining legacy lifecycle migration, package checklists, full candidate CI and
merge-head CI keep G and offline acceptance incomplete. Native qualification
remains a separate real-Fusion milestone after offline completion.

## Thirteenth merged A–F checkpoint — catalog registry composition

Merged main `be50c47d661dc9361a100dd0922a91ca8031e71f` contains Agent E's typed
catalog registry delivery from PR #67. Its exact head
`eaa3ff9d43b3713e037f8c567dbef659e9db8829` passed all 22 jobs in workflow
`42531860636`. The merge SHA has no registered workflow; G's combined candidate
and eventual merge head still require fresh full CI.

Typed composition now owns catalog assembly, specialist wiring, invocation
validation and capability dispatch while retaining C/D specialist implementations,
configuration ordering, local execution classification and broker probe pins.
Frozen/current comparisons run in isolated processes, and the installed tarball
compiles the new registry declarations outside the checkout.

The delivered consumer extends the already-registered `library-api` suite, so no
new source is added to the debt ledger: coverage remains 493 sources / 248
registered / 245 explicit gaps. After explicit cache preparation and a writable
temporary directory outside the checkout, all 16 library cases pass locally,
including the unchanged offline install and strict declaration compile. The full
build, simulator typing and 58-method / 21-property API verifier also pass.

Runtime inventory increases to 671 files while public routes remain 420. Package
inspection reports 1,611 files, 3,383,482 compressed bytes and 16,677,940
unpacked bytes, shasum `43a9119831e0be960bea7c19b0a40db677468bf7`.
`src/catalog/index.js` remains an installed compatibility loader with active
consumers and is not retired.

E1–E4, G and offline acceptance remain incomplete; remaining public consumers,
queue/framing, UI orchestration, package checklists and exact candidate/merge-head
CI remain open. Native preparation stays `NOTRUN`; Fusion was not executed.

## Fourteenth merged A–F checkpoint — MCP queue recovery and framing

Merged main `54b31e48dc27b73e5b0cd5a0def9659f5bc8eacc` contains Agent E's remaining
MCP compatibility delivery from PR #68. Its exact head
`90d7d55575b6722affdb20a9ed3c8da4b77f113f` passed all 22 jobs in workflow
`42532613149`. No merge-SHA workflow is registered; the combined G candidate and
eventual merge head still require fresh complete CI.

Strict typed catalog, queue and forwarder modules now own the compatibility path.
Explicit ports retain request/document context, one submission, lost-acknowledgement
lookup, owned artifact reads, caller-only wait abort and disposal. The historical
forwarder keeps its separate framing and bounded diagnostics instead of silently
inheriting stronger transport semantics. The public JS file remains a loader.

G registers the retained `mcp-stdio` suite alongside the already-selected library
and catalog-sharing consumers. The exact 35-case selection passes locally after
explicit cache preparation and outside-checkout installation, with no changed or
skipped assertions. Coverage moves to 493 sources / 249 registered / 244 explicit
gaps; only the delivered stdio source is removed from the debt ledger.

The combined full build passes. Runtime inventory increases to 674 files while
public routes remain 420. Package inspection reports 1,617 files, 3,385,022
compressed bytes and 16,694,315 unpacked bytes, shasum
`22dd30f1e463c1b7bcb4989dda969668ff6555fe`.

`src/mcp-stdio-compat.js` remains an active installed loader and is not retired.
The separately inventoried queue-lifecycle source remains open until its own
owner/execution evidence is delivered. E1–E4, G and offline acceptance remain
incomplete; full candidate/merge-head CI and remaining package checklists are
required. Native preparation remains `NOTRUN`; Fusion was not executed.

## Fifteenth merged A–F checkpoint — dimensioned rectangle regeneration

Merged main `6c9f6c5a1c98d0e6413e6cea006e725e25063836` contains Agent B's bounded
dimensioned-rectangle delivery from PR #63. Its exact head
`9be5e0f43d4a2c7b93ce04d0601b08f92ef0c7ec` passed all 22 jobs in workflow
`42530763341`. Both production-checker component transports passed on that
immutable head. No merge-SHA workflow is registered; G's previous candidate CI
is stale after this main advance and cannot qualify the new combined tree.

The shared `rectangles` family executes the production `shape.box` recipe with an
analytical anchored rectangle, independent driving dimensions and retained
extrusion expressions. It checks dimensions, volume, parameter regeneration,
saved revision/reopen persistence and a further edit after reopen. Unsupported
general solver behavior remains rejected, including foreign, driven, duplicate,
incompatible and invalid dimension inputs.

G adds `rectangles` to the required broker matrix for MCP and addin at concurrency
1/2/10 with ten owners. The registration guard now covers all eighteen combinations
across reopen, revisions and rectangles, and artifact names remain concurrency-
specific. Static coverage moves to 494 sources / 250 registered / 244 explicit
gaps; the new scenario source is reached by the existing scenario-unit gate.

The combined pinned build, strict test typecheck and all 163 shared scenario unit
cases pass. The six rectangle transport/concurrency cases exercise 60 owned saved
fixtures. Simulator typing reports zero diagnostics; the pinned API verifier now
covers 61 methods / 21 property accessors; both CI-registration assertions pass.

The native generator includes the new family and validates 66 MCP/addin command
arrays. All 27 native obligations and nine diagnostics remain `NOTRUN`; Fusion
was not started. Runtime inventory remains 674 files and public routes remain 420.
Published package content is unchanged at 1,617 files, 3,385,022 compressed bytes
and 16,694,315 unpacked bytes, shasum
`22dd30f1e463c1b7bcb4989dda969668ff6555fe`.

No facade is retired. General solver/topology behavior, definitions and batch
scenario migration, semantic assertion disposition, package checklists, fresh
candidate CI and eventual merge-head CI remain open. Offline acceptance is still
incomplete; native qualification remains a separate real-Fusion milestone.

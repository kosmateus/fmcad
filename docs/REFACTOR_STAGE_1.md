# Refactor regression gates — first delivery

The reference is `a26222ff617b0e9597b2a91b50474bdca8d0a0ce`, before the
TypeScript toolchain migration. Keychain had already been removed and is excluded.
This stage establishes repeatable offline evidence; it does not certify Fusion.
The complete historical comparison, backend design, dependency/acceptance plan
and disposition of the remaining Beads scope are in
[REFACTOR_COMPLETION_PLAN.md](REFACTOR_COMPLETION_PLAN.md).

## Changes and evidence

- Historical source comparisons no longer call `git show` against commits absent
  from a fresh GitHub checkout. Three verbatim fixtures have original revision,
  path and SHA-256 in `tests/fixtures/history/manifest.json`. The checker and audit
  fixtures reproduce bugs introduced later in the refactor; they are not the
  pre-refactor reference. They execute only in tests.
- The old CLI's injected `McpClient` is no longer the execution boundary. Baseline
  capture now invokes the current typed worker service with a fake physical port;
  historical checkouts retain their original CLI adapter. The generated program,
  output, read-only flag and number of calls remain observed. This capture does
  not establish CLI/broker parity; the separate worker/identity CI tests cover that
  boundary.
- `migration-allowances.json` records four exact, reasoned differences from the
  frozen capture: current help, generated CAD bytes, generated run bytes and the
  hash of the actual submitted run script. No outcome, identity or call-count
  mismatch is waived. Missing observations and stale migration exceptions fail.
- Inspection (`stats`, `bbox`, `bodies`, `rollback`, `units`) uses typed arguments
  and explicit SDK type boundaries. All five generated programs must pass the
  real checker. Eight SDK scenarios run against both pre-refactor and current
  Python, checking exact output, target activation and mutations. Missing SDK
  items still fail; existing volume-error behavior is preserved for later review.
- The catalog worker uses the broker's explicit native-path test adapter in place
  of a module-loader patch. A timeout reports its last job state and physical call
  count; the deadline and admission checks are not relaxed.
- The pause/resume test no longer accepts a Python checker rejection as proof of
  document protection. It requires either invalidated preparation
  (`DOCUMENT_CHANGED`) or a fresh unavailable target (`DOCUMENT_STATE_UNAVAILABLE`),
  a not-started outcome and zero product submissions. The fixture explicitly
  reports the unavailable target.
- Browser project filtering waits for the complete scoped result, because a
  matching row is already present before the scope change. The expected rows are
  unchanged.
- CI supplies its read-only GitHub token for the pinned Autodesk API download.
  The downloader sends it only to the exact HTTPS API origin, refuses redirects
  and still verifies the pinned commit and every file hash. Tests cover both
  authenticated and anonymous requests and ensure other origins receive no token.
- Locale runtime, selector and catalogs come from archived commit
  `7f01c715b2c61835e8a797fbaf12a358e2af44d5`. The current four-view UI receives its
  localization wiring without that branch's system-control feature. The later
  disposal fix (`fcb1013`) informs cancellation of late renders. The asset allowlist
  grows from 19 to 26 for six locale modules and their stylesheet. Catalog keys,
  interpolation parameters, persistence and disposal have regression coverage.
  This is not completion of the remaining console refactor or a full translation
  review.

## Repeatable checks

Run `npm ci`, `npm run build`, `npm run lint`, `npm run format:check`,
`npm run typecheck:tests`, `npm run test:regressions`, `npm run test:python`,
`npm run test:contracts` and `npm run test:control-center:e2e`.

The new `refactor-regressions` CI job runs on Node 22.13 and 24. Its physical ports
are controlled test doubles. Existing scenario-broker jobs retain both protocols,
ten concurrent scenario owners and production broker admission. A simulator or
mock pass must never be reported as a live Fusion pass.

## Remaining stages

1. Finish scenario ownership/cleanup: a separately saved Fusion file per scenario,
   cleanup after operation/assertion failure, close/delete reconciliation and an
   explicit cross-document routing regression. Preserve one SDK lane and concurrent
   offline preparation. Include failed document activation and duplicate document
   names: the historical inspection helper already trusted activation and selected
   the first matching name. Add identity-based rejection before tightening that
   behavior. A failed volume read reported as zero is another inherited defect
   requiring an explicit unknown/error contract, not a fabricated measurement.
   Native concurrency defaults to 10; measure CPU/memory
   before increasing the simulator default of 2.
2. Extend the shared simulator/live scenarios from historical assertions, using
   the pinned Autodesk interfaces. Add parameters, sketch/component operations,
   attributes and import/export incrementally. Simulator JSON is not an F3D file;
   geometric validity, asynchronous cloud save/delete and actual export semantics
   require native measurements.
3. Complete remaining JavaScript service/entrypoint adapters and Python runtime
   families, preserving typed payloads and admission/receipt boundaries. Keep
   characterization and safety regressions in CI before removing legacy paths.
4. Reconcile live-suite registration and unfinished Beads work with the delivered
   code. Register newer tests and remove duplicate/stale tasks without treating a
   historical task status as proof of implementation.
5. Complete remaining console and packaging work, then run installed-package and
   native Fusion qualification. Record SHA, Fusion/API versions, scenario inputs,
   assertions, cleanup results and unresolved operations. Unknown mutation outcomes
   are reconciled, never automatically replayed.

The archived reports do not prove every old live suite passed at the reference
SHA. To classify remaining broker failures, run the same scenario against both
revisions on the same Fusion version with full broker/receipt logs. No missing
native evidence is replaced by changing an assertion to match current output.

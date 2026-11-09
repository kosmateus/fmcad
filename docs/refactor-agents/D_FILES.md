# Agent D — files, import/export, references and publication

Status: **claimed by Agent D** (8 November 2026), starting from `0b84454`. Read
[the shared plan](../REFACTOR_PARALLEL_PLAN.md).

## Outcome and ownership

Complete file-dependent modeling workflows with exact source/destination identity,
version lineage, durable results and safe recovery. A successful transport reply
must never be confused with cloud completion or successful native file content.

Own `src/data-import.js`, `references-refresh.js`, `externalization.js`,
`drawing-package.js`, `drawing-export.js`, `drawing-check.js`, relevant document
publication composition, document/reference/import application services,
family-specific persistence/Python adapters, and non-live tests. Python scope
includes data_import, references, externalization, io, document/file operations
and corresponding domain/application modules and compatibility loaders.

Exceptions: A owns authenticated stage/operation journal primitives, broker
saved-fixture control and recovery/epoch infrastructure; B owns shared scenarios,
simulator and all live files; C owns geometric/assembly behavior; E owns public
registration/help and host image/reference-image tools. G owns shared build/CI
configuration. Use existing publication and stage APIs rather than redesign them.

## D1 — source and evidence inventory

Compare each path with `a26222f` where present and its immediate pre-extraction
revision. Reuse already migrated document publication and journal behavior;
PRs/stages 4g, 4h, 4l and 4r are delivered foundations. Keep acceptance/publication
separation, source pins, receipt-only replay and exact version ownership.

Inventory import source modes, replacement/lineage, reference policies, cold
open/close, derived dependencies, externalization ownership, drawing/export
formats and artifact publication. Map every branch to a test or explicit native
requirement. Check installed paths and foreign/incomplete/malformed results.

## D2 — migrate import and reference workflows

Move remaining Node orchestration to strict typed composition/ports/adapters.
Preserve synchronous input pinning and file hashes before asynchronous work.
Test source replacement during checking, duplicate/ambiguous file names,
changed document/file/version, target read-only state and foreign owner receipts.

For reference refresh, retain preserve/latest semantics, plan-time version pins,
mixed-parent and self-reference guards, graph/health checks and immutable plans.
Unknown updates never escalate to a second native command, save, close or replay.
Keep qualified fallback behavior, watcher lifetime and poststate evidence.
For imports, preserve replacement/lineage and deterministic errors without
silently creating duplicates. Compare expected call counts before and after.

## D3 — externalization, save and artifact lifecycle

Separate pure planning from Fusion mutation in large Python reference and
externalization modules. Keep strict checker coverage for generated paths and
the pinned Autodesk interfaces. Test partial success, failed save, accepted but
processing save, version increment, readback, reopen identity and cleanup failure.
Read original evidence after response loss; do not resubmit a possible mutation.

Review file artifact staging, atomic publication, manifest ownership, path and
descriptor validation, output overwrite rules and packaging. Genuine missing
files must remain distinct from failed inode/path verification. Preserve original
artifacts on parse/validation failure and never silently present fabricated bytes
as successful export. Changes to A's journal primitives need an explicit handoff.

## D4 — drawing/export and shared fixture integration

Finish drawing package/export/check service migration and file verification
contracts. Include path mappings, supported format options, error propagation,
partial output cleanup and publication boundaries. Geometry/rendering validity
belongs to native qualification; file existence alone is insufficient.

Provide B fixtures for saved versions/reopen, imports, references, roundtrip and
exports, including every supported positive/negative historical assertion.
Model files are marked JSON; their semantics can test identity/version/state but
cannot qualify F3D/STEP/STL/PNG. Keep native format/physical property assertions in
the common scenario inventory. Fixed original assets require owned test copies.

## Completion and checks

Run family-specific paired historical tests, real Python admission, strict
build/types/lint, fault injection at save/import/publish/delete boundaries,
immutable plan/journal tests and installed public CLI/SDK consumers. Coordinate
both transport profiles with A/B and require full CI on every merge head.

Exit when assigned Node services have one typed implementation, Python family
boundaries are verified, source/destination/version and ownership are enforced,
all known partial/unknown outcomes retain evidence without replay, and B/G have
shared scenario contracts plus native format/async-cloud assumptions. Preserve
existing behavior while separating new feature requests from refactor work.
Append PR/SHA, checks and remaining work after each group; the whole assignment
includes imports, references, externalization, save/publication and drawings.

## Execution ledger

- Claimed after reading the shared plan and D1–D4 and checking merged PRs
  through #35. PR #34 is the latest behavioral foundation; PR #36 claims B.
- Preserve A-owned journal/stage APIs, B-owned shared/live tests and E-owned
  registration. Record proposed integration contracts here and in each PR.
- Native Fusion and genuine native-format qualification remain pending.
- D1–D4 are in progress; this claim is not implementation completion.

### Delivery 1 — drawing check/export boundary (PR #38)

- Starting main: `0b84454d8e5d22abb23bcf52999c506894ebf5bf`.
- Strict typed drawing check/export implementations retain public signatures and
  complete SVG/PDF/DXF bytes. JavaScript entries delegate to the typed factory.
- Frozen, SHA-256 checked comparisons cover pre-refactor `a26222f` and immediate
  predecessor `0b84454`. The original archive Git history was downloaded and read
  separately; no archive or repository metadata is included in this PR.
- Historical cleanup loses the original publication error when removal fails.
  Both historical versions reproduce it. The new boundary returns AggregateError
  with the original cause and cleanup error, and refuses to delete a replacement
  directory with another inode. This is an inherited defect, not attributed to
  the TypeScript migration. Successful bytes and ordinary failure remain equal.
- Baseline pinned build and 114 family tests passed. Initial tests failed because
  this host lacks `/tmp`; rerunning with a writable TMPDIR passed unchanged.
- New paired/fault tests: 20 passed; existing drawing suite: 12 passed. Strict
  adapter compilation and repository lint passed. Full CI remains the merge gate.
- Integration request for G: add `tests/drawing.test.js` and
  `tests/drawing-migration.test.js` to `package.json` `test:regressions` in a small
  registry commit. They are discovered by `npm test`, which current CI does not
  invoke. Shared configuration has not been edited by D.
- B fixture contract: drawing reports retain `nativeAcceptance:notEvaluated`,
  source-map identity and content hashes. These are genuine external sheet
  artifacts, not native Fusion drawings or F3D/STEP/STL/PNG qualification.
- E: public `descriptors`, `validate`, `execute` and emitter exports are unchanged;
  installed factories and declarations stage under node-adapters/persistence.
- A: no journal primitives, stage ownership or receipt formats changed.
- Remaining: drawing package model/scene preparation and verification, full import
  and reference validation/planning composition, externalization policy/Python
  boundaries, source/destination receipt fault inventory and B integration.
  D1–D4 remain open; this bounded delivery does not complete the package.

### Delivery 2 — original externalization evidence

- Stacked on drawing delivery `9a7432ba1268a29c2cc1d7395cc0070ddb3b4511`.
  Comparison sources remain `a26222f` (archived monolithic workflow) and
  `0b84454` (pre-change composition plus persistence adapter).
- Reject a foreign manifest operation, a foreign operation result inside an
  otherwise correctly bound journal, and a manifest/record snapshot changed
  between reading the continuation and acquiring its lock. These are D-owned
  result checks; A's journal envelope and stage primitives are unchanged.
- Both historical readers accept the substituted owner and changed manifest in
  the same fault tests. They also return foreign completion results. These are
  inherited validation gaps. The required result is refusal with zero further
  SDK calls, preserved original bytes and no new mutation/replay.
- Cursor restoration and original copy-intent construction now have one strict
  typed core implementation. A seeded-session comparison preserves full copy
  payloads, source/destination pins, nonces and phase results across all readers.
- Five Python driver-refresh planning functions moved unchanged from the Fusion
  adapter into the pure domain. Historical function-body fixtures are SHA-256
  checked and carry exact revision/source/symbol provenance. Positive forward
  and restore requests, ambiguous bindings, changed producer/consumer versions
  and unrelated dependency drift retain behavior without SDK globals.
- Local evidence: 49 externalization Node tests, 93 existing Python SDK-double
  tests, six new paired pure-planning/boundary tests, pinned build, lint, formatting and
  strict test types passed. The new production basedpyright bundle admission
  gate also passed (74 seconds, no skipped analysis). Full CI remains the merge
  gate for this exact delivery.
- Failure during admission cleanup retains both the original evidence error and
  the lock-cleanup error; the retained lock remains explicit recovery evidence.
- Remaining D1–D4 work is unchanged apart from these extracted boundaries. Full
  import/reference validators and planners, drawing package model verification,
  remaining Python orchestration and shared lifecycle fixtures are still open.

- The new real-checker gate exposed two JSON-to-TypedDict argument errors in
  the pre-existing `_external_refresh_internal` signature (present at `0b84454`).
  Its wire entry now validates action and object shape before decoding into the
  internal operation record. Malformed inputs fail before registry/SDK access.
  A duplicate cast import introduced by the extraction was caught and removed.
  No checker strictness or admission requirement was reduced.
- Final staged checks also pass 20 native-action wrapper comparisons and all
  three document-I/O bundle tests. The bundle fixture formerly hardcoded
  `/tmp/opencode`; on this host spawn failed before Python execution because
  that directory is absent. It now uses the host temporary directory, still
  outside the checkout. All registry, source-map and no-filesystem-load
  assertions are unchanged. G should also register `tests/python-document-io.test.js`.
- PR #49 carries this delivery; full CI and #38 remain merge dependencies.

- Follow-up gate correction: the final lint rerun caught an optional-chain
  non-null assertion in the extracted pending-evidence reader. Split the lookup
  from the existing slot call without changing runtime behavior; rerun lint
  and the externalization tests before updating #49. The earlier blanket lint
  pass statement was premature.

### Delivery 3 — typed import workflow

- Parent: external evidence correction `ffe5d1e642669e5adeb082df6404262101c2849d`.
  Main remains `0b84454` at the latest fetch; deliveries #38 and #49 are not merged.
- Moved all remaining import preparation behavior into strict core modules:
  CSV/canonical values and rigid transforms, source snapshots/schema mappings,
  model/mass/provenance evidence, catalog/instance and purchase ledgers,
  parameter/placement/replacement records, and synchronous workflow composition.
  `src/data-import.js` retains public descriptors/manuals and delegates behavior.
  Public routes, source read order, ownership/revision fields and plan digests
  remain unchanged. No new save, mutation, fallback or retry is introduced.
- SHA-256 checked fixtures retain `a26222f` and `0b84454` complete import sources.
  Paired tests compare complete plans, offline results, source hashes, CSV line
  provenance, unit transforms, source schema errors, catalog refusal branches,
  replacement datum maps, missing model evidence and model hash refusals.
  A source changed immediately after reading still yields exactly one read and
  the matching original rows/hash. Read failure propagates the same error object
  with one attempt. No changed historical expectation is needed for this delivery.
- Local evidence: 104 import/reference/drawing/publication Node tests passed,
  including all 25 import tests; 18 existing Python import SDK-double tests passed.
  Pinned full build, strict test types, repository lint, formatting and explicit
  formatting of the new core modules passed. Externalization follow-up passed
  all 50 Node tests, including the real checker (67 seconds for admission).
- G's regression command already selects `tests/data_import.test.js`; no shared
  configuration was changed. B should retain the exact source/version and
  single-snapshot assertions when integrating shared import scenarios; E's public
  descriptor names, signatures and offline/live dispatch contract are unchanged.
- Still open: reference validation/planning composition, drawing package scene
  preparation/verification, remaining externalization and Python lifecycle
  boundaries, and full shared lifecycle/native assertion inventory. D1–D4 are
  not complete. Full CI on each exact merge head and the G registry handoff remain
  mandatory. Genuine native-format qualification remains explicitly pending;
  these text/model doubles do not qualify Fusion geometry or exported formats.

### Delivery 4 — typed reference workflow and Python wire admission

- Parent: import PR #53, `b768425071db4cd73c660a61e60040731b2512e7`.
- Migrated all remaining reference input validation, dependency planning,
  explicit binding coverage and freshness decisions into strict core modules.
  Typed host wiring now binds existing reference application services to the
  unchanged plan/receipt store. The public entry retains configuration/exports.
- The strict wiring exposed inaccurate existing declarations: planned versions,
  methods and fallback can be null; the top-level plan budget and a missing
  journal's writerActive can be absent. Types now describe actual serialized
  behavior. The budget comparison retains JavaScript's numeric coercion.
  Journal formats and A-owned primitives are unchanged.
- Frozen full sources from `a26222f` and `0b84454` compare normalized inputs,
  complete plans and snapshot effects, pins, diamond/cyclic graphs, duplicate
  identities, inaccessible sources, health/version drift and freshness refusal.
  Paired lifecycle tests compare success, unknown update, failed save and
  accepted-but-processing save; each submits one update and at most one save.
  Immutable plans remain byte-equivalent, reopening uses persisted receipts,
  and repeated apply performs no additional native step in every outcome.
- Moved the pure Python occurrence-state projection unchanged into the domain.
  Archived function-body hashes and paired tests verify ordering, missing token
  evidence and no mutation without SDK globals.
- Real production admission initially reproduced two pre-existing JsonValue
  argument errors in the reference wrapper at `0b84454`: action:str and
  data:_ReferencesInput. The Python wire entry now validates the action and
  object payload before decoding or touching SDK context. Invalid payloads get
  an explicit refusal instead of a later attribute/type error. Unknown actions
  retain the original error. Valid action semantics are unchanged.
- Final local evidence: 159 family Node tests passed, including 42 reference
  tests and both real basedpyright bundle checks (reference admission 67 seconds,
  externalization admission 68 seconds). All 27 Python reference tests passed.
  Full pinned build, repository lint, strict test types, repository formatting,
  explicit new-module formatting and diff checks passed. No test was skipped.
- The new reference tests extend an already selected regression file. B can
  reuse the paired save/reopen/replay assertions; E's public API is unchanged.
  Full CI on exact merge heads and G's earlier drawing/document-I/O registry
  additions remain required. No delivery has been merged prematurely.
- Remaining: drawing package scene/model preparation and verification, the
  externalization input/composition boundary, remaining Python lifecycle
  separation and shared D1/D4 inventory/integration. Native Fusion and genuine
  native-format qualification remain pending. The whole D package is still open.

### Delivery 5 — typed externalization input and composition

- Parent: reference PR #54, `719acdf339b74cb54ba71d2280aedd5dc970f049`.
- Moved the remaining externalization validator, immutable manifest projection
  and host composition into strict core/adapter modules. The public facade now
  only re-exports typed implementations. Exact source/reuse/destination pins,
  copy/replace/retirement authorization, extraction groups, mapping bijections,
  caller namespaces, dimensional bounds and driver-probe lease checks remain in
  their original order. A-owned journal code is unchanged.
- Added an immediate-predecessor `719acdf` fixture alongside archived `a26222f`.
  Paired comparisons cover all four modes, complete normalized inputs/manifests,
  phase/invocation controls, exact refusal messages, and isolation from later
  caller mutation. Invocation cursors do not change immutable manifests.
- The 50 existing externalization tests pass, including original-evidence owner
  faults, delayed publication, partial/unknown outcomes, no replay and production
  Python admission; all three new paired input tests pass separately. Full build,
  lint, strict test types, new-module formatting and diff checks pass. No Python
  or shared build configuration changed in this delivery.
- D2 import/reference and externalization Node services now each have one typed
  behavioral implementation. Remaining work is drawing package model/scene and
  publication verification, Python lifecycle separation and the D1/D4 shared
  inventory/integration. Exact-head full CI and prior registry handoffs still
  block merging; native-format qualification remains pending and keychain stays
  excluded. The full package is not yet complete.

### Delivery 6 — typed drawing model, scene and package publication

- Parent: external input PR #55, `8d6bf072043191a246a925adcd0d09668002d4b5`.
- All drawing model validation, scene preparation and report envelopes now live
  in strict core modules. Typed package persistence owns readback, hashing and
  publication; the JavaScript entry retains only descriptors and delegation.
  Shared scene types now come from core. Public exports and successful complete
  scene/report bytes and hashes match archived `a26222f` and predecessor `8d6bf`.
- Paired tests cover default and detailed models, sections, hatch/arc/angle,
  GD&T, uncertainty, native blocking, precise validation failures and readback
  of missing/malformed/foreign packages without modifying original evidence.
- Historical fault tests reproduce lost primary errors on cleanup failure,
  deletion of a replacement directory, and a partial scene left behind when
  report serialization fails. Publication now retains both errors, refuses
  cleanup of foreign inode ownership and includes serialization in its owned
  cleanup boundary. These are explicit inherited-defect corrections. An inode
  lookup failure now refuses before writing, retaining the empty directory as
  uncertain ownership evidence; older versions did not verify ownership.
- Local drawing evidence: 45 Node tests and five Python drawing tests pass.
  Full build, lint, strict test types and explicit new-module formatting pass.
  Lint caught and removed an unused type import before final verification.
- G's pending drawing regression registration also covers these appended tests.
  No A primitive, B live scenario or E public registry was changed. Full CI on
  exact heads remains mandatory. Native-format qualification remains pending.

### Delivery 7 — finish pure Python file-policy boundaries

- Moved 21 functions, without changing their AST bodies, from SDK adapters into
  existing domain modules: import plan/metadata/ownership validation; camera,
  visibility and restore-error rules; externalization endpoint identity, exact
  source pins, reserved probe budget and their type predicates. This makes these
  refusal and lineage decisions executable without a Fusion context. Native
  access, time/filesystem effects, mutation and cleanup remain in SDK adapters.
- Complete before/after function AST comparison against predecessor `71380fd`
  passes for all three adapter families. Existing historical composition parity
  remains intact. Added direct SDK-free execution evidence for foreign ownership,
  revision conflict, incomplete source copy, ambiguous endpoint identity, invalid
  camera/visibility state and cleanup failure propagation.
- Corrected the migrated-suite selector from nonexistent
  `data_import_native_test` to `data_import_test`. The old optional-file filter
  silently omitted the real import tests from this aggregate gate.
- Full document/I/O composition suite passed (7 tests including retained SDK
  fault suites, 79.7 seconds); 8 AST/boundary/planning checks passed. Genuine
  native file and geometry qualification remains a separate Fusion obligation.
  Exact-head generated Python admission and full CI remain required before merge.
- Enabling the actual import suite exposed two typed-migration regressions:
  `_di_item_metadata` rejected the `id`, `item` and `geometry` fields that the
  catalog writer emits (and its TypedDict already declares); strict `_di_plan`
  rejected `_deadline` left in a reused caller request by `_di_handler`.
  The metadata validator now admits its declared optional fields, and the handler
  copies the input before attaching execution bookkeeping. Historical assertions
  remain unchanged: successful reuse remains successful and COTS import failure
  is observed after creating the replacement while retaining original occurrences.
  These two deliberate fixes are exceptions to unchanged extraction ASTs.
- Final evidence after those corrections: retained compatibility import suite
  passes all 18 tests; the migrated aggregate including that same suite passes
  (76.3 seconds); nine AST/pure-boundary/planning checks pass. The final
  [contract map](D_FILE_CONTRACTS.md) separates executable offline evidence,
  shared-scenario handoff and native qualification obligations.

### Delivery 8 — canonical file host composition and retained executable contracts

- Continued from integrated candidate `dce47c5`; the seven previous deliveries
  already own the domain, application and Python lifecycle boundaries. They are
  retained, not reimplemented. Remaining import/drawing descriptor construction,
  local/native classification, workflow composition and reference catalog wiring
  now have strict `library-*` implementations. Existing public JS entrypoints
  delegate to them; installed-path compatibility is preserved.
- Added paired descriptor/manual and exact catalog-mutation checks against the
  existing SHA-256 verified baseline and predecessor fixtures. Import source
  snapshots, owner/version pins, immutable plans, receipt-only continuation and
  known/unknown cleanup semantics are unchanged.
- Migrated the document/I/O bundle contract and synthetic import fixture generator
  to strict TypeScript. The bundle still executes actual Python with filesystem
  loading forbidden, checks the full handler registry and source maps, and
  verifies unavailable document readback. The generator retains exclusive file
  creation and its existing no-overwrite/emitted-artifact tests.
- Focused strict compilation, lint and formatting pass. The six-file Node family
  selection executed 171 cases: 167 passed and four failed, without skipped cases.
  Two production checker cases ran before pinned `typing/current.json` existed;
  the generated adapter parser timed out in its unchanged Python child-process
  budget, and nested externalization returned unknown during the same incomplete
  host preparation. No production guard or expectation was relaxed.
- The targeted recheck after typings became available still encountered Python
  timeouts while other checker work ran. It was stopped to give the integration
  owner one heavy-test slot at a time; its partial output is not a pass. The
  canonical Python composition suite likewise needs its complete rerun after the
  interrupted child-process probe. Fresh exact-head CI and installed-consumer
  evidence remain release gates. Native Fusion qualification remains NOTRUN.

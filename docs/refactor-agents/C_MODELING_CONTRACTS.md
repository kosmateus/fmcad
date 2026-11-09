# Modeling contracts and delivery ledger

## Scope and baseline

Agent C started from `0b84454d8e5d22abb23bcf52999c506894ebf5bf`.
The original archive was downloaded separately; its Git object database supplies
`a26222ff617b0e9597b2a91b50474bdca8d0a0ce` and extraction history.
No archive metadata, worktrees, generated files or keychain are source changes.

The first delivery extracts input policies for sketch, entity query, spring,
thread, seal and cam into `packages/core/src/application/modeling`. Existing
`src/*.js` entrypoints delegate to the staged compiled implementation. Core
validation takes `unknown`, narrows nested values and performs no SDK or host I/O.
Public signatures and catalog registration remain unchanged; E owns registration.

This delivery does **not** complete C1–C4. Metadata-only wrappers, policy extraction,
generated programs and native modeling must not be counted as equivalent evidence.

## Inventory at package claim (superseded by the delivery records below)

| Family | Existing implementation and boundary | Remaining work |
| --- | --- | --- |
| Sketch | Typed input policy; Python `geometry_sketch`, `geometry_sketch_plan`, `sketch_geometry_proof`; compatibility loaders contain no handlers | Complete operation admission matrix, SDK false/null returns, dimension/regeneration model contract with B |
| Entity and measurement | Typed entity-query policy; Python entity/measure and ownership helpers; prior unavailable-volume fix retained | All generated query/measure operations; independent zero/unavailable readback, foreign tokens and proxies |
| Spring, thread, seal, cam | Typed input policies and unchanged descriptors; existing Python domain/adapter separation | Full admission and numerical contract matrix; native recipes remain unqualified |
| Curves | `src/curve.js` combines unit conversion, file adaptation and pure sample planning | Split source/hash/CSV adapter from sample policy; preserve provenance, winding, endpoint snap, source rows and synchronous preparation |
| Datum | `src/datum.js` combines catalog extensions and rigid-frame validation; Python geometry_datum split | Typed policy and catalog seam; nested occurrence frames, matrix units and identity regression matrix |
| Surface/model/shape | `src/surface.js` validation plus Python geometry_surface/model/shapes/feature | Typed surface policy; prepare-before-mutate and native failure/readback coverage |
| Fastener and feature rework | `src/fastener.js`, `src/feature-rework.js`; measured-fastener and geometry_feature Python modules | Typed nested contracts, structural parameter ownership, operation-change counts, timeline restoration |
| Selection rules | Typed artifact persistence already exists; `src/selection-rules.js` still composes owner checks and native calls | Typed orchestration with ports; preserve missing-vs-unverified distinction and request/file/creation identity |
| BRep baselines | Typed core service and persistence already exist; `src/brep-baseline.js` remains composition | Typed composition; exact artifact lineage and no repeated capture on uncertain response |
| Assembly, appearance, motion and other engineering families | Existing Python domain/application/adapter modules and catalog tables | Audit each existing public route, characterize effects and native obligations; do not infer completeness from module placement |

Document/file/import/reference/externalization/drawing remain D-owned;
execution/admission/identity remain A-owned; simulator and live scenarios remain
B-owned; common build/CI and retirement remain G-owned.

## Paired historical evidence

`tests/fixtures/modeling-history/manifest.json` records source SHA-256 and exact
revision for each retained policy. The migration suite verifies bytes before
executing frozen code in an isolated context. It compares identical inputs,
acceptance/errors and input immutability. It also compares descriptor bytes.

- Sketch pre-TypeScript baseline predates coordinate/profile proofs. Those routes
  are compared against pre-migration main separately, not called baseline parity.
- Spring/thread/seal/cam ordinary and invalid examples retain prior behavior.
- Entity query cases preserve exact scope conflicts, unit expressions, nonzero
  directions, expected counts, edge-kind requirements and recursive measurement
  validation. The existing entity suite additionally covers proxy/native
  attributes and verifies zero backend/config calls for invalid input.
- Public wrappers point to the staged compiled policies; no second maintained
  JavaScript implementation remains for these six input-policy families.

## Contract handoff to B

| Operation group | Required effects and independent evidence |
| --- | --- |
| Sketch create/build/geometry | Preserve explicit expressions and selected component ownership; reject malformed nested geometry before submission. Read sketch/entity/profile counts independently. Native curve/solver validity remains native-only. |
| Dimension plan/apply | Planning is read-only; applying is mutating. Accepted proposal IDs must be unique and tied to the original document/sketch/fingerprint. Do not turn failed readback into success or replay an uncertain apply. |
| Coordinate/profile proofs | Preserve existing coordinate frames, cm and cm² outputs and tolerances; zero profile counts are valid, invalid negative counts fail. B owns supported frame capabilities. |
| Entity query/fillet/chamfer | Require one explicit edges/query source; modeling queries need edge kind and expected count/uniqueness. Preserve scope, occurrence context and foreign-token guards. Read the protected document separately. |
| Spring/thread/seal/cam | Pure numerical results are analytic evidence only. Preserve explicit length/angle/material units, declared counts, hand/lead, pressure/curvature and limitations. Native body creation/solver acceptance needs separate qualification. |

All shared scenarios must retain one body of steps/assertions for model and Fusion.
C does not modify simulator or live-scenario ownership. No new routes are requested
from E by this delivery.

## Integration request for G

Add the new strict tests to compiler-only runtime tests and the regression job:

- `tests/modeling-policy-migration.test.ts` (107 paired/policy tests)
- `tests/modeling-admission.test.ts` (six representative generated public programs)

Also register retained `gm06-sketch`, `sketch-geometry-proof-bundle`, `entity-query`,
`spring`, `thread`, `seal` and `cam` JavaScript suites where not already selected.
The shared build/CI files are intentionally left to G. Do not merge this delivery
until the exact-head full matrix and these additional runtime gates are green.
The admission set is representative, not the full C3 operation inventory.

## Local evidence

- Pinned `npm run build` passed; definitions snapshot
  `83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179`.
- `npm run typecheck:tests` and targeted ESLint passed.
- Historical policy suite: 107 passed.
- Retained sketch/engineering suites: 25 passed; entity suite: 8 passed.
- `sketch.build` passes the production checker with document/file pins and pinned
  definitions. An initial diagnostic probe omitted `definitionsRoot`, which
  produced a tool error; it is not a production regression or passing evidence.
- Full Python discovery on this restricted host: 1517 run, 3 failures, 39 errors,
  66 skipped. Missing image libraries and absent Linux `/proc` block host tests;
  one inventory check overlapped staging and is rerun after the build. These
  results are not a full-suite pass. Linux CI remains required.
- Native Fusion, solver, topology and physical-property qualification not run.

## Fixture-order defect

Running `gm06_sketch_test sketch_geometry_proof_test entity_query_test spring_test
thread_test seal_test cam_test` together exposed four import errors: the isolated
sketch fixture restores `sys.modules`, while the engineering fixtures relied on
`model_test` having installed SDK modules globally. Both implementations are the
unchanged pre-delivery Python sources; this is fixture-state coupling, not native
geometry failure. Each engineering fixture now scopes its own existing SDK mock
with `patch.dict` while loading the canonical runtime. No handler or assertion
changed. The identical combined selection passes all 109 tests after the repair.
The separate document-runtime inventory rerun passed after staging completed.

## Second delivery: fastener and feature rework

The next stacked delivery moves `fastener` and `feature-rework` policy into the
same strict core boundary. Catalog registration remains unchanged; feature
configuration keeps the existing one-time replacement behavior. This includes
measured-fastener nested references and tool-access structures, legacy declared
stacks, feature parameter entries, extent mode exclusivity, operation changes
and native-edit exclusivity.

The pre-TypeScript fastener reference predates `fastener.measured-check`.
Historical descriptor comparisons explicitly exclude only that later route at
that revision; pre-migration main covers the complete descriptor set. Existing
legacy examples and negative inputs run against both references unchanged.
The expanded historical suite passes 156 tests. Retained fastener/rework/bundle
JavaScript suites pass 12 tests; their Python suites pass 67 tests.

The measured-fastener bundle test used a hard-coded `/tmp/opencode` working
directory. The same test on pre-delivery source fails to start its child when
that directory is absent. It now owns a temporary directory and cleans it in
`t.after`; the denial of checkout filesystem access and every registry/handler
assertion are unchanged. This is an inherited fixture assumption, not a change
to production execution or native qualification.

G should also register `tests/fastener.test.js`, `tests/feature-rework.test.js` and
`tests/measured-fasteners-bundle.test.js`. Full exact-head CI is still mandatory.
The remaining curve/datum/surface and selection/BRep composition work, exhaustive
Python admission inventory and native obligations remain open.

## Third delivery: curve preparation, datums and surfaces

Curve preparation now runs through pure typed sample policy and an injected,
synchronous Node source adapter. The existing CSV parser is supplied as a port;
its D-owned implementation is not copied. Full prepared outputs (including source
hash, file path, row/index provenance, units, winding and endpoint snapping) and
negative outcomes are compared against both historical sources. Source preflight
still completes before any native submission. No retry or background file read
was introduced.

Datum and surface validation/configuration are canonical typed core implementations.
The existing frame dialect, matrix tolerance, reflection/shear refusal, snapshot
requirements, trim plan/apply distinction, protected-zone guards and native-only
representation remain unchanged. These validators do not prove solver validity.

Evidence: 218 historical/policy tests; 18 retained curve/datum/surface JavaScript
tests; 43 Python tests. The representative admission test list now also includes
curve.fit, datum.transform, surface.patch, fastener.measured-check and feature.edit;
their run result is recorded in the PR after completion. G should register existing
`tests/datum.test.js` and `tests/surface.test.js`; curve.test.js is already selected.

## Fourth delivery: selection and BRep orchestration

Selection orchestration now lives in typed core policy with artifact/native ports;
its Node adapter owns path resolution, artifact clients and request identity.
The BRep entrypoint delegates to typed Node composition of the existing typed core
service. Catalog authorization remains injected by the facade. A single request
context is retained across each selection read/update and each operation submits
at most one native call. Missing artifacts do not invoke Fusion; inspection does
not write; unresolved responses do not update the stored manifest.

`modeling-artifact-history.test.js` verifies SHA-256-bound pre-migration source
and compares 24 identical scenarios, outputs and ordered side effects. Its injected
stores isolate orchestration; they are not evidence for real filesystem ownership.
The retained real-store/service suites pass 10 of 15 cases locally; five fail on
this host's unavailable `/proc` identity verification. Those guards and assertions
are unchanged and must pass in Linux CI. No native BRep roundtrip is claimed.

G: register `tests/modeling-artifact-history.test.js`, `tests/brep-baseline.test.js`
and `tests/brep-baseline-service.test.js`; selection store/e2e already run in the
regression gate. New service declarations use the existing persistence staging
rewrite and require no new package export. B should retain foreign-owner/hash,
missing-artifact, uncertain outcome and exactly-one-native-turn assertions.

Fourth-delivery checks: pinned full build and strict test compilation pass;
24 historical orchestration cases pass. Running the identical real-store suites
with the previous wrappers produces the same 10 passes / 5 `/proc` failures.
Targeted TypeScript lint passes. The five additional admission cases from the third
delivery passed (393.5 seconds total); all eleven representative cases are green.

## Complete public modeling inventory and admission obligations

`tests/fixtures/modeling-operation-contracts.json` inventories 266 public descriptors
in the assigned modeling/engineering families at the baseline. Each record includes
its public operation, requested read-only classification, route and native program.
The runtime test refuses additions/removals outside that inventory. The five shared
routes are explicitly assigned: D externalization and sketch file adaptation;
A/E definition host inspection/expansion/instantiation. C retains native recipe and
regeneration behavior. A host coordinator is not counted as a generic Python call.

There are 254 direct C Python operations, six selection/BRep coordinator-generated
internal programs, and one C offline baseline-inspection service. The six internal
fixtures invoke the actual typed core coordinator and authorization boundary before
preparing its program. Fixture artifact ports supply evidence inputs; they do not
claim durable storage, native serialization or geometry success. Existing real-store
regression tests independently cover those boundaries.

`modeling-admission.test.ts` now defaults to all 260 generated programs. G should run
8 disjoint jobs with `FMCAD_MODELING_ADMISSION_SHARD=0/8` through `7/8` after the pinned
build; every job uses the production checker without cache/limit exceptions. Each
report must pass and identify the prepared artifact hash and pinned definitions.
Do not also run the unsharded suite in the ordinary regression job. Merely preparing
all examples or starting the matrix is not a full admission pass.

`modeling-installed.test.js` installs the packed package with npm `--offline` outside
the checkout. Its public API validates every inventory example without mutation,
backend startup or checkout reads. It checks strict declarations for the migrated
core policies, persistence composition and curve source adapter. G should register
this test in the existing installed-consumer/regression job with offline cache setup.

## Python boundary audit and B scenario handoff

Existing geometry, assembly and document-I/O-family extraction tests already verify
handler registration, retained function bodies, SDK-free domain imports and historical
fake-SDK effects. These are retained, not replaced with file-placement assertions.
The audit ran 154 geometry/assembly/appearance/measurement tests and 218 further
runtime/boundary tests successfully. The latter includes sketch, curve, datum, surface,
feature rework, entity, selection, regional geometry and measured fasteners.

| Family | Independent state/effect contract for B | Existing behavioral evidence |
| --- | --- | --- |
| Sketches/dimensions | Dimension plan is read-only; apply validates document/sketch/fingerprint and accepted IDs. Read actual dimension expressions, driving flags, geometry and profiles after mutation. Preserve original solver errors if readback also fails. A denied/invalid plan must add no dimension. | `gm06_sketch_test.py`, `sketch_geometry_proof_test.py`, `typesgeometry/python_types_geometry_sketch_test.py` |
| Curves/datums | Preserve source rows/hashes and explicit frames; transformed occurrences must retain the root/component frame distinction. Compare endpoint/axis/frame readback rather than only response count. Do not infer spline or surface validity from samples. | `gm07_curve_test.py`, `datum_test.py`, `modeling-policy-migration.test.ts` |
| Model/shapes/surface/features | Reject malformed inputs before an SDK add. False/null SDK results are errors. Read owned ModelParameter expressions, timeline health and unaffected bodies; restore timeline position on failures. Fillets, lofts, sweeps, shells, splits and topology remain native qualifications. | `python_geometry_test.py`, `feature_rework_test.py`, `surface_test.py`, `typesgeometry/python_types_shapes_test.py` |
| Components/occurrences/joints | Ambiguous names must fail; child-local transforms and root occurrence transforms are distinct. Preserve exactly one intended mutation and verify the protected document independently. Joint reports distinguish requested/evaluated setter values from post-capture readback. | `python_assembly_parity_test.py`, `assembly_test.py`, `manual_assembly_test.py` |
| Entity/selection | A foreign native token/proxy cannot change ownership. Preserve zero/multiple-match rules and attribute readback. Artifact ownership includes project/file/creation identity. Missing artifacts do not invoke Fusion; inspection never writes; uncertain native outcomes are never replayed. | `entity_query_test.py`, `selection_rules_test.py`, `selection-rules-e2e.test.js`, `modeling-artifact-history.test.js` |
| Measurements/geometry evidence | Length/area/volume internal values use cm/cm²/cm³; outputs default to mm/mm²/mm³, mass kg, angle degrees. Valid zero stays zero; unavailable/nonfinite readings remain errors. Temporary booleans must not add design bodies. Parameter probes restore original expressions even after callback/recompute failure. | `measure_test.py`, `python_measurement_runtime_test.py`, `regional_geometry_test.py`, `brep-baseline-service.test.js` |
| Appearance/material/attributes | Appearance and physical material are separate; inspect the concrete face/body override. Missing density/coating is not invented. Preserve deterministic ambiguity reporting and source IDs. | `appearance_test.py` (including attributes/texture), document-I/O-family runtime replay |
| Engineering/motion/model state | Preserve explicit dimensional units, hand/lead, material assumptions and reference ownership. Analytic predictions and stored states are not solver or physical qualification. Native MotionLink, joints, sheet metal and native regeneration retain their explicit capability/refusal contracts. | `python_assembly_parity_test.py`, `measured_fasteners_test.py`, engineering family suites and original native assertion ledger |

B owns new simulator implementations and shared scenario files. This table and the
operation inventory specify handoff requirements, not a claim that B's model covers
all listed methods. G must reconcile each retained live assertion with B's ledger.

## Measurement policy boundary

The existing unit conversion table/function move from the Fusion measurement adapter
to its domain module. Both the original `a26222f` and pre-delivery `0b84454` versions
are SHA-256-bound fixtures. Identical zero, signed, ordinary, nonfinite, missing-value,
unsupported-unit and all supported-unit cases retain values/errors. No SDK call or
unit factor changes. A unique math import prevents a flattened-program duplicate;
the initial duplicate-import diagnostic was fixed, not suppressed. The real checker
passes the corrected program and 69 retained measurement tests pass.

D coordination is required for the existing cross-family AST parity test's alias map:
`_measurement_rules_math` must normalize to `math`, exactly like the other existing
pure-domain aliases. The shared file is left to D/G. This is a structural name change;
all behavioral comparisons remain required. Package C is still in progress pending
full exhaustive admission, shared gates, exact-head CI/merges and B/G reconciliation.

Fifth-delivery local checks: pinned full build, strict test types, targeted TypeScript
lint and the installed 266-example/strict-declaration consumer pass. Six authorized
internal-program preparations pass. The existing cross-family AST parity test now
fails only at the proposed measurement import-alias normalization; D/G's one-line
integration remains an explicit dependency, not a suppressed failure. The complete
260-program matrix is ready to run in shared CI; results remain pending.

## Canonical Python compatibility paths and discovered entity regression

Nineteen remaining C-owned `assets/cad` implementations are now thin compatibility
loaders for the already-typed runtime: animation/animation2, appearance/attributes,
cam/seal, checking/containment/dfm/interference, entity/measure, explode/fpc_pcb,
marking/optics/presentation, simulation and texture. D/A assets are untouched.
The installed assets no longer carry a second maintained handler implementation.
Loaders support an explicit `_FMCAD_RUNTIME_ROOT` from a foreign cwd and become no-ops
when canonical handlers are already present. Prepared native bundles still use the
manifest-declared runtime units directly and do not execute filesystem loaders.

Original bytes are retained under `tests/fixtures/modeling-python-history` with
revision/path/SHA-256 metadata. The C loader suite reuses the existing full function
body/count and registry-ownership oracles with those frozen inputs; a new loader can
never serve as its own historical reference. The D-owned comparator is not edited
by this delivery beyond the separately proposed math-alias integration.

Switching retained tests to the real canonical entity adapter exposed a production
regression from the earlier typing migration. `_entity_describe` emits a geometry
`frame` object (kind plus owned reference), and `_EntityGeometry.frame` declares
that object, but `_entity_geometry` incorrectly included `frame` among text fields.
Consequently 14 of 22 existing entity-query tests failed before a result could be
returned. The same 22 tests pass with the frozen original implementation.

The correction validates `frame` as a JSON object and retains it unchanged. All 22
existing assertions pass again. A new public-query regression verifies root/component
frame metadata, cm/rad units, document creation/file identity, empty affected list
and unchanged native geometry/attribute writes. That identical scenario passes on
`a26222f`, fails on the typed `0b84454` implementation with “geometry frame must be
text”, and passes after correction. No assertion was relaxed and no native solver
behavior was inferred. Across the now-canonical modeling family fixtures, 297 tests
pass, including appearance/texture, measurements, query/model integration and numerical
engineering contracts. The three loader/history tests pass with the proposed shared
math-alias normalization. Updated real admission and integrated CI remain mandatory.

A separate audit of the retained full `cad.test.js` reproduces the same three failures
with old and new C wrappers: two assume WSL path translation, and the CLI-preview case
uses a newline-containing display name without an immutable document pin. A trial using the existing fake-WSL fixture and explicit creation/file IDs exposed
an additional shared catalog.import preview contract: success=true/status=unknown
with exit code 1 for an unresolved source. The trial was reverted and handed to E/D;
no production outcome or retained assertion was changed by C.

The installed consumer independently passes all 261 C CLI previews and all 261 C MCP
previews outside the checkout, with no backend construction or native execution.
Snapshot capture uses its example scope identity and rejects foreign document pins.
All 266 public example schemas and strict consumer declarations also pass. These
checks cover installed host contracts, not native geometry or solver qualification.


## Current integration evidence

The integration proposal also includes main `9daedef4f763bd9b229cc88dc376967a488b55e3`
(E's MCP helper, review/screenshot and catalog boundaries). The combined tree passes
the pinned build, strict test types, lint, formatting and all 252 modeling
policy/history/installed tests with zero skips. This includes 263 CLI and 263 MCP
previews outside the checkout. No C runtime or modeling program changed in that
merge. PR #57 head `1c94657b` and #61 head `255dd866` now each have 22/22 successful
CI jobs (runs `42529553914` and `42530208843`). Shared gate integration and the
complete 262-program admission matrix remain required; the partial local shard
logs and queued integration CI are not successful full-matrix evidence.

The C stack is #37 → #47 → #57 → #61 → #65; #66 is the isolated shared-gate
proposal. Runtime head `c61a2515` is integrated with fetched main `5d5a793` in
#66 at `39103d1e`. The package-script conflict was resolved by retaining every
main entry and appending the C entries; no test was removed. Runtime Python,
CAD assets and modeling/checker implementations are unchanged by that merge.

A fresh geometry/assembly audit runs the retained statement/registration oracles,
historical SDK effect transcripts and modeling fixtures together: 274 tests,
273 pass and one existing installed-Fusion-SDK test skipped. The selection includes
geometry and assembly parity, model, datum, surface, feature rework, sketch/proof,
shapes and curves. An initial command used three nonexistent module names; that
harness error was corrected to the actual suite names without editing assertions.

B's `refactor/b-rectangle-dimensions` supplies bounded rectangle regeneration and
saved-reopen scenarios with independent dimensions and volume readback, plus
foreign/driven/duplicate/unsupported dimension negatives. This is reviewed source,
not a C execution result or general sketch-solver claim. Dimension plan/apply and
advanced geometry obligations in the handoff table remain separately accountable.

On the integrated tree, the pinned full build, test types, lint and formatting
pass. All 306 C JavaScript/TypeScript historical, retained and installed-consumer
tests pass, and all 129 currently integrated shared scenario unit tests pass.

Full current-head CI, all 260 admission cases on both supported Node lines, shared
gate integration and B/G assertion reconciliation remain open. Native Fusion solver,
topology, joints and physical-property qualification remain stage 3.


## Sixth delivery: remaining specialist and private-turn policies

The final JavaScript inventory found six additional modeling validators under
`src/catalog`: native-drive, regional geometry, section/witness, semantic model
state, selection-rule definitions/artifacts and BRep baseline input. Their pure
logic now lives in strict core policies. Two private selection/BRep catalogs also
use one typed core implementation, including their exact-object WeakMap/WeakSet
capabilities. JavaScript files are compatibility facades. E's registry composition,
public names, private declaration metadata and configuration order are unchanged.

All eight original sources are retained byte-for-byte with `0b84454` SHA-256
provenance under `tests/fixtures/modeling-specialist-history`. None of these source
files exists at `a26222f`; this delivery therefore uses the actual pre-delivery
implementation rather than claiming an unavailable earlier comparison.

The existing policy entrypoint now includes 2,651 paired public input scenarios
across all 16 affected public operations: positive examples, removed fields and
nested invalid/zero/nonfinite values, identical error names/messages and no input
mutation. Private cases additionally compare all six turns, unauthorized payloads,
cloned payloads, wrong selection operation capabilities and exact declarations.
All 251 policy/history/installed-consumer tests pass, including 261 CLI and 261 MCP
previews and strict installed declarations for all eight new core modules.

The six retained specialist integration/bundle suites initially produced the same
10 pass / 6 failure against both frozen and migrated sources. Five failures were
hard-coded `/tmp` or `/tmp/opencode` fixture directories; those fixtures now create
and remove owned temporary directories. No filesystem-denial or handler/readback
assertion changed. The resulting 15 pass / 1 failure includes an unchanged Linux
storage prerequisite: the large native-drive MCP result reaches
`describeOwnedResult`, whose verification of `/proc/self/fd` fails on this host.
The exact historical source reproduces it. Required CI must run that assertion;
no owner guard or externalization-success assertion is weakened.

G should add native-drive-integration, native-drive-bundle, regional-geometry,
section-witness-bundle, semantic-model-state and semantic-model-state-e2e to the
existing regression selection. No new test entrypoint is needed for the additional
historical scenarios or installed declarations. The proposal remains separate from
G's main integration. Full current-head CI and exhaustive admission are pending;
native solver/geometry qualification remains stage 3.


## Reverse-registry admission audit

A second inventory pass starts with the executed Python handler registry rather
than public operation-name prefixes. It exposed two omitted C operations:
`deliver` belongs to checking, and `visibility.finalize` belongs to presentation.
The anti-omission test reproduces exactly those two missing rows with the old
inventory and passes after correction. It records 38 C Python families and requires
every handler they register to have an admission entry or explicit shared owner.

The current inventory supersedes earlier counts: **272 public descriptors, 263 C
and 9 shared; 262 C native programs (256 direct plus six coordinator turns), and
one offline baseline inspection**. The four other visibility operations are D's
I/O state/restore handlers and are explicit shared rows. No production handler,
mutation count, ownership guard or readback changed in this audit.

All four canonical-loader/registry/history tests pass on the integrated alias
proposal. The installed consumer passes all 272 example contracts and 263 previews
through each CLI and MCP path. The two added real admission cases are required in
the full matrix; their focused result is recorded separately. Earlier partial
260-program runs do not establish completion of the corrected matrix.


An additional isolated-process historical comparison passes the exact artifact and
source hashes for all 15 generated public/coordinator operations affected by the
specialist extraction. Each child uses the real public preparation and private
coordinator paths; one substitutes the eight SHA-verified original specialists,
the other uses the typed modules. No production checker is mocked or relaxed.
The combined policy/history/installed selection now passes 252 tests. Both added
registry-audit operations (`deliver`, `visibility.finalize`) also pass real pinned
admission. Long local shard processes lost their runner sessions without a final
result; their partial logs are not recorded as completed shards. Full CI remains
the authoritative complete-matrix gate.


## Retained test migration and continuation evidence

The host wrappers for curve preparation, selection execution and BRep execution
are now `src/composition/library-{curve,selection-rules,brep-baseline}.ts`.
Compatibility generation retains the existing CommonJS/public paths. The
44 retained C test sources use strict interfaces for real modules and bounded
injected fixtures; no parallel test framework was added. Catalog negatives
still assert their original validation messages and now also call the actual
`executeCad` boundary with zero SDK dispatch. Selection/BRep retain exact-owner,
artifact hash, receipt, result and uncertain-mutation no-replay assertions.

The artifact-history comparison retains all 24 frozen source hashes and effect
transcripts. Cross-realm historical errors are compared by a checked string
`message`, preserving the predecessor's exact text. A Node `instanceof Error`
check cannot recognize the VM realm and must not prepend `Error:` to that text.
The installed-package consumer additionally compiles the three composition
module declarations; its execution remains pending the stable integrated build.

Local executed tests: 27 core catalogs, 47 secondary catalogs, 32
artifact-history/selection, 51 specialists and nine parameter dispatch cases,
all with zero skipped cases after two focused fixture reruns. Python contract,
entity, shape and loader selections pass 61 tests; the larger 22-family selection
passes 413 tests. These are selection counts, not a claim of unique coverage or
native acceptance. The migrated files pass ESLint; the integrated compiler's
remaining diagnostics at this checkpoint belong to concurrent broker work.

Two fixture repairs preserve expected behavior: Python geometry uses its own
temporary directory, and style-motion installs/restores the established fake-WSL
adapter. The unchanged `dce47c5` style-motion source reproduces the same unsupported
platform failure on Linux before repair. Manual source references, including the
surface/datum canonical policies, now identify the actual strict test sources.
The BRep lifecycle must be rerun after staging stabilizes: a concurrent build
contract change invalidated its earlier attempt. Final installed consumers,
complete pinned admission and full CI for the exact integrated commit remain
open; simulator evidence does not qualify Fusion's native solver or geometry.


### Linux CI preparation for retained real checker tests

The completed CI logs show all nine fixed-import checker cases and the unsaved
isolated-document admission case failing in receipt path mapping before invoking
the checker. Both source files are unchanged from `dce47c5`; the predecessor
requires a detected WSL environment while these offline fixtures run on Linux.
Each real-checker test now installs and restores the existing fake-WSL fixture.
The final wrapped program, actual basedpyright check, certificate byte fence,
expected document binding and absent receipt assertions remain unchanged.
The fixed-import source passes strict compilation and lint. The eight isolated
Python document-guard cases pass with zero skips. The ten real-checker cases
remain pending a stable build and the coordinated checker execution slot.


### Individual retained live assertions

The modeling supplement accounts for all 962 frozen sites from live-cad,
live-extended, live-sketch-operations and live-thicken-slot-pattern, preserving
three existing camera mappings and adding 959 individually identified rows.
There are 46 additional shared invariant mappings, 45 actual installed sketch
preflight mappings (execution pending the stable build), and 868 precise retained
native-context obligations marked not-run. Source hashes, unique IDs and literal
evidence were checked. See [the native obligation register](C_NATIVE_ASSERTION_OBLIGATIONS.md)
for exact readbacks, capability requirements and unresolved legacy runner
migration prerequisites. This accounting does not claim those runners are ready
for concurrent Fusion execution or that native acceptance has passed.


The follow-up feature/hierarchy supplement accounts for another 266 frozen sites
(161 feature-mode, 105 hierarchy): ten exact shared lifecycle invariants and
256 native-context obligations. The hard-coded addin/concatenated-handler fixture
and mutable hierarchy suite globals remain explicitly listed migration
prerequisites, not native-ready runners. Across both C supplements, all 1,228
assigned sites are identified without modifying their frozen sources.

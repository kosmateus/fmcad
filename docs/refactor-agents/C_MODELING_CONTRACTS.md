# Modeling contracts and migration evidence

This document preserves technical contracts and historical evidence. Counts and
test results below are tied to the cited source revisions, not current task status;
current remaining work and dependencies are tracked in Beads.

## Scope and baseline

Historical source baseline: `0b84454d8e5d22abb23bcf52999c506894ebf5bf`.
The original archive was downloaded separately; its Git object database supplies
`a26222ff617b0e9597b2a91b50474bdca8d0a0ce` and extraction history.
No archive metadata, worktrees, generated files or keychain are source changes.

The first delivery extracts input policies for sketch, entity query, spring,
thread, seal and cam into `packages/core/src/application/modeling`. Existing
`src/*.js` entrypoints delegate to the staged compiled implementation. Core
validation takes `unknown`, narrows nested values and performs no SDK or host I/O.
Public signatures and catalog registration remain unchanged.

Policy extraction, generated programs and native modeling require separate
behavioral evidence; wrappers alone are not equivalent evidence.

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

## Shared scenario contract requirements

| Operation group | Required effects and independent evidence |
| --- | --- |
| Sketch create/build/geometry | Preserve explicit expressions and selected component ownership; reject malformed nested geometry before submission. Read sketch/entity/profile counts independently. Native curve/solver validity remains native-only. |
| Dimension plan/apply | Planning is read-only; applying is mutating. Accepted proposal IDs must be unique and tied to the original document/sketch/fingerprint. Do not turn failed readback into success or replay an uncertain apply. |
| Coordinate/profile proofs | Preserve existing coordinate frames, cm and cm² outputs and tolerances; zero profile counts are valid, invalid negative counts fail. Unsupported frame capabilities remain explicit. |
| Entity query/fillet/chamfer | Require one explicit edges/query source; modeling queries need edge kind and expected count/uniqueness. Preserve scope, occurrence context and foreign-token guards. Read the protected document separately. |
| Spring/thread/seal/cam | Pure numerical results are analytic evidence only. Preserve explicit length/angle/material units, declared counts, hand/lead, pressure/curvature and limitations. Native body creation/solver acceptance needs separate qualification. |

Shared scenarios retain one body of steps and assertions for model and Fusion.

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

## Fastener and feature-rework policies

`fastener` and `feature-rework` policy use the same strict core boundary. Catalog
registration remains unchanged; feature configuration keeps the existing one-time
replacement behavior. This includes
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


## Curve preparation, datums and surfaces

Curve preparation now runs through pure typed sample policy and an injected,
synchronous Node source adapter. The existing CSV parser is supplied as a port;
its implementation is not duplicated. Full prepared outputs (including source
hash, file path, row/index provenance, units, winding and endpoint snapping) and
negative outcomes are compared against both historical sources. Source preflight
still completes before any native submission. No retry or background file read
was introduced.

Datum and surface validation/configuration are canonical typed core implementations.
The existing frame dialect, matrix tolerance, reflection/shear refusal, snapshot
requirements, trim plan/apply distinction, protected-zone guards and native-only
representation remain unchanged. These validators do not prove solver validity.

Historical evidence records 218 policy/history tests, 18 retained
curve/datum/surface JavaScript tests and 43 Python tests. Representative admission
cases include `curve.fit`, `datum.transform`, `surface.patch`,
`fastener.measured-check` and `feature.edit`.

## Selection and BRep orchestration

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


Historical selection/BRep checks: pinned full build and strict test compilation pass;
24 historical orchestration cases pass. Running the identical real-store suites
with the previous wrappers produces the same 10 passes / 5 `/proc` failures.
Targeted TypeScript lint passed. Five additional admission cases from the earlier
curve/datum/surface work passed (393.5 seconds total); all eleven representative
cases were green.

## Complete public modeling inventory and admission obligations

`tests/fixtures/modeling-operation-contracts.json` inventories 266 public descriptors
in the assigned modeling/engineering families at the baseline. Each record includes
its public operation, requested read-only classification, route and native program.
The runtime test refuses additions/removals outside that inventory. The shared
routes include file externalization and sketch-file adaptation, plus definition
host inspection, expansion and instantiation. Native recipe and regeneration
behavior remain separate from generic Python calls; a host coordinator is not
counted as a generic Python call.

There are 254 direct modeling Python operations, six selection/BRep
coordinator-generated internal programs, and one offline baseline-inspection
service. The six internal
fixtures invoke the actual typed core coordinator and authorization boundary before
preparing its program. Fixture artifact ports supply evidence inputs; they do not
claim durable storage, native serialization or geometry success. Existing real-store
regression tests independently cover those boundaries.


`modeling-installed.test.js` installs the packed package with npm `--offline` outside
the checkout. Its public API validates every inventory example without mutation,
backend startup or checkout reads. It checks strict declarations for the migrated
core policies, persistence composition and curve source adapter.

## Python boundary contracts

Existing geometry, assembly and document-I/O-family extraction tests already verify
handler registration, retained function bodies, SDK-free domain imports and historical
fake-SDK effects. These are retained, not replaced with file-placement assertions.
The audit ran 154 geometry/assembly/appearance/measurement tests and 218 further
runtime/boundary tests successfully. The latter includes sketch, curve, datum, surface,
feature rework, entity, selection, regional geometry and measured fasteners.

| Family | Shared-scenario state/effect contract | Existing behavioral evidence |
| --- | --- | --- |
| Sketches/dimensions | Dimension plan is read-only; apply validates document/sketch/fingerprint and accepted IDs. Read actual dimension expressions, driving flags, geometry and profiles after mutation. Preserve original solver errors if readback also fails. A denied/invalid plan must add no dimension. | `gm06_sketch_test.py`, `sketch_geometry_proof_test.py`, `typesgeometry/python_types_geometry_sketch_test.py` |
| Curves/datums | Preserve source rows/hashes and explicit frames; transformed occurrences must retain the root/component frame distinction. Compare endpoint/axis/frame readback rather than only response count. Do not infer spline or surface validity from samples. | `gm07_curve_test.py`, `datum_test.py`, `modeling-policy-migration.test.ts` |
| Model/shapes/surface/features | Reject malformed inputs before an SDK add. False/null SDK results are errors. Read owned ModelParameter expressions, timeline health and unaffected bodies; restore timeline position on failures. Fillets, lofts, sweeps, shells, splits and topology remain native qualifications. | `python_geometry_test.py`, `feature_rework_test.py`, `surface_test.py`, `typesgeometry/python_types_shapes_test.py` |
| Components/occurrences/joints | Ambiguous names must fail; child-local transforms and root occurrence transforms are distinct. Preserve exactly one intended mutation and verify the protected document independently. Joint reports distinguish requested/evaluated setter values from post-capture readback. | `python_assembly_parity_test.py`, `assembly_test.py`, `manual_assembly_test.py` |
| Entity/selection | A foreign native token/proxy cannot change ownership. Preserve zero/multiple-match rules and attribute readback. Artifact ownership includes project/file/creation identity. Missing artifacts do not invoke Fusion; inspection never writes; uncertain native outcomes are never replayed. | `entity_query_test.py`, `selection_rules_test.py`, `selection-rules-e2e.test.js`, `modeling-artifact-history.test.js` |
| Measurements/geometry evidence | Length/area/volume internal values use cm/cm²/cm³; outputs default to mm/mm²/mm³, mass kg, angle degrees. Valid zero stays zero; unavailable/nonfinite readings remain errors. Temporary booleans must not add design bodies. Parameter probes restore original expressions even after callback/recompute failure. | `measure_test.py`, `python_measurement_runtime_test.py`, `regional_geometry_test.py`, `brep-baseline-service.test.js` |
| Appearance/material/attributes | Appearance and physical material are separate; inspect the concrete face/body override. Missing density/coating is not invented. Preserve deterministic ambiguity reporting and source IDs. | `appearance_test.py` (including attributes/texture), document-I/O-family runtime replay |
| Engineering/motion/model state | Preserve explicit dimensional units, hand/lead, material assumptions and reference ownership. Analytic predictions and stored states are not solver or physical qualification. Native MotionLink, joints, sheet metal and native regeneration retain their explicit capability/refusal contracts. | `python_assembly_parity_test.py`, `measured_fasteners_test.py`, engineering family suites and original native assertion ledger |

The table and operation inventory specify independent behavior/effect requirements;
they do not claim that every listed method is covered by a model scenario.

## Measurement policy boundary

This section describes a historical migration, not current task status.

The existing unit conversion table/function move from the Fusion measurement adapter
to its domain module. Both the original `a26222f` and pre-delivery `0b84454` versions
are SHA-256-bound fixtures. Identical zero, signed, ordinary, nonfinite, missing-value,
unsupported-unit and all supported-unit cases retain values/errors. No SDK call or
unit factor changes. A unique math import prevents a flattened-program duplicate;
the initial duplicate-import diagnostic was fixed, not suppressed. The real checker
passes the corrected program and 69 retained measurement tests pass.


## Canonical Python compatibility paths and discovered entity regression

Nineteen remaining modeling `assets/cad` implementations are now thin compatibility
loaders for the already-typed runtime: animation/animation2, appearance/attributes,
cam/seal, checking/containment/dfm/interference, entity/measure, explode/fpc_pcb,
marking/optics/presentation, simulation and texture. The installed assets no longer carry a second maintained handler implementation.
Loaders support an explicit `_FMCAD_RUNTIME_ROOT` from a foreign cwd and become no-ops
when canonical handlers are already present. Prepared native bundles still use the
manifest-declared runtime units directly and do not execute filesystem loaders.

Original bytes are retained under `tests/fixtures/modeling-python-history` with
revision/path/SHA-256 metadata. The modeling loader suite reuses the existing full function
body/count and registry-ownership oracles with those frozen inputs; a new loader can
never serve as its own historical reference.
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

An audit of the retained full `cad.test.js` reproduced three failures with both old
and migrated wrappers: two assume WSL path translation, and the CLI-preview case
uses a newline-containing display name without an immutable document pin. A trial
using the existing fake-WSL fixture and explicit creation/file IDs exposed an
additional shared `catalog.import` preview contract: `success=true/status=unknown`
with exit code 1 for an unresolved source. The trial was reverted; no production
outcome or retained assertion changed.

The installed consumer independently passes all 261 modeling CLI previews and all
261 modeling MCP previews outside the checkout, with no backend construction or
native execution.
Snapshot capture uses its example scope identity and rejects foreign document pins.
All 266 public example schemas and strict consumer declarations also pass. These
checks cover installed host contracts, not native geometry or solver qualification.


## Specialist and private-turn policies

The final JavaScript inventory found six additional modeling validators under
`src/catalog`: native-drive, regional geometry, section/witness, semantic model
state, selection-rule definitions/artifacts and BRep baseline input. Their pure
logic now lives in strict core policies. Two private selection/BRep catalogs also
use one typed core implementation, including their exact-object WeakMap/WeakSet
capabilities. JavaScript files are compatibility facades. Public registry composition,
public names, private declaration metadata and configuration order are unchanged.

All eight original sources are retained byte-for-byte with `0b84454` SHA-256
provenance under `tests/fixtures/modeling-specialist-history`. None of these source
files exists at `a26222f`; this comparison therefore uses the actual pre-delivery
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



## Reverse-registry admission audit

A second inventory pass starts with the executed Python handler registry rather
than public operation-name prefixes. It exposed two omitted C operations:
`deliver` belongs to checking, and `visibility.finalize` belongs to presentation.
The anti-omission test reproduces exactly those two missing rows with the old
inventory and passes after correction. It records 38 modeling Python families and requires
every handler they register to have an admission entry or explicit shared owner.

The audit snapshot recorded the following inventory: **272 public descriptors, 263
modeling and 9 shared; 262 native programs (256 direct plus six coordinator turns),
and one offline baseline inspection**. The four other visibility operations belong to
file I/O state/restore handlers and are explicit shared rows. No production handler,
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
result; their partial logs are not completed-shard evidence. Current complete-matrix
status is tracked in Beads rather than this historical evidence record.

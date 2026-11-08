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

## Inventory and remaining boundaries

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

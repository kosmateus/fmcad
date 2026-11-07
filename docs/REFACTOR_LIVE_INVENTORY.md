# Live suite migration inventory

This inventory lists every top-level live suite and helper. It is a source and
scope inventory, not a claim that a method or scenario has passed. `partial` means
only the listed shared scenarios exist; no native suite is fully replaced yet.
Native-only marks geometry, motion or rendering evidence that the analytical model
cannot qualify. Shared setup/error/cleanup contracts can still be extracted from
those suites. Native execution remains deferred until the offline refactor ends.

The reference is `a26222ff617b0e9597b2a91b50474bdca8d0a0ce`. Baseline hashes are stored
in `tests/live-suite-inventory.json`; renamed sources must be linked explicitly.
The fixture archive, rather than a current test result, is the provenance source.

| Suite / helper | Runner | Model | Reference relation | Remaining contract |
| --- | --- | --- | --- | --- |
| [`animation-methods`](../tests/live-animation-methods.js) | standalone | native-only | later | Storyboard creation, animation actions and frame export |
| [`backend-adapter`](../tests/live-backend-adapter.js) | all | pending | changed | Backend capabilities, progress, transport limits and read-only soak |
| [`batch-reference`](../tests/live-batch-reference.js) | standalone | pending | unchanged | Batch reference resolution, propagation and failure stop |
| [`cad`](../tests/live-cad.js) | all | pending | unchanged | Dimension regeneration, bodies, holes, patterns, fillets and checkpoints |
| [`camera-probe`](../tests/live-camera-probe.js) | all | native-only | unchanged | Camera projection, orientation, capture and restoration |
| [`component-hierarchy`](../tests/live-component-hierarchy.js) | standalone | pending | later | Nested occurrences, component lookup and transforms |
| [`data-import-fixed`](../tests/live-data-import-fixed.ts) | scoped | pending | later | Source-pinned cad-v1 import in an externally owned exact scratch document |
| [`data-import`](../tests/live-data-import.ts) | all | pending | later | Versioned catalog import, replacement, lineage and native geometry |
| [`definitions`](../tests/live-definitions.js) | all | pending | changed | Literal definitions, idempotent run IDs and failed-check stop |
| [`design-styles`](../tests/live-design-styles.js) | standalone | pending | later | Material/appearance editing, scope and retained design state |
| [`engineering-analytics`](../tests/live-engineering-analytics.js) | standalone | pending | later | Engineering calculations with native geometry/measurement readback |
| [`entity-attributes`](../tests/live-entity-attributes.js) | standalone | pending | later | Entity identity, attributes and selection behavior |
| [`extended`](../tests/live-extended.js) | all | pending | unchanged | Sweep, loft, shell, chamfer, combine, split, draft, joints and interference |
| [`feature-modes`](../tests/live-feature-modes.js) | all | pending | unchanged | Extrusion, hole, sweep and loft variants; geometry and timeline health |
| [`file-exports`](../tests/live-file-exports.js) | standalone | pending | later | Native export artifacts, paths and file checks |
| [`gm07`](../tests/live-gm07.js) | standalone | pending | later | Pinned native GM07 fixture and its geometric evidence |
| [`gm12-spring`](../tests/live-gm12-spring.js) | scoped | pending | later | Pinned spring fixture and native shape/measurement evidence |
| [`import-receipts`](../tests/live-import-receipts.ts) | helper | helper | later | Receipt parsing and owned import evidence used by import suites |
| [`joint-limits-probe`](../tests/live-joint-limits-probe.js) | all | native-only | unchanged | Joint limit setup, readback and pose ordering |
| [`legacy`](../tests/live-legacy.js) | all | partial | unchanged | Document/parameter/plane/component CLI, units, box, rollback and exports |
| [`mcp-stdio`](../tests/live-mcp-stdio.js) | all | pending | changed | Installed stdio discovery and live Fusion tool invocation |
| [`motion-animation`](../tests/live-motion-animation.js) | all | native-only | unchanged | Joint limits, five motion frames, storyboard and workspace restoration |
| [`normal-multidocument`](../tests/live-normal-multidocument.ts) | standalone | pending | later | Normal document operations with interleaving and exact document ownership |
| [`pose-methods`](../tests/live-pose-methods.js) | standalone | native-only | later | Pose creation/application, capture and restoration |
| [`recovery-ports`](../tests/live-recovery-ports.ts) | helper | helper | later | Shared response-loss boundary helpers for recovery tests |
| [`response-recovery`](../tests/live-response-recovery.ts) | standalone | pending | later | Accepted response loss, original receipt recovery and no mutation replay |
| [`rpc-recovery`](../tests/live-rpc-recovery.js) | standalone | pending | changed | RPC reply loss, broker settlement and original result recovery |
| [`shape-native-solids`](../tests/live-shape-native-solids.js) | standalone | pending | later | Native solid creation and geometric properties |
| [`sketch-operations`](../tests/live-sketch-operations.ts) | standalone | pending | later | Sketch creation, curves, dimensions, constraints, edits and readback |
| [`style-save`](../tests/live-style-save.js) | all | pending | changed | Style precedence, mass, unsaved state and local archive roundtrip |
| [`thicken-slot-pattern`](../tests/live-thicken-slot-pattern.js) | standalone | pending | later | Thicken, slots and pattern geometry with rejected inputs |
| [`thread-method`](../tests/live-thread-method.js) | standalone | pending | later | Thread selection, creation and native feature readback |
| [`ui-host-inspect`](../tests/live-ui-host-inspect.js) | helper | helper | unchanged | Windows UI inspection host helper |
| [`ui-observed-watcher`](../tests/live-ui-observed-watcher.js) | helper | helper | unchanged | Observed UI watcher host helper |
| [`ui-respond-host`](../tests/live-ui-respond-host.js) | helper | helper | unchanged | Windows UI response host helper |
| [`ui-watcher-host`](../tests/live-ui-watcher-host.js) | helper | helper | unchanged | Windows UI watcher lifecycle host helper |

## Required next deliveries

1. Port sketch curves/dimensions/constraints and entity attributes with analytical
   cases and negative no-mutation checks. Preserve native solver assertions as
   pending; types and source generation do not establish constraint satisfaction.
2. Add component transforms and additional solid/feature modes that have defensible
   analytical models. Keep exact native tolerances and unsupported capability errors.
3. Model saved versions/reopen and import/export state explicitly; marked model files
   must never count as genuine F3D, STEP or rendered image validation.
4. Move batch/definition, reference and response-recovery scenarios onto owned saved
   fixtures. Recover original results after reply loss without replaying mutations.
5. Isolate UI, camera, styles, motion and fixed external-fixture profiles. Global UI
   state needs coordinated restoration; registering an old exclusive suite in a
   parallel `all` run is not a substitute for scenario isolation.
6. Register migrated suites in the required shared profile. Keep fixed-scope
   diagnostics explicit and report blocked/unsupported/not-run separately from pass.

`node tests/run-live.js --list` reports this inventory without connecting to Fusion.
CI verifies that new live files cannot be added without a classification and that
the existing runner lists agree with this source of truth. It does not execute
unmigrated suites or treat their current presence in `all` as proof of safe concurrency.

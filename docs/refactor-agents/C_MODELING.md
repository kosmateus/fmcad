# Agent C — CAD modeling services and Python runtime

Status: **claimed by Agent C** (8 November 2026), based on `0b84454`. Read
[the shared plan](../REFACTOR_PARALLEL_PLAN.md) before editing.

## Outcome and ownership

Complete the remaining modeling service migration and verify already extracted
Python behavior. Preserve useful modeling through public CAD/run commands;
moving files or retaining a JavaScript facade does not finish a family.

Own modeling wrappers such as `src/sketch.js`, `curve.js`, `surface.js`,
`datum.js`, `entity-query.js`, `selection-rules.js`, `fastener.js`, `spring.js`,
`seal.js`, `thread.js`, `feature-rework.js`, `brep-baseline.js` and `cam.js`;
their typed service/adapter destinations; geometry, sketch, assembly, entity,
measurement, appearance, motion and modeling families under
`runtime/python/fmcad`; associated `assets/cad` compatibility loaders and
non-live modeling tests. Include existing engineering/model-state functionality
when it belongs to these families; do not add unrelated new product features.

Exceptions: D owns document/file/import/reference/externalization and drawing
workflows; A owns atomic execution/identity/admission; E owns catalog/public
registration and offline host tooling; B owns simulator and live scenarios.
Request coordinated changes for common identity/values helpers instead of
editing them concurrently. G owns shared build configuration and final facade
retirement. Family-specific persistence adapters (selection/BRep) belong here.

## C1 — inventory and characterize remaining services

Separate real JavaScript implementations from facades and metadata tables.
For each family, identify core policy, platform-free validation, ports,
Node/Python adapters, public route and installed path. Record current API shape,
outputs, errors, mutation counts, document/component pins and retained artifacts.

Compare pre-TypeScript `a26222f`, the commit immediately before that family's
extraction, and current behavior. Preserve earlier successful and negative
assertions. Existing fixes for ambiguous component names, unavailable volume,
duplicate results and ownership must remain protected. Diagnose newly found
problems with paired inputs before deciding whether expectations should change.

## C2 — migrate modeling service families

Deliver coherent groups: sketch/curve/datum; entity/selection/BRep; surface/shape/
feature preparation; assembly/fastener/spring/seal/thread/rework; remaining
modeling/engineering services. Use strict types, typed ports and explicit unknown
validation. Keep filesystem/process/SDK access in adapters and policy in core.
Preserve dispatch order, synchronous preparation boundaries, preview behavior,
immutable source/argument hashes and exactly one intended execution.

Reuse existing `packages/core` and `packages/node-adapters` implementations.
Remove duplicate logic only after tests prove the production path uses the new
implementation. A facade is temporarily acceptable for consumers but not a
second maintained implementation. Public changes and help/catalog updates go
through E; staging/typecheck additions through G.

## C3 — finish Python boundaries and checker coverage

Review geometry_feature, geometry_model, geometry_shapes, geometry_sketch,
geometry_surface, geometry_datum, assembly, entity, measure, appearance and
related model families. Large extracted files may still mix pure planning with
SDK mutation. Split only where contracts justify it; avoid cosmetic module churn.
Cover every generated operation admitted by the public route with the real
checker and pinned Autodesk interfaces. Do not silence diagnostics using blanket
`Any`, unchecked casts or checker exceptions.

Test native false/null/error returns, wrong/ambiguous names, foreign tokens,
invalid dimensions, failed mutation and rollback. Read back changed state and
verify unrelated entities/documents did not change. Explicitly preserve valid zero
measurements while unavailable values remain errors. Verify units, parameters,
timeline/health, component transforms and numerical tolerances with B's model
where it can support them honestly.

## C4 — integrate modeling scenarios and native obligations

Provide B operation contracts, fixtures, analytic expectations and negative
cases for sketches/dimensions/regeneration, components/occurrences, geometry,
selection and attributes. B owns model implementations and scenario files;
submit suggested patches or dependent PRs rather than competing edits.

For advanced solver/topology, fillets, holes/patterns, sweep/loft/shell/split,
joint/motion or native physical-property behavior, keep historical assertions
and explicit native assumptions. An offline source/type/model pass cannot
certify native CAD validity. Nevertheless finish all independently verifiable
planning, input validation, receipt and cleanup work before native access.

## Completion and checks

For every migrated family: paired historical cases, strict build/types/lint,
generated-program admission, positive readback, invalid-input/no-mutation and
identity tests, public dispatch and installed-package consumers. Run relevant
Python suites, B's supported shared cases and full CI before each merge.

Exit when all assigned service implementations have one canonical typed path,
Python policy/SDK boundaries and admission are enforced, defects found in migrated
code have justified regressions, and B/G can account for every modeling live
assertion. Record native-only gaps without treating them as completion evidence.
Append PR/SHA, exact checks and remaining scope here after each family and
continue through the whole package, not just sketch migration.

## Active delivery

Claim: PR #37. Initial policy extraction and remaining ownership/dependencies are
tracked in [the modeling contracts ledger](C_MODELING_CONTRACTS.md).
The package remains in progress; no C1–C4 completion is claimed. G must integrate
the new runtime test gates before the policy delivery can merge.

The second delivery migrates fastener and feature-rework policy, extends paired
history to 156 tests and retains 12 JavaScript / 67 Python tests. It is stacked
on #37; integration remains blocked on G's runtime gates and full exact-head CI.

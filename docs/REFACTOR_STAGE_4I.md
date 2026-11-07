# Stage 4i: atomic batch adapter and result evidence

Atomic script preparation, budget handling, journal reading and recovery
composition now live in strict TypeScript. The compatibility entry delegates to
that implementation. Ordinary batch orchestration and the remaining compatibility
entries are still part of the refactor.

The atomic core selected the first `FMCAD_RESULT` line even when another line
contradicted it. The same test now runs against frozen pre-refactor `a26222f`
and current code at each phase: resolve, start, status and finalize. The baseline
reports `committed` in all four conflicting-result cases. This is an inherited
defect retained during migration, not evidence of a newly introduced parser bug.

The expected result changes for a reason: contradictory evidence cannot authorize
a target or prove a mutation's outcome. Ambiguity during resolution rejects the
run before start; ambiguity after submission is `unknown`. Both stop further SDK
calls. A possibly completed start is never replayed. The shared parser also rejects
missing, malformed and non-object results; explicit ordinary failure results
remain valid result objects.

The historical fixture decodes the old JSON-string wrapper as data; current
fixtures decode Python literals as data. Neither decoder executes the generated
program. Complete prepared artifacts are compared against pre-extraction
`e92a0ee`, and ordinary completion retains the pre-refactor call sequence.

Validation: all 11 new comparisons passed. All 38 existing atomic-batch tests
passed, covering timeout budgets, locks, reconciliation, finalization, rollback
labels and explicit fault injection. Build, lint, strict type checks and formatting
passed. Packaging checks include the compiled adapter and declaration. Full CI
and final native qualification remain separate checks.

PR #18 is merged after its complete 20-job CI run passed.

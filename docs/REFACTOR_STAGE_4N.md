# Stage 4n: historical batch selector compatibility

The typed invocation boundary omits absent component/project selectors. Older
CLI reports can contain explicit nulls instead. Exact replay worked with the old
context but was refused with the new representation, even when the document and
file pins were unchanged. The stage 4j test recorded that safe refusal; this
delivery restores access to the historical result without another SDK call.

## Contract and historical evidence

The complete baseline `src/batch.js` at `a26222f` and the pre-change typed policy
at `e57d387` are frozen with hashes. The comparison creates a real numbered
report through the baseline writer, then feeds the same report and inputs to
both old policies and the new policy. Old policies accept the original context
and reject omitted selectors. The new policy returns the original report with
`replayed: true`, keeping its stored context, request hash and bytes unchanged.
This is a context-representation compatibility issue exposed by the migration,
not evidence of different Fusion geometry or native document routing.

Only null/absent `component` and `projectId` fields are equivalent. Both contexts
must carry nonempty creation/file pins. The original binding must match its own
hash before comparison, and every other context field and the complete request
must match. Explicit selectors, even an explicit `root`, are never folded into
an absent selector. Existing exact-binding replay remains unchanged.

The CLI expectation changes from refusal to returning an existing successful
report because no operation is being requested again: every step explicitly
allows reuse. Tests must show zero SDK calls, zero stage acquisition and byte-for-
byte unchanged files. Failed, unknown or running history still requires operator
inspection. A historical report is not a fresh validation of the Fusion model.

This normalization is confined to successful non-atomic report replay. Atomic
receipt validation and authenticated stage-owner bindings remain exact; a
historical result cannot certify a new request's physical completion.

The comparisons also expose an inherited validation gap in both frozen policies:
they accepted contradictory success flags, changed report/step operation metadata,
a different top-level run ID and undeclared or blocked expected failures. Replay
now requires a coherent successful report whose steps match the original plan.
Declared negative checks still accept a well-formed `fail`; `blocked` and unknown
results cannot become successful history. These refusals follow the existing
execution contract and never resubmit a mutation.

## Completion checks

Run the frozen-policy comparisons, changed request/identity/selector cases,
missing pins, changed hashes, nonterminal history and the real command-worker
CLI fixture. Then run existing batch/atomic/outcome regressions, the full build,
lint/types/formatting and full CI for the same commit before merging.

Local results: 106 batch/replay/atomic/outcome tests passed, including 33 new
historical compatibility and corruption cases. The first declared-negative
fixture incorrectly marked its check as mutating; the unchanged validator
correctly rejected it. That fixture now declares a read-only check, and its
original `fail`/`blocked` assertions pass. Build, pinned API refresh, lint,
types and formatting passed. Full CI is still required before merge.

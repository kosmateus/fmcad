# Command settlement dependency for C/G

The shared runner previously treated a settled transport as a settled CAD command.
That is incorrect when the production coordinator returns an explicit unknown
outcome. The B correction refuses subsequent mutations/cleanup and rechecks the
original result during recovery. Do not revert that guard to restore green tests.

## Reproduction

Use the production `definition.instantiate` path on an owned saved document:

```json
{
  "runId": "no_eval",
  "parameters": {"width": "__import__(\"builtins\").str(23) + \" mm\""},
  "operations": [
    {"id": "box", "operation": "shape.box", "onExisting": "reuse", "data": {
      "name": "NoEvalBox", "width": {"$param": "width"}, "depth": "2 mm", "height": "3 mm"
    }},
    {"id": "later", "operation": "shape.box", "onExisting": "reuse", "data": {
      "name": "NoEvalLater", "width": "2 mm", "depth": "2 mm", "height": "2 mm"
    }}
  ]
}
```

Supply a unique report directory and exact doc/docId/docFileId context. The
historical assertion requires the literal string to reach native expression
validation unchanged, `success: false`, `Invalid or incompatible expression`,
the later step skipped, and unchanged independently audited geometry. Keep those
assertions. Do not evaluate the literal, retry, remove its journal lock, or report
unknown as successful qualification.

The current path returns overall `status: unknown`: native action execution
throws an unknown-outcome error after the failed physical script, and the batch
coordinator conservatively preserves that outcome. The historical live wrapper
checks only timeout/transport exceptions; the first B migration also failed to
check the command-level status. This is now exposed by the shared runner.

Relevant production boundaries (owned outside B):

- `packages/core/src/application/cad/execute.ts`: failed native responses become
  `unknownNativeOutcome`.
- `packages/core/src/application/cad/batch.ts`: failed step settlement and unknown
  report/lock retention.
- Native shape input validation/receipt publication: distinguish proven rejection
  before mutation from an exception after possible effects; retain exact request,
  client and document identity. A blanket conversion of native exceptions to known
  failure is unsafe and is not proposed.

C/G must decide and implement a receipt-proven pre-mutation rejection contract,
or retain this required case as blocked. B will consume that contract without
changing its literal, skip or independent-readback assertions. General failed
native mutations must remain unknown when effects cannot be proven.

## Evidence and limits

On parent `b35d82a`, the complete local suite was 184/186; only journal lock
refusals failed. With command-level settlement checks, five previously passing
selected transaction tests now correctly stop at the unknown no-eval result.
The two original-result recovery tests still pass. Five new settlement tests
pass across MCP/addin, including refusal of unknown/foreign original evidence,
retained-document readback, and no command replay.

This is separate from the intermittent `EEXIST` journal issue: parent `5f2bed1`
passed the production-checker MCP component profile but addin failed reopening
the journal for changed-run rejection even with one scenario owner. Source hashes
were stable. The lock owner must investigate against ordinary Linux CI; no lock
workaround has been introduced. Native Fusion execution remains deferred.

## Ordinary Linux CI confirmation

The blocker is now reproduced outside the local restricted host. At pose head
`c51dacf904c93ef6a4db741330639d5ff2281c26`, CI run
[42563565989](https://github.com/kosmateus/fmcad/actions/runs/42563565989) fails the
scenario-unit step in both Node 22.13.0 and Node 24 contract jobs. The decoded logs
of jobs [128985054792](https://github.com/kosmateus/fmcad/actions/runs/42563565989/job/128985054792)
and [128985054637](https://github.com/kosmateus/fmcad/actions/runs/42563565989/job/128985054637)
each contain seven failing reports: all six MCP/addin × concurrency 1/2/10 positive
transaction cases and the replay/zero-SDK-call case. Every report ends at
`cad-literal-rejection` with command `status=unknown`, error
`Original CAD command remains unsettled: status=unknown`, and deferred cleanup.

The other 20 jobs in this run pass, including the existing broker/model families.
Those jobs do not resolve the required transaction failure. The earlier unsafe
heads #70/#72/#75 passed CI before command-level settlement was enforced; do not
merge those heads as a workaround. Draft #78 and descendant PRs remain blocked.
The separate intermittent local journal-lock refusal remains unresolved and is
not the cause shown by these seven Linux failure reports.

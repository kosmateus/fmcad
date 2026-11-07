# Document isolation and settled cleanup — stage 2a

This delivery builds on stage 1 (`3ba1ccb`). It closes the document identity and
cleanup error paths that can be verified without a native Fusion instance.
The complete saved/cloud-file lifecycle remains stage 2b; an unsaved document
and a local export are still not proof of that lifecycle.

## Problems reproduced before changing behavior

- A scenario could call `session.execute` with another scenario's valid document
  and program. The recipient was mutated before the test detected the mistake.
- A result bearing another document's `creationId` was left to individual
  scenario assertions. Cleanup could proceed even though the returned result
  did not establish settlement of the intended operation.
- Losing the close response produced `cleanup: failed`, although the SDK close
  could already have completed. The existing recovery path correctly avoids
  replay once the original close result is available; the normal path now
  preserves that same distinction.
- Historical inspection selected the first case-insensitive name match and
  ignored `activate()`'s return value and the resulting active document. Six
  paired cases (units/rollback × duplicate name/false activation/wrong active
  identity) reproduce mutation of an unintended or ambiguous target in
  `a26222f` and in the stage-1 code. This is an inherited defect, not a new
  TypeScript regression.

## Changed contract and evidence

The session holds immutable copies of its owner and document identity. Public
scenario steps can address only that document and cannot impersonate the
runner's create/export/cleanup phases. A foreign target is rejected before
dispatch. Tests use two actual scenario sessions, each with its own document
and export; the recipient independently verifies that its parameter count
remains zero. The same test runs for MCP and addin.

Every targeted successful result must identify the owned document. A mismatch
defers cleanup until original backend evidence is recovered. This runner check
does not sandbox arbitrary Python: scenarios remain trusted source, and their
in-SDK guards plus the broker still enforce physical document selection.

Creation receipts now include the exact client and request IDs. The returned
creation identity must agree with the durable receipt before the first export
or scenario operation. Recovery rereads original backend results and validates
the same binding. A settled partial setup failure may use its own valid durable
receipt to close its document; a foreign receipt never authorizes closure.
New proof fields intentionally reject older/unbound receipts. Recovery also
continues to require the matching backend/build identity.

Lost cleanup responses remain deferred. After original settlement is recovered,
the local export is removed without a second SDK close. Operation and assertion
errors remain separate from cleanup errors. Existing cancellation, ten-owner
interleaving and protected-document inventory checks remain in force.

Inspection now requires exactly one name match, a successful activation and the
same active `creationId`. The six unsafe cases now return an explicit error and
leave both documents unchanged. These changed expectations follow the requested
target, not the accidental active document. Eight normal historical scenarios
retain their exact output and effects. The reviewed AST exception changes only
`_design`, with a per-definition explanation and exact before/after hashes;
all five generated operations must still pass the real strict checker.

## Verification and next boundary

Run the build, lint, test typecheck, `test:regressions`, `test:scenarios:unit`,
both component profiles, Python tests and the full CI matrix. Existing broker
tests verify that project A can remain in offline preparation while B executes,
with separate outputs and a maximum of one physical SDK call. Limits remain
configurable: Fusion defaults to 10, the model to at most 2 by CPU budget.
Neither admission nor production process guards are disabled.

Stage 2b must still implement and verify save acceptance, exact cloud file/version
ownership, asynchronous completion, close/delete observation and recovery of
uncertain deletion. It also needs native checks of document lifetime/activation
and cleanup after process restart, including restoration of the original active
document after deferred cleanup. Missing volume reads still use the historical
zero fallback; replacing it requires a separate explicit measurement contract.
No native Fusion run or cloud deletion is claimed by this delivery.

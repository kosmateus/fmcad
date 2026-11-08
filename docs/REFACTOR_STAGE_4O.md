# Stage 4o: accurate run guard receipts

A run rejected by the add-in's interactive-command guard reported
`userCodeSubmitted: true`. The pre-refactor CLI at `a26222f` and the typed worker
at `0e9afe1` both invert this field. Complete frozen sources run the same guard
inputs in the new test, so this is an inherited reporting defect, not a new
migration regression or evidence that Fusion actually executed blocked code.

A guard with `status: rejected-before-mutation` and `notStarted: true` now reports
`userCodeSubmitted: false`. Missing, malformed or contradictory evidence reports
`null`; its explanation no longer claims that non-submission was proved. The
underlying operation remains `notEvaluated`. No retry or UI action is introduced.

The old fixture counted one transport request as one user-script submission and
expected the inverted value. Its replacement exercises the actual command-worker
composition with a real source file. A separate test runs the real add-in wrapper
and response parser against the Python model: busy/unreadable command identity
executes the user body zero times; idle executes it once. These tests exercise
the transport component, not authenticated broker admission or Windows UIA.

The original CLI fixture used the retired direct-client injection. It moves to
strict TypeScript with the command worker and frozen CLI comparison. Other UI
fixtures now explicitly install the existing reversible WSL path fixture around
their synthetic Windows host responses. Platform checks in production are
unchanged. The first worker fixture lacked the required `DOC_NAME` slot; source
preparation correctly rejected it, and the fixture now satisfies that contract.

Local validation: 86 run-guard, add-in and UI tests passed, including nine new
comparisons/component cases. Full pinned build, lint, test types and formatting
passed. UI and add-in regressions are now explicitly included in CI on both Node
versions. Full CI is required before merging. Actual native command identity and
UI behavior remain part of final Fusion qualification.

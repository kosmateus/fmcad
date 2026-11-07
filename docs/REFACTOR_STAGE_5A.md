# Stage 5a: helper inventory and CLI mode fixtures

The capability inventory omitted `FMCAD.mechanism_drive_test` and
`FMCAD.terminal`. These methods were added in `3857c42` and `6e7ce6d`, after the
pre-refactor reference. Discovery now describes both while retaining unknown
native evidence. The terminal method is documented as wrapper-managed output;
calling it directly may produce duplicate markers and is not completion proof.

The inventory test previously matched every indented `def`, including the
private `_require_stage_context` and the `has_emitted` property. It now uses the
Python AST to enumerate public callable methods of the actual `FMCAD` class.
All public methods must still match exactly. Properties are checked separately
and are not advertised as callable methods. This corrects the definition of the
tested interface; it does not remove a public method from coverage.

The definition-mode fixture originated in `a241207` and still injected a direct
`McpClient`. The current CLI uses the broker library boundary, so that unused
dependency allowed the test to enter real configuration validation instead of
its fake executor. The fixture now supplies `createFmcad`, complete broker
configuration and a scoped fake execution port. A direct backend/client is an
explicit failure. Existing mode, output, report and operation-count assertions
are unchanged. New assertions check session disposal as well.

Both failures were reproduced with the frozen pre-dispatch CAD coordinator in
stage 4e. The corrected fixtures and catalog preview comparisons pass all 17
tests. Both suites are registered in CI regressions. Build, lint, TypeScript and
formatting checks passed; full CI is still required before merging.

The native-timeout broker test also retains its last public job state, execution
evidence, physical-call trace and probe count if its wait fails. Its 300 ms
production budget, observation timeout and all settlement/no-replay assertions
are unchanged. This supplies the evidence missing from PR #11's failed CI job;
it does not claim to fix or explain that timeout.

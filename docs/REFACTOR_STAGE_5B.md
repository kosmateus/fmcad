# Stage 5b: compiled CAD regression tests

CAD preparation, dispatch and publication comparisons now have strict TypeScript
sources. They load the generated runtime through typed boundaries and retain the
same historical fixtures, inputs, results, document pins and call-count assertions.
The handwritten JavaScript tests are removed. Both the default test command and
regression CI execute their compiler output from `dist/tests`.

These three files are explicitly included in TypeScript, ESLint and Prettier.
There is no `any`, `ts-nocheck`, suppression or fallback copy. The emitted tests
and existing publication cases pass 19 tests. Other legacy/regression test files
still need migration; this does not close `fmcad-e4m` or `fmcad-hex-integration`.

Before this test-only extraction, runtime commit `165585e` passed all 109 shared
scenario unit tests. The complete component profile passed 18 scenarios over MCP
and the same 18 over addin using production Python admission. Every scenario
reported complete cleanup. Both profiles retained source hash
`f9da63dce5a47ffcc0f39e468673b68d431d29f03fce10ba3f5709b81cdbb091`
before and after execution. These are model/checker results, not native Fusion
qualification or a local real-broker run.

PRs #11 and #12 are merged into `main` after complete 18-job CI runs on their
respective heads. PR #11's unchanged native-timeout job passed on its second
attempt (183 contract tests). The first timeout's cause remains unresolved;
stage 5a adds retained diagnostic evidence without changing the budget or checks.

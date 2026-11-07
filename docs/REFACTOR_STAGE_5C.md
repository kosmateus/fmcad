# Stage 5c: compiled native result comparisons

Public CAD and private reference/externalization result tests now use strict
TypeScript and emitted JavaScript. Their fake transports use the production
request/reply types, and caught failures are narrowed from `unknown` before their
evidence is checked. Historical source hashes, exact scripts, timeouts, result
values, error identity/cause and physical call counts remain unchanged.

Both handwritten JavaScript test files are removed. The default test command and
regression CI run `dist/tests` output, and both sources are included in lint,
formatting and TypeScript checks. All 31 tests pass, including ambiguous markers,
non-object JSON, frozen/primitive errors, UI refusal and no-replay assertions.

Build and local checks pass. Full CI is required before merging; the remaining
JavaScript test suites and production facades are still open migration work.

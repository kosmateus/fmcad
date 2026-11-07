# Stage 4j: batch services, reports and installed declarations

Batch orchestration now has a typed composition root. Filesystem journals live in
the Node adapter; report validation, scalar summaries and formatting live in the
core. The existing entry delegates to the compiled implementation. Offline modes
may omit an executor, which the core already rejects before an actual run.

Frozen `979944d` comparisons preserve complete success/failure/unknown reports,
bytes, physical calls, stage hashes, reference substitution, replay decisions and
sanitized diagnostics. Read-only work does not acquire a mutation stage. Existing
batch, local-engineering and summary cases run alongside these comparisons.

The old summary CLI fixture failed against both the old and new batch adapter
because it injected a retired direct client and incomplete configuration. Its
replacement is strict TypeScript and invokes the real command worker composition
behind the library boundary. It captures actual formatted streams and result
callbacks, checks disposal, and retains the original operation-count and report
immutability assertions.

One context assertion changes deliberately: the typed invocation contract omits
absent optional component/project selectors instead of passing null. Explicit
document/file pins, exact request hashes and same-context replay remain checked.
This does **not** prove transparent replay of old null-selector reports. A new
case records the current safe refusal with zero SDK calls and unchanged files.
Compatibility for those historical bindings remains a separate completion task;
it must never permit replay across a different document, file, component or
project.

Installed persistence declarations also retained workspace imports. Staging now
rewrites their core references into the installed layout. The new consumer test
fails on the old staged files and passes after rebuilding, with strict declaration
checking and no workspace package type references.

Validation: 32 focused tests passed, including the external declaration consumer,
and all 38 atomic-batch regressions passed. Full build with the pinned API and
lint/type/format checks passed. CI is required before
merge; native Fusion qualification remains deferred.

PRs #19–#20 passed all 20 CI jobs each and are merged into `main`.

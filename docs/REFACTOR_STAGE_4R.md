# Stage 4r: typed authenticated stage composition

`src/composition/stage-dependencies.ts` now composes document save, ordinary and
atomic batch, and cad-v1 helper stages. The existing JavaScript entry delegates to
the compiled implementation. Accepted payloads, physical preflight pins, stage
references and receipt digests retain their existing representation. The worker
still verifies its capability and inputs before creating a stage owner.

The immediate comparison source is
`938643314c76fd6503fd4e44720eca13edc7bfd0`, unchanged at the start of this stage
(`6c1358e880bafe76c8e95ecd5aeeba9d4e53ac1a`). Its frozen fixture has SHA-256
`c08b7ae433baa3da3bc8f9563c613c7dbab5d60da72d3f848b1f6e2eec123723`.
This module was introduced after the pre-TypeScript `a26222f` reference, in
`42fe75cf484df4808592fc35c9a6c5cf0abdbeef`. The earlier fixture remains part of
the comparison; these are source-level reproductions, not new Fusion runs.

## Ordinary batch completion defect

Both the introduced reader and the immediate pre-migration reader accepted the
four contradictory reports below. The old `readBatchReportSync` at `42fe75c`
also skipped output validation whenever the stored step asserted `expectFail`.
The comparison exercises the real report validator as well as the stage reader.
The defect therefore predates this extraction. It does not establish that a
native Fusion operation was routed incorrectly.

| Retained evidence | Previous result | Required result and reason |
| --- | --- | --- |
| Stored `expectFail` without the same flag in the accepted operation | Completed | Unknown: the report cannot redefine the accepted operation's expected outcome |
| A declared negative check reports `blocked` | Completed | Unknown: refusal is not evidence that the intended negative assertion ran |
| A negative result carries `rollbackVerified: false` | Completed | Unknown: the existing batch outcome policy does not certify restored state |
| Top-level report `runId` differs from its accepted request | Completed | Corrupt: completion belongs to a different run identity |

The reader now compares steps with the expanded accepted operations and uses the
existing `expectedFail` and `failedOutcome` policies. A valid declared `fail` and
ordinary successful steps remain completed. CAD command wrappers and definition
invocations retain their bindings. Refusal preserves the original receipt bytes
and does not submit or replay an operation.

## Evidence and remaining scope

The 65 new cases compare save/helper receipts, request and document pins,
preflight ambiguity, unsaved helper ownership, expected failures, intent ordering
and packaged module resolution. Existing atomic ownership assertions are
unchanged; their harness now reads the compiled module. Filesystem reads are
supplied in the paired reader cases. Real descriptor checks, authenticated queue
snapshots, restart behavior and the installed worker remain covered by the
existing integration suites in full CI.
The real non-atomic stage-owner integration now also replaces its terminal report
with contradictory negative-test evidence, requires unknown/no replay, restores
the original bytes and verifies that the physical call count stays at one.

The focused set passes 97 tests, including atomic ownership, declaration
consumers and worker stage ordering. The pinned build, lint and test types pass.
Package tests require both the staged implementation and its declarations. New
tests consume staged types so their compiler cannot overwrite the packaged
compatibility entry, as happened during stage 4q.

Full CI remains the merge gate. This host lacks `/proc` evidence required by the
installed broker; those checks run on Linux CI without changing process or file
guards. Queue admission/recovery, the remaining runtime families and additional
shared Fusion scenarios remain open. Native qualification stays at the final
stage requested by the owner.

# Stage 4h: shared operation journals

The immutable operation-journal codec now lives in the typed persistence adapter.
Document publication and externalization use it directly. The batch adapter
retains its existing exports for callers while its remaining orchestration is
still awaiting migration.

Read results stay unknown until the operation validates them. The codec checks
contiguous numbering and the complete binding hash; it does not infer success
from an owner's opaque result. Writes keep the original JSON format, timestamp,
exclusive publication, fsync and cleanup behavior.

The comparison uses frozen, hash-checked sources from pre-refactor `a26222f` and
the immediately preceding `e92a0ee`. All three implementations run the same tests:
exact bytes and return values, canonical key order, absent versus unreadable
directories, sequence gaps, wrong owner/file identity, corrupt JSON, concurrent
writers and failures before/after publication. Their publication dependency is
the current shared adapter; this is a comparison of the journal codec, not a
claim that the entire historical runtime was executed.

Validation: 64 tests passed across journal comparisons, document publication,
publication migration and externalization; all six publication fault tests also
passed. Full build with the pinned API, strict test compilation, lint, type
checking and formatting passed. Packaging checks require the new
compiled module and declaration. Complete CI is required before merge.

PRs #16 and #17 passed all 20 CI jobs at their published heads and are merged into
`main`. Native Fusion qualification remains deferred.

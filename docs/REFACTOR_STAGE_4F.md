# Stage 4f: unavailable artifact evidence is not absence

An existing selection-rule artifact could be reported as missing when the file
opened successfully but Linux inode-path verification failed with `ENOENT`.
The record reader propagated that error unchanged, and the artifact store treated
it like a missing file. This hid a storage/verification failure from callers.

The guard was added in `888a374`; frozen `04fa9e1` contains the exact reader bytes
that survived into the current code. The artifact store was added in `09336cf`.
Both are later than the pre-refactor reference `a26222f`, which has neither this
reader nor the selection artifact store. This is a defect in code introduced
during the refactor, not a demonstrated pre-refactor Fusion behavior.

The reader now reports `STORAGE_UNAVAILABLE` and retains the original cause when
it cannot verify an already-opened file. It reads no content and closes the file
descriptor. A mismatched inode still fails as `INVALID_ARTIFACT`; a genuinely
missing file still returns the existing missing-record result. No identity guard
is bypassed and no receipt is rewritten or replayed.

Paired tests inject `ENOENT`, `EACCES` and `EIO` into the historical and current
reader. Additional tests cover valid evidence, foreign paths, actual absence and
the artifact store's final result. All 10 focused record/selection-store tests
pass. The selection-rule integration suite is now registered in the regression
CI matrix; it needs a host with `/proc/self/fd`, unavailable locally. The local
environment failure must remain explicit, not be counted as successful readback.

This changes an expected error, not a CAD result: an inability to verify a file
does not prove that the file is absent. Build, lint, TypeScript and formatting
checks plus full CI are required before merging.

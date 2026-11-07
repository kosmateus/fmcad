# Stage 5d: compile historical evidence tests

The run-script comparisons, live-suite inventory and artifact-read evidence tests
now compile under the strict runtime-test configuration. Default and regression
commands execute their compiled output; lint and formatting include their sources.

The assertions are unchanged: exact Python artifacts and source hashes, queue
input pinning, the archived live-suite classifications, and the distinction between
an absent file and unavailable inode-verification evidence. Filesystem fault
injection uses scoped mocks, restored after each test.

Validation: 23 focused tests passed, including the existing selection-store
suite. Runtime-test compilation, test type checking, lint and formatting passed.
No production runtime changed. Native Fusion qualification remains deferred.

PRs #13–#15 are merged into `main`; each passed all 20 CI jobs at its published
head. This does not establish that a later `main` workflow has finished.

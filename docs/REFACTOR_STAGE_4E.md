# Stage 4e: typed CAD dispatch

The public CAD facade now delegates to a typed composition root. The core owns
the order of preview, offline import, definition, batch, Node service and native
routes. The composition root binds service adapters, nested executors, stage
dependencies and the one-call transport. Service implementations that remain in
JavaScript still need their own migrations.

All catalog examples are compared in preview mode against frozen `5292078`.
The test compares successes and validation errors and requires zero SDK calls.
Public read, dry-run and mutation examples also compare complete transport calls,
including source, manifest and document/file/project pins. Capability discovery
remains offline. Route selection stays synchronous so native preparation occurs
before the first asynchronous boundary, as required by the existing input-binding
regression. No expected output or retry policy changed.

Validation passed 180 tests covering CAD preparation/execution, previews,
definitions, batch persistence, save publication, curve/import preparation,
reference refresh and externalization. Build, lint, TypeScript and formatting
checks passed. The tarball test now checks the new composition module and its
declaration. Full CI remains required before merging.

A wider 81-test selection had six failures. Repeating the affected four files
with the frozen CAD coordinator produced the same six failures (14 passes,
6 failures), so they are not introduced by this dispatch extraction:

- Two baseline-service cases depend on `/proc` process identity or WSL spelling,
  unavailable in this local host without an explicit test fixture.
- Two selection-store cases cannot verify the opened file through
  `/proc/self/fd`. The current adapter incorrectly presents that verification
  error as a missing artifact; error classification needs a separate fix.
- The capability helper inventory omits newer public methods and its test also
  includes an internal method. Reconcile public metadata against actual methods.
- The definition CLI fixture still supplies the old direct-client dependency and
  incomplete configuration. Migrate the fixture to the broker boundary while
  preserving operation counts and preview assertions.

These failures remain tracked work, not waived acceptance results. None requires
changing the expected model outcome or bypassing production identity guards.

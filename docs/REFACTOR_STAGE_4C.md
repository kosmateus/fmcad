# Stage 4c: one native result parser

The typed public CAD executor still selected the first `FMCAD_RESULT` line.
Paired tests reproduce that behavior in the pre-refactor `a26222f` executor:
a second conflicting result, or a repeated identical result, was silently ignored.
Neither response proves which native outcome belongs to the operation.

The shared core parser now requires exactly one JSON object. The public CAD
executor and private reference/externalization adapters use it. Missing,
malformed, non-object or ambiguous reply evidence is marked unknown without
replaying the SDK call. Ordinary valid results, including explicit native failure
objects, retain their values. Existing failure messages and transport evidence
are preserved where the old path already rejected a response.

The earlier TypeScript migration already rejected non-object public results;
this stage adds their unknown classification and closes the remaining duplicate
marker gap. It does not turn malformed results into success or claim a native
mutation was rolled back. The existing transport exceptions retain their own
submission/settlement evidence.

Validation compares the original executor's duplicate-marker behavior, exact
normal output, failure messages and physical call count with the new executor.
Existing CAD application and private native-action regression suites also run.
Full CI remains required before merging.

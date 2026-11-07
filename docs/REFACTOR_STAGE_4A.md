# Stage 4a: run script preparation

The Node adapter now owns script discovery, file reads and Python bundle assembly
in strict TypeScript. The composition root connects invocation provenance and
queue byte verification. `src/run.js` is a compatibility entrypoint.

A frozen copy of `src/run.js` from `d496c734` supplies paired comparisons. Plain,
identity-bound, read-only and cad-v1 preparations retain identical artifacts,
source maps, hashes and generated Python. Both versions reject changed or
unregistered queued source. Preparation uses the same raw buffer as provenance
and admission, even if the file changes after the read. Existing document guards
and argument/output contracts remain unchanged.

The build stages implementation and declarations into the installed runtime.
The tarball test prepares an identity-bound builtin from the installed package;
it must not resolve private workspace packages. Run/CLI/application/artifact
regressions are now part of CI. Three older fixture paths use the configured temp
directory, and the offline receipt test explicitly installs its WSL path fixture.
These test setup changes preserve assertions and do not relax platform checks.

Local validation passed 46 script/application/artifact tests, three selected
configuration/CLI tests, build, lint and strict type checks. The full interpreter
consumer and installed dependency tests require CI in this environment: local
executable fixtures cannot be launched and the npm offline cache is incomplete.
Native Fusion qualification remains deferred. This delivery does not close the
remaining CAD orchestration, broker support services or other JavaScript adapters.

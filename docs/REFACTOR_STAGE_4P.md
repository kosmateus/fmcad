# Stage 4p: typed command composition and invocation storage

CAD/run command composition and catalog execution move to strict TypeScript.
The Node execution adapter owns invocation-local storage and delegates the
existing pure context helpers. Compatibility entries resolve the same storage
instance, so source provenance and request purpose stay local across awaits.
These entries remain transitional; final facade retirement is still open.

Full sources from `2a51000` are frozen for paired comparisons. Tests compare
parsed payloads, policy arguments, complete SDK argument hashes, source
provenance, output streams, exit codes and helper stage order. Success, failed
and lost responses, proven/unknown UI guards, read-only and helper requests,
offline preview and malformed native results retain their behavior. Overlapping
invocation scopes retain separate owners and disappear after completion.

The initial extraction inserted `preview` before document selectors. Its changed
generated source hash failed the historical comparison. Original field order is
restored; no checksum or source assertion was relaxed. The comparison hashes the
complete serialized arguments to keep multi-megabyte artifact diffs bounded.

Two diagnostics improve deliberately: a run with no backend rejects explicitly
before preparation, and a thrown string retains its message instead of printing
`undefined`. Missing clients make no SDK call; an execution failure makes one
call and is never retried. Ordinary Error messages, partial output and secret
redaction are unchanged.

Installed-package tests require the new implementation/declaration files. An
external strict TypeScript consumer covers both composition modules and the
invocation adapter without private workspace types. Full broker CI and installed
CLI/MCP checks remain required before merging; native Fusion stays deferred.

Local validation passed 75 migration, invocation, command, batch and declaration
tests. Full pinned build, lint/types/formatting and package-content checks are
required alongside the CI matrix. Native checks are not counted as passed.

# Stage 4g: typed document publication adapter

The document-publication facade now delegates to typed composition. It binds the
existing save use case, immutable journal adapter, authenticated stage hooks and
scoped status/save operations. The request, default description, target version,
clock and sleep behavior are retained. The shared atomic journal codec remains
unchanged; its remaining JavaScript migration is separate work.

Paired tests execute frozen `a9cf665` and the typed adapter with identical
observations for completed publication, a clean-document no-op and a lost reply
after submission. They compare complete results, replay receipts, stage bindings
and the internal call trace. Both implementations submit at most once. No expected
result changes are introduced, and acceptance is not treated as cloud completion.

The existing suite also covers later observation, identity/version drift, corrupt
receipts, interrupted locks, default descriptions and display-name changes after
save. All 16 publication/dispatch tests pass. CI now registers both publication
suites and checks the composition module and declaration in the npm tarball.
Full CI is required before merging; real Fusion remains a final qualification task.

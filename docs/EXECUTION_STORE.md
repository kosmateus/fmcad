# Execution persistence and owned results

`packages/node-adapters/src/persistence` owns filesystem effects. The dedicated
core port `ports/execution-store.ts` describes serialized snapshot commit/restore,
records, owned result references and exclusive publication. Snapshot schema and
queue transitions remain queue-domain concerns. No panel database, telemetry
directory or temporary log owns scheduler state or reconciliation evidence.

## Durability

`records.ts` writes private temporary files, flushes their contents, atomically
renames snapshots (or exclusively links journals/receipts) and flushes the parent
directory. Exclusive records never replace existing evidence, including unresolved
receipts. Cleanup only removes a temporary file created by this invocation.

`createSnapshotStore` preserves the existing queue-state filename and serialized
format. A separate `queue-state.pending.json` journal is durable before a snapshot
replacement. If a write, rename or flush fails, the current store stays faulted;
restart with an unresolved pending journal fails closed too. A complete JSON
snapshot after a failed directory flush is **not** proof that the transaction was
acknowledged. Keep the journal and receipts, inspect the snapshot and physical
execution evidence, and explicitly reconcile before administrative recovery.
There is no automatic deletion of unresolved journals, retry or rollback.

Reads use a regular-file check, `O_NOFOLLOW`, `O_NONBLOCK` and bounded byte reads.
Truncated/changed records, excessive sizes and unsupported queue versions are
errors; the queue domain remains responsible for decoding snapshot versions.
If storage is completely unwritable, no implementation can guarantee recording a
new fault: the failing operation still throws and must never be acknowledged as
successful. Existing durable evidence is retained.

## Owned result contract

New response files remain in `<project>/.cad/results/<jobId>`. Legacy global
`jobs/<jobId>` remains readable; `queue-response-migration.js` is the only offline
migrator and continues to skip unresolved jobs. Nested projects are not treated
as their parent's scope. Existing destination conflicts leave both copies intact.

An artifact reference has exactly `version`, `jobId`, `scope`, `storage`, `name`,
`bytes`, and `sha256`. Scope hashes the canonical owning project (or the canonical
broker directory for old unscoped jobs). The reader supplies its own expected job
and cwd, derives the allowed filename and directories, checks every component,
opens without following the final symlink, verifies the opened inode's Linux path,
and validates size/hash before parsing. A broker-supplied `path` is only display
metadata, never authorization. No arbitrary-path allowlist is introduced.
Supported names are stdout, stderr and RPC-result only. MCP RPC reads remain
limited to 16 MiB; the adapter's bulk description/migration ceiling is 128 MiB.
Inline stdout/stderr polling reads one bounded prefix snapshot, because a live
worker may append while the broker serves it. It never hashes one read and serves
different bytes from a second read. External references remain size/hash-bound:
if an active log grows after the descriptor was issued, obtain a fresh result
reference; a stale reference is not silently accepted. RPC/receipt reads remain
strict and do not use the growing-log exception.
Authenticated broker ownership checks are still required before returning a
reference; this local contract is not a bearer capability or sandbox against the
same OS user modifying both the broker and its private state.

## Accepted input evidence

`accepted-inputs.ts` stores accepted payload/source bytes under the durable broker
directory, separate from mutable input paths and result files. Content-addressed
bytes and immutable admission manifests retain original paths only as provenance.
Submitted SHA256 must match source bytes **before admission**. Equivalent retries
reuse retained bytes rather than reading changed current files. Input identity is
separate from the queue's immutable request hash, preserving older idempotency
records. Conflicting provenance for a reused admission identity is rejected.

For old jobs without a manifest or missing retained content, readers report
`missing`; they must not substitute the current source file or claim it was the
accepted original. Temp-log/panel cleanup must not remove `accepted`, `admissions`,
`jobs`, receipts, snapshots or pending journals.

## Integration boundary

The CommonJS `queue-instance`, `queue-response-files` and `publish` modules are
temporary facades over compiler-produced adapters staged in `src/dist`.
The broker wires `outputs` to `jobOutputs`, calls `retainAdmission` before
admitting new jobs, and exposes `readAdmission` provenance in owned results.
Historical jobs keep their original missing-evidence semantics: current sources
are not captured on retries. `QueueState` composes `QueueDomain` with the snapshot
adapter; no transition policy or snapshot-version decoder is duplicated in Node.
`tests/execution-store-integration.test.js` exercises real broker IPC, large
project RPC across broker restart, private ownership, provenance, symlink refusal,
snapshot faults and unresolved restart semantics with a fake physical backend.

Offline verification is in `tests/execution-store.test.js`,
`tests/project-responses.test.js`, and `tests/publish.test.js`. These tests do not
validate live Fusion execution or physical CAD quality.

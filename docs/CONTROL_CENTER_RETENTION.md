# Control Center retention and diagnostic ownership

Execution history and auxiliary diagnostics have different failure semantics.

| Data | Owner and storage | Retention and failure behavior |
| --- | --- | --- |
| Project events, aliases, jobs and registered artifact references | Project-history SQLite under the registered project | Bounded pages, serialized reads and database quota. Failed durable writes do not advance revisions. Unresolved evidence is not purged. |
| Task stdout/stderr and results | Owning job/project `.cad/results` | Retained execution evidence; diagnostic cleanup never visits it. |
| Broker lifecycle, operation and reconciliation receipts | Existing broker/journal stores | Authoritative durable evidence. Their existing fail-closed writes are unchanged. |
| Existing project text logs | `.cad/logs` and recognized legacy sources | Existing hourly rotation and bounded readers remain. Deployment never deletes or rewrites historical files. |
| Project observer implementation errors | Private `fmcad-diagnostics-<uid>` directory under the OS temporary directory | Redacted, disposable, bounded records. Loss is counted independently from project write failures. |

The diagnostic writer permits at most 128 queued records, each retaining at most
8,192 characters. Each process retains four files of at most 1 MiB per service.
When opening a new file, cleanup scans at most 256 directory entries. It keeps at
most four inactive files for that service and removes inactive files older than
seven days. A process that cannot be proven dead is treated as active, including
PID reuse and permission failures. Other active processes keep their own bounded
files. A crowded or unrecognizable directory is not broadly purged.

Files use exclusive creation, private permissions and no-follow opens. Cleanup
requires the service filename, a regular single-link file, matching user and
unchanged device/inode identity. Symlinks, hard links and foreign files are left
alone. Deleting temporary diagnostics does not delete histories or receipts and
the writer recreates its own directory on the next write.

The observer no longer redirects detached stderr to an unbounded file. Handled
startup and project-log errors use the bounded writer; a failed readiness check
records `LOGGER_NOT_READY`. Diagnostic errors never write to MCP stdout. The
observer status response reports pending, dropped and failed auxiliary writes.
Its project writer remains bounded to 64 project destinations and 128 pending
records per destination. Existing `observer-errors.log` is retained in place for
compatibility; no migration cleanup targets it.

Validation: `tests/diagnostic-retention.test.js` covers burst limits, redaction,
byte/count rotation, age cleanup, live PID protection, foreign/symlink/hard-link
protection, disk-full recovery and deletion of temporary storage. Existing
`tests/project-logger-rotation.test.js` retains hourly/legacy evidence checks.
The local host passes the five new tests and three existing file tests; its
Linux abstract-socket observer test fails with `EPERM` before readiness. Full
Linux CI remains required. SQLite quota/reopen evidence is in PR #41.

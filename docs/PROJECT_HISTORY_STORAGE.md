# Project history storage

Each registered project keeps console history in
`.cad/control-center/control-center.sqlite`. Writable opens apply a static 32 MiB
SQLite page cap by default; the internal `maxDatabasePages` option can override
the page count for a specific deployment. Read-only opens do not change database
settings.

The cap limits the main SQLite database, not every byte in the project directory.
SQLite's rollback journal is not retained after a write. Opt-in WAL mode uses a
256-page auto-checkpoint and a zero-byte retained-journal target; another process
holding a read transaction can delay a checkpoint, so this is not a strict total
disk quota.

An existing database larger than the default cap is never truncated or cleaned
up: SQLite cannot lower its page ceiling below its current size, and the existing
history remains readable. A `SQLITE_FULL` write is rolled back and exposed as
`HISTORY_DB_FULL`. The passive telemetry runtime reports that condition once,
stops further event and gap writes to the full database, and leaves CAD results
and previously stored history untouched. It does not delete old history or
retry gap writes against the full database. The event queue defaults to 256
pending events. The runtime holds at most 256 queued gaps plus one merged
overflow range.

# Observation ports

Events and process presence are auxiliary observations, not execution evidence.
They share the `@fmcad/core` observation contract, while each CLI, MCP, or
OpenCode process owns its own `InvocationContext`, event sink, and disposal
lifecycle.

## Correlation and identity

`InvocationContext` carries the optional client, request, job, project, document,
host-session, and turn IDs plus a required instance ID and adapter source. The
MCP client ID identifies a transport process; OpenCode session and agent IDs are
separate host identities and never replace it. A process heartbeat records a
PID and Linux `/proc` birth identity when available. It is `observed` only when
the PID/birth pair is live and the timestamp is fresh; a stale or future
timestamp, or an uncheckable process, is `unknown`. A closed record or confirmed
dead/reused PID is `offline`. Historical jobs do not create presence.

Each presence instance writes its own file. Disposing an instance closes only
that record; another process using the same client ID remains observed. Readers
bound the scan to 256 records and aggregate per-client counts without dropping
the underlying process identities.

## Failure and retention boundaries

`EventSink` and presence writes are best-effort. The application scope catches
telemetry and disposal errors, and no telemetry error changes admission, hold,
execution, or a returned operation result. Queue jobs and receipts remain the
authoritative durable evidence; a missing observation or receipt is not a
success. Events are bounded JSON and the project-log adapter writes only
allow-listed correlation and scalar fields. MCP stdout remains protocol-only.

Historical direct transport snapshots remain readable as bounded process
metadata and outcomes, never request arguments, credentials, or returned
payloads. Current public adapters do not create direct snapshots or send work
outside the broker. A historical unsettled failure remains `unknown`; observing
or stopping it does not cancel Fusion or make a retry safe.

## Verification boundary

The observation tests use synthetic files, fake event writers, and local child
processes. They cover same-client multi-process presence, PID/birth and
freshness classification, bounded reads, disposal ownership, event failure,
and diagnostic redaction. They do not validate a Fusion SDK operation or CAD
model quality.

# Owner-bound atomic holder observation

This is a narrowly scoped recovery control for the approved blocked Fasteners
atomic batch. It is not a general resume, replay, rollback or lifecycle bypass.

## Deployment prerequisite

The running broker must advertise `features.atomicWorkflowObserve: true`, and
the installed CLI and broker must have the same approved build. The observer
must also have the production Python admission checker and final-byte
certificate integrated. Merely installing the scoped observer source does not
provide that checker.

The legacy broker with build `1ef9b72…` does **not** implement this control.
The CLI refuses that broker before submitting a job. This command cannot deploy
the observer, release the old broker, or migrate a live unresolved owner.
An independently approved, receipt-preserving lifecycle handoff is still required.
The explicitly approved external handoff contract is documented in
[ATOMIC_BROKER_MIGRATION.md](ATOMIC_BROKER_MIGRATION.md); it remains unavailable
for live use until the candidate's production admission and packaged build pass.

## Exact owner invocation after deployment

The original Fasteners owner runs the installed public CLI using the **existing**
authenticated CLI environment and credentials, from its original project directory
`/tmp/opencode/fmcad-backlog/measured-fasteners`:

```sh
fmcad queue observe-atomic \
  --job 5fbcd38b-8e8a-4cd7-8eab-353e8b025b9a \
  --request-id measured-fasteners-atomic-status-20261028-v1
```

Do not override `--client`, edit credential files, pass a token, use an unrelated
MCP identity, or wrap this in `queue exec`. This command uses the normal CLI
credential loader and the broker verifies the actual token against the original
job's owner. Knowing a client label or a job ID does not authorize observation.

The broker, not the caller, derives the typed `batch.reconcile` invocation from
the original immutable job and the approved exact holder scope. It supplies empty
`operations`, the original document pins, report path, command ID and session
nonce. Clients cannot provide replacement payloads or document/report overrides.
The original Fasteners job is a raw/phased CLI submission. Its accepted request,
argv and hash remain unchanged. The observer reads the broker's preserved typed
`jobs/JOB_ID/request.json` input envelope, verifies every original header field,
build, owner, input-file pin and policy argv, and binds its byte/inode digest to
the fences. It never re-executes argv or rereads an edited original `--file`.
Missing, changed or unvalidated original input is refused, not reconstructed.
The existing scoped submission and dispatch path still checks original receipts,
build, owner, report history, pause/reset epochs, live instance and document
identity, then sends only the broker-generated read-only `atomic_status`.

The command returns the observer **job receipt**, not a claim of terminal CAD
completion. Read that job through `fmcad queue result --job OBSERVER_JOB_ID` using
the same owner credentials. If an acknowledgement is lost, reuse the **same**
request ID; never invent a second request ID to send another probe. The original
receipt is returned without replay. Another probe is refused once an observation
has been sent or its dispatch outcome is uncertain.

The original job remains blocked after observation. Owner acceptance is a separate
`queue reconcile --job ORIGINAL_JOB_ID --accept-outcome committed|aborted` action,
permitted only when the bound observation genuinely proves that exact terminal
outcome, destruction and idle state. Do not infer `aborted` from an exception,
`notStarted`, absence of a holder, or a timeout. Acceptance never establishes
rollback verification or model/physical validation and preserves manual pause.

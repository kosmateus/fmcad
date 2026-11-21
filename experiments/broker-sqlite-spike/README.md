# Broker SQLite spike

Isolated Linux experiment, not an fmcad backend. It does not start the production
broker, load Fusion, send CAD payloads, import real history, or update both
formats. The fake broker and fake receiver are separate OS processes, use
separate SQLite files, and communicate over local sockets. Client processes do
not open either database. `fixtures/legacy-unknown.json` is synthetic.

## Run

```sh
cd experiments/broker-sqlite-spike
npm ci
npm test
npm run bench
npm run compare -- <reviewed-fmcad-source-sha>
```

Use Node 24 (or Node 22.15+ for the comparison) and a local Linux filesystem.
`SPIKE_TMP` may change the
private fixture base on that filesystem. The harness creates and removes only
its own temporary directories. Do not place WAL on a shared Windows/WSL mount
or network filesystem. The benchmark uses the public spike socket and two
client processes; it reports client round-trip latency, broker restart through
first verified reads, event-loop delay, and transaction counts/timings. The
comparison exports the given Git revision without changing the worktree and
runs the real reference `QueueDomain` and snapshot store without any receiver.
It measures the same synthetic submit/cancel pairs and module reopen, not
whole-broker performance parity. The spike omits policy that would have to be
retained in a production comparison.

## Durability boundaries

- A broker must bind its configured local socket before opening the database.
  SQLite uses `BEGIN IMMEDIATE`, `journal_mode=WAL`, and `synchronous=FULL`.
  The configured writer wait is 100 ms, so contention can stall the event
  loop. A `SIGKILL` proves process-crash behavior, not power-loss recovery.
- The broker commits immutable admission before sending an ACK. The caller
  can recover it by lookup. The indexed store persists exactly one turn and
  the bound call identity before attempting a dispatch.
- The fake receiver commits admission or a withdrawal under the same physical
  key before acting or acknowledging; it checks the dispatch epoch at the
  receiver. The effect is a flushed file append **outside** both SQL
  transactions. An admitted call without a bound terminal receipt remains
  `UNKNOWN`, including when the effect happened. Lookup never dispatches. A
  missing postflight holds the turn even if the original main receipt exists.
  The receiver records each incoming dispatch before rejection or deduplication
  in a separate test trace; the effect log remains independent.
- The history importer accepts a v1 copy with one blocked RPC and only matching
  receipt evidence. It validates the canonical SHA-256 and retains both the
  original bytes (administrator only) and the block. The owner sees job
  metadata, not the archive. It is not a cutover, a general legacy parser, or
  a cleanup tool.

## What the prototype replaces — and what it does not

| Current mechanism                                                                      | Experimental substitute                                         | Scope                                                                           |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `queue-state.pending.json` and explicit ambiguity journal creation/removal             | SQLite transaction/WAL recovery                                 | Only SQLite metadata, not effects or external artifacts                         |
| Temporary write + `fsync` + rename/link + directory `fsync` for that snapshot          | SQLite VFS commit instead of per-admission snapshot replacement | The existing helpers still serve accepted inputs, artifacts, and other journals |
| Rewriting and reparsing the complete queue snapshot and scanning its IDs for admission | Indexed jobs and a unique request key in the same transaction   | Targeted projections, not whole-queue status/fairness/history policy            |

No production code is removed. The prototype needs a native `better-sqlite3`
dependency plus its locked `node-addon-api` dependency; the fake receiver,
socket, tests and comparator are evidence scaffolding, not production
integration. An adoption would still need existing public framing, owner
authorization, detailed queue policy, compatible artifact/receipt identity and
retention, safe native packaging, and a receiver capable of durable admission
and fencing. The fake shared secrets and socket addresses are test fixtures,
not a production trust or lifecycle model. Do not infer a migration or rollout
decision from this spike alone.

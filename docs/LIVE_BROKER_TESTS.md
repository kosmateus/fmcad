# Live Fusion tests with and without the broker

The `npm run test:live:*` entry points use `tests/run-live.js`. SDK calls from
both the CLI suites and the in-process backend adapter suites go through the
same configured broker. There is no direct fallback and no automatic SDK replay.

You may launch multiple entry points concurrently:

```sh
npm run test:live:cad
npm run test:live:definitions
```

Run the complete integration set through the shared broker:

```sh
npm run test:live -- --routing queue
```

`--routing queue` is accepted as a redundant compatibility spelling. The former
`--routing direct` mode now fails with a migration message; there is no live-test
direct transport. Suites use shared queue admission and never stop a broker behind
other clients.

There is **no suite-wide broker lease**. CLI commands use phased admission;
local preparation, assertions and report writes must not reserve Fusion. Only
settled SDK turns are serialized. Existing identity, unsaved-document and cleanup
guards remain in effect. Aggregate queue runs capture the original user documents
before launching suites. Test assertions compare that baseline plus their own
UUID-named fixture, not another suite's independently changing fixture. The test
transport activates a fixture only by its verified creationId/name/unsaved state,
inside the same SDK turn. CLI parsing/handlers still execute locally; the CLI's
typed application submits SDK work through the shared broker.
An aggregate check verifies the original user documents after the run. Disappearing
or replaced owned documents still fail closed; scoped assertions are not permission
to ignore changes to original user documents or replay an operation.

An accepted `document.save_as` can return after the SDK call while the observed
target file is still processing in the cloud. A matching saved/unmodified target
with incomplete cloud processing is not an unfinished native command: its settled
SDK turn may yield, and the owner must verify final cloud identity/completion
separately. This does not make the file ready or permit repeating `saveAs`.
Unaccepted/unobserved or mismatched targets, explicit unknown execution outcomes
and unfinished native command lifecycles remain fenced. Large CLI replies may be
returned as `FMCAD_QUEUE_OUTPUTS` references; consumers verify the completed job
binding, project-owned path, stable regular file and byte count before decoding the
response, rather than treating empty inline stdout as missing execution proof.
Large queued command arguments use private project sidecars above 1 MiB, with
request byte count/SHA-256 and operation/document identity checked on the Fusion
host before execution. The returned sidecar is bound to that request and verified
before use. These files are bounded at 128 MiB; the socket request limit remains
16 MiB. Native pending/unknown/termination identity fields stay inline so a file
reference cannot hide unfinished work. A failed read clears per-command pending
file bookkeeping without deleting uncertain inputs or replaying the operation.

The retained aggregate queue snapshot is different from an individual protocol
record. Console and stopped-broker response migration read it with an explicit
128 MiB bound; ordinary records retain the default 16 MiB bound. This preserves
existing history rather than deleting old jobs to make the monitor readable.

The test runner does not start Fusion, change global configuration, resolve
interactive commands, cancel SDK calls, reconcile unknown work or replay tests.
It requires an already-running broker with the matching build identity; it does
not autostart, reload, restart, reclaim or resume a broker.
Avoid editing `src`, `assets`, `bin` or `package.json` while live work is executing:
the broker pins its executable build. External clients that bypass the broker
are outside these test sequences.

## Entry points

- `npm run test:live:stdio`: read-only stdio smoke test.
- `npm run test:live:adapter`: read-only backend/session soak through the broker.
- `npm run test:live:cad`, `test:live:extended`, `test:live:legacy`.
- `npm run test:live:definitions`, `test:live:feature-modes`.
- `npm run test:live:styles`, `npm run test:live:motion`.
- `node tests/run-live.js camera-probe --run`.
- `node tests/run-live.js joint-limits-probe --run`.

The UI host inspection/watcher helper processes do not issue Fusion SDK calls;
they remain host-side helpers rather than independently scheduled CAD suites.

Reports retain their existing `tests/live-*-report.json` locations. Do not run two
copies of the same suite against the same report path. Broker job IDs are also
printed on stderr. A failed assertion is not the same as an unknown SDK outcome;
inspect both the report and broker state before choosing any further action.

## Offline verification

```sh
npm test
```

The offline suite validates CLI/registry behavior, generic queue contracts, MCP
stdio forwarding, and Python-side tooling without accessing Fusion.

`tests/phased-queue.test.js` additionally verifies that a short caller timeout
keeps active/unknown SDK work fenced but releases subsequent clients promptly
after original completion evidence is available, without replay. Automatic
recovery checks local evidence every second; it never sends a probe while the
original worker/RPC or its completion receipt is still unresolved.

## Real Fusion RPC fault injection

```sh
node tests/live-rpc-recovery.js --run
```

This is an isolated live integration check, not a mocked-kernel test. Run it only
against the matching installed build and already-running shared broker. It wraps
the real addin transport to discard exactly one already executed read-only
response. It verifies automatic receipt-bound recovery and a second client
completing without replay. A separate case closes a client socket before its
admission acknowledgement and verifies that the accepted original job and
another client's job still complete. It shares the broker queue with other
clients and does not require a manual Fusion reservation.

The test records broker job IDs and before/after document state in
`tests/live-rpc-recovery-report.json`; do not run duplicate copies that write the
same report path. It never kills Fusion or requests model mutations. Unknown
execution prevents broker ownership release rather than pretending the test
safely finished. Normal parallel suites use the ordinary broker; do not start a
competing broker.
